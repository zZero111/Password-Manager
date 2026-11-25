import { type TotpCode, parseTotp, totpCode } from "@pm/core";
import { type ReactNode, useEffect, useId, useState } from "react";
import { copySecret } from "../lib/clipboard";

// ── Icons (inline SVG, inherit currentColor) ──────────────────────────

const paths = {
  copy: "M9 9h10v10H9zM5 15V5h10",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2",
  plus: "M12 5v14M5 12h14",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm10 3-5-5",
  star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9Z",
  key: "M15 7a4 4 0 1 1-3.9 4.9L4 19v2h3v-2h2v-2h2l1.1-1.1A4 4 0 0 1 15 7Zm1 2h.01",
  note: "M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7",
  card: "M3 6h18v12H3zM3 10h18M7 15h4",
  folder: "M3 6h6l2 2h10v11H3z",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2.2-1.3L14.4 3h-4l-.4 2.4a7.5 7.5 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2.2 1.3l.4 2.4h4l.4-2.4a7.5 7.5 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3Z",
  dice: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm3.5 4.5h.01M15.5 15.5h.01M12 12h.01M15.5 7.5h.01M8.5 15.5h.01",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  refresh: "M20 11a8 8 0 0 0-14.7-4.4L4 8M4 4v4h4M4 13a8 8 0 0 0 14.7 4.4L20 16m0 4v-4h-4",
  back: "M15 18l-6-6 6-6",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  check: "M5 12l5 5L20 7",
  x: "M6 6l12 12M18 6 6 18",
};
export type IconName = keyof typeof paths;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  active,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button type="button" className={`icon-btn${active ? " active" : ""}`} onClick={onClick} title={label} aria-label={label}>
      <Icon name={icon} />
    </button>
  );
}

// ── Copy ──────────────────────────────────────────────────────────────

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className={`icon-btn${done ? " ok" : ""}`}
      title={label}
      aria-label={label}
      onClick={async () => {
        await copySecret(value);
        setDone(true);
      }}
    >
      <Icon name={done ? "check" : "copy"} />
    </button>
  );
}

// ── Form fields ───────────────────────────────────────────────────────

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function PasswordInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  autoComplete = "off",
  extra,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  autoComplete?: string;
  extra?: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="input-row">
      <input
        type={shown ? "text" : "password"}
        className="mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <IconButton icon={shown ? "eyeOff" : "eye"} label={shown ? "Hide" : "Show"} onClick={() => setShown(!shown)} />
      {extra}
    </div>
  );
}

// ── Read-only value row (item view) ───────────────────────────────────

export function ValueRow({
  label,
  value,
  secret,
  mono,
  href,
}: {
  label: string;
  value: string;
  secret?: boolean;
  mono?: boolean;
  href?: string;
}) {
  const [shown, setShown] = useState(false);
  const id = useId();
  if (!value) return null;
  return (
    <div className="value-row">
      <div className="value-main">
        <span className="field-label" id={id}>
          {label}
        </span>
        <span className={`value${mono || secret ? " mono" : ""}`} aria-labelledby={id}>
          {secret && !shown ? "••••••••••••" : value}
        </span>
      </div>
      <div className="value-actions">
        {secret && <IconButton icon={shown ? "eyeOff" : "eye"} label={shown ? "Hide" : "Reveal"} onClick={() => setShown(!shown)} />}
        {href && (
          <a className="icon-btn" href={href} target="_blank" rel="noreferrer noopener" title="Open" aria-label="Open">
            <Icon name="external" />
          </a>
        )}
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

// ── TOTP ──────────────────────────────────────────────────────────────

export function TotpRow({ uri }: { uri: string }) {
  const [code, setCode] = useState<TotpCode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let params: ReturnType<typeof parseTotp>;
    try {
      params = parseTotp(uri);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setError(null);
    let alive = true;
    const tick = () => totpCode(params).then((c) => alive && setCode(c));
    void tick();
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [uri]);

  if (error) {
    return (
      <div className="value-row">
        <div className="value-main">
          <span className="field-label">Verification code</span>
          <span className="value muted">Can’t generate codes: {error}</span>
        </div>
      </div>
    );
  }
  if (!code) return null;
  const pretty = code.code.length === 6 ? `${code.code.slice(0, 3)} ${code.code.slice(3)}` : code.code;
  return (
    <div className="value-row">
      <div className="value-main">
        <span className="field-label">Verification code (TOTP)</span>
        <span className="value mono totp">
          {pretty}
          <span className={`totp-timer${code.remaining <= 5 ? " low" : ""}`} aria-label={`${code.remaining} seconds left`}>
            <svg viewBox="0 0 36 36" width="22" height="22" aria-hidden="true">
              <circle cx="18" cy="18" r="15" className="track" />
              <circle
                cx="18"
                cy="18"
                r="15"
                className="arc"
                strokeDasharray={`${(code.remaining / code.period) * 94.2} 94.2`}
              />
            </svg>
            {code.remaining}
          </span>
        </span>
      </div>
      <div className="value-actions">
        <CopyButton value={code.code} label="Copy code" />
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}
