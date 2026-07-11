#!/usr/bin/env bash
#
# Run the adapter storage conformance suites against REAL backends in Docker.
#
# Spins up Redis + DynamoDB Local + Postgres, installs the live-test clients
# (not saved), runs:
#   - adapter-node     → live Redis conformance (real Lua EVAL / SET NX)
#   - adapter-aws      → live DynamoDB conformance (real conditional writes / CAS)
#   - adapter-aws      → live DynamoDB DataStore<T> conformance (GSI Query, COUNT, paging)
#   - adapter-aws      → real hono/aws-lambda raw-body decode (ARCH-08, no service)
#   - adapter-postgres → live Postgres DataStore<T> conformance (JSONB CAS / WHERE / COUNT)
#   - adapter-cf       → live miniflare conformance (real KV + Durable Object; in-process)
# then tears the containers down.
#
# The in-process fakes already prove adapter LOGIC + the atomicity contract in
# the normal suites; this proves the REAL backend honors that contract.
#
# Requires: docker, node. Usage: ./scripts/verify-live.sh
# (miniflare runs in-process, so adapter-cf needs no container.)

set -euo pipefail
cd "$(dirname "$0")/.."

REDIS_NAME=shono-live-redis
DDB_NAME=shono-live-ddb
PG_NAME=shono-live-pg

cleanup() { docker rm -f "$REDIS_NAME" "$DDB_NAME" "$PG_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "==> Building @smithy-hono/security-core + @smithy-hono/data-core (adapters import their dist)"
npm -w @smithy-hono/security-core run build >/dev/null
npm -w @smithy-hono/data-core run build >/dev/null

echo "==> Installing live-test clients (ioredis, @aws-sdk/*, pg, miniflare) — --no-save"
npm install ioredis@^5 @aws-sdk/client-dynamodb@^3 @aws-sdk/lib-dynamodb@^3 pg@^8 miniflare@^3 \
  --no-save --no-package-lock --workspaces=false --ignore-scripts >/dev/null

echo "==> Starting Redis + DynamoDB Local + Postgres"
docker run --rm -d --name "$REDIS_NAME" -p 6379:6379 redis:7-alpine >/dev/null
docker run --rm -d --name "$DDB_NAME" -p 8000:8000 amazon/dynamodb-local >/dev/null
docker run --rm -d --name "$PG_NAME" -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=shono postgres:16-alpine >/dev/null
sleep 4

echo "==> adapter-node: live Redis conformance"
( cd packages/adapter-node && REDIS_URL=redis://localhost:6379 npx vitest run src/live.redis.test.ts )

echo "==> adapter-aws: live DynamoDB conformance"
( cd packages/adapter-aws && DYNAMODB_ENDPOINT=http://localhost:8000 npx vitest run src/live.dynamodb.test.ts )

echo "==> adapter-aws: live DynamoDB DataStore<T> conformance (Plan 13 P6)"
( cd packages/adapter-aws && DYNAMODB_ENDPOINT=http://localhost:8000 npx vitest run src/live.dynamodb.dataStore.test.ts )

echo "==> adapter-aws: real hono/aws-lambda raw-body decode (ARCH-08)"
( cd packages/adapter-aws && npx vitest run src/lambdaRawBody.real.test.ts )

echo "==> adapter-postgres: live Postgres DataStore<T> conformance (Plan 13 D7)"
( cd packages/adapter-postgres && DATABASE_URL=postgres://postgres:postgres@localhost:5432/shono npx vitest run src/live.postgres.dataStore.test.ts )

echo "==> adapter-cf: live miniflare conformance (real KV + Durable Object)"
( cd packages/adapter-cf && CF_LIVE=1 npx vitest run src/live.miniflare.test.ts )

echo "==> All live conformance suites passed against real backends."
