// Boundary between the business rules (sync.ts) and the social network.
// The provider only knows how to fetch one page and fail in HTTP-shaped ways.
// Everything else (retry, waiting, dedup, storage) lives on the other side.

export const PLATFORMS = ["instagram", "tiktok", "youtube", "x"] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface Metrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

/** Absolute counters of a post, read by the provider at `metricsAsOf`. */
export interface ProviderPost {
  id: string;
  publishedAt: string;
  metrics: Metrics;
  metricsAsOf: string;
}

export interface FetchRequest {
  platform: Platform;
  accountId: string;
  accessToken: string;
  /** Posts published in [since, until). */
  since: string;
  until: string;
  cursor?: string;
  signal?: AbortSignal;
}

export interface ProviderPage {
  posts: ProviderPost[];
  nextCursor?: string;
}

export interface MetricsProvider {
  fetchPosts(req: FetchRequest): Promise<ProviderPage>;
}

export class ProviderTimeoutError extends Error {
  constructor() {
    super("o provedor não respondeu a tempo");
  }
}

export class ProviderHttpError extends Error {
  constructor(public readonly status: number) {
    super(`o provedor respondeu ${status}`);
  }
}

/** 429. `retryAfter` is the raw Retry-After header: seconds or an HTTP date. */
export class ProviderRateLimitError extends Error {
  constructor(public readonly retryAfter?: string) {
    super("o provedor respondeu 429");
  }
}
