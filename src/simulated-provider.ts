import {
  ProviderHttpError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  type FetchRequest,
  type Metrics,
  type MetricsProvider,
  type ProviderPage,
  type ProviderPost,
} from "./provider.ts";

/** One scripted failure, consumed by the next fetchPosts call. */
export type Fault =
  | { kind: "ok" } // lets this call through, to place a failure on a later one
  | { kind: "timeout" }
  | { kind: "hang" } // never answers; only the caller's abort ends it
  | { kind: "http"; status: number }
  | { kind: "rate_limit"; retryAfter?: string }
  | { kind: "duplicate_page" }; // answers, but repeats the first post

/** In-memory stand-in for a social network API. Deterministic: faults are scripted. */
export class SimulatedProvider implements MetricsProvider {
  readonly calls: FetchRequest[] = [];
  private posts = new Map<string, ProviderPost>();
  private faults: Fault[] = [];

  constructor(
    private readonly pageSize = 50,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Creates the post or publishes a new snapshot of its counters. */
  setPost(id: string, publishedAt: string, metrics: Metrics, metricsAsOf = this.now().toISOString()) {
    this.posts.set(id, { id, publishedAt, metrics, metricsAsOf });
  }

  failNext(...faults: Fault[]) {
    this.faults.push(...faults);
  }

  async fetchPosts(req: FetchRequest): Promise<ProviderPage> {
    this.calls.push(req);
    const fault = this.faults.shift();
    if (fault?.kind === "timeout") throw new ProviderTimeoutError();
    if (fault?.kind === "http") throw new ProviderHttpError(fault.status);
    if (fault?.kind === "rate_limit") throw new ProviderRateLimitError(fault.retryAfter);
    if (fault?.kind === "hang") {
      await new Promise<void>((_, reject) =>
        req.signal?.addEventListener("abort", () => reject(new ProviderTimeoutError())),
      );
    }

    const since = Date.parse(req.since);
    const until = Date.parse(req.until);
    const inWindow = [...this.posts.values()]
      .filter((p) => Date.parse(p.publishedAt) >= since && Date.parse(p.publishedAt) < until)
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id));

    const start = req.cursor ? Number(req.cursor) : 0;
    const posts = inWindow.slice(start, start + this.pageSize).map((p) => structuredClone(p));
    const end = start + this.pageSize;
    if (fault?.kind === "duplicate_page" && posts[0]) posts.push(structuredClone(posts[0]));
    return { posts, nextCursor: end < inWindow.length ? String(end) : undefined };
  }
}
