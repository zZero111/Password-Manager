import type {
  ChangePasswordRequest,
  Device,
  LoginRequest,
  LoginResponse,
  PreloginResponse,
  PushChange,
  PushResponse,
  RegisterRequest,
  SyncResponse,
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

export class SessionExpiredError extends ApiError {
  constructor() {
    super(401, "Your session has ended. Log in again to keep syncing.");
    this.name = "SessionExpiredError";
  }
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
      if (!this.token) throw new SessionExpiredError();
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
    if (res.status === 401 && auth) throw new SessionExpiredError();
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
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
