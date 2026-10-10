import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function detectSchemaPushFailure(output) {
  const normalized = output.replace(ANSI_PATTERN, "");

  if (/\berror:\s+/i.test(normalized)) {
    return "database error reported by drizzle-kit";
  }

  if (/\bseverity:\s*['\"]ERROR['\"]/i.test(normalized)) {
    return "PostgreSQL reported ERROR severity";
  }

  return null;
}

/**
 * The legacy export remains callable, but generic forced reconciliation is
 * retired for every target. No environment flag authorizes an unreviewed
 * schema delta. Hosted rollout needs its exact reviewed SQL, source, target
 * and recovery procedure; isolated provisioning uses its own local runner.
 */
export function assertStagingSchemaPushGate() {
  throw new Error(
    "Automatic schema reconciliation is retired. Use the reviewed SQL, exact source and target, and approved recovery procedure.",
  );
}

const isDirectExecution =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    assertStagingSchemaPushGate();
  } catch (error) {
    console.error(`Schema release refused: ${error.message}`);
    process.exitCode = 1;
  }
}
