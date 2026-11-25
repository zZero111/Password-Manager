#!/usr/bin/env bash
# Consistent online backup of the Keyhold database (it only contains encrypted data,
# but the backup is still needed to restore your vault if the server is lost).
set -euo pipefail
out="${1:-keyhold-backup-$(date +%Y%m%d-%H%M%S).db}"
docker compose exec -T keyhold node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/vault.db');
db.exec(\"VACUUM INTO '/data/backup.db'\");
" 2>/dev/null
docker compose cp keyhold:/data/backup.db "$out"
docker compose exec -T keyhold rm -f /data/backup.db
echo "Backup written to $out"
