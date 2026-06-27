# Rebase do fork (`godextreme/master`) sobre o upstream (`paperclipai/master`)

Nosso fork está **4 commits à frente** do fork-point `412a04c` (nossos PRs #1–#4)
e **vários commits atrás** do upstream (não foi possível medir o número exato; a
página de compare expirou com um rótulo de ~145). Este guia rebaseia os nossos 4
commits sobre o upstream atualizado, tratando o ponto mais arriscado: a
**colisão de numeração da migração `0102`**.

> Rode isto **localmente** (onde há acesso ao `github.com/paperclipai`). O ambiente
> remoto do Claude não alcança o upstream pelo proxy.

## Nossos 4 commits (o que será reaplicado)
- `f68030f` feat: persistência de config por adapter + fallback no limite de uso
- `ac092e8` chore: docker-compose self-host + workflow_dispatch + docs
- `1c8b048` fix(ui): vazamento da config do adapter ao trocar
- `c0ebe3f` fix(ui): reset do cheap model + "desativado" persistente

## Passo 1 — Buscar o upstream e ver a diferença
```bash
git remote add upstream https://github.com/paperclipai/paperclip.git 2>/dev/null || true
git fetch upstream

# O que o upstream adicionou que não temos:
git log --oneline master..upstream/master | wc -l
git log --oneline master..upstream/master | head -40

# Nossos commits (devem ser os 4 acima):
git log --oneline upstream/master..master
```

## Passo 2 — Rebase
```bash
git checkout master
git switch -c rebase/onto-upstream   # opcional: trabalhar numa branch separada
git rebase upstream/master
```

## Passo 3 — Resolver a colisão da migração (o ponto crítico)
Se o upstream tiver adicionado migrações além de `0101`, a nossa `0102` colide.
Renumere para `(maior do upstream) + 1`:

```bash
# Maior número de migração após o rebase do estado do upstream:
MAX=$(ls packages/db/src/migrations/*.sql | grep -oE '[0-9]{4}' | sort -n | tail -1)
NEXT=$(printf "%04d" $((10#$MAX + 1)))
echo "Maior atual: $MAX -> nossa migração vira: $NEXT"

OLD=packages/db/src/migrations/0102_agent_adapter_persistence_fallback.sql
NEW=packages/db/src/migrations/${NEXT}_agent_adapter_persistence_fallback.sql
git mv "$OLD" "$NEW" 2>/dev/null || mv "$OLD" "$NEW"
```

Depois edite `packages/db/src/migrations/meta/_journal.json`:
- Resolva o conflito mantendo TODAS as entradas do upstream.
- Na NOSSA entrada, troque:
  - `"tag": "0102_agent_adapter_persistence_fallback"` → `"${NEXT}_agent_adapter_persistence_fallback"`
  - `"idx"` → o próximo índice sequencial (último idx do upstream + 1)
  - `"when"` → um timestamp maior que o da última entrada do upstream
- Garanta que a NOSSA entrada seja a **última** do array.

Valide a numeração/journal:
```bash
pnpm --filter @paperclipai/db run check:migrations
```

> A migração é **aditiva** (`ADD COLUMN adapter_config_archive / fallback_adapter_type
> / fallback_state`). Renumerar é seguro: nenhuma instância ainda aplicou a `0102`
> com esse número fora do nosso próprio deploy — e nesse deploy ela já está aplicada
> como `0102`. **Atenção:** se você JÁ subiu a imagem `0102` em produção, renumerar
> faria o banco tentar reaplicar a migração com o novo número. Nesse caso, use a
> seção "Já tenho 0102 aplicado" abaixo.

### Já tenho `0102` aplicado em produção
O Paperclip registra migrações aplicadas pela `tag`. Se você renumerar para `0150`,
o servidor verá `0150` como pendente e tentará rodar `ADD COLUMN` de novo →
falharia (coluna já existe). Duas saídas:
1. **Manter `0102` localmente** e, no rebase, só resolver o conflito do `_journal.json`
   **sem renumerar** — desde que o upstream **não** tenha um `0102` próprio. Se tiver,
   há conflito real de número e você precisa renumerar + ajustar o registro no banco.
2. **Renumerar e ajustar o registro**: após renumerar para `$NEXT`, atualize a linha
   da migração na tabela de controle do Paperclip para a nova tag (ou use
   `ADD COLUMN IF NOT EXISTS` nas três colunas para a reaplicação virar no-op).
   O mais limpo é tornar a migração idempotente:
   ```sql
   ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "adapter_config_archive" jsonb DEFAULT '{}'::jsonb NOT NULL;
   ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "fallback_adapter_type" text;
   ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "fallback_state" jsonb;
   ```
   Assim, mesmo renumerada, a reaplicação é segura.

## Passo 4 — Outros arquivos com conflito provável
Arquivos que NÓS tocamos e o upstream pode ter mexido (resolva mantendo as duas
intenções):
- `packages/db/src/migrations/meta/_journal.json` (quase certo)
- `packages/db/src/schema/agents.ts` (nossas 3 colunas novas)
- `packages/shared/src/index.ts`, `types/index.ts`, `types/agent.ts`, `validators/agent.ts`
- `packages/plugins/sdk/src/testing.ts`
- `server/src/routes/agents.ts`, `server/src/services/heartbeat.ts`
- `ui/src/components/AgentConfigForm.tsx`, `ui/src/lib/agent-config-patch.ts`
- `.github/workflows/docker.yml`

Arquivos **só nossos** (sem conflito): `server/src/services/adapter-fallback.ts`(+test),
a migração `*.sql`, `docker-compose.yml`, `docker-compose.build.yml`, `docs/*`.

## Passo 5 — Validar e publicar
```bash
pnpm install
pnpm -r typecheck
pnpm --filter @paperclipai/db run check:migrations
# testes focados:
npx vitest run server/src/services/adapter-fallback.test.ts \
  ui/src/components/AgentConfigForm.test.ts ui/src/lib/agent-config-patch.test.ts

git push --force-with-lease origin master   # rebase reescreve histórico
```
O push para `master` dispara o workflow Docker e republica a imagem.

## paperclip-mcp
**Não requer atualização** por causa das nossas mudanças: ele consome a API em
passthrough (`return r.json()`, sem modelos estritos / `extra=forbid`) e usa agents
apenas em modo read-only (`list/get/heartbeat`), sem `adapterType`/`adapterConfig`.
Os campos novos do Agent apenas aparecem como chaves extras. Só mexa nele se quiser
**expor** o fallback/archive como novas ferramentas MCP.
