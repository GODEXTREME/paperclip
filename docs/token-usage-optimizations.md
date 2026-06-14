# Token usage optimizations — plano de trabalho

Plano para reduzir o consumo de tokens por execução de agent no Paperclip.
Baseado na investigação do pipeline de montagem de prompt/contexto do heartbeat.

Contexto-base por execução: **~5k–40k tokens**, dominado por (1) instruções do
agent, (2) contexto do issue (comentários + continuation summary) e (3) skills
**efetivamente injetadas**. O número de **projetos** por companhia **não** afeta
o custo por run (só o projeto do issue é carregado).

### Como as skills realmente entram no run (importante)

As skills **não** são injetadas só por estarem instaladas na companhia. O
conjunto injetado por run é **filtrado**:

- `server/src/services/company-skills.ts:4249` (`listFull`) monta a lista de
  **metadados** de todas as skills, mas isso é só para decidir o que materializar.
- `packages/adapters/claude-local/src/server/execute.ts:462` filtra por
  `desiredSkillNames` antes de materializar.
- `packages/adapter-utils/src/server-utils.ts:1809-1824`
  (`resolvePaperclipDesiredSkillNames`): injeta **bundled/required sempre**; se o
  agent não tem preferência explícita, injeta **só as bundled**; se tem, injeta
  `required + as escolhidas explicitamente`.
- `server/src/services/heartbeat.ts:8441-8449`: skills **mencionadas no issue**
  entram só para aquele run.

> Conjunto injetado por run = **bundled (sempre) + escolhidas pelo agent +
> mencionadas no issue**. Skills usam *progressive disclosure*: ao contexto vai
> só o frontmatter (nome + descrição); o corpo é lido sob demanda.

---

## 1. Filtrar skills por tarefa/projeto (ganho condicional — só com muitas skills)

**Premissa corrigida:** o sistema **já filtra** as skills injetadas por
agent (desired) + required + mencionadas no issue. Não há despejo company-wide.
Portanto o ganho desta otimização **só existe** quando agents selecionam
*explicitamente muitas* skills, ou quando o set de bundled/mencionadas é grande.

- **Onde:** `server/src/services/company-skills.ts` (`listRuntimeSkillEntries`,
  `listFull(companyId)`); `packages/adapter-utils/src/server-utils.ts`
  (`resolvePaperclipDesiredSkillNames`); injeção em
  `server/src/services/heartbeat.ts` (`paperclipRuntimeSkills`).
- **O que fazer:** opcionalmente escopar/limitar as skills desejadas por
  projeto/categoria da tarefa, e/ou reduzir o metadado da lista `paperclipRuntimeSkills`
  ao que é de fato materializado. Manter compatibilidade: sem escopo →
  comportamento atual.
- **Ganho:** ~2k–10k tokens/run **apenas** em agents com muitas skills desejadas.
- **Esforço:** Médio-Alto (precisa de metadados de skill por projeto + testes).
- **Risco:** Médio (regressão se uma skill necessária for filtrada). Mitigar com
  opt-in e fallback para o comportamento atual.

## 2. Teto/aviso de tamanho nas instruções do agent (AGENTS.md)

**Problema:** o bundle de instruções é incluído inteiro, sem limite.

- **Onde:** `server/src/services/agent-instructions.ts` (montagem do bundle).
- **O que fazer:** medir o tamanho do bundle e emitir warning (UI + log) acima de
  um limite (ex.: ~8–10KB); opcionalmente expor o tamanho estimado na UI de
  instruções. Não truncar automaticamente (evita perda silenciosa).
- **Ganho:** indireto (induz o usuário a enxugar) — 0,5k–3k tokens/run.
- **Esforço:** Baixo.
- **Risco:** Baixo (apenas aviso, sem mudança de comportamento de execução).

## 3. Compactar continuation summaries

**Problema:** o corpo do resumo de continuação é passado inteiro, sem teto.

- **Onde:** `server/src/services/issue-continuation-summary.ts`;
  `server/src/services/heartbeat.ts` (`paperclipContinuationSummary`).
- **O que fazer:** limitar/condensar o corpo (heurística: manter blockers +
  últimas N seções; referenciar links de comentário em vez de inline) acima de
  um tamanho. Idealmente reaproveitar a sessão (que já preserva contexto) em vez
  de reinjetar o resumo completo.
- **Ganho:** ~1k–5k tokens por run de continuação.
- **Esforço:** Médio.
- **Risco:** Médio (perder contexto útil). Mitigar com limite generoso.

## 4. Prompt caching da Anthropic (cache_control)

**Problema:** não há `cache_control` nas partes estáveis (instruções + skills).

- **Onde:** adapter `packages/adapters/claude-local/*`.
- **Importante (caveat):** os adapters locais executam via **CLI** (`claude ...`),
  então não controlamos `cache_control` diretamente — quem decide é a CLI/SDK por
  baixo. Tornar acionável exigiria um adapter via **API HTTP** ou suporte explícito
  da CLI. Avaliar antes de investir.
- **Ganho potencial:** até ~90% nas partes estáveis e repetidas — porém
  **incerto** para os adapters atuais baseados em CLI.
- **Esforço:** Alto / Incerto.
- **Risco:** Alto (depende de capacidade externa). Tratar como pesquisa/spike.

## 5. Usar mais os model profiles "cheap" para trabalho leve

**Problema:** trabalho de status/baixo esforço pode usar o modelo caro.

- **Onde:** `packages/shared/src/constants.ts` (`MODEL_PROFILE_KEYS`);
  aplicação em `server/src/services/heartbeat.ts` (model profile resolution) e o
  recovery model-profile-hint já existente.
- **O que fazer:** ampliar os caminhos que selecionam o profile "cheap"
  (ex.: recuperação/status), e documentar/expor melhor na UI.
- **Ganho:** custo unitário menor (troca de modelo), não reduz contexto.
- **Esforço:** Baixo-Médio.
- **Risco:** Baixo-Médio (qualidade do output em tarefas sensíveis).

## 6. Escopar workspace hints pelo projeto do issue

**Problema:** dicas de workspace alternativos podem inflar o contexto.

- **Onde:** `server/src/services/heartbeat.ts` (`paperclipWorkspaces` /
  `workspaceHints`).
- **O que fazer:** filtrar hints pelo projeto do issue e/ou por recência.
- **Ganho:** ~0,5k–2k tokens/run.
- **Esforço:** Baixo-Médio.
- **Risco:** Baixo.

---

## Ordem recomendada

1. **#2** (teto/aviso AGENTS.md) — baixo risco, valor imediato.
2. **#3** (compactar continuation summaries) — ganho consistente em runs de continuação.
3. **#6** (escopar workspace hints) — baixo risco.
4. **#5** (model profiles cheap) — custo unitário.
5. **#1** (escopar skills) — **ganho condicional**: só vale com agents que
   selecionam muitas skills (o sistema já filtra por desired + required + mentioned).
6. **#4** (prompt caching) — spike de pesquisa, ganho incerto nos adapters CLI.
