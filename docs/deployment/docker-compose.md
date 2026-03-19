# Docker Compose — Local Production

## First-time setup

### 1. Start the database only

```bash
docker compose -f docker-compose.local-prod.yml up -d db
```

### 2. Run migrations

```bash
bun db:migrate
```

> Requires `DATABASE_URL=postgresql://genie:genie@localhost:5434/genie` in your `.env` (note port `5434` — the local-prod DB is mapped there to avoid conflicting with local-dev on `5432`).

### 3. Start the app

```bash
docker compose -f docker-compose.local-prod.yml up -d app
```

---

## Updating the app after source code changes

Rebuild and restart only the `app` container without touching the `db`:

```bash
docker compose -f docker-compose.local-prod.yml build app && docker compose -f docker-compose.local-prod.yml up -d app
```

Or as a one-liner with the build flag:

```bash
docker compose -f docker-compose.local-prod.yml up -d --build app
```

The `db` container is unaffected as only the `app` service is targeted.

---

## Viewing logs

```bash
docker compose -f docker-compose.local-prod.yml logs -f app
```

## Stopping

Stop the app only:

```bash
docker compose -f docker-compose.local-prod.yml stop app
```

Stop everything:

```bash
bun run local:prod:down
```

> **Never use `down -v`** — this removes the `db-data` named volume and wipes the database.
