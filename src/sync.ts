import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.ts";
import {
  ProviderHttpError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  type MetricsProvider,
  type ProviderPage,
  type ProviderPost,
} from "./provider.ts";
import type { Connection, MetricsStore, SyncRun } from "./store.ts";

export interface SyncConfig {
  /** Attempts per page request, the first one included. */
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Longest Retry-After we are willing to wait. Longer than this fails the sync. */
  maxRetryAfterMs: number;
  /** Total waiting allowed in one sync, all pages and causes together. */
  maxTotalWaitMs: number;
  requestTimeoutMs: number;
  /** Guard against a provider that never stops paginating. */
  maxPages: number;
}

export const DEFAULT_CONFIG: SyncConfig = {
  maxAttempts: 4,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  maxRetryAfterMs: 60_000,
  maxTotalWaitMs: 120_000,
  requestTimeoutMs: 10_000,
  maxPages: 200,
};

class SyncFailure extends Error {
  constructor(
    public readonly code: "rate_limited" | "retries_exhausted" | "unauthorized" | "provider_error" | "too_many_pages" | "wait_budget_exceeded",
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/**
 * Retry-After is delta-seconds or an HTTP date. Returns milliseconds from `now`,
 * or undefined when the header is missing or unreadable.
 */
export function parseRetryAfter(value: string | undefined, now: Date): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // Strict: Date.parse accepts junk like "1.5" or "-5" as a date.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return undefined;
  const date = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now.getTime());
}

/** A post we can trust: usable id, real dates, and non-negative finite counters. */
function isValid(post: ProviderPost): boolean {
  const counters = [post.metrics?.views, post.metrics?.likes, post.metrics?.comments, post.metrics?.shares];
  return (
    typeof post.id === "string" &&
    post.id !== "" &&
    !Number.isNaN(Date.parse(post.publishedAt)) &&
    !Number.isNaN(Date.parse(post.metricsAsOf)) &&
    counters.every((n) => Number.isFinite(n) && n >= 0)
  );
}

