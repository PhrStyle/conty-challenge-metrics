import { describe, expect, it } from "vitest";
import { parseRetryAfter, SyncService } from "../src/sync.ts";
import { M, setup, WINDOW } from "./helpers.ts";

describe("idempotência", () => {
  it("o mesmo snapshot buscado de novo não muda nem duplica o número", async () => {
    const { provider, store, sync, connection } = setup();
    provider.setPost("p1", "2026-10-05T10:00:00.000Z", M(1000));

    const first = await sync.sync(connection, WINDOW);
    const second = await sync.sync(connection, WINDOW);

    expect(first.counts).toMatchObject({ inserted: 1, unchanged: 0 });
    expect(second.counts).toMatchObject({ inserted: 0, unchanged: 1 });
    const posts = store.postsOf(connection.id);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.metrics.views).toBe(1000);
  });

  it("janelas sobrepostas contam o post da interseção uma vez", async () => {
    const { provider, store, sync, connection } = setup();
    provider.setPost("a", "2026-10-02T10:00:00.000Z", M(100));
    provider.setPost("b", "2026-10-06T10:00:00.000Z", M(200)); // na interseção
    provider.setPost("c", "2026-10-10T10:00:00.000Z", M(400));

    await sync.sync(connection, { since: "2026-10-01T00:00:00.000Z", until: "2026-10-08T00:00:00.000Z" });
    await sync.sync(connection, { since: "2026-10-05T00:00:00.000Z", until: "2026-10-12T00:00:00.000Z" });

    const posts = store.postsOf(connection.id);
    expect(posts.map((p) => p.post_id).sort()).toEqual(["a", "b", "c"]);
    expect(posts.reduce((sum, p) => sum + p.metrics.views, 0)).toBe(700);
  });

  it("snapshot mais novo substitui os contadores, em vez de somar", async () => {
    const { provider, clock, store, sync, connection } = setup();
    provider.setPost("p1", "2026-10-05T10:00:00.000Z", M(1000));
    await sync.sync(connection, WINDOW);

    clock.advance(3_600_000);
    provider.setPost("p1", "2026-10-05T10:00:00.000Z", M(1500));
    const run = await sync.sync(connection, WINDOW);

    expect(run.counts.updated).toBe(1);
    expect(store.postsOf(connection.id)[0]!.metrics.views).toBe(1500);
  });

  it("snapshot mais antigo que o guardado é ignorado", async () => {
    const { provider, store, sync, connection } = setup();
    provider.setPost("p1", "2026-10-05T10:00:00.000Z", M(1500), "2026-10-12T11:00:00.000Z");
    await sync.sync(connection, WINDOW);

    provider.setPost("p1", "2026-10-05T10:00:00.000Z", M(1000), "2026-10-12T09:00:00.000Z");
    const run = await sync.sync(connection, WINDOW);

    expect(run.counts.stale).toBe(1);
    expect(store.postsOf(connection.id)[0]!.metrics.views).toBe(1500);
  });

  it("post repetido dentro da mesma resposta conta uma vez", async () => {
    const { provider, store, sync, connection } = setup();
    provider.setPost("p1", "2026-10-05T10:00:00.000Z", M(1000));
    provider.failNext({ kind: "duplicate_page" });

    const run = await sync.sync(connection, WINDOW);

    expect(run.counts).toMatchObject({ inserted: 1, duplicates_in_response: 1 });
    expect(store.postsOf(connection.id)).toHaveLength(1);
  });

  it("o mesmo post id em conexões diferentes não se mistura", async () => {
    const { provider, store, sync, connection } = setup();
    const other = store.addConnection({ platform: "tiktok", account_id: "acc_2", access_token: "t" });
    provider.setPost("p1", "2026-10-05T10:00:00.000Z", M(1000));

    await sync.sync(connection, WINDOW);
    await sync.sync(other, WINDOW);

    expect(store.postsOf(connection.id)).toHaveLength(1);
    expect(store.postsOf(other.id)).toHaveLength(1);
  });

  it("dois syncs simultâneos da mesma conexão rodam em fila", async () => {
    const { provider, store, sync, connection } = setup();
    provider.setPost("p1", "2026-10-05T10:00:00.000Z", M(1000));

    const [a, b] = await Promise.all([sync.sync(connection, WINDOW), sync.sync(connection, WINDOW)]);

    expect(a.counts.inserted).toBe(1);
    expect(b.counts).toMatchObject({ inserted: 0, unchanged: 1 });
    expect(store.postsOf(connection.id)).toHaveLength(1);
  });
});

