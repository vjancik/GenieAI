# Docker Compose — Local Production

## First-time setup

### 1. Start the stack

Migrations run automatically before the app starts.

```bash
docker compose -f docker-compose.local.yml up -d --build
```

---

## Updating the app after source code changes

Rebuild and restart only the `app` container without touching the `db`:

```bash
docker compose -f docker-compose.local.yml up -d --build app
```

The `db` container is unaffected as only the `app` service is targeted.

---

## Viewing logs

```bash
docker compose -f docker-compose.local.yml logs -f app
```

## Stopping

Stop the app only:

```bash
docker compose -f docker-compose.local.yml stop app
```

Stop everything:

```bash
docker compose -f docker-compose.local.yml down
```

> **Never use `down -v`** — this removes the `db-data` named volume and wipes the database.
