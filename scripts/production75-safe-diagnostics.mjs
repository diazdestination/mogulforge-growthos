/** Content-free diagnostics only. Never transaction, retry or admission evidence. */
import { types } from "node:util";

const codes = new Set([
  "production75_diagnostic_unknown",
  "production75_live_client",
  "production75_live_query",
  "production75_live_deadline",
  "production75_live_identity",
  "production75_live_capabilities",
  "production75_live_socket",
  "production75_combined_protected",
  "production75_operator_deadline",
  "production75_operator_resources",
]);
const stages = new Set([
  "operator-callback",
  "legacy-context",
  "scheduling-context",
  "transport-connect",
  "transport-close",
  "snapshot-close",
  "snapshot-rollback",
  "legacy-reader-other-databases",
  "legacy-reader-begin",
  "legacy-reader-state",
  "legacy-reader-extras",
  "legacy-reader-capabilities",
  "legacy-reader-rollback",
  "scheduling-reader-protected",
  "scheduling-reader-other-databases",
  "scheduling-reader-begin",
  "scheduling-reader-state",
  "scheduling-reader-extras",
  "scheduling-reader-capabilities",
  "scheduling-reader-invariants",
  "scheduling-reader-rollback",
]);
const ownedCodes = new WeakMap(),
  records = new WeakMap(),
  sealed = new WeakSet();
const object = (value) =>
  value !== null && typeof value === "object" && !types.isProxy(value);
function record(value) {
  if (!object(value) || sealed.has(value)) return null;
  let entry = records.get(value);
  if (!entry) {
    entry = {};
    records.set(value, entry);
  }
  return entry;
}
export function registerProduction75SafeError(error, code) {
  if (object(error) && !sealed.has(error) && codes.has(code))
    ownedCodes.set(error, code);
  return error;
}
export function recordProduction75DriverFailure(error, driverError) {
  // Own data descriptors only: no getters, proxy traps, coercion or raw Error serialization.
  try {
    const entry = record(error);
    if (!entry || !object(driverError)) return error;
    if (!entry.stage && records.get(driverError)?.stage)
      entry.stage = records.get(driverError).stage;
    const code = Object.getOwnPropertyDescriptor(driverError, "code")?.value;
    if (
      !entry.sqlState &&
      typeof code === "string" &&
      code.length === 5 &&
      /^[0-9A-Z]{5}$/.test(code)
    )
      entry.sqlState = code;
  } catch {
    /* Diagnostic capture cannot replace the original failure. */
  }
  return error;
}
export function transferProduction75Diagnostic(target, source) {
  // Sanitizers retain their existing public classification. Copy only privately
  // owned diagnostics, never properties on the incoming error or driver object.
  try {
    if (!object(source)) return target;
    const entry = record(target),
      prior = records.get(source);
    if (!entry) return target;
    if (!ownedCodes.has(target) && ownedCodes.has(source))
      ownedCodes.set(target, ownedCodes.get(source));
    for (const field of ["stage", "sqlState", "secondary"])
      if (entry[field] === undefined && prior?.[field] !== undefined)
        entry[field] = prior[field];
  } catch {
    /* Capture cannot replace the primary failure. */
  }
  return target;
}
function view(error, fallbackStage) {
  const entry = object(error) ? records.get(error) : null;
  const value = {
    stage:
      entry?.stage ??
      (stages.has(fallbackStage) ? fallbackStage : "operator-callback"),
    safeCode: object(error)
      ? (ownedCodes.get(error) ?? "production75_diagnostic_unknown")
      : "production75_diagnostic_unknown",
  };
  if (entry?.sqlState) value.sqlState = entry.sqlState;
  return value;
}
export async function withProduction75Stage(stage, action) {
  try {
    return await action();
  } catch (error) {
    const entry = record(error);
    if (entry && !entry.stage && stages.has(stage)) entry.stage = stage;
    throw error;
  }
}
export function recordProduction75Secondary(primary, secondary, stage) {
  const entry = record(primary);
  if (entry && !entry.secondary && stages.has(stage))
    entry.secondary = Object.freeze({ ...view(secondary, stage), stage });
}
export function production75Diagnostic(
  error,
  fallbackStage = "operator-callback",
) {
  const value = view(error, fallbackStage),
    entry = object(error) ? records.get(error) : null;
  if (entry?.secondary) value.secondary = entry.secondary;
  if (object(error)) sealed.add(error);
  return Object.freeze(value);
}
