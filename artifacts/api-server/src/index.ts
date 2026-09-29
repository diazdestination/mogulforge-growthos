import { db, pool, organizationsTable } from "@workspace/db";
import app from "./app";
import { runAutoMigrate } from "./lib/auto-migrate";
import { logger } from "./lib/logger";
import {
  ensureDefaultAutomations,
} from "./services/automation";
import { startAutomationScheduler, stopAutomationScheduler } from "./services/scheduler";
import { ensureDefaultServiceAreas, getOrgSettings } from "./services/settings";
import { ensureInstallation } from "./services/installation";
import { ensurePlatformAdmins } from "./services/org";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function main(): Promise<void> {
  // No-op unless AUTO_MIGRATE is set. Awaited before listen so we never serve
  // traffic against a database whose schema hasn't been applied yet.
  await runAutoMigrate();

  const server = app.listen(port, process.env.HOST || "0.0.0.0", (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    startAutomationScheduler();
    // One-time (idempotent) grant: default-org owners become platform admins.
    void ensurePlatformAdmins().catch((err: unknown) =>
      logger.error({ err }, "Ensuring platform admins failed"),
    );
    // One-time (idempotent) seeding of default automations for existing orgs.
    void (async () => {
      const orgs = await db
        .select({ id: organizationsTable.id })
        .from(organizationsTable);
      for (const org of orgs) {
        await ensureDefaultAutomations(org.id);
        await ensureDefaultServiceAreas(org.id);
        // Seed an installation key + authorized domains so the existing
        // first-party website keeps working when it starts sending its key.
        const settings = await getOrgSettings(org.id).catch(() => null);
        const seedDomains = ["localhost"];
        const site = settings?.businessProfile?.website;
        if (site) seedDomains.push(site);
        if (process.env.REPLIT_DEV_DOMAIN) {
          seedDomains.push(process.env.REPLIT_DEV_DOMAIN);
        }
        await ensureInstallation(org.id, seedDomains).catch((err) =>
          logger.error({ err, orgId: org.id }, "Seeding installation failed"),
        );
      }
    })().catch((err) =>
      logger.error(
        { err },
        "Seeding default automations / service areas failed",
      ),
    );
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Draining HTTP requests and background work");
    // Bound shutdown. An interrupted durable receipt remains held for review;
    // a replacement process must never blindly replay an uncertain effect.
    const deadline = setTimeout(() => process.exit(1), 25_000);
    deadline.unref();
    try {
      await Promise.all([
        new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
        stopAutomationScheduler(),
      ]);
      await pool.end();
      clearTimeout(deadline);
    } catch {
      logger.error("Graceful shutdown did not finish; durable actions may need review");
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
}

// Fail fast: a failed schema push means the app would 500 on every request, so
// exit loudly (and let the platform restart us) rather than serve broken.
void main().catch((err: unknown) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
