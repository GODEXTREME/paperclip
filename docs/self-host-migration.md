# Self-host: publicar a imagem no GHCR e usar no Portainer

Seu setup usa **bind mounts** no NAS, então **seus dados já estão seguros no
disco** (`/volume1/docker/paperclip`) — não há volume anônimo para migrar. Trocar
de imagem/compose não apaga nada; o container novo apenas reabre o mesmo diretório.

Conjunto de dados persistidos hoje:

- `/volume1/docker/paperclip` → `/paperclip` (Postgres embarcado, config, secrets)
- `/volume1/docker/paperclip/codex` → `/home/node/.codex` (login do Codex CLI)
- `/volume1/docker/paperclip/claude` → `/home/node/.claude` (login do Claude CLI)

A migration `0102` (adapter persistence + fallback) é **aditiva** (`ADD COLUMN`) e
é aplicada no boot via `PAPERCLIP_MIGRATION_AUTO_APPLY=true`.

---

## Passo 1 — Habilitar GitHub Actions no seu fork (uma vez)

Forks vêm com Actions desabilitado. Os workflows aparecem como "active" na API,
mas **não rodam** até você liberar:

1. Vá em `https://github.com/GODEXTREME/paperclip/actions`
2. Clique em **"I understand my workflows, go ahead and enable them"**.

> Sem esse passo, nenhuma imagem é publicada.

## Passo 2 — Publicar a imagem no GHCR

O workflow `.github/workflows/docker.yml` já builda (linux/amd64 + arm64) e publica
em `ghcr.io/godextreme/paperclip`. Ele dispara em:

- **push para `master`** → tag `:latest` (+ `:sha-…`)
- **tag `v*`** → tags semver (`:1.2.3`, `:1.2`)
- **manualmente** (`workflow_dispatch`) → aba *Actions → Docker → Run workflow*

Como a feature já está no `master`, basta **rodar o workflow** (Run workflow) ou
criar uma tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Acompanhe em *Actions → Docker*. Ao final, a imagem estará em:

```
ghcr.io/godextreme/paperclip:latest
```

## Passo 3 — Tornar o pacote acessível ao Portainer

Por padrão, o pacote no GHCR nasce **privado**. Duas opções:

- **Simples:** torne o pacote público.
  GitHub → seu perfil → *Packages* → `paperclip` → *Package settings* →
  *Change visibility* → **Public**. (Portainer puxa sem login.)
- **Privado:** crie um *Personal Access Token* (classic) com escopo `read:packages`
  e configure o registry no Portainer (*Registries → Add registry → Custom*,
  URL `ghcr.io`, usuário = seu login, senha = o token).

## Passo 4 — Apontar o Portainer para a imagem

Use o `docker-compose.yml` deste repositório (stack no Portainer). Ele usa
`image: ghcr.io/godextreme/paperclip:latest` e os seus bind mounts.

No Portainer:

1. *Stacks → Add stack* → cole o `docker-compose.yml` (ou aponte para o repo).
2. *Deploy the stack*.
3. *Containers → paperclip → Logs* e confira:
   - `Applying N pending migrations for Embedded PostgreSQL` (a 0102), e
   - `Embedded PostgreSQL ready`.

Para atualizar no futuro: republique a imagem (Passo 2) e no Portainer faça
*Recreate* / *Pull and redeploy* da stack.

---

## Backup recomendado (rede de segurança)

Mesmo sem risco de perda na troca de imagem, faça um backup do diretório de dados
antes de atualizar (idealmente com o container parado, para consistência do banco):

```bash
# No NAS (via SSH), com o container parado:
tar czf paperclip-backup-$(date +%Y%m%d-%H%M%S).tar.gz -C /volume1/docker/paperclip .
```

## Notas

- **Build local em vez de GHCR:** descomente o bloco `build:` no `docker-compose.yml`
  (Opção B) — útil para testar sem publicar.
- **Arquitetura:** o workflow publica amd64 e arm64, cobrindo Synology Intel/AMD e ARM.
- **Permissões nos bind mounts:** se aparecer erro de permissão, ajuste `USER_UID`/
  `USER_GID` no compose para o dono dos arquivos em `/volume1/docker/paperclip`.
- **`private` + `authenticated`** funciona com Postgres embarcado; só
  `PAPERCLIP_DEPLOYMENT_EXPOSURE: public` exigiria `DATABASE_URL` externo.
