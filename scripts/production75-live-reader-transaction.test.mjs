import { test, expect } from "vitest";
import { readerTimingCase } from "./test-support/live-reader-timing.mjs";

for (const kind of ["legacy", "scheduling"]) {
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
