# Keyhold

A self-hosted, end-to-end encrypted password manager — a replacement for Bitwarden that you run yourself.

- **Native apps** for Windows, macOS, Linux, Android and iOS from one codebase ([Tauri 2](https://v2.tauri.app)).
- **Zero-knowledge sync**: everything is encrypted on your devices before it leaves them. Your server only stores
  ciphertext and never sees your master password. See [docs/SECURITY.md](docs/SECURITY.md).
- **Works offline**: the encrypted vault is cached on each device; edits made offline sync when you reconnect.
- Logins, credit cards and secure notes, with custom fields, folders, favourites and password history.
- Built-in **TOTP authenticator** (2FA codes), **password / passphrase generator**.
- **Import from Bitwarden** (unencrypted `.json` export) and export to JSON.
- Devices list with remote sign-out, auto-lock, clipboard auto-clear, master password change.

## Repository layout

| Path            | What                                                                                |
| --------------- | ----------------------------------------------------------------------------------- |
| `packages/core` | Shared TypeScript: crypto, vault model, sync client, TOTP, generator, importer      |
| `apps/server`   | Sync server (Node 22 + Fastify + SQLite). Stores only encrypted blobs.              |
| `apps/app`      | The app: React UI + Tauri shell (`src-tauri/`) for desktop and mobile               |
| `deploy`        | Docker Compose with Caddy for automatic HTTPS, and a backup script                  |
| `deploy/tailscale` | Home-box setup: Tailscale for HTTPS, nightly backups to a second disk           |

## 1. Run the sync server

> Running it on a home machine that is already on your Tailscale network? Use
> [deploy/tailscale](deploy/tailscale/README.md) instead — no domain or open ports needed.

You need a machine reachable from all your devices (a small VPS, a home server, a NAS…) and a domain name.

```bash
cd deploy
cp .env.example .env        # set KEYHOLD_DOMAIN=vault.yourdomain.com
docker compose up -d --build
```

Caddy obtains a TLS certificate automatically. After you have created your account from the app, **close sign-ups**
so nobody else can register on your server:

```bash
sed -i 's/SIGNUPS=open/SIGNUPS=closed/' .env && docker compose up -d
```

**Back up** the server regularly with `deploy/backup.sh`. The backup contains only encrypted data, but you need it to
restore your vault if the server is lost (each device also keeps a full encrypted copy).

Server environment variables:

| Variable      | Default  | Meaning                                                         |
| ------------- | -------- | --------------------------------------------------------------- |
| `PORT`        | `8080`   | Listen port                                                     |
| `HOST`        | `0.0.0.0`| Listen address                                                  |
| `DATA_DIR`    | `./data` | Where `vault.db` lives                                          |
| `SIGNUPS`     | `open`   | `closed` disables new account registration                      |
| `TRUST_PROXY` | `false`  | Set `true` behind a reverse proxy so rate limiting sees real IPs |
| `LOG`         | on       | `off` disables request logs                                     |

Without Docker: `pnpm install && pnpm --filter @pm/server build && node apps/server/dist/server.js` (Node 22+),
behind any HTTPS reverse proxy.

> Always use HTTPS. Android and iOS refuse plain-HTTP servers by default, and on an untrusted network HTTP
> would expose your login token (though never your passwords — those are encrypted either way).

## 2. Build the apps

Prerequisites: Node 22+, pnpm 10, Rust (stable), plus the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
for your platform.

```bash
pnpm install
```

**Desktop** (builds an installer for the OS you run it on: `.msi`/`.exe`, `.dmg`/`.app`, `.deb`/`.rpm`/`.AppImage`):

```bash
pnpm tauri build
```

Output is in `apps/app/src-tauri/target/release/bundle/`. Pushing a tag like `v0.1.0` also builds installers for all
three desktop OSes in GitHub Actions (see `.github/workflows/release.yml`) and attaches them to a draft release.

**Android** (needs Android Studio, the SDK and NDK — see Tauri’s prerequisites):

```bash
pnpm tauri android init      # once
pnpm tauri android build --apk
```

Sign the APK before installing it (Tauri docs: *Distribute → Google Play → Signing*). For a quick try on your own
phone, `pnpm tauri android dev` runs it over USB.

**iOS** (needs a Mac with Xcode and an Apple developer account for installing on a device):

```bash
pnpm tauri ios init          # once
pnpm tauri ios build
```

## 3. Move from Bitwarden

1. In Bitwarden: **Tools → Export vault → File format: `.json`** (the unencrypted one).
2. In Keyhold: **Settings → Import → Choose file…**
3. Securely delete the export file — it contains every password in plain text.

Identities and SSH keys (types Keyhold doesn't have) are imported as secure notes with their fields, in
“Identities” / “SSH keys” folders. Attachments, Sends, and organization/collection sharing are not imported.

## Development

```bash
pnpm install
pnpm dev:server              # sync server on http://localhost:8080 (tsx watch)
pnpm tauri dev               # desktop app with hot reload
# or just the UI in a browser: pnpm dev:app  → http://localhost:1420
pnpm test                    # unit + end-to-end sync tests
pnpm smoke                   # UI smoke test: built app + throwaway Server in Chromium (Playwright)
pnpm typecheck
```

## Not (yet) included

Browser extension / autofill, passkeys, sharing between users, file attachments, emergency access, biometric
unlock. The core and sync protocol are designed so these can be added without changing the encryption format.
