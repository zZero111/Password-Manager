import { type ItemType, type VaultItem, folders as folderList, inFolder, matchesSearch, newItemData, sortItems } from "@pm/core";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Vault } from "../lib/useVault";
import { Generator } from "./Generator";
import { ItemEditor, ItemView, TYPE_META, daysLeftLabel } from "./Item";
import { SettingsPage } from "./Settings";
import { ErrorText, Field, Icon, type IconName, IconButton, Modal, PasswordInput } from "./ui";

type Filter =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "type"; type: ItemType }
  | { kind: "folder"; folder: string }
  | { kind: "trash" };
type Page = "items" | "generator" | "settings";
type Editing = null | { kind: "new"; type: ItemType } | { kind: "edit"; id: string };

const same = (a: Filter, b: Filter) =>
  a.kind === "folder" && b.kind === "folder" ? inFolder(a.folder, b.folder) : JSON.stringify(a) === JSON.stringify(b);

function subtitle(item: VaultItem) {
  if (item.login) return item.login.username || item.login.uris[0] || "";
  if (item.card) return item.card.number ? `•••• ${item.card.number.slice(-4)}` : item.card.brand;
  return item.notes.split("\n")[0]?.slice(0, 60) ?? "";
}

export function VaultScreen({ vault }: { vault: Vault }) {
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [page, setPage] = useState<Page>("items");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [drawer, setDrawer] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  const [reauth, setReauth] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // The Trash is its own pool: Trash Items never reach the main list, search, Folders, Favourites or counts.
  const inTrash = filter.kind === "trash";
  const pool = inTrash ? vault.trash : vault.items;
  const allFolders = useMemo(() => folderList(vault.items), [vault.items]);
  const visible = useMemo(() => {
    const filtered = pool.filter((i) => {
      switch (filter.kind) {
        case "favorites":
          return i.favorite;
        case "type":
          return i.type === filter.type;
        case "folder":
          return inFolder(i.folder, filter.folder);
        default:
          return true;
      }
    });
    return sortItems(filtered.filter((i) => matchesSearch(i, query)));
  }, [pool, filter, query]);

  const selected = pool.find((i) => i.id === selectedId) ?? null;

  // Keyboard shortcuts: Ctrl/Cmd+F search, Ctrl/Cmd+L lock.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "f") {
        e.preventDefault();
        setPage("items");
        searchRef.current?.focus();
      } else if (e.key === "l") {
        e.preventDefault();
        vault.lock();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [vault]);

  function choose(f: Filter) {
    setFilter(f);
    setPage("items");
    setDrawer(false);
    setEditing(null);
  }

  const nav = (icon: IconName, label: string, f: Filter, count?: number) => (
    <button type="button" className={`nav-item${page === "items" && same(filter, f) ? " active" : ""}`} onClick={() => choose(f)}>
      <Icon name={icon} />
      <span>{label}</span>
      {count !== undefined && <span className="count">{count}</span>}
    </button>
  );

  const showDetail = page !== "items" || editing !== null || selected !== null;
  const editingItem = editing?.kind === "edit" ? vault.items.find((i) => i.id === editing.id) : undefined;

  let detail: React.ReactNode = <div className="empty-detail muted">Select an item</div>;
  if (page === "generator") {
    detail = (
      <div className="detail">
        <header className="detail-head">
          <button type="button" className="icon-btn only-narrow" onClick={() => setPage("items")} aria-label="Back">
            <Icon name="back" />
          </button>
          <div className="detail-title">
            <h2>Password generator</h2>
          </div>
        </header>
        <div className="detail-body">
          <Generator />
        </div>
      </div>
    );
  } else if (page === "settings") {
    detail = <SettingsPage vault={vault} onBack={() => setPage("items")} />;
  } else if (editing) {
    const initial = editing.kind === "new" ? newItemData(editing.type) : editingItem;
    if (initial) {
      if (editing.kind === "new" && filter.kind === "folder") initial.folder = filter.folder;
      detail = (
        <ItemEditor
          key={editing.kind === "edit" ? editing.id : `new-${editing.type}`}
          initial={initial}
          folders={allFolders}
          onCancel={() => setEditing(null)}
          onSave={async (data) => {
            const saved = await vault.save(data, editing.kind === "edit" ? editing.id : undefined);
            setEditing(null);
            setSelectedId(saved.id);
          }}
        />
      );
    }
  } else if (selected) {
    detail = (
      <ItemView
        key={selected.id}
        item={selected}
        onBack={() => setSelectedId(null)}
        onEdit={() => setEditing({ kind: "edit", id: selected.id })}
        onToggleFavorite={() => void vault.save({ ...selected, favorite: !selected.favorite }, selected.id)}
        onDelete={async () => {
          await vault.delete(selected.id);
          setSelectedId(null);
        }}
        trash={
          inTrash
            ? {
                onRestore: async () => {
                  await vault.restore(selected.id);
                  setSelectedId(null);
                },
                onPurge: async () => {
                  await vault.purge(selected.id);
                  setSelectedId(null);
                },
              }
            : undefined
        }
      />
    );
  }

  const s = vault.sync;
  const syncLabel =
    s.state === "syncing"
      ? "Syncing…"
      : s.state === "offline"
        ? `Offline${s.pending ? ` · ${s.pending} waiting` : ""}`
        : s.state === "disconnected"
          ? `Disconnected${s.pending ? ` · ${s.pending} waiting` : ""}`
          : s.state === "error"
            ? "Sync error"
            : s.pending
              ? `${s.pending} waiting`
              : "Synced";

  return (
    <div className={`vault${showDetail ? " has-detail" : ""}${drawer ? " drawer-open" : ""}`}>
      <aside className="sidebar">
        <div className="brand small">
          <span className="brand-mark">
            <Icon name="lock" size={18} />
          </span>
          <span>Keyhold</span>
        </div>
        <nav>
          {nav("grid", "All items", { kind: "all" }, vault.items.length)}
          {nav("star", "Favourites", { kind: "favorites" })}
          <div className="nav-heading">Types</div>
          {(Object.keys(TYPE_META) as ItemType[]).map((t) =>
            nav(TYPE_META[t].icon, TYPE_META[t].label + "s", { kind: "type", type: t }, vault.items.filter((i) => i.type === t).length),
          )}
          {allFolders.length > 0 && <div className="nav-heading">Folders</div>}
          {allFolders.map((f) => nav("folder", f, { kind: "folder", folder: f }))}
          <div className="nav-heading">Trash</div>
          {nav("trash", "Trash", { kind: "trash" }, vault.trash.length)}
          <div className="nav-heading">Tools</div>
          <button type="button" className={`nav-item${page === "generator" ? " active" : ""}`} onClick={() => (setPage("generator"), setDrawer(false))}>
            <Icon name="dice" />
            <span>Generator</span>
          </button>
          <button type="button" className={`nav-item${page === "settings" ? " active" : ""}`} onClick={() => (setPage("settings"), setDrawer(false))}>
            <Icon name="gear" />
            <span>Settings</span>
          </button>
        </nav>
        <div className="sidebar-foot">
          <button
            type="button"
            className={`sync-pill s-${s.state}`}
            title={s.message ?? "Sync now"}
            onClick={() => (s.state === "disconnected" ? setReauth(true) : void vault.syncNow())}
          >
            <Icon name="refresh" size={14} /> {syncLabel}
          </button>
          <IconButton icon="lock" label="Lock (Ctrl+L)" onClick={vault.lock} />
        </div>
      </aside>
      <div className="drawer-scrim" onClick={() => setDrawer(false)} />

      <section className="list-pane">
        <header className="list-head">
          <button type="button" className="icon-btn only-narrow" onClick={() => setDrawer(true)} aria-label="Menu">
            <Icon name="grid" />
          </button>
          <div className="search">
            <Icon name="search" size={16} />
            <input ref={searchRef} type="search" placeholder={inTrash ? "Search Trash" : "Search vault"} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="new-wrap">
            <button type="button" className="btn primary icon-only" aria-label="New item" onClick={() => setNewMenu(!newMenu)}>
              <Icon name="plus" />
            </button>
            {newMenu && (
              <div className="menu" onMouseLeave={() => setNewMenu(false)}>
                {(Object.keys(TYPE_META) as ItemType[]).map((t) => (
                  <button
                    type="button"
                    key={t}
                    onClick={() => {
                      setNewMenu(false);
                      setPage("items");
                      if (inTrash) setFilter({ kind: "all" });
                      setSelectedId(null);
                      setEditing({ kind: "new", type: t });
                    }}
                  >
                    <Icon name={TYPE_META[t].icon} /> {TYPE_META[t].label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </header>

        {s.state === "disconnected" && (
          <button type="button" className="banner warn" onClick={() => setReauth(true)}>
            Disconnected
            {s.pending > 0 && ` · ${s.pending} ${s.pending === 1 ? "change" : "changes"} waiting`} · Sign in again
          </button>
        )}
        {vault.unreadable > 0 && (
          <div className="banner danger">
            {vault.unreadable} item(s) couldn’t be decrypted. They may be corrupted or have been tampered with on the server.
          </div>
        )}

        {filter.kind === "folder" && (
          <div className="folder-bar muted small">
            <span>
              <Icon name="folder" size={14} /> {allFolders.find((f) => inFolder(f, filter.folder)) ?? filter.folder}
            </span>
            <button
              type="button"
              className="btn small"
              onClick={async () => {
                const current = allFolders.find((f) => inFolder(f, filter.folder)) ?? filter.folder;
                const to = prompt(`Rename folder “${current}” to:`, current)?.trim();
                if (!to || to === current) return;
                await vault.renameFolder(current, to);
                setFilter({ kind: "folder", folder: to });
              }}
            >
              Rename folder
            </button>
          </div>
        )}
        {inTrash && vault.trash.length > 0 && (
          <div className="trash-bar muted small">
            <span>Items in the Trash are deleted permanently after 30 days.</span>
            <button
              type="button"
              className="btn danger small"
              onClick={async () => {
                const n = vault.trash.length;
                if (!confirm(`Permanently delete all ${n} ${n === 1 ? "item" : "items"} in the Trash on all your devices? This can’t be undone.`)) return;
                await vault.emptyTrash();
                setSelectedId(null);
              }}
            >
              Empty Trash
            </button>
          </div>
        )}

        <ul className="item-list">
          {visible.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                className={`item-row${i.id === selectedId && page === "items" && !editing ? " active" : ""}`}
                onClick={() => {
                  setSelectedId(i.id);
                  setEditing(null);
                  setPage("items");
                }}
              >
                <span className="item-icon">
                  <Icon name={TYPE_META[i.type].icon} />
                </span>
                <span className="item-text">
                  <span className="item-name">
                    {i.name}
                    {i.favorite && <span className="fav-dot" aria-label="favourite">★</span>}
                  </span>
                  <span className="item-sub muted">{inTrash ? daysLeftLabel(i) : subtitle(i)}</span>
                </span>
              </button>
            </li>
          ))}
          {visible.length === 0 && (
            <li className="empty muted">
              {inTrash && vault.trash.length === 0 ? (
                "The Trash is empty"
              ) : pool.length === 0 ? (
                <>
                  Your vault is empty.
                  <br />
                  Add an item with <strong>+</strong>, or import from Bitwarden in Settings.
                </>
              ) : (
                "No matching items"
              )}
            </li>
          )}
        </ul>
      </section>

      <main className="detail-pane">{detail}</main>

      {reauth && <ReauthModal vault={vault} onClose={() => setReauth(false)} />}
    </div>
  );
}

function ReauthModal({ vault, onClose }: { vault: Vault; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await vault.reauthenticate(password);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Sign in again" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <p className="muted small">
          This Device is Disconnected — usually because the master password was changed on another Device. Your changes
          are kept and will upload once you sign in with your current master password.
        </p>
        <Field label="Master password">
          <PasswordInput value={password} onChange={setPassword} autoFocus autoComplete="current-password" />
        </Field>
        <ErrorText error={error} />
        <button className="btn primary wide" disabled={busy || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </Modal>
  );
}
