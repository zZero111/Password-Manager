import {
  type ItemType,
  type VaultItem,
  type VaultItemData,
  emptyCard,
  emptyLogin,
  parseTotp,
  trashDaysLeft,
} from "@pm/core";
import { type FormEvent, useState } from "react";
import { Generator } from "./Generator";
import { ErrorText, Field, Icon, IconButton, type IconName, Modal, PasswordInput, TotpRow, ValueRow } from "./ui";

export const TYPE_META: Record<ItemType, { label: string; icon: IconName }> = {
  login: { label: "Login", icon: "key" },
  card: { label: "Card", icon: "card" },
  note: { label: "Secure note", icon: "note" },
};

/** Only allow http(s) links to be opened from the vault. */
function safeHref(uri: string): string | undefined {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(uri) ? uri : `https://${uri}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function fmt(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function daysLeftLabel(item: VaultItemData) {
  const n = trashDaysLeft(item);
  return n === 0 ? "deleted permanently at next sync" : `${n} ${n === 1 ? "day" : "days"} left`;
}

// ── View ──────────────────────────────────────────────────────────────

export function ItemView({
  item,
  onEdit,
  onDelete,
  onToggleFavorite,
  onBack,
  trash,
}: {
  item: VaultItem;
  onEdit: () => void;
  onDelete: () => void;
  onToggleFavorite: () => void;
  onBack: () => void;
  /** Set for a Trash Item: shown read-only, with Restore and Delete permanently instead of Edit and Delete. */
  trash?: { onRestore: () => void; onPurge: () => void };
}) {
  const [showHistory, setShowHistory] = useState(false);
  const { login, card } = item;
  return (
    <div className="detail">
      <header className="detail-head">
        <button type="button" className="icon-btn only-narrow" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
        <span className="item-icon">
          <Icon name={TYPE_META[item.type].icon} />
        </span>
        <div className="detail-title">
          <h2>{item.name}</h2>
          <span className="muted small">
            {TYPE_META[item.type].label}
            {item.folder && ` · ${item.folder}`}
          </span>
        </div>
        {trash ? (
          <button type="button" className="btn" onClick={trash.onRestore}>
            <Icon name="refresh" /> Restore
          </button>
        ) : (
          <>
            <IconButton
              icon="star"
              label={item.favorite ? "Remove from favourites" : "Add to favourites"}
              active={item.favorite}
              onClick={onToggleFavorite}
            />
            <button type="button" className="btn" onClick={onEdit}>
              Edit
            </button>
          </>
        )}
      </header>

      <div className="detail-body">
        {login && (
          <section className="card-section">
            <ValueRow label="Username" value={login.username} />
            <ValueRow label="Password" value={login.password} secret />
            {login.totp && !trash && <TotpRow uri={login.totp} />}
          </section>
        )}
        {login && login.uris.length > 0 && (
          <section className="card-section">
            {login.uris.map((u, i) => (
              <ValueRow key={i} label={i === 0 ? "Website" : `Website ${i + 1}`} value={u} href={trash ? undefined : safeHref(u)} />
            ))}
          </section>
        )}
        {card && (
          <section className="card-section">
            <ValueRow label="Cardholder name" value={card.cardholderName} />
            <ValueRow label="Brand" value={card.brand} />
            <ValueRow label="Number" value={card.number} secret mono />
            <ValueRow
              label="Expiry"
              value={card.expMonth || card.expYear ? `${card.expMonth.padStart(2, "0")}/${card.expYear}` : ""}
            />
            <ValueRow label="Security code" value={card.code} secret />
          </section>
        )}
        {item.fields.length > 0 && (
          <section className="card-section">
            {item.fields.map((f, i) => (
              <ValueRow key={i} label={f.name || "Field"} value={f.value} secret={f.hidden} />
            ))}
          </section>
        )}
        {item.notes && (
          <section className="card-section">
            <span className="field-label">Notes</span>
            <p className="notes">{item.notes}</p>
          </section>
        )}

        <div className="meta muted small">
          {trash && <span>In the Trash · {daysLeftLabel(item)}</span>}
          <span>Updated {fmt(item.modifiedAt)}</span>
          <span>Created {fmt(item.createdAt)}</span>
          {item.passwordHistory.length > 0 && (
            <button type="button" className="btn link small" onClick={() => setShowHistory(true)}>
              Password history ({item.passwordHistory.length})
            </button>
          )}
        </div>

        {trash ? (
          <button
            type="button"
            className="btn danger"
            onClick={() =>
              confirm(`Permanently delete “${item.name}” on all your devices? This can’t be undone.`) && trash.onPurge()
            }
          >
            <Icon name="trash" /> Delete permanently
          </button>
        ) : (
          <button type="button" className="btn danger" onClick={onDelete}>
            <Icon name="trash" /> Delete
          </button>
        )}
      </div>

      {showHistory && (
        <Modal title="Password history" onClose={() => setShowHistory(false)}>
          {item.passwordHistory.map((h, i) => (
            <ValueRow key={i} label={`Replaced ${fmt(h.changedAt)}`} value={h.password} secret />
          ))}
        </Modal>
      )}
    </div>
  );
}

// ── Editor ────────────────────────────────────────────────────────────

export function ItemEditor({
  initial,
  folders,
  onSave,
  onCancel,
}: {
  initial: VaultItemData;
  folders: string[];
  onSave: (data: VaultItemData) => Promise<void>;
  onCancel: () => void;
}) {
  const [d, setD] = useState<VaultItemData>(() => structuredClone(initial));
  const [genOpen, setGenOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<VaultItemData>) => setD((x) => ({ ...x, ...patch }));
  const login = d.login ?? emptyLogin();
  const card = d.card ?? emptyCard();
  const setLogin = (patch: Partial<typeof login>) => set({ login: { ...login, ...patch } });
  const setCard = (patch: Partial<typeof card>) => set({ card: { ...card, ...patch } });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!d.name.trim()) return setError("Give this item a name.");
    if (d.login?.totp) {
      try {
        parseTotp(d.login.totp);
      } catch (err) {
        return setError(`Authenticator key: ${(err as Error).message}`);
      }
    }
    setBusy(true);
    setError(null);
    try {
      const cleaned: VaultItemData = {
        ...d,
        name: d.name.trim(),
        folder: d.folder.trim(),
        fields: d.fields.filter((f) => f.name || f.value),
        login: d.login && { ...d.login, uris: d.login.uris.map((u) => u.trim()).filter(Boolean) },
      };
      await onSave(cleaned);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="detail editor" onSubmit={submit}>
      <header className="detail-head">
        <span className="item-icon">
          <Icon name={TYPE_META[d.type].icon} />
        </span>
        <div className="detail-title">
          <h2>{initial.name ? `Edit ${TYPE_META[d.type].label.toLowerCase()}` : `New ${TYPE_META[d.type].label.toLowerCase()}`}</h2>
        </div>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy}>
          Save
        </button>
      </header>

      <div className="detail-body">
        <section className="card-section">
          <Field label="Name">
            <input value={d.name} onChange={(e) => set({ name: e.target.value })} autoFocus={!initial.name} />
          </Field>
          <div className="row">
            <Field label="Folder">
              <input value={d.folder} onChange={(e) => set({ folder: e.target.value })} list="folders" placeholder="None" />
              <datalist id="folders">
                {folders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </Field>
            <label className="check fav">
              <input type="checkbox" checked={d.favorite} onChange={(e) => set({ favorite: e.target.checked })} />
              <span>Favourite</span>
            </label>
          </div>
        </section>

        {d.type === "login" && (
          <section className="card-section">
            <Field label="Username">
              <input value={login.username} onChange={(e) => setLogin({ username: e.target.value })} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            </Field>
            <Field label="Password">
              <PasswordInput
                value={login.password}
                onChange={(v) => setLogin({ password: v })}
                autoComplete="new-password"
                extra={<IconButton icon="dice" label="Generate password" onClick={() => setGenOpen(true)} />}
              />
            </Field>
            <Field label="Authenticator key (TOTP)" hint="Paste the setup key or otpauth:// link from the site’s 2FA setup.">
              <input className="mono" value={login.totp} onChange={(e) => setLogin({ totp: e.target.value })} autoCapitalize="off" spellCheck={false} />
            </Field>
            <span className="field-label">Websites</span>
            {[...login.uris, ""].map((u, i) => (
              <div className="input-row" key={i}>
                <input
                  value={u}
                  placeholder="https://example.com"
                  autoCapitalize="off"
                  onChange={(e) => {
                    const uris = [...login.uris];
                    uris[i] = e.target.value;
                    setLogin({ uris });
                  }}
                />
                {i < login.uris.length && (
                  <IconButton icon="x" label="Remove website" onClick={() => setLogin({ uris: login.uris.filter((_, j) => j !== i) })} />
                )}
              </div>
            ))}
          </section>
        )}

        {d.type === "card" && (
          <section className="card-section">
            <Field label="Cardholder name">
              <input value={card.cardholderName} onChange={(e) => setCard({ cardholderName: e.target.value })} autoComplete="off" />
            </Field>
            <div className="row">
              <Field label="Brand">
                <input value={card.brand} onChange={(e) => setCard({ brand: e.target.value })} placeholder="Visa" />
              </Field>
              <Field label="Number">
                <input className="mono" inputMode="numeric" value={card.number} onChange={(e) => setCard({ number: e.target.value })} autoComplete="off" />
              </Field>
            </div>
            <div className="row">
              <Field label="Exp. month">
                <input inputMode="numeric" maxLength={2} value={card.expMonth} onChange={(e) => setCard({ expMonth: e.target.value })} placeholder="MM" />
              </Field>
              <Field label="Exp. year">
                <input inputMode="numeric" maxLength={4} value={card.expYear} onChange={(e) => setCard({ expYear: e.target.value })} placeholder="YYYY" />
              </Field>
              <Field label="Security code">
                <PasswordInput value={card.code} onChange={(v) => setCard({ code: v })} />
              </Field>
            </div>
          </section>
        )}

        <section className="card-section">
          <span className="field-label">Custom fields</span>
          {d.fields.map((f, i) => {
            const update = (patch: Partial<typeof f>) => set({ fields: d.fields.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div className="custom-field" key={i}>
                <input placeholder="Name" value={f.name} onChange={(e) => update({ name: e.target.value })} />
                <input
                  placeholder="Value"
                  type={f.hidden ? "password" : "text"}
                  value={f.value}
                  onChange={(e) => update({ value: e.target.value })}
                />
                <IconButton icon={f.hidden ? "eyeOff" : "eye"} label={f.hidden ? "Hidden field" : "Visible field"} active={f.hidden} onClick={() => update({ hidden: !f.hidden })} />
                <IconButton icon="x" label="Remove field" onClick={() => set({ fields: d.fields.filter((_, j) => j !== i) })} />
              </div>
            );
          })}
          <button type="button" className="btn small" onClick={() => set({ fields: [...d.fields, { name: "", value: "", hidden: false }] })}>
            <Icon name="plus" size={16} /> Add field
          </button>
        </section>

        <section className="card-section">
          <Field label="Notes">
            <textarea rows={d.type === "note" ? 10 : 4} value={d.notes} onChange={(e) => set({ notes: e.target.value })} />
          </Field>
        </section>
        <ErrorText error={error} />
      </div>

      {genOpen && (
        <Modal title="Generate password" onClose={() => setGenOpen(false)}>
          <Generator
            onUse={(v) => {
              setLogin({ password: v });
              setGenOpen(false);
            }}
          />
        </Modal>
      )}
    </form>
  );
}
