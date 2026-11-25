#!/usr/bin/env bash
# Nightly backup of the Keyhold database to BACKUP_DIR, keeping the newest KEEP copies.
# The database only holds encrypted data, but you need it (or any Device's copy, via
# Move) to rebuild the Server if this box or its storage dies.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
data=${KEYHOLD_DATA:-/var/lib/keyhold}
dir=${BACKUP_DIR:?Set BACKUP_DIR in .env}
keep=${KEEP:-30}

mkdir -p "$dir"
rm -f "$data/backup.db"
# VACUUM INTO makes a consistent copy while the Server keeps running.
docker compose exec -T keyhold node --disable-warning=ExperimentalWarning -e \
  "new (require('node:sqlite').DatabaseSync)('/data/vault.db').exec(\"VACUUM INTO '/data/backup.db'\")"
test -s "$data/backup.db" || { echo "backup failed: empty file" >&2; exit 1; }

out="$dir/keyhold-$(date +%Y%m%d-%H%M%S).db"
mv "$data/backup.db" "$out"
ls -1t "$dir"/keyhold-*.db | tail -n +"$((keep + 1))" | xargs -r rm --
echo "Backup written to $out ($(du -h "$out" | cut -f1)); keeping newest $keep"
