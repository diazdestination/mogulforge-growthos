import { test, expect } from "vitest";
import { readerTimingCase } from "./test-support/live-reader-timing.mjs";
import { production75Diagnostic } from "./production75-safe-diagnostics.mjs";

for (const kind of ["legacy", "scheduling"]) {
  test.each([undefined, null, false, 0, ""])(
    `${kind} falsy primary %s survives rollback rejection`,
    async (mainFailure) => {
      const f = readerTimingCase({
        kind,
        failMain: true,
        mainFailure,
        rollbackFailure: Error("synthetic rollback"),
        otherDatabaseMs: 0,
      });
      let rejected = false,
        observed;
      try {
        await f.run();
      } catch (error) {
        rejected = true;
        observed = error;
      }
      expect(rejected).toBe(true);
      expect(observed).toBe(mainFailure);
      expect(f.metrics.rollback).toBe(1);
    },
  );
  test(`${kind} rollback-only rejection still holds the Reader`, async () => {
    const failure = Error("synthetic rollback-only"),
      f = readerTimingCase({
        kind,
        rollbackFailure: failure,
        otherDatabaseMs: 0,
      });
    await expect(f.run()).rejects.toBe(failure);
    expect(production75Diagnostic(failure).stage).toBe(
      `${kind === "legacy" ? "legacy" : "scheduling"}-reader-rollback`,
    );
  });
  test(`${kind} rollback failure cannot replace the primary observation failure`, async () => {
    const primary = Error("synthetic primary observation"),
      secondary = Error("synthetic secondary rollback"),
      f = readerTimingCase({
        kind,
        mainFailure: primary,
        rollbackFailure: secondary,
        otherDatabaseMs: 0,
      });
    await expect(f.run()).rejects.toBe(primary);
    expect(production75Diagnostic(primary)).toEqual({
      stage: `${kind}-reader-state`,
      safeCode: "production75_diagnostic_unknown",
      secondary: {
        stage: `${kind}-reader-rollback`,
        safeCode: "production75_diagnostic_unknown",
      },
    });
    expect(f.metrics.rollback).toBe(1);
    expect(f.metrics.writerCalls).toBe(0);
  });
  test.each([0, 19999])(
    `${kind} Reader supports short observations (%dms)`,
    async (otherDatabaseMs) => {
      const f = readerTimingCase({ kind, otherDatabaseMs });
      await expect(f.run()).resolves.toBeDefined();
      expect(f.metrics).toMatchObject({
        begin: 1,
        rollback: 1,
        writerCalls: 0,
        transactionOpen: false,
      });
    },
  );
  test.each([20001, 60000])(
    `${kind} Reader does not stay in a transaction during slow other-database observations (%dms)`,
    async (otherDatabaseMs) => {
      const f = readerTimingCase({ kind, otherDatabaseMs });
      await expect(f.run()).resolves.toBeDefined();
      expect(f.metrics).toMatchObject({
        begin: 1,
        rollback: 1,
        writerCalls: 0,
        transactionOpen: false,
        otherCaptures: 1,
        otherInsideTransaction: [false],
      });
    },
  );
  test(`${kind} other-database failure retains its identity without an idle Reader rollback masking it`, async () => {
    const failure = Error("synthetic other database failure"),
      f = readerTimingCase({ kind, otherFailure: failure });
    await expect(f.run()).rejects.toBe(failure);
    expect(f.metrics.transactionOpen).toBe(false);
    expect(f.metrics.writerCalls).toBe(0);
  });
  test(`${kind} main observation failure closes its Reader transaction`, async () => {
    const failure = Error("synthetic main observation failure"),
      f = readerTimingCase({ kind, mainFailure: failure, otherDatabaseMs: 0 });
    await expect(f.run()).rejects.toBe(failure);
    expect(f.metrics).toMatchObject({
      begin: 1,
      rollback: 1,
      transactionOpen: false,
      writerCalls: 0,
    });
  });
}
