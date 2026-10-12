import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { SimulatedProvider } from "./simulated-provider.ts";
import { MetricsStore } from "./store.ts";
import { SyncService } from "./sync.ts";

const port = Number(process.env.PORT ?? 3004);

// Demo data for the simulated provider; the real one would call the network API.
const provider = new SimulatedProvider(2);
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
for (let i = 1; i <= 5; i++) {
  provider.setPost(`post_${i}`, day(i), { views: 1000 * i, likes: 90 * i, comments: 8 * i, shares: 3 * i });
}

const store = new MetricsStore();
const app = createApp(store, new SyncService(provider, store, systemClock));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`métricas em http://127.0.0.1:${info.port}`);
});
