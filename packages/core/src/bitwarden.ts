import { type CustomField, MAX_SECRET_HISTORY, type SecretHistoryEntry, type VaultItemData, newItemData } from "./vault";

// Importer for Bitwarden's *unencrypted* JSON export
// (Bitwarden: Tools → Export vault → File format: .json).

interface BwField {
  name?: string | null;
  value?: string | null;
  type?: number;
}
interface BwItem {
  type: number;
  name?: string | null;
  notes?: string | null;
  favorite?: boolean;
  folderId?: string | null;
  fields?: BwField[] | null;
  login?: {
    username?: string | null;
    password?: string | null;
    totp?: string | null;
    uris?: { uri?: string | null }[] | null;
  } | null;
  card?: {
    cardholderName?: string | null;
    brand?: string | null;
    number?: string | null;
    expMonth?: string | null;
    expYear?: string | null;
    code?: string | null;
  } | null;
  identity?: Record<string, string | null> | null;
  sshKey?: { privateKey?: string | null; publicKey?: string | null; keyFingerprint?: string | null } | null;
  passwordHistory?: { password?: string | null; lastUsedDate?: string | null }[] | null;
  creationDate?: string | null;
  revisionDate?: string | null;
}
interface BwExport {
  encrypted?: boolean;
  passwordProtected?: boolean;
  folders?: { id: string; name: string }[];
  items?: BwItem[];
}

export interface ImportResult {
  items: VaultItemData[];
  warnings: string[];
}

const s = (v: string | null | undefined) => v ?? "";

const IDENTITY_LABELS: Record<string, string> = {
  title: "Title",
  firstName: "First name",
  middleName: "Middle name",
  lastName: "Last name",
  username: "Username",
  company: "Company",
  email: "Email",
  phone: "Phone",
  address1: "Address 1",
  address2: "Address 2",
  address3: "Address 3",
  city: "City",
  state: "State / Province",
  postalCode: "Postal code",
  country: "Country",
  ssn: "Social security number",
  passportNumber: "Passport number",
  licenseNumber: "License number",
};
const SENSITIVE_IDENTITY = new Set(["ssn", "passportNumber", "licenseNumber"]);

export function importBitwardenJson(json: string): ImportResult {
  let data: BwExport;
  try {
    data = JSON.parse(json) as BwExport;
  } catch {
    throw new Error("This file is not valid JSON. Export from Bitwarden using the “.json” format.");
  }
  if (data.encrypted || data.passwordProtected) {
    throw new Error(
      "This is an encrypted Bitwarden export. Re-export using the unencrypted “.json” format, import it, then securely delete the file.",
    );
  }
  if (!Array.isArray(data.items)) throw new Error("No items found — is this a Bitwarden JSON export?");

  const folderNames = new Map((data.folders ?? []).map((f) => [f.id, f.name]));
  const warnings: string[] = [];
  const items: VaultItemData[] = [];

  for (const bw of data.items) {
    const fields: CustomField[] = (bw.fields ?? [])
      .filter((f) => f.type !== 3) // "linked" fields reference other fields; nothing to import
      .map((f) => ({ name: s(f.name), value: s(f.value), hidden: f.type === 1 }));

    let type: VaultItemData["type"];
    switch (bw.type) {
      case 1:
        type = "login";
        break;
      case 3:
        type = "card";
        break;
      case 2:
        type = "note";
        break;
      case 4: {
        type = "note";
        for (const [k, label] of Object.entries(IDENTITY_LABELS)) {
          const v = bw.identity?.[k];
          if (v) fields.push({ name: label, value: v, hidden: SENSITIVE_IDENTITY.has(k) });
        }
        break;
      }
      case 5: {
        type = "note";
        if (bw.sshKey?.privateKey) fields.push({ name: "Private key", value: bw.sshKey.privateKey, hidden: true });
        if (bw.sshKey?.publicKey) fields.push({ name: "Public key", value: bw.sshKey.publicKey, hidden: false });
        if (bw.sshKey?.keyFingerprint)
          fields.push({ name: "Fingerprint", value: bw.sshKey.keyFingerprint, hidden: false });
        break;
      }
      default:
        warnings.push(`Skipped “${s(bw.name) || "unnamed"}”: unsupported Bitwarden item type ${bw.type}`);
        continue;
    }

    const item = newItemData(type);
    item.name = s(bw.name) || "Untitled";
    item.notes = s(bw.notes);
    item.favorite = !!bw.favorite;
    item.folder = (bw.folderId && folderNames.get(bw.folderId)) || "";
    item.fields = fields;
    if (bw.creationDate) item.createdAt = bw.creationDate;
    if (bw.revisionDate) item.modifiedAt = bw.revisionDate;
    if (bw.type === 4) item.folder ||= "Identities";
    if (bw.type === 5) item.folder ||= "SSH keys";

    if (type === "login") {
      item.login = {
        username: s(bw.login?.username),
        password: s(bw.login?.password),
        totp: s(bw.login?.totp),
        uris: (bw.login?.uris ?? []).map((u) => s(u.uri)).filter(Boolean),
      };
      if (item.login.totp.toLowerCase().startsWith("steam://")) {
        warnings.push(`“${item.name}”: Steam Guard codes are not supported; the secret was kept but no codes will show.`);
      }
    }
    if (type === "card") {
      item.card = {
        cardholderName: s(bw.card?.cardholderName),
        brand: s(bw.card?.brand),
        number: s(bw.card?.number),
        expMonth: s(bw.card?.expMonth),
        expYear: s(bw.card?.expYear),
        code: s(bw.card?.code),
      };
    }
    item.secretHistory = (bw.passwordHistory ?? [])
      .filter((h) => h.password)
      .map((h): SecretHistoryEntry => ({
        field: { kind: "password" },
        value: s(h.password),
        changedAt: s(h.lastUsedDate) || item.modifiedAt,
      }))
      .sort((a, b) => b.changedAt.localeCompare(a.changedAt))
      .slice(0, MAX_SECRET_HISTORY);
    items.push(item);
  }
  return { items, warnings };
}
