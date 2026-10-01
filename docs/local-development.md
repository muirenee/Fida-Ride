# Fida Ride Local Development Environment

## Prerequisites

- Docker Engine 24+ or Docker Desktop
- Docker Compose v2
- Git
- OpenSSL (recommended for generating local secrets)
- Optional database client: DBeaver, TablePlus, DataGrip, or pgAdmin

## 1. Clone and configure

```bash
git clone https://github.com/muirenee/Fida-Ride.git
cd Fida-Ride
cp .env.example .env
```

Generate two independent local secrets:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Paste the first value into `POSTGRES_PASSWORD` and the second into `REDIS_PASSWORD` in `.env`.

Do not commit `.env`. It is ignored by `.gitignore`.

## 2. Validate the Compose configuration

```bash
docker compose config --quiet
```

A successful command exits without output.

## 3. Start the stack

```bash
docker compose up -d
```

Check service health:

```bash
docker compose ps
```

Expected services:

- `fida-ride-postgres`
- `fida-ride-redis`
- `fida-ride-go-telemetry`
- `fida-ride-nestjs-core`

The Go and NestJS containers are HTTP placeholder stubs until their application source trees are added.

## 4. Verify PostgreSQL and PostGIS

Check the extensions:

```bash
docker compose exec postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT extname, extversion FROM pg_extension WHERE extname IN ('\''postgis'\'', '\''uuid-ossp'\'') ORDER BY extname;"'
```

Check the PostGIS build:

```bash
docker compose exec postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT PostGIS_Full_Version();"'
```

Verify the schemas:

```bash
docker compose exec postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('\''core'\'', '\''telemetry'\'') ORDER BY schema_name;"'
```

Run a spatial-function smoke test:

```bash
docker compose exec postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT ST_AsText(ST_SetSRID(ST_MakePoint(30.0619, -1.9441), 4326)) AS kigali_point;"'
```

A valid result should contain:

```text
POINT(30.0619 -1.9441)
```

## 5. Verify Redis authentication and geospatial operations

Ping Redis:

```bash
docker compose exec redis sh -lc \
  'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli PING'
```

Expected:

```text
PONG
```

Insert two development driver positions:

```bash
docker compose exec redis sh -lc \
  'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli GEOADD dev:drivers 30.0619 -1.9441 driver-1 30.0680 -1.9500 driver-2'
```

Query nearby drivers:

```bash
docker compose exec redis sh -lc \
  'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli GEOSEARCH dev:drivers FROMLONLAT 30.0619 -1.9441 BYRADIUS 5 KM ASC WITHDIST'
```

Redis persistence is intentionally disabled for this local transient-telemetry workload. Restarting the Redis container discards cached data.

## 6. Verify service stubs

Go telemetry placeholder:

```bash
curl http://127.0.0.1:8080/
```

Expected:

```json
{"service":"go-telemetry-service","status":"stub"}
```

NestJS core placeholder:

```bash
curl http://127.0.0.1:3000/
```

Expected:

```json
{"service":"nestjs-core-api","status":"stub"}
```

## 7. Connect with DBeaver or TablePlus

Create a PostgreSQL connection with:

| Setting | Value |
|---|---|
| Host | `127.0.0.1` |
| Port | value of `POSTGRES_PORT` in `.env` (default `5432`) |
| Database | value of `POSTGRES_DB` (default `fida_ride`) |
| User | value of `POSTGRES_USER` (default `fida_ride`) |
| Password | value of `POSTGRES_PASSWORD` |
| SSL | Disabled for local-only development |

After connecting, confirm the `core`, `telemetry`, and `public` schemas are visible.

Run:

```sql
SELECT PostGIS_Full_Version();

SELECT extname, extversion
FROM pg_extension
WHERE extname IN ('postgis', 'uuid-ossp');

SELECT ST_AsText(
  ST_SetSRID(ST_MakePoint(30.0619, -1.9441), 4326)
);
```

## 8. Logs and diagnostics

All services:

```bash
docker compose logs -f
```

PostgreSQL only:

```bash
docker compose logs -f postgres
```

Redis only:

```bash
docker compose logs -f redis
```

## 9. Stop and restart

Stop containers while preserving PostgreSQL data:

```bash
docker compose down
```

Start again:

```bash
docker compose up -d
```

PostgreSQL persists under `./.data/postgres`.

Redis is intentionally ephemeral.

## 10. Re-run database initialization from scratch

`init-db.sql` is executed only when the PostgreSQL data directory is empty.

For local development only, to completely reset the database:

```bash
docker compose down
rm -rf ./.data/postgres
docker compose up -d
```

Do not use that reset command against any environment containing data that must be retained.

## Security characteristics of the local stack

- PostgreSQL, Redis, NestJS, and Go host ports bind to `127.0.0.1`, not all host interfaces.
- PostgreSQL and Redis require passwords supplied through an untracked `.env` file.
- No real secrets are stored in the repository.
- Redis AOF/RDB persistence is disabled intentionally for maximum local transient-data performance.
- Containers use `no-new-privileges` where applicable.
- Docker JSON log rotation prevents unbounded local log growth.
- PostgreSQL uses a host-local bind mount so database state survives container replacement.
