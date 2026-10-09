#!/bin/sh
# Migrate, then start the server in this process (exec, so it receives SIGTERM).
# Migrations run through `dist/migrate.js` (node-pg-migrate's runner with the
# server's own Postgres TLS settings), not the node-pg-migrate CLI, which would take
# TLS from DATABASE_URL, where decision Q1 refuses it. See apps/server/src/migrate.ts.
set -e

echo "Running database migrations..."
node dist/migrate.js migrations
echo "Migrations complete."

exec node --max-old-space-size=4096 --max-http-header-size=16384 dist/index.js
