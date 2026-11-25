import { ApiError, NetworkError, WrongPasswordError, estimateStrength } from "@pm/core";
import { type FormEvent, useState } from "react";
import { guessDeviceName } from "../lib/platform";
import { useSettings } from "../lib/settings";
import type { ErasedReason, Vault } from "../lib/useVault";
import { ErrorText, Field, Icon, PasswordInput } from "./ui";

function friendly(e: unknown): string {
  if (e instanceof NetworkError) return "Couldn’t reach the server. Check the URL and that the server is running.";
  if (e instanceof WrongPasswordError) return "Incorrect master password.";
  if (e instanceof ApiError) return e.message;
  if (e instanceof TypeError && /URL/i.test(e.message)) return "That server URL doesn’t look right.";
  return (e as Error)?.message ?? "Something went wrong";
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Icon name="lock" size={22} />
      </span>
      <span>Keyhold</span>
    </div>
  );
}

const MIN_MASTER = 12;

export function Welcome({ vault }: { vault: Vault }) {
  const settings = useSettings();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [serverUrl, setServerUrl] = useState(settings.lastServerUrl);
  const [email, setEmail] = useState(settings.lastEmail);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [deviceName, setDeviceName] = useState(guessDeviceName());
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const strength = estimateStrength(password);
  const registerBlocked =
    mode === "register" && (password.length < MIN_MASTER || password !== confirm || !ack || strength.label === "weak");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (registerBlocked) return;
    setBusy(true);
    setError(null);
    try {
      const creds = { serverUrl, email, password, deviceName: deviceName.trim() || guessDeviceName() };
      await (mode === "login" ? vault.login(creds) : vault.register(creds));
    } catch (err) {
      setError(friendly(err));
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <Brand />
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === "login"} onClick={() => setMode("login")}>
            Sign in
          </button>
          <button type="button" role="tab" aria-selected={mode === "register"} onClick={() => setMode("register")}>
            Create account
          </button>
        </div>

        <Field label="Server URL" hint="The address of your self-hosted Keyhold server.">
          <input
            type="url"
            required
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="https://vault.example.com"
            autoCapitalize="off"
            autoCorrect="off"
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoCapitalize="off"
          />
        </Field>
        <Field
          label="Master password"
          hint={
            mode === "register" && password ? (
              <span className={`strength s-${strength.label}`}>
                <span className="strength-bar" style={{ width: `${Math.min(100, strength.bits)}%` }} />
                {strength.label} · ~{strength.bits} bits
                {password.length < MIN_MASTER && ` · at least ${MIN_MASTER} characters`}
              </span>
            ) : undefined
          }
        >
          <PasswordInput
            value={password}
            onChange={setPassword}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </Field>
        {mode === "register" && (
          <>
            <Field label="Confirm master password" hint={confirm && confirm !== password ? "Passwords don’t match" : undefined}>
              <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" />
            </Field>
            <label className="check">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>
                I understand that <strong>my master password cannot be recovered</strong>. If I forget it, my vault is
                lost — not even the server owner can decrypt it.
              </span>
            </label>
          </>
        )}
        <details className="advanced">
          <summary>This device</summary>
          <Field label="Device name" hint="Shown in the devices list so you can sign it out remotely.">
            <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={100} />
          </Field>
        </details>

        <ErrorText error={error} />
        <button className="btn primary wide" disabled={busy || registerBlocked}>
          {busy ? "Deriving keys…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shown on the Unlock screen when Offline erase will fire in less than a day. */
function OfflineEraseWarning({ deadline }: { deadline: Date | null }) {
  if (!deadline) return null;
  const left = deadline.getTime() - Date.now();
  if (left >= DAY_MS) return null;
  const hours = Math.max(0, Math.ceil(left / 3_600_000));
  return (
    <p className="error" role="alert">
      Offline erase will erase this Device’s vault {hours <= 1 ? "within the hour" : `in about ${hours} hours`} unless it
      reaches the Server. Connect to the internet to keep it.
    </p>
  );
}

export function Unlock({ vault }: { vault: Vault }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await vault.unlock(password);
    } catch (err) {
      setError(friendly(err));
      setBusy(false);
      setPassword("");
    }
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <Brand />
        <p className="muted center">
          Vault locked · <strong>{vault.lockedEmail}</strong>
        </p>
        <OfflineEraseWarning deadline={vault.offlineEraseDeadline} />
        <Field label="Master password">
          <PasswordInput value={password} onChange={setPassword} autoFocus autoComplete="current-password" />
        </Field>
        <ErrorText error={error} />
        <button className="btn primary wide" disabled={busy || !password}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
        <button
          type="button"
          className="btn link"
          onClick={() => {
            if (confirm("Sign out and remove this device’s copy of the vault? Unsynced changes will be lost.")) {
              void vault.logout();
            }
          }}
        >
          Sign out of this device
        </button>
      </form>
    </div>
  );
}

/** Full-screen notice after a Sign out from another Device erased this Device's vault. */
export function ErasedNotice({ vault, reason }: { vault: Vault; reason: ErasedReason }) {
  const text =
    reason === "accountDeleted"
      ? {
          title: "Your Account was deleted",
          body: "The Account and everything it stored were permanently removed from the Server, and this Device’s copy of the vault was erased. Your other Devices erase theirs the next time they reach the Server.",
        }
      : reason === "offlineErase"
      ? {
          title: "This Device’s vault was erased by Offline erase",
          body: "It went longer than the chosen number of days without reaching the Server, so its copy of the vault and any unsynced changes were removed. Sign in again to use your vault here.",
        }
      : {
          title: "This Device was signed out and its vault erased",
          body: "It was signed out from another Device. Its copy of the vault has been removed. Sign in again to use your vault here.",
        };
  return (
    <div className="auth" role="alertdialog" aria-labelledby="erased-title">
      <div className="auth-card">
        <Brand />
        <h2 id="erased-title" className="center">
          {text.title}
        </h2>
        <p className="muted center">{text.body}</p>
        <button type="button" className="btn primary wide" autoFocus onClick={vault.dismissErasedNotice}>
          Continue
        </button>
      </div>
    </div>
  );
}
