import {
  DEFAULT_PASSPHRASE_OPTIONS,
  DEFAULT_PASSWORD_OPTIONS,
  type PassphraseOptions,
  type PasswordOptions,
  generatePassphrase,
  generatePassword,
  passphraseEntropy,
  passwordEntropy,
} from "@pm/core";
import { useCallback, useEffect, useState } from "react";
import { CopyButton, IconButton } from "./ui";

const KEY = "keyhold.generator";

interface Prefs {
  mode: "password" | "passphrase";
  password: PasswordOptions;
  passphrase: PassphraseOptions;
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    return {
      mode: p.mode ?? "password",
      password: { ...DEFAULT_PASSWORD_OPTIONS, ...p.password },
      passphrase: { ...DEFAULT_PASSPHRASE_OPTIONS, ...p.passphrase },
    };
  } catch {
    return { mode: "password", password: DEFAULT_PASSWORD_OPTIONS, passphrase: DEFAULT_PASSPHRASE_OPTIONS };
  }
}

export function Generator({ onUse }: { onUse?: (value: string) => void }) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const regenerate = useCallback(() => {
    try {
      setValue(prefs.mode === "password" ? generatePassword(prefs.password) : generatePassphrase(prefs.passphrase));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [prefs]);

  useEffect(() => {
    regenerate();
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
  }, [prefs, regenerate]);

  const pw = prefs.password;
  const pp = prefs.passphrase;
  const setPw = (patch: Partial<PasswordOptions>) => setPrefs({ ...prefs, password: { ...pw, ...patch } });
  const setPp = (patch: Partial<PassphraseOptions>) => setPrefs({ ...prefs, passphrase: { ...pp, ...patch } });
  const bits = prefs.mode === "password" ? passwordEntropy(pw) : passphraseEntropy(pp);

  return (
    <div className="generator">
      <div className="gen-output">
        <span className="mono gen-value" aria-live="polite">
          {error ?? value}
        </span>
        <div className="value-actions">
          <IconButton icon="refresh" label="Regenerate" onClick={regenerate} />
          <CopyButton value={value} />
        </div>
      </div>
      <p className="muted small">≈ {bits} bits of entropy</p>

      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={prefs.mode === "password"} onClick={() => setPrefs({ ...prefs, mode: "password" })}>
          Password
        </button>
        <button type="button" role="tab" aria-selected={prefs.mode === "passphrase"} onClick={() => setPrefs({ ...prefs, mode: "passphrase" })}>
          Passphrase
        </button>
      </div>

      {prefs.mode === "password" ? (
        <div className="gen-options">
          <label className="slider">
            <span>
              Length <strong>{pw.length}</strong>
            </span>
            <input type="range" min={8} max={64} value={pw.length} onChange={(e) => setPw({ length: +e.target.value })} />
          </label>
          {(
            [
              ["uppercase", "A–Z"],
              ["lowercase", "a–z"],
              ["digits", "0–9"],
              ["symbols", "!@#$%"],
              ["avoidAmbiguous", "Avoid look-alikes (l, 1, O, 0)"],
            ] as const
          ).map(([k, label]) => (
            <label className="check" key={k}>
              <input type="checkbox" checked={pw[k]} onChange={(e) => setPw({ [k]: e.target.checked })} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      ) : (
        <div className="gen-options">
          <label className="slider">
            <span>
              Words <strong>{pp.words}</strong>
            </span>
            <input type="range" min={3} max={12} value={pp.words} onChange={(e) => setPp({ words: +e.target.value })} />
          </label>
          <label className="field inline">
            <span className="field-label">Separator</span>
            <input value={pp.separator} maxLength={3} onChange={(e) => setPp({ separator: e.target.value })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={pp.capitalize} onChange={(e) => setPp({ capitalize: e.target.checked })} />
            <span>Capitalise words</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={pp.includeNumber} onChange={(e) => setPp({ includeNumber: e.target.checked })} />
            <span>Include a number</span>
          </label>
        </div>
      )}

      {onUse && (
        <button type="button" className="btn primary wide" disabled={!!error} onClick={() => onUse(value)}>
          Use this password
        </button>
      )}
    </div>
  );
}
