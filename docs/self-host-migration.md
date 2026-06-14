# Migração segura para o compose com build próprio (sem perder dados)

Você já tem um Paperclip rodando a partir de `ghcr.io/paperclipai/paperclip:latest`
sem volume declarado. Isso significa que seus dados (Postgres **embarcado**,
config e secrets em `/paperclip`) estão em um **volume anônimo** criado pelo
Docker. O novo `docker-compose.yml` deste repositório builda o código modificado
e usa um volume **nomeado** (`paperclip-data`). Os passos abaixo movem seus dados
do volume anônimo para o nomeado, sem perda.

> Execute na **máquina onde o Paperclip está rodando hoje**.

## 0. Pré-checagem — descubra o volume anônimo atual

```bash
# Nome do volume anônimo montado em /paperclip do container atual:
OLD_VOL=$(docker inspect -f \
  '{{ range .Mounts }}{{ if eq .Destination "/paperclip" }}{{ .Name }}{{ end }}{{ end }}' \
  paperclip)
echo "Volume atual: $OLD_VOL"
```

Se `OLD_VOL` vier vazio, o container pode estar usando bind mount ou outro nome —
rode `docker inspect paperclip | grep -A3 Mounts` e ajuste os comandos.

## 1. Pare o container atual (NÃO remova o volume)

```bash
# Se você subiu com o compose antigo:
docker compose -f docker-compose.antigo.yml stop
# ou, se foi container avulso:
docker stop paperclip
```

Parar é importante: garante que o Postgres embarcado não esteja escrevendo
durante a cópia (consistência do banco).

> ⚠️ Nunca use `docker compose down -v` nem `docker volume rm` no volume antigo
> até confirmar que a migração deu certo.

## 2. Backup do volume antigo para um arquivo no host (rede de segurança)

```bash
docker run --rm -v "$OLD_VOL":/from -v "$PWD":/backup alpine \
  tar czf /backup/paperclip-backup-$(date +%Y%m%d-%H%M%S).tar.gz -C /from .
ls -lh paperclip-backup-*.tar.gz
```

Guarde esse `.tar.gz`. Se algo der errado, ele restaura tudo.

## 3. Crie o volume nomeado e copie os dados

```bash
docker volume create paperclip-data

docker run --rm -v "$OLD_VOL":/from -v paperclip-data:/to alpine \
  sh -c 'cp -a /from/. /to/ && echo OK'
```

Verifique que a cópia tem conteúdo:

```bash
docker run --rm -v paperclip-data:/data alpine sh -c 'ls -la /data && du -sh /data'
```

## 4. Suba o novo compose (build do código modificado)

Coloque o novo `docker-compose.yml` (deste repositório) na raiz do projeto e:

```bash
docker compose build        # builda sua imagem modificada (paperclip:local)
docker compose up -d
docker compose logs -f paperclip
```

No log, procure por:

- `Applying N pending migrations for Embedded PostgreSQL` (a 0102 sendo aplicada), e
- `Embedded PostgreSQL ready`.

Acesse `http://<host>:3100` e confirme que seus dados (companies, agents, issues)
estão lá.

## 5. Limpeza (somente depois de confirmar tudo)

```bash
# Remova o container antigo, se ainda existir:
docker rm paperclip-antigo 2>/dev/null || true
# O volume anônimo antigo pode ser removido após validar:
# docker volume rm "$OLD_VOL"
```

---

## Rollback

Se precisar voltar ao estado anterior:

```bash
docker compose down                 # mantém o volume paperclip-data
# Restaure o backup para um volume novo, se necessário:
docker volume create paperclip-restore
docker run --rm -v paperclip-restore:/to -v "$PWD":/backup alpine \
  sh -c 'tar xzf /backup/paperclip-backup-XXXX.tar.gz -C /to'
```

E suba novamente apontando para o volume restaurado.

## Notas

- **Exposição `private` + `authenticated`** funciona com Postgres embarcado.
  Só `PAPERCLIP_DEPLOYMENT_EXPOSURE: public` exigiria `DATABASE_URL` externo.
- A migration `0102_agent_adapter_persistence_fallback` apenas **adiciona
  colunas** (`adapter_config_archive`, `fallback_adapter_type`, `fallback_state`)
  — é não destrutiva e reversível por restore do backup.
- Se algum dia migrar para **Postgres externo**, troque o volume embarcado por
  `DATABASE_URL` e use `docker/docker-compose.yml` como referência.
