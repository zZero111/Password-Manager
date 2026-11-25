# Security design

Keyhold is **zero-knowledge**: the sync server, and anyone who compromises it, cannot read your vault. Encryption and
decryption happen only on your devices, in `packages/core`.

## Keys

```
master password ──Argon2id(salt, m=64 MiB, t=3, p=4)──▶ master key        (never stored, never sent)
     master key ──HKDF-SHA256 "pm-enc-v1"────────────▶ key-encryption key (KEK)
     master key ──HKDF-SHA256 "pm-auth-v1"───────────▶ auth key           (sent to log in)
     vault key  = 32 random bytes, encrypted with the KEK ─▶ "protected key" (stored on server + devices)
     each item  = AES-256-GCM(vault key, JSON, AAD = "pm-item:<id>")
```

- The **salt** is 16 random bytes per account. The password is Unicode-normalised (NFKC) first.
- The **auth key** is a separate HKDF output, so knowing it reveals nothing about the KEK. The server stores only
  `scrypt(auth key)`, so a stolen database can't be replayed to log in.
- **Every item** is encrypted separately with a fresh 96-bit IV. The item id is bound in as additional authenticated
  data, so a malicious server can't swap ciphertexts between items without detection (the app shows them as
  “couldn't be decrypted”).
- **Changing the master password** re-encrypts only the vault key under a new KEK with a new salt; items are untouched.
  Every other device is signed out and must sign in with the new password.

## What the server sees

| Stored on server                         | Sensitive?                                           |
| ---------------------------------------- | ---------------------------------------------------- |
| Email, salt, KDF parameters              | Not secret                                           |
| scrypt hash of the auth key              | Can't be used to log in or decrypt                   |
| Protected (encrypted) vault key          | Useless without the master password                  |
| Encrypted items + revision numbers       | Reveals the **number** of items and roughly their size, and when they change |
| Device names, last-seen times            | Metadata                                             |

The server **cannot** see item names, usernames, passwords, URLs, notes or folder names.

## Protections against a malicious server

- **KDF downgrade**: KDF parameters come from the server at login. The client refuses anything below Argon2id
  m=19 MiB, t=2 (OWASP minimum), so a server can't make your password cheap to crack.
- **Account enumeration**: `prelogin` returns a deterministic fake salt for unknown emails.
- **Tampering**: AES-GCM authentication and per-item AAD detect modified or swapped ciphertexts.
- **Rollback**: a server *can* withhold recent changes or serve an older copy of an item. Keyhold does not currently
  detect this (Bitwarden doesn't either).

## On the device

- The vault key exists only in memory while unlocked, as a non-extractable WebCrypto key. Locking discards it.
- The on-disk copy (IndexedDB in the app's private storage) is the same ciphertext the server holds, plus the login
  token. Unlocking works offline by decrypting the stored protected key.
- Auto-lock after inactivity (default 15 min), optional lock when backgrounded, clipboard cleared 30 s after copying.
- The Tauri shell has a strict CSP (no remote scripts; WASM allowed for Argon2) and only the clipboard, save-dialog and
  write-file permissions.

## Server hardening

- Bearer-token auth (no cookies, so no CSRF). Tokens are 256-bit random values stored as SHA-256 hashes; each device
  has its own and can be revoked from any other device.
- Login rate limit: 10 failures per IP+email per 15 minutes. Unknown emails take the same time as wrong passwords.
- Strict JSON-schema validation; item data must look like ciphertext (`1.<iv>.<ct>`) and is size-limited.
- Sign-ups can be closed (`SIGNUPS=closed`). Run it behind HTTPS (the provided Caddy setup does this).

## Recovery

There is **no password reset**. If you forget your master password, the vault cannot be decrypted by anyone. Keep an
offline export (Settings → Export) somewhere safe if that worries you, and use a memorable passphrase.

## Reporting

This is a personal project and has not had an external audit. Open an issue for anything you find.
