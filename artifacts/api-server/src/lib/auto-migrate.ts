/**
 * Startup schema mutation is retired. Keep this guard awaited before normal
 * startup so a legacy AUTO_MIGRATE setting fails clearly instead of applying
 * an unreviewed delta. Provisioning uses the reviewed release procedure.
 */
export async function runAutoMigrate(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const raw = env.AUTO_MIGRATE?.trim().toLowerCase();
  if (raw !== "true" && raw !== "1" && raw !== "yes") return;
  throw new Error(
    "Automatic startup schema reconciliation is retired. Leave AUTO_MIGRATE unset or false and apply reviewed SQL through the approved exact-source, target and recovery procedure.",
  );
}
