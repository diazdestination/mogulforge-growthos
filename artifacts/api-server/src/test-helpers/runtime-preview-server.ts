// Starts the real API against the runner's disposable database. Deliberately
// excludes index.ts's legacy concurrent startup seeds: PGlite multiplexes one
// backend and cannot validate PostgreSQL's independent-session startup behavior.
import { pool } from "@workspace/db";
import app from "../app";
import {
  startAutomationScheduler,
  stopAutomationScheduler,
} from "../services/scheduler";

if (
  process.env.RUNTIME_SYNTHETIC_PREVIEW !== "loopback-only" ||
  process.env.HOST !== "127.0.0.1" ||
  new URL(process.env.DATABASE_URL!).hostname !== "127.0.0.1"
)
  throw new Error("Synthetic loopback preview required");
// PGlite exposes one backend through its socket adapter. Multiple concurrent
// pg clients can mix result metadata during a full-page browser load. Serialize
// this disposable visual runner only; real PostgreSQL/production pooling and
// CI's independent-session concurrency checks remain unchanged.
pool.options.max = 1;
const previewPort = Number(process.env.PORT ?? "4192");
if (![4192, 4193].includes(previewPort))
  throw new Error(
    "Only the two disposable loopback preview ports are permitted.",
  );
const server = app.listen(previewPort, "127.0.0.1", () =>
  startAutomationScheduler(),
);
server.once("error", (error) => {
  throw error;
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    const deadline = setTimeout(() => process.exit(1), 10_000);
    void (async () => {
      await stopAutomationScheduler();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      clearTimeout(deadline);
    })();
  });
