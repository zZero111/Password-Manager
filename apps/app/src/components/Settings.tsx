import { type Device, type VaultItemData, WrongPasswordError, estimateStrength, importBitwardenJson } from "@pm/core";
import { type FormEvent, useEffect, useState } from "react";
import { saveTextFile } from "../lib/files";
import { updateSettings, useSettings } from "../lib/settings";
import type { Vault } from "../lib/useVault";
import { ErrorText, Field, Icon, PasswordInput } from "./ui";

interface KeyholdExport {
  format: "keyhold";
  version: 1;
  exportedAt: string;
  items: VaultItemData[];
}

function parseImport(text: string): { items: VaultItemData[]; warnings: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("This file is not valid JSON.");
  }
  if ((parsed as KeyholdExport)?.format === "keyhold") return { items: (parsed as KeyholdExport).items, warnings: [] };
  return importBitwardenJson(text);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function ago(ts: number | null) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(ts).toLocaleString();
}

export function SettingsPage({ vault, onBack }: { vault: Vault; onBack: () => void }) {
  const settings = useSettings();
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);

  async function onImportFile(file: File) {
    setImportMsg(null);
    setImportErr(null);
    try {
      const { items, warnings } = parseImport(await file.text());
      if (!items.length) throw new Error("No items found in this file.");
      if (!confirm(`Import ${items.length} items into your vault?`)) return;
      await vault.importItems(items);
      setImportMsg(
        `Imported ${items.length} items.${warnings.length ? ` ${warnings.length} note(s): ${warnings.join(" ")}` : ""} ` +
          "Now securely delete the export file — it contains your passwords unencrypted.",
      );
    } catch (e) {
      setImportErr((e as Error).message);
    }
  }

  async function onExport() {
    if (!confirm("The export file will contain ALL your passwords unencrypted. Only save it somewhere safe and delete it when done. Continue?")) return;
    const data: KeyholdExport = {
      format: "keyhold",
      version: 1,
      exportedAt: new Date().toISOString(),
      items: vault.items.map(({ id: _id, ...rest }) => rest),
    };
    await saveTextFile(`keyhold-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
  }

  return (
    <div className="detail settings">
      <header className="detail-head">
        <button type="button" className="icon-btn only-narrow" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
        <div className="detail-title">
          <h2>Settings</h2>
        </div>
      </header>
      <div className="detail-body">
        <Section title="Account & sync">
          <p>
            Signed in as <strong>{vault.lockedEmail}</strong>
            <br />
            <span className="muted small">{vault.serverUrl}</span>
          </p>
          <p className="muted small">
            Last synced {ago(vault.sync.lastSyncAt)}
            {vault.sync.pending > 0 && ` · ${vault.sync.pending} change(s) waiting to upload`}
          </p>
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => void vault.syncNow()}>
              <Icon name="refresh" size={16} /> Sync now
            </button>
            <button type="button" className="btn" onClick={vault.lock}>
              <Icon name="lock" size={16} /> Lock
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() =>
                confirm(
                  vault.sync.pending
                    ? `You have ${vault.sync.pending} unsynced change(s) that will be LOST. Sign out anyway?`
                    : "Sign out and remove the vault from this device?",
                ) && void vault.logout()
              }
            >
              Sign out
            </button>
          </div>
        </Section>

        <Section title="Security">
          <Field label="Lock after inactivity">
            <select value={settings.autoLockMinutes} onChange={(e) => updateSettings({ autoLockMinutes: +e.target.value })}>
              {[1, 5, 15, 30, 60, 240].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} minute${m > 1 ? "s" : ""}` : `${m / 60} hour${m > 60 ? "s" : ""}`}
                </option>
              ))}
              <option value={0}>Never</option>
            </select>
          </Field>
          <Field label="Clear copied passwords from clipboard after">
            <select value={settings.clipboardClearSeconds} onChange={(e) => updateSettings({ clipboardClearSeconds: +e.target.value })}>
              {[10, 30, 60, 120].map((s) => (
                <option key={s} value={s}>
                  {s} seconds
                </option>
              ))}
              <option value={0}>Never</option>
            </select>
          </Field>
          <label className="check">
            <input type="checkbox" checked={settings.lockOnHide} onChange={(e) => updateSettings({ lockOnHide: e.target.checked })} />
            <span>Lock when the app is minimised or sent to the background</span>
          </label>
        </Section>

        <ChangePassword vault={vault} />
        <Devices vault={vault} />

        <Section title="Import">
          <p className="muted small">
            From Bitwarden: <em>Tools → Export vault → File format “.json”</em> (not the encrypted one). Keyhold exports can
            also be imported here.
          </p>
          <label className="btn file-btn">
            Choose file…
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void onImportFile(f);
              }}
            />
          </label>
          {importMsg && <p className="success">{importMsg}</p>}
          <ErrorText error={importErr} />
        </Section>

        <Section title="Export">
          <p className="muted small">Download every item as unencrypted JSON, for backups or moving to another password manager.</p>
          <button type="button" className="btn" onClick={() => void onExport()}>
            Export vault…
          </button>
        </Section>
      </div>
    </div>
  );
}

function ChangePassword({ vault }: { vault: Vault }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const strength = estimateStrength(next);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next.length < 12 || strength.label === "weak") return setError("Choose a stronger password (12+ characters).");
    if (next !== confirmPw) return setError("New passwords don’t match.");
    setBusy(true);
    setError(null);
    try {
      await vault.changePassword(current, next);
      setDone(true);
      setCurrent("");
      setNext("");
      setConfirmPw("");
    } catch (err) {
      setError(err instanceof WrongPasswordError ? "Current master password is incorrect." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Change master password">
      <form onSubmit={submit} className="stack">
        <Field label="Current master password">
          <PasswordInput value={current} onChange={setCurrent} autoComplete="current-password" />
        </Field>
        <Field label="New master password" hint={next ? `${strength.label} · ~${strength.bits} bits` : undefined}>
          <PasswordInput value={next} onChange={setNext} autoComplete="new-password" />
        </Field>
        <Field label="Confirm new master password">
          <PasswordInput value={confirmPw} onChange={setConfirmPw} autoComplete="new-password" />
        </Field>
        <p className="muted small">Your other Devices will be Disconnected and need the new password to sign in again.</p>
        <ErrorText error={error} />
        {done && <p className="success">Master password changed.</p>}
        <button className="btn" disabled={busy || !current || !next}>
          {busy ? "Changing…" : "Change master password"}
        </button>
      </form>
    </Section>
  );
}

function Devices({ vault }: { vault: Vault }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    vault.session
      ?.devices()
      .then(setDevices)
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Section title="Signed-in devices">
      <ErrorText error={error} />
      {devices?.map((d) => (
        <div className="device" key={d.id}>
          <div>
            <strong>{d.name}</strong> {d.current && <span className="badge">This device</span>}
            <div className="muted small">Last active {new Date(d.lastSeenAt).toLocaleString()}</div>
          </div>
          {!d.current && (
            <button
              type="button"
              className="btn small"
              onClick={async () => {
                if (!confirm(`Sign out “${d.name}”?`)) return;
                await vault.session?.revokeDevice(d.id);
                await load();
              }}
            >
              Sign out
            </button>
          )}
        </div>
      ))}
    </Section>
  );
}
