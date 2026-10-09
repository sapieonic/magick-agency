#!/bin/sh
# Ported from core `docker/entrypoint.sh:1-8`@4850d1d9. PORT NOTE (magick-agency): the
# migration step (core :5) is `dist/migrate.js` (node-pg-migrate's runner with the server's
# own Postgres TLS settings) instead of the node-pg-migrate CLI, which would take
# TLS from DATABASE_URL, where Q1 refuses it. See apps/server/src/migrate.ts.
set -e

echo "Running database migrations..."
node dist/migrate.js migrations
echo "Migrations complete."

exec node --max-old-space-size=4096 --max-http-header-size=16384 dist/index.js