describe("janela e resposta repetida", () => {
  it("until é exclusivo e since é inclusivo", async () => {
    const { provider, store, sync, connection } = setup();
    provider.setPost("no_since", "2026-10-01T00:00:00.000Z", M(1));
    provider.setPost("no_until", "2026-10-12T00:00:00.000Z", M(2));
    provider.setPost("antes", "2026-09-30T23:59:59.999Z", M(4));

    await sync.sync(connection, WINDOW);

    expect(store.postsOf(connection.id).map((p) => p.post_id)).toEqual(["no_since"]);
  });

  it("repetido na resposta com snapshots diferentes fica com o mais novo, em qualquer ordem", async () => {
    const post = (views: number, asOf: string) => ({
      id: "p1",
      publishedAt: "2026-10-05T10:00:00.000Z",
      metrics: M(views),
      metricsAsOf: asOf,
    });
    const older = post(900, "2026-10-12T10:00:00.000Z");
    const newer = post(1000, "2026-10-12T11:00:00.000Z");
    for (const posts of [[older, newer], [newer, older]]) {
      const { store, clock, connection } = setup();
      const service = new SyncService({ fetchPosts: async () => ({ posts }) }, store, clock);
      const run = await service.sync(connection, WINDOW);
      expect(run.counts).toMatchObject({ inserted: 1, duplicates_in_response: 1 });
      expect(store.postsOf(connection.id)[0]!.metrics.views).toBe(1000);
    }
  });
});

describe("quando a métrica foi buscada", () => {
  it("posts buscados em momentos diferentes têm fetched_at próprio", async () => {
    const { provider, clock, store, sync, connection } = setup();
    provider.setPost("antigo", "2026-10-02T10:00:00.000Z", M(1));
    await sync.sync(connection, { since: "2026-10-01T00:00:00.000Z", until: "2026-10-03T00:00:00.000Z" });
    clock.advance(600_000);
    provider.setPost("novo", "2026-10-08T10:00:00.000Z", M(1));
    await sync.sync(connection, { since: "2026-10-07T00:00:00.000Z", until: "2026-10-09T00:00:00.000Z" });

    const byId = Object.fromEntries(store.postsOf(connection.id).map((p) => [p.post_id, p.fetched_at]));
    expect(byId).toEqual({ antigo: "2026-10-12T12:00:00.000Z", novo: "2026-10-12T12:10:00.000Z" });
  });

  it("guarda fetched_at (nosso relógio) e metrics_as_of (leitura do provedor)", async () => {
    const { provider, clock, store, sync, connection } = setup();
    provider.setPost("p1", "2026-10-05T10:00:00.000Z", M(1000), "2026-10-12T11:30:00.000Z");
    await sync.sync(connection, WINDOW);

    clock.advance(60_000);
    const run = await sync.sync(connection, WINDOW);

    const post = store.postsOf(connection.id)[0]!;
    expect(post.metrics_as_of).toBe("2026-10-12T11:30:00.000Z");
    expect(post.first_fetched_at).toBe("2026-10-12T12:00:00.000Z");
    expect(post.fetched_at).toBe("2026-10-12T12:01:00.000Z");
    expect(post.last_sync_id).toBe(run.id);
    expect(run.started_at).toBe("2026-10-12T12:01:00.000Z");
  });
});

describe("paginação", () => {
  it("percorre todas as páginas e persiste cada post", async () => {
    const { provider, store, sync, connection } = setup({}, 2);
    for (let i = 1; i <= 5; i++) provider.setPost(`p${i}`, `2026-10-0${i}T10:00:00.000Z`, M(100));

    const run = await sync.sync(connection, WINDOW);

    expect(run).toMatchObject({ status: "succeeded", pages: 3, requests: 3 });
    expect(store.postsOf(connection.id)).toHaveLength(5);
  });

  it("para ao passar do teto de páginas", async () => {
    const { provider, sync, connection } = setup({ maxPages: 2 }, 1);
    for (let i = 1; i <= 5; i++) provider.setPost(`p${i}`, `2026-10-0${i}T10:00:00.000Z`, M(100));

    const run = await sync.sync(connection, WINDOW);

    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("too_many_pages");
    expect(run.pages).toBe(2);
  });
});