export class SyncService {
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly provider: MetricsProvider,
    private readonly store: MetricsStore,
    private readonly clock: Clock,
    private readonly config: SyncConfig = DEFAULT_CONFIG,
  ) {}

  /**
   * Syncs posts published in [since, until). Syncs of the same connection run one
   * at a time, so overlapping windows never interleave their writes.
   */
  sync(connection: Connection, window: { since: string; until: string }): Promise<SyncRun> {
    const previous = this.locks.get(connection.id) ?? Promise.resolve();
    const run = previous.then(() => this.execute(connection, window));
    const tail = run.catch(() => undefined);
    this.locks.set(connection.id, tail);
    void tail.then(() => {
      if (this.locks.get(connection.id) === tail) this.locks.delete(connection.id);
    });
    return run;
  }

  private async execute(connection: Connection, window: { since: string; until: string }): Promise<SyncRun> {
    const run: SyncRun = {
      id: `syn_${randomUUID().slice(0, 8)}`,
      connection_id: connection.id,
      window,
      status: "running",
      started_at: this.clock.now().toISOString(),
      requests: 0,
      waited_ms: 0,
      retries: [],
      counts: { inserted: 0, updated: 0, unchanged: 0, stale: 0, duplicates_in_response: 0, invalid: 0 },
    };
    this.store.addRun(run);

    try {
      let cursor: string | undefined;
      let pages = 0;
      do {
        if (pages >= this.config.maxPages) {
          throw new SyncFailure("too_many_pages", `mais de ${this.config.maxPages} páginas, sync interrompido`);
        }
        const page = await this.fetchPage(connection, window, cursor, run);
        pages += 1;
        // Each page is saved as it arrives. A later failure keeps this progress,
        // and re-running is safe because writes are idempotent.
        this.apply(connection, page, run);
        cursor = page.nextCursor;
      } while (cursor);
      run.status = "succeeded";
    } catch (err) {
      run.status = "failed";
      run.error =
        err instanceof SyncFailure
          ? { code: err.code, message: err.message, retry_after_ms: err.retryAfterMs }
          : { code: "provider_error", message: err instanceof Error ? err.message : String(err) };
    }
    run.finished_at = this.clock.now().toISOString();
    return run;
  }

  private apply(connection: Connection, page: ProviderPage, run: SyncRun) {
    // The provider may repeat a post inside one response. Keep the newest read.
    const unique = new Map<string, ProviderPost>();
    for (const post of page.posts) {
      if (!isValid(post)) {
        run.counts.invalid += 1;
        continue;
      }
      const seen = unique.get(post.id);
      if (seen) run.counts.duplicates_in_response += 1;
      if (!seen || Date.parse(post.metricsAsOf) > Date.parse(seen.metricsAsOf)) unique.set(post.id, post);
    }
    for (const post of unique.values()) {
      run.counts[this.store.upsert(connection, post, this.clock.now())] += 1;
    }
  }

  private async fetchPage(
    connection: Connection,
    window: { since: string; until: string },
    cursor: string | undefined,
    run: SyncRun,
  ): Promise<ProviderPage> {
    for (let attempt = 1; ; attempt++) {
      run.requests += 1;
      let reason: string;
      let waitMs: number;
      try {
        return await this.request(connection, window, cursor);
      } catch (err) {
        if (err instanceof ProviderRateLimitError) {
          const asked = parseRetryAfter(err.retryAfter, this.clock.now());
          if (asked !== undefined && asked > this.config.maxRetryAfterMs) {
            // Waiting less than asked would only earn another 429.
            throw new SyncFailure(
              "rate_limited",
              `limite de taxa: o provedor pediu ${asked} ms, acima do teto de ${this.config.maxRetryAfterMs} ms`,
              asked,
            );
          }
          reason = "rate_limited";
          waitMs = asked ?? this.backoff(attempt);
        } else if (err instanceof ProviderTimeoutError || (err instanceof ProviderHttpError && err.status >= 500)) {
          reason = err instanceof ProviderTimeoutError ? "timeout" : `http_${(err as ProviderHttpError).status}`;
          waitMs = this.backoff(attempt);
        } else if (err instanceof ProviderHttpError && (err.status === 401 || err.status === 403)) {
          throw new SyncFailure("unauthorized", `o provedor recusou a conexão (${err.status})`);
        } else {
          throw new SyncFailure("provider_error", err instanceof Error ? err.message : String(err));
        }
        if (attempt >= this.config.maxAttempts) {
          throw new SyncFailure("retries_exhausted", `${attempt} tentativas sem sucesso (último motivo: ${reason})`);
        }
      }
      if (run.waited_ms + waitMs > this.config.maxTotalWaitMs) {
        throw new SyncFailure(
          "wait_budget_exceeded",
          `espera total passaria de ${this.config.maxTotalWaitMs} ms (último motivo: ${reason})`,
        );
      }
      run.waited_ms += waitMs;
      run.retries.push({ at: this.clock.now().toISOString(), reason, wait_ms: waitMs });
      await this.clock.sleep(waitMs);
    }
  }

  private backoff(attempt: number): number {
    return Math.min(this.config.baseBackoffMs * 2 ** (attempt - 1), this.config.maxBackoffMs);
  }

  private async request(connection: Connection, window: { since: string; until: string }, cursor?: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const call = this.provider.fetchPosts({
        platform: connection.platform,
        accountId: connection.account_id,
        accessToken: connection.access_token,
        ...window,
        cursor,
        signal: controller.signal,
      });
      call.catch(() => undefined); // a late failure after the timeout must not go unhandled
      // A provider that ignores the signal must not hang the sync either.
      const timeout = new Promise<never>((_, reject) =>
        controller.signal.addEventListener("abort", () => reject(new ProviderTimeoutError())),
      );
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
