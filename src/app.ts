import { Hono } from "hono";
import { PLATFORMS, type Platform } from "./provider.ts";
import type { MetricsStore } from "./store.ts";
import type { SyncService } from "./sync.ts";

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

class HttpError extends Error {
  constructor(
    public readonly status: 404 | 422,
    public readonly code: "not_found" | "validation",
    message: string,
  ) {
    super(message);
  }
}

async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(422, "validation", "o corpo deve ser um objeto JSON");
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(422, "validation", `${field} é obrigatório`);
  }
  return value.trim();
}

function instant(value: unknown, field: string): string {
  const raw = text(value, field);
  const ms = ISO_INSTANT.test(raw) ? Date.parse(raw) : NaN;
  if (Number.isNaN(ms)) throw new HttpError(422, "validation", `${field} deve ser uma data ISO 8601`);
  return new Date(ms).toISOString();
}

export function createApp(store: MetricsStore, sync: SyncService) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code, message: err.message }, err.status);
    console.error(err);
    return c.json({ error: "internal", message: "erro interno" }, 500);
  });

  const findConnection = (id: string) => {
    const connection = store.connection(id);
    if (!connection) throw new HttpError(404, "not_found", `conexão ${id} não existe`);
    return connection;
  };

  app.post("/connections", async (c) => {
    const body = await jsonBody(c.req.raw);
    const platform = text(body.platform, "platform");
    if (!(PLATFORMS as readonly string[]).includes(platform)) {
      throw new HttpError(422, "validation", `platform deve ser um de: ${PLATFORMS.join(", ")}`);
    }
    const connection = store.addConnection({
      platform: platform as Platform,
      account_id: text(body.account_id, "account_id"),
      access_token: text(body.access_token, "access_token"),
    });
    return c.json({ id: connection.id, platform: connection.platform, account_id: connection.account_id }, 201);
  });

  // Runs the sync and answers when it ends. 200 ok, 429 + Retry-After when the provider
  // asked for more than we wait, 502 for any other failure. The body is always the run.
  app.post("/connections/:id/syncs", async (c) => {
    const connection = findConnection(c.req.param("id"));
    const body = await jsonBody(c.req.raw);
    const since = instant(body.since, "since");
    const until = instant(body.until, "until");
    if (Date.parse(until) <= Date.parse(since)) {
      throw new HttpError(422, "validation", "until deve ser depois de since");
    }
    const run = await sync.sync(connection, { since, until });
    if (run.status === "succeeded") return c.json(run);
    if (run.error?.code === "rate_limited" && run.error.retry_after_ms !== undefined) {
      c.header("Retry-After", String(Math.ceil(run.error.retry_after_ms / 1000)));
      return c.json(run, 429);
    }
    return c.json(run, 502);
  });

  app.get("/connections/:id/syncs", (c) => c.json({ syncs: store.runsOf(findConnection(c.req.param("id")).id) }));

  app.get("/connections/:id/posts", (c) => c.json({ posts: store.postsOf(findConnection(c.req.param("id")).id) }));

  // Totals add each post once, using its latest accepted snapshot.
  app.get("/connections/:id/metrics", (c) => {
    const posts = store.postsOf(findConnection(c.req.param("id")).id);
    const totals = { views: 0, likes: 0, comments: 0, shares: 0 };
    for (const post of posts) {
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += post.metrics[key];
    }
    const fetched = posts.map((p) => p.fetched_at).sort();
    return c.json({
      posts: posts.length,
      totals,
      oldest_fetched_at: fetched[0] ?? null,
      last_fetched_at: fetched.at(-1) ?? null,
    });
  });

  return app;
}
