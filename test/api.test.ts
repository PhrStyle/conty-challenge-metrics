import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { M, setup } from "./helpers.ts";

function api(config = {}) {
  const ctx = setup(config);
  const app = createApp(ctx.store, ctx.sync);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: (await res.json()) as any };
  };
  return { ...ctx, call };
}

const WINDOW = { since: "2026-10-01T00:00:00Z", until: "2026-10-12T00:00:00Z" };

async function connect(call: ReturnType<typeof api>["call"]) {
  const res = await call("POST", "/connections", { platform: "youtube", account_id: "acc", access_token: "fake" });
  return res.body.id as string;
}

describe("API", () => {
  it("sincroniza, soma cada post uma vez e informa quando foi buscado", async () => {
    const { call, provider } = api();
    provider.setPost("p1", "2026-10-05T10:00:00.000Z", M(1000));
    provider.setPost("p2", "2026-10-06T10:00:00.000Z", M(500));
    const id = await connect(call);

    const first = await call("POST", `/connections/${id}/syncs`, WINDOW);
    const again = await call("POST", `/connections/${id}/syncs`, WINDOW);
    expect(first.status).toBe(200);
    expect(again.body.counts.unchanged).toBe(2);

    const metrics = await call("GET", `/connections/${id}/metrics`);
    expect(metrics.body).toMatchObject({
      posts: 2,
      totals: { views: 1500 },
      last_fetched_at: "2026-10-12T12:00:00.000Z",
    });
    expect(metrics.body.oldest_fetched_at).toBe("2026-10-12T12:00:00.000Z");
    const syncs = await call("GET", `/connections/${id}/syncs`);
    expect(syncs.body.syncs).toHaveLength(2);
  });

  it("não devolve o token da conexão", async () => {
    const { call } = api();
    const res = await call("POST", "/connections", { platform: "x", account_id: "a", access_token: "segredo" });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain("segredo");
  });

  it("429 acima do teto responde 429 com Retry-After e o run", async () => {
    const { call, provider } = api({ maxRetryAfterMs: 5000 });
    provider.failNext({ kind: "rate_limit", retryAfter: "90" });
    const id = await connect(call);

    const res = await call("POST", `/connections/${id}/syncs`, WINDOW);

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("90");
    expect(res.body.status).toBe("failed");
  });

  it("falha transitória esgotada responde 502", async () => {
    const { call, provider } = api({ maxAttempts: 2 });
    provider.failNext({ kind: "http", status: 500 }, { kind: "http", status: 500 });
    const id = await connect(call);

    const res = await call("POST", `/connections/${id}/syncs`, WINDOW);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("retries_exhausted");
  });

  it.each([
    ["conexão inexistente", "/connections/nope/syncs", WINDOW, 404],
    ["sem since", "CONN", { until: WINDOW.until }, 422],
    ["data inválida", "CONN", { since: "ontem", until: WINDOW.until }, 422],
    ["until antes de since", "CONN", { since: WINDOW.until, until: WINDOW.since }, 422],
    ["data sem formato ISO", "CONN", { since: "1", until: WINDOW.until }, 422],
  ])("sync: %s", async (_name, path, body, status) => {
    const { call } = api();
    const id = await connect(call);
    const res = await call("POST", path === "CONN" ? `/connections/${id}/syncs` : path, body);
    expect(res.status).toBe(status);
  });

  it("last_fetched_at e oldest_fetched_at refletem syncs em momentos diferentes", async () => {
    const { call, provider, clock } = api();
    provider.setPost("a", "2026-10-02T10:00:00.000Z", M(1));
    provider.setPost("b", "2026-10-08T10:00:00.000Z", M(1));
    const id = await connect(call);
    await call("POST", `/connections/${id}/syncs`, { since: "2026-10-01T00:00:00Z", until: "2026-10-03T00:00:00Z" });
    clock.advance(600_000);
    await call("POST", `/connections/${id}/syncs`, { since: "2026-10-07T00:00:00Z", until: "2026-10-09T00:00:00Z" });

    const { body } = await call("GET", `/connections/${id}/metrics`);
    expect(body.oldest_fetched_at).toBe("2026-10-12T12:00:00.000Z");
    expect(body.last_fetched_at).toBe("2026-10-12T12:10:00.000Z");
  });

  it("valida a conexão", async () => {
    const { call } = api();
    expect((await call("POST", "/connections", { platform: "orkut", account_id: "a", access_token: "t" })).status).toBe(422);
    expect((await call("POST", "/connections", { platform: "x", access_token: "t" })).status).toBe(422);
  });
});
