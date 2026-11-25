import { describe, expect, it } from "vitest";
import { ApiClient, ApiError, DisconnectedError } from "../src/api";

const respond = (status: number, body: string) => async () => new Response(body, { status });

describe("ApiClient rejections", () => {
  it("maps a 401 with reason signed_out to DisconnectedError(signed_out)", async () => {
    const api = new ApiClient("http://x", "t", respond(401, JSON.stringify({ error: "Not signed in", reason: "signed_out" })));
    const err = await api.devices().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DisconnectedError);
    expect((err as DisconnectedError).reason).toBe("signed_out");
  });

  it("treats a 401 without a known reason (older Server) as disconnected", async () => {
    for (const body of ["", "not json", JSON.stringify({ error: "x" }), JSON.stringify({ error: "x", reason: "weird" })]) {
      const api = new ApiClient("http://x", "t", respond(401, body));
      const err = await api.devices().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DisconnectedError);
      expect((err as DisconnectedError).reason).toBe("disconnected");
    }
  });

  it("does not report Disconnected for unauthenticated calls", async () => {
    const api = new ApiClient("http://x", null, respond(401, JSON.stringify({ error: "nope", reason: "disconnected" })));
    const err = await api.prelogin("a@b.c").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(DisconnectedError);
  });
});
