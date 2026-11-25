# Keyhold on a home box with Tailscale

For a small always-on machine (e.g. a Dell Wyse 3040 running Debian) that is already on your tailnet.
No domain, no router changes: the Server listens only on `127.0.0.1`, and `tailscale serve` gives it an
`https://` address that only your tailnet can reach. Devices need Tailscale connected to sync (they still
work offline without it).

## Storage

| What                                   | Where                  | Size                                   |
| -------------------------------------- | ---------------------- | -------------------------------------- |
| Server image (Node.js + the Server)    | Docker (built-in disk) | ~310 MB                                |
| Build cache from the first build       | Docker (built-in disk) | a few hundred MB; free it with `docker builder prune` |
| Database                               | `KEYHOLD_DATA`         | under 1 MB per 1,000 Items             |
| Nightly backups                        | `BACKUP_DIR` (the HDD) | one database-sized file per night, `KEEP` of them |

Keep the database on the built-in storage and backups on the other disk, so one failing disk can't take both.

## Setup

Run these on the box as a user who can use `sudo` and Docker.

1. Get the code (the backup timer expects `/opt/password-manager`; edit `keyhold-backup.service` if you use another path):

   ```bash
   sudo git clone https://github.com/zZero111/Password-Manager /opt/password-manager
   ```

2. Configure and create the data folder (the Server runs as user id 1000 inside the container):

   ```bash
   cd /opt/password-manager/deploy/tailscale && sudo cp .env.example .env && sudo nano .env
   ```

   ```bash
   sudo mkdir -p /var/lib/keyhold && sudo chown 1000:1000 /var/lib/keyhold
   ```

3. Build and start the Server (the first build takes a while on a small CPU):

   ```bash
   sudo docker compose up -d --build
   ```

4. Give it HTTPS on your tailnet. Port 443 is often already used (e.g. by Navidrome), so use 8443 — Tailscale
   allows 443, 8443 and 10000. HTTPS certificates must be enabled for your tailnet.

   ```bash
   sudo tailscale serve --bg --https=8443 http://127.0.0.1:8080
   ```

   Your Server URL is `https://<machine-name>.<tailnet-name>.ts.net:8443` (shown by `tailscale serve status`).

5. In the app, **Create account** with that URL. Then close sign-ups: set `SIGNUPS=closed` in `.env` and run

   ```bash
   sudo docker compose up -d
   ```

6. Turn on nightly backups (03:30, catching up after downtime):

   ```bash
   sudo cp keyhold-backup.service keyhold-backup.timer /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now keyhold-backup.timer
   ```

   Run one now to check it works:

   ```bash
   sudo systemctl start keyhold-backup.service && journalctl -u keyhold-backup.service -n 5
   ```

## Restoring

**Prefer a Device if you can.** A backup is a snapshot: if any Device was used after it was taken, those changes are
not in it, and Devices don't re-upload changes they've already synced. So if a Device has your latest vault, set up a
fresh Server (steps 2–5) and use **Settings → Move to a new Server** on that Device instead.

Restore from a backup only when no Device has a newer copy. Stop the Server, copy the backup over the database, start
it again:

```bash
sudo docker compose down && sudo cp /mnt/hdd/backups/keyhold/keyhold-YYYYMMDD-HHMMSS.db /var/lib/keyhold/vault.db && sudo rm -f /var/lib/keyhold/vault.db-wal /var/lib/keyhold/vault.db-shm && sudo chown 1000:1000 /var/lib/keyhold/vault.db && sudo docker compose up -d
```

## Updating

```bash
cd /opt/password-manager && sudo git pull && cd deploy/tailscale && sudo docker compose up -d --build && sudo docker builder prune -f
```
