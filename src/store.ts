import { randomUUID } from "node:crypto";
import type { Metrics, Platform, ProviderPost } from "./provider.ts";

export interface Connection {
  id: string;
  platform: Platform;
  account_id: string;
  /** Already authorized elsewhere. Never returned by the API. */
  access_token: string;
}

export interface StoredPost {
  post_id: string;
  platform: Platform;
  published_at: string;
  metrics: Metrics;
  /** When the provider read these counters. */
  metrics_as_of: string;
  /** When we last received (and accepted or confirmed) them. */
  fetched_at: string;
}

export type UpsertOutcome = "inserted" | "updated" | "unchanged" | "stale";

export interface SyncRun {
  id: string;
  connection_id: string;
  window: { since: string; until: string };
  status: "running" | "succeeded" | "failed";
  started_at: string;
  finished_at?: string;
  /** Requests sent to the provider, retries included. */
  requests: number;
  /** Total time spent waiting between attempts. */
  waited_ms: number;
  retries: { at: string; reason: string; wait_ms: number }[];
  /** Posts per outcome, after collapsing repeats inside the same response. `invalid` were discarded. */
  counts: Record<UpsertOutcome, number> & { duplicates_in_response: number; invalid: number };
  error?: { code: string; message: string; retry_after_ms?: number };
}

export class MetricsStore {
  private connections = new Map<string, Connection>();
  private posts = new Map<string, StoredPost>();
  private runs: SyncRun[] = [];

  addConnection(input: Omit<Connection, "id">): Connection {
    const connection = { id: `con_${randomUUID().slice(0, 8)}`, ...input };
    this.connections.set(connection.id, connection);
    return connection;
  }

  connection(id: string): Connection | undefined {
    return this.connections.get(id);
  }

  addRun(run: SyncRun) {
    this.runs.push(run);
  }

  runsOf(connectionId: string): SyncRun[] {
    return this.runs.filter((r) => r.connection_id === connectionId);
  }

  postsOf(connectionId: string): StoredPost[] {
    return [...this.posts.entries()]
      .filter(([key]) => key.startsWith(`${connectionId}:`))
      .map(([, post]) => post);
  }

  /**
   * Idempotent write. The identity of a post is (connection, post id) and the
   * counters are absolute, so receiving a post again replaces it, never adds to it.
   * Only a snapshot newer than the stored one changes the numbers.
   */
  upsert(connection: Connection, incoming: ProviderPost, now: Date): UpsertOutcome {
    const key = `${connection.id}:${incoming.id}`;
    const stored = this.posts.get(key);
    const fetchedAt = now.toISOString();

    if (!stored) {
      this.posts.set(key, {
        post_id: incoming.id,
        platform: connection.platform,
        published_at: incoming.publishedAt,
        metrics: { ...incoming.metrics },
        metrics_as_of: incoming.metricsAsOf,
        fetched_at: fetchedAt,
      });
      return "inserted";
    }

    const incomingAt = Date.parse(incoming.metricsAsOf);
    const storedAt = Date.parse(stored.metrics_as_of);
    if (incomingAt < storedAt) return "stale"; // an older read must not roll numbers back

    stored.fetched_at = fetchedAt;
    if (incomingAt === storedAt) return "unchanged"; // same snapshot seen again

    stored.metrics = { ...incoming.metrics };
    stored.metrics_as_of = incoming.metricsAsOf;
    return "updated";
  }
}
