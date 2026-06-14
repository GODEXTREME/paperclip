# Token usage optimizations — plano de trabalho

Plano para reduzir o consumo de tokens por execução de agent no Paperclip.
Baseado na investigação do pipeline de montagem de prompt/contexto do heartbeat.

Contexto-base por execução: **~5k–40k tokens**, dominado por (1) instruções do
agent, (2) skills da companhia e (3) contexto do issue. O número de **projetos**
por companhia **não** afeta o custo por run (só o projeto do issue é carregado).

---

## 1. Filtrar skills por tarefa/projeto (maior ROI direto)

**Problema:** skills são carregadas company-wide a cada run — todas, sem filtro
por projeto/tarefa.

- **Onde:** `server/src/services/company-skills.ts` (`listRuntimeSkillEntries`,
  `listFull(companyId)`); injeção em `server/src/services/heartbeat.ts`
  (`paperclipRuntimeSkills`).
- **O que fazer:** aceitar `issueId`/`projectId` opcional e filtrar as skills
  pelo escopo da tarefa (já existe filtro por `desiredSkillEntries` do agent —
  estender para também considerar projeto/categoria). Manter compatibilidade:
  sem escopo → comportamento atual.
- **Ganho:** ~2k–10k tokens/run em companhias com muitas skills.
- **Esforço:** Médio-Alto (precisa de metadados de skill por projeto + testes).
- **Risco:** Médio (regressão se uma skill necessária for filtrada). Mitigar com
  opt-in e fallback para "todas".

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
2. **#1** (escopar skills) — maior ganho direto.
3. **#3** (compactar continuation summaries).
4. **#6** (escopar workspace hints).
5. **#5** (model profiles cheap).
6. **#4** (prompt caching) — spike de pesquisa, ganho incerto nos adapters CLI.
