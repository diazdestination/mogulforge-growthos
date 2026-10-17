import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluateSavedSchedulingRollback } from './release-schema.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function evidence() {
  const identity = { sourceCommit:'1'.repeat(40), sourceTree:'2'.repeat(40), schemaSha256:'3'.repeat(64), sqlSha256:'4'.repeat(64), fixtureSha256:'5'.repeat(64) };
  const files = [{ path:'contractor-recovery-entry.mjs', bytes:123, sha256:'6'.repeat(64) }, { path:'pino-worker.mjs', bytes:45, sha256:'7'.repeat(64) }];
  const artifact = { ...identity, files, artifactSha256:hash(files) };
  const cases = ['reduced','disabled'].flatMap(policy => ['appointment','project'].map(targetKind => ({policy,targetKind,controlStatus:201,refusedStatus:409,code:'manual_scheduling_refused',outcome:'no_commit_refused',refusalCode:'travel_conflict',auditInserts:2,otherWrites:0,equalityStatus:201})));
  const probe = { ...identity, artifactSha256:artifact.artifactSha256, engine:'PGlite embedded PostgreSQL', restoredFingerprint:'8'.repeat(64), cases, cleanupVerified:true, providerCalls:0 };
  return { expected:identity, artifact, probe };
}
describe('saved scheduling writable rollback boundary', () => {
  it('accepts exact local enforcement evidence but holds release without a second independently verified artifact', () => {
    const result = evaluateSavedSchedulingRollback(evidence());
    expect(result.candidateCompatible).toBe(true);
    expect(result.releaseEligible).toBe(false);
    expect(result.reasons).toContain('second_compatible_artifact_unverified');
  });
  it.each(['sourceCommit','sourceTree','schemaSha256','sqlSha256','fixtureSha256'])('rejects mismatched %s', field => {
    const input=evidence(); input.probe[field]='f'.repeat(field.startsWith('source')?40:64);
    expect(evaluateSavedSchedulingRollback(input).candidateCompatible).toBe(false);
  });
  it.each(['controlStatus','refusedStatus','refusalCode','auditInserts','otherWrites','equalityStatus'])('rejects false enforcement: %s', field => {
    const input=evidence(); input.probe.cases[0][field]=field==='refusalCode'?'stale_scheduling_review':99;
    expect(evaluateSavedSchedulingRollback(input).candidateCompatible).toBe(false);
  });
  it('rejects column counts, labels, boolean claims and incomplete policy/target coverage', () => {
    expect(evaluateSavedSchedulingRollback({ artifact:{name:'PR57',tables:142,savedSnapshotEnforcement:true} }).candidateCompatible).toBe(false);
    const input=evidence(); input.probe.cases.pop();
    expect(evaluateSavedSchedulingRollback(input).candidateCompatible).toBe(false);
  });
  it('binds all worker bytes and refuses missing cleanup or provider activity', () => {
    const input=evidence(); input.artifact.files[1].sha256='0'.repeat(64);
    expect(evaluateSavedSchedulingRollback(input).candidateCompatible).toBe(false);
    for (const change of [{cleanupVerified:false},{providerCalls:1}]) {
      const next=evidence(); Object.assign(next.probe,change);
      expect(evaluateSavedSchedulingRollback(next).candidateCompatible).toBe(false);
    }
  });
  it('does not certify a claimed second artifact or a rerun of the same candidate', () => {
    const input=evidence(); input.rollbackArtifact={...input.artifact,independentlyVerified:true};
    expect(evaluateSavedSchedulingRollback(input).releaseEligible).toBe(false);
  });
  it('fails closed for malformed artifact or case entries', () => {
    for(const field of ['files','cases']) {
      const input=evidence();
      if(field==='files') input.artifact.files=[null]; else input.probe.cases=[null,null,null,null];
      expect(evaluateSavedSchedulingRollback(input).candidateCompatible).toBe(false);
    }
  });
});
