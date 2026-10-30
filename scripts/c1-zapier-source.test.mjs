import { beforeAll, describe, expect, it } from 'vitest';
import { loadC1SourceSnapshot, verifyC1SourceSnapshot, applyC1ZapierAmendment } from './c1-source-preservation.mjs';

const APPROVED_HEAD = '7e5a5832041b00686dacbde68e977efde7527366';
let original;
beforeAll(() => { original = loadC1SourceSnapshot(); }, 30000);
const copy = () => structuredClone(original);

describe('exact Zapier Connected Apps source successor', () => {
  it('accepts the owner-approved source while retaining the historical revenue proof and release hold', () => {
    const proof = verifyC1SourceSnapshot(original);
    expect(proof.revenueOpportunitiesAmendment.scope).toEqual({ count: 2124, sha256: 'e4dd528c0b4ace7d638df724bf704b74bc33bfc43a3879bd8f9000a88dab35ea' });
    expect(proof.zapierConnectedAppsAmendment.sourceCommit).toBe(APPROVED_HEAD);
    expect(proof.currentScope).toEqual({ count: 2134, sha256: '0291108bb05805ab9a16f7cbdc9ff9e5b44f9f880d74ad613bc7ad7b880a3997' });
    expect(proof.zapierConnectedAppsAmendment.changedPaths).toHaveLength(19);
    expect(proof.zapierConnectedAppsAmendment.releaseEligible).toBe(false);
    expect(proof.releaseEligible).toBe(false);
  });

  it.each(['zapierAmendment', 'zapierOriginal', 'zapierCurrent'])('rejects changed %s bytes', key => {
    const snapshot = copy();
    expect(snapshot[key]).toBeDefined();
    const bytes = key === 'zapierAmendment' ? snapshot[key] : snapshot[key][0].bytes;
    bytes[0] ^= 1;
    expect(() => verifyC1SourceSnapshot(snapshot)).toThrow(/changed/);
  });

  it.each(['commit', 'tree', 'parents', 'isAncestor', 'product'])('rejects changed %s for both source identities', field => {
    for (const key of ['zapierBase', 'zapierSource']) {
      const snapshot = copy();
      expect(snapshot[key]).toBeDefined();
      const source = snapshot[key];
      if (field === 'commit' || field === 'tree') source[field] = '0'.repeat(40);
      if (field === 'parents') source.parents.push('0'.repeat(40));
      if (field === 'isAncestor') source.isAncestor = false;
      if (field === 'product') source.product[0].blob = '0'.repeat(40);
      expect(() => verifyC1SourceSnapshot(snapshot)).toThrow();
    }
  });

  it.each(['zapierOriginal', 'zapierCurrent'])('rejects pin coverage, mode and blob changes in %s', key => {
    for (const change of ['missing', 'extra', 'duplicate', 'mode', 'blob']) {
      const snapshot = copy();
      expect(snapshot[key]).toBeDefined();
      const rows = snapshot[key];
      if (change === 'missing') rows.pop();
      if (change === 'extra') rows.push({ ...rows[0], path: 'lib/unreviewed.ts' });
      if (change === 'duplicate') rows.push(rows[0]);
      if (change === 'mode') rows[0].mode = '100755';
      if (change === 'blob') rows[0].blob = '0'.repeat(40);
      expect(() => verifyC1SourceSnapshot(snapshot)).toThrow(/coverage|changed/);
    }
  });

  it('allows only the exact nineteen-path successor, including its ten new files', () => {
    const descriptor = JSON.parse(Buffer.from(original.zapierAmendment).toString());
    const base = new Map(original.zapierBase.product.map(row => [row.path, row]));
    const apply = changes => applyC1ZapierAmendment(base, changes);
    expect([...apply(descriptor.changes).values()]).toHaveLength(2134);
    expect(descriptor.changes.filter(change => change.before === null)).toHaveLength(10);
    const stale = structuredClone(descriptor.changes); stale[0].before.blob = '0'.repeat(40);
    expect(() => apply(stale)).toThrow(/base path changed/);
    const invented = structuredClone(descriptor.changes); const added = invented.find(change => change.before === null); added.before = { path: added.path, mode: '100644', blob: '0'.repeat(40) };
    expect(() => apply(invented)).toThrow(/base path changed/);
    expect(() => apply(descriptor.changes.slice(1))).toThrow(/coverage/);
    expect(() => apply([...descriptor.changes, descriptor.changes[0]])).toThrow(/duplicate/);
    const extra = structuredClone(descriptor.changes); extra[0].path = 'lib/unreviewed.ts';
    expect(() => apply(extra)).toThrow(/coverage/);
    const deleted = structuredClone(descriptor.changes); deleted[0].after = null;
    expect(() => apply(deleted)).toThrow(/cannot delete/);
  });
});
