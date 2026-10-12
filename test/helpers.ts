import type { Clock } from "../src/clock.ts";
import { SimulatedProvider } from "../src/simulated-provider.ts";
import { MetricsStore } from "../src/store.ts";
import { DEFAULT_CONFIG, SyncService, type SyncConfig } from "../src/sync.ts";

/** Controlled time: sleep never waits, it moves "now" forward and records the wait. */
export class FakeClock implements Clock {
  readonly sleeps: number[] = [];
  constructor(private current = new Date("2026-10-12T12:00:00.000Z")) {}
  now() {
    return new Date(this.current);
  }
  async sleep(ms: number) {
    this.sleeps.push(ms);
    this.current = new Date(this.current.getTime() + ms);
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const WINDOW = { since: "2026-10-01T00:00:00.000Z", until: "2026-10-12T00:00:00.000Z" };
export const M = (views: number) => ({ views, likes: views / 10, comments: 1, shares: 1 });

export function setup(config: Partial<SyncConfig> = {}, pageSize = 50) {
  const clock = new FakeClock();
  const provider = new SimulatedProvider(pageSize, () => clock.now());
  const store = new MetricsStore();
  const sync = new SyncService(provider, store, clock, { ...DEFAULT_CONFIG, ...config });
  const connection = store.addConnection({ platform: "instagram", account_id: "acc_1", access_token: "fake-token" });
  return { clock, provider, store, sync, connection };
}
