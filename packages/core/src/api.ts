import {
  type ApiErrorBody,
  type ChangePasswordRequest,
  type Device,
  type LoginRequest,
  type LoginResponse,
  type PreloginResponse,
  type PushChange,
  type PushResponse,
  type RegisterRequest,
  type SyncResponse,
  REJECTION_REASONS,
  type RejectionReason,
} from "./protocol";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The Server no longer accepts this Device. `reason` is what the Server said
 * (see RejectionReason); either way the Device is Disconnected for now: its
 * vault and unsynced changes are kept until the person signs in again.
 */
export class DisconnectedError extends ApiError {
  constructor(readonly reason: RejectionReason = "disconnected") {
    super(401, "The Server no longer accepts this Device. Sign in again to keep syncing.");
    this.name = "DisconnectedError";
  }
}

function rejectionReason(body: unknown): RejectionReason {
  const reason = (body as ApiErrorBody | undefined)?.reason;
  return reason && REJECTION_REASONS.includes(reason) ? reason : "disconnected";
}

export class NetworkError extends Error {
  constructor(cause: unknown) {
    super("Could not reach the sync server");
    this.name = "NetworkError";
    this.cause = cause;
  }
}

export type FetchFn = typeof fetch;

export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Server URL must be http(s)");
  return trimmed;
}

export class ApiClient {
  constructor(
    readonly baseUrl: string,
    public token: string | null = null,
    private fetchFn: FetchFn = (...a) => fetch(...a),
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) {
      if (!this.token) throw new DisconnectedError();
      headers.authorization = `Bearer ${this.token}`;
    }
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new NetworkError(e);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? (JSON.parse(text) as unknown) : undefined;
    } catch (e) {
      if (res.ok) throw e;
    }
    if (res.status === 401 && auth) throw new DisconnectedError(rejectionReason(json));
    if (!res.ok) {
      const msg = (json as { error?: string } | undefined)?.error ?? `Request failed (${res.status})`;
      throw new ApiError(res.status, msg);
    }
    return json as T;
  }

  prelogin(email: string) {
    return this.request<PreloginResponse>("POST", "/api/accounts/prelogin", { email }, false);
  }
  register(req: RegisterRequest) {
    return this.request<{ userId: string }>("POST", "/api/accounts/register", req, false);
  }
  login(req: LoginRequest) {
    return this.request<LoginResponse>("POST", "/api/accounts/login", req, false);
  }
  /** Resolves if the Server still accepts this Device; throws DisconnectedError (with reason) if not. */
  status() {
    return this.request<void>("GET", "/api/accounts/status");
  }
  logout() {
    return this.request<void>("POST", "/api/accounts/logout", {});
  }
  changePassword(req: ChangePasswordRequest) {
    return this.request<void>("POST", "/api/accounts/password", req);
  }
  sync(since: number) {
    return this.request<SyncResponse>("GET", `/api/sync?since=${since}`);
  }
  push(changes: PushChange[]) {
    return this.request<PushResponse>("POST", "/api/sync", { changes });
  }
  devices() {
    return this.request<Device[]>("GET", "/api/devices");
  }
  revokeDevice(id: string) {
    return this.request<void>("DELETE", `/api/devices/${encodeURIComponent(id)}`);
  }
}
