import { beforeAll, describe, expect, it } from 'vitest';
import { loadC1SourceSnapshot, verifyC1SourceSnapshot, applyC1RevenueAmendment } from './c1-source-preservation.mjs';

let original;
beforeAll(() => { original = loadC1SourceSnapshot(); }, 30000);
const copy = () => structuredClone(original);

describe('exact Revenue Opportunities source successor', () => {
  it('accepts the owner-approved source while retaining the historical inquiry proof and release hold', () => {
    const proof = verifyC1SourceSnapshot(original);
    expect(proof.inquiryConsentAmendment.integration.scope.sha256).toBe('c0519f20f3cf8e0e26ac1aa6d19701e4c587450fd82d6c4d8b359070703ef497');
    expect(proof.revenueOpportunitiesAmendment.sourceCommit).toBe('0db6be4cbffde55130dbbd1a7a61993489ed40c9');
    expect(proof.currentScope).toEqual({ count: 2124, sha256: 'e4dd528c0b4ace7d638df724bf704b74bc33bfc43a3879bd8f9000a88dab35ea' });
    expect(proof.revenueOpportunitiesAmendment.changedPaths).toHaveLength(3);
    expect(proof.revenueOpportunitiesAmendment.releaseEligible).toBe(false);
    expect(proof.releaseEligible).toBe(false);
  });

  it.each(['revenueAmendment', 'revenueOriginal', 'revenueCurrent'])('rejects changed %s bytes', key => {
    const snapshot = copy();
    expect(snapshot[key]).toBeDefined();
    const bytes = key === 'revenueAmendment' ? snapshot[key] : snapshot[key][0].bytes;
    bytes[0] ^= 1;
    expect(() => verifyC1SourceSnapshot(snapshot)).toThrow(/changed/);
  });

  it.each(['commit', 'tree', 'parents', 'isAncestor', 'product'])('rejects changed %s for both source identities', field => {
    for (const key of ['revenueBase', 'revenueSource']) {
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

  it.each(['revenueOriginal', 'revenueCurrent'])('rejects pin coverage, mode and blob changes in %s', key => {
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

  it('allows only the exact three-path successor, including its one new route', () => {
    const descriptor = JSON.parse(Buffer.from(original.revenueAmendment).toString());
    const base = new Map(original.revenueBase.product.map(row => [row.path, row]));
    const apply = changes => applyC1RevenueAmendment(base, changes);
    expect([...apply(descriptor.changes).values()]).toHaveLength(2124);
    const stale = structuredClone(descriptor.changes); stale[0].before.blob = '0'.repeat(40);
    expect(() => apply(stale)).toThrow(/base path changed/);
    expect(() => apply(descriptor.changes.slice(1))).toThrow(/coverage/);
    expect(() => apply([...descriptor.changes, descriptor.changes[0]])).toThrow(/duplicate/);
    const extra = structuredClone(descriptor.changes); extra[0].path = 'lib/unreviewed.ts';
    expect(() => apply(extra)).toThrow(/coverage/);
    const deleted = structuredClone(descriptor.changes); deleted[0].after = null;
    expect(() => apply(deleted)).toThrow(/cannot delete/);
  });
});
