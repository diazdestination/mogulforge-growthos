import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** Pure local-evidence boundary; never performs a release or schema operation. */
export function evaluateSavedSchedulingRollback({ expected, artifact, probe } = {}) {
  const held = reason => ({ candidateCompatible:false, releaseEligible:false, reasons:[reason] });
  if (!expected || !artifact || !probe) return held('enforcement_evidence_missing');
  for (const key of ['sourceCommit','sourceTree','schemaSha256','sqlSha256','fixtureSha256']) {
    const pattern = key.startsWith('source') ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
    if (!pattern.test(expected[key] ?? '') || artifact[key] !== expected[key] || probe[key] !== expected[key]) return held('artifact_identity_mismatch');
  }
  if (!Array.isArray(artifact.files) || !artifact.files.length || artifact.files.some(f=>!f || !/^[-a-zA-Z0-9_.]+$/.test(f.path) || !Number.isSafeInteger(f.bytes) || f.bytes<=0 || !/^[a-f0-9]{64}$/.test(f.sha256)) || new Set(artifact.files.map(f=>f.path)).size !== artifact.files.length) return held('artifact_manifest_invalid');
  const hash=createHash('sha256').update(JSON.stringify(artifact.files)).digest('hex');
  if (artifact.artifactSha256!==hash || probe.artifactSha256!==hash) return held('artifact_bytes_mismatch');
  const required=['reduced:appointment','reduced:project','disabled:appointment','disabled:project'];
  if (!Array.isArray(probe.cases) || probe.cases.length!==4 || probe.cases.some(c=>!c || !required.includes(`${c.policy}:${c.targetKind}`) || c.controlStatus!==201 || c.refusedStatus!==409 || c.code!=='manual_scheduling_refused' || c.outcome!=='no_commit_refused' || c.refusalCode!=='travel_conflict' || c.auditInserts!==2 || c.otherWrites!==0 || c.equalityStatus!==201) || new Set(probe.cases.map(c=>`${c.policy}:${c.targetKind}`)).size!==4) return held('saved_gap_enforcement_unverified');
  if (probe.engine!=='PGlite embedded PostgreSQL' || !/^[a-f0-9]{64}$/.test(probe.restoredFingerprint??'') || probe.cleanupVerified!==true || probe.providerCalls!==0) return held('probe_boundary_unverified');
  // This wave has no second reviewed artifact or complete scheduling mutation
  // hold. A label, boolean or repeated candidate can never clear that gate.
  return {candidateCompatible:true,releaseEligible:false,reasons:['second_compatible_artifact_unverified']};
}

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