describe("falha transitória", () => {
  it("timeout e 5xx são repetidos com backoff e o sync termina", async () => {
    const { provider, clock, sync, connection } = setup();
    provider.setPost("p1", "2026-10-05T10:00:00.000Z", M(1000));
    provider.failNext({ kind: "timeout" }, { kind: "http", status: 503 });

    const run = await sync.sync(connection, WINDOW);

    expect(run.status).toBe("succeeded");
    expect(run.requests).toBe(3);
    expect(clock.sleeps).toEqual([500, 1000]);
    expect(run.retries.map((r) => r.reason)).toEqual(["timeout", "http_503"]);
  });

  it("para no teto de tentativas, sem loop infinito", async () => {
    const { provider, clock, sync, connection } = setup({ maxAttempts: 3 });
    provider.failNext(...Array.from({ length: 10 }, () => ({ kind: "http", status: 500 }) as const));

    const run = await sync.sync(connection, WINDOW);

    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("retries_exhausted");
    expect(provider.calls).toHaveLength(3);
    expect(clock.sleeps).toHaveLength(2); // não dorme depois da última tentativa
  });

  it("o backoff respeita o teto", async () => {
    const { provider, clock, sync, connection } = setup({ maxAttempts: 6, baseBackoffMs: 1000, maxBackoffMs: 3000 });
    provider.failNext(...Array.from({ length: 6 }, () => ({ kind: "timeout" }) as const));

    await sync.sync(connection, WINDOW);

    expect(clock.sleeps).toEqual([1000, 2000, 3000, 3000, 3000]);
  });

  it("resposta que nunca chega vira timeout e é repetida", async () => {
    const { provider, sync, connection } = setup({ requestTimeoutMs: 20 });
    provider.setPost("p1", "2026-10-05T10:00:00.000Z", M(1000));
    provider.failNext({ kind: "hang" });

    const run = await sync.sync(connection, WINDOW);

    expect(run.status).toBe("succeeded");
    expect(run.retries.map((r) => r.reason)).toEqual(["timeout"]);
  });

  it("401 não é repetido", async () => {
    const { provider, sync, connection } = setup();
    provider.failNext({ kind: "http", status: 401 });

    const run = await sync.sync(connection, WINDOW);

    expect(run.error?.code).toBe("unauthorized");
    expect(provider.calls).toHaveLength(1);
  });

  it("falha na página 2 mantém a página 1 e o retry do sync não duplica", async () => {
    const { provider, store, sync, connection } = setup({ maxAttempts: 1 }, 1);
    provider.setPost("p1", "2026-10-02T10:00:00.000Z", M(100));
    provider.setPost("p2", "2026-10-03T10:00:00.000Z", M(200));
    provider.failNext({ kind: "ok" }, { kind: "http", status: 500 });

    const failed = await sync.sync(connection, WINDOW);
    expect(failed.status).toBe("failed");
    expect(store.postsOf(connection.id)).toHaveLength(1);

    const retried = await sync.sync(connection, WINDOW);
    expect(retried.status).toBe("succeeded");
    expect(store.postsOf(connection.id).reduce((s, p) => s + p.metrics.views, 0)).toBe(300);
  });
});

describe("429 e Retry-After", () => {
  it("espera exatamente o Retry-After (segundos) e continua", async () => {
    const { provider, clock, sync, connection } = setup();
    provider.setPost("p1", "2026-10-05T10:00:00.000Z", M(1000));
    provider.failNext({ kind: "rate_limit", retryAfter: "7" });
    const started = clock.now().getTime();

    const run = await sync.sync(connection, WINDOW);

    expect(run.status).toBe("succeeded");
    expect(clock.sleeps).toEqual([7000]);
    expect(clock.now().getTime() - started).toBe(7000);
    expect(run.retries[0]).toMatchObject({ reason: "rate_limited", wait_ms: 7000, at: "2026-10-12T12:00:00.000Z" });
  });

  it("aceita Retry-After como data HTTP, calculada pelo relógio controlado", async () => {
    const { provider, clock, sync, connection } = setup();
    provider.setPost("p1", "2026-10-05T10:00:00.000Z", M(1000));
    provider.failNext({ kind: "rate_limit", retryAfter: "Mon, 12 Oct 2026 12:00:30 GMT" });

    await sync.sync(connection, WINDOW);

    expect(clock.sleeps).toEqual([30_000]);
  });

  it("Retry-After acima do teto falha na hora, sem esperar", async () => {
    const { provider, clock, sync, connection } = setup({ maxRetryAfterMs: 10_000 });
    provider.failNext({ kind: "rate_limit", retryAfter: "120" });

    const run = await sync.sync(connection, WINDOW);

    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ code: "rate_limited", retry_after_ms: 120_000 });
    expect(clock.sleeps).toEqual([]);
    expect(provider.calls).toHaveLength(1);
  });

  it("espera igual ao teto ainda é aceita", async () => {
    const { provider, clock, sync, connection } = setup({ maxRetryAfterMs: 10_000 });
    provider.failNext({ kind: "rate_limit", retryAfter: "10" });

    const run = await sync.sync(connection, WINDOW);

    expect(run.status).toBe("succeeded");
    expect(clock.sleeps).toEqual([10_000]);
  });

  it("429 repetido para no teto de tentativas", async () => {
    const { provider, clock, sync, connection } = setup({ maxAttempts: 3 });
    provider.failNext(...Array.from({ length: 10 }, () => ({ kind: "rate_limit", retryAfter: "2" }) as const));

    const run = await sync.sync(connection, WINDOW);

    expect(run.error?.code).toBe("retries_exhausted");
    expect(provider.calls).toHaveLength(3);
    expect(clock.sleeps).toEqual([2000, 2000]);
  });

  it("429 sem Retry-After cai no backoff", async () => {
    const { provider, clock, sync, connection } = setup();
    provider.failNext({ kind: "rate_limit" });

    await sync.sync(connection, WINDOW);

    expect(clock.sleeps).toEqual([500]);
  });
});

describe("parseRetryAfter", () => {
  const now = new Date("2026-10-12T12:00:00.000Z");
  it.each([
    ["5", 5000],
    ["0", 0],
    [" 3 ", 3000],
    ["Mon, 12 Oct 2026 11:00:00 GMT", 0], // data no passado
    [undefined, undefined],
    ["", undefined],
    ["logo", undefined],
    ["1.5", undefined],
    ["-5", undefined],
    ["+5", undefined],
  ])("%s", (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });
});
