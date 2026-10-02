import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  db,
  organizationsTable,
  contactsTable,
  leadsTable,
  appointmentsTable,
  estimatesTable,
  projectsTable,
  valueEntriesTable,
  playbooksTable,
  playbookEnrollmentsTable,
  playbookTouchesTable,
  reactivationCampaignsTable,
  reactivationCampaignLeadsTable,
  type ImportedOpportunityHistory,
} from "@workspace/db";
import { getRoiReport, roiReportToCsv } from "./roi-report";
import { valueLedger } from "./revenue-workspace";
import { parseReportingPeriod, reportQuerySchema } from "./reporting-period";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

const end = new Date();
const at = (daysAgo: number) => new Date(end.getTime() - daysAgo * 86_400_000);
const period = {
  startAt: at(30).toISOString(),
  endAt: end.toISOString(),
  timeZone: "UTC" as const,
};
const orgs: string[] = [];
async function tenant() {
  if (new URL(process.env.DATABASE_URL!).hostname !== "127.0.0.1")
    throw new Error("Local DB only");
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "Reporting QA", slug: `report-${randomUUID()}` })
    .returning();
  orgs.push(org.id);
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "Fictional",
      lastName: "Owner",
    })
    .returning();
  const lead = async (values: Partial<typeof leadsTable.$inferInsert> = {}) => {
    const [row] = await db
      .insert(leadsTable)
      .values({
        organizationId: org.id,
        contactId: contact.id,
        createdAt: at(2),
        ...values,
      })
      .returning();
    return row;
  };
  return { org: org.id, lead };
}
function history(originalCreatedAt: string | null): ImportedOpportunityHistory {
  return {
    version: 1,
    kind: "csv_snapshot",
    originalCreatedAt,
    sourceUpdatedAt: null,
    statusChangedAt: null,
    lastContactAt: null,
    snapshotAsOf: null,
    firstImportedAt: at(1).toISOString(),
    lastImportedAt: at(1).toISOString(),
    externalCustomerId: null,
    externalEstimateId: null,
    currency: null,
    fingerprint: "a".repeat(64),
    appliedFingerprint: "a".repeat(64),
    mappedFields: ["originalCreatedAt"],
  };
}
afterAll(() => deleteTestOrgs(...orgs));

describe("owner report period correctness", () => {
  it("uses source creation history for the cohort and unique tenant-valid cohort bookings", async () => {
    const t = await tenant(),
      foreign = await tenant();
    const fresh = await t.lead();
    await t.lead();
    const old = await t.lead({ createdAt: at(90) });
    await t.lead({
      creationMethod: "import",
      importedHistory: history(at(180).toISOString()),
    });
    await t.lead({ creationMethod: "import", importedHistory: history(null) });
    await t.lead({ creationMethod: "import" });
    const other = await foreign.lead();
    await db.insert(appointmentsTable).values([
      ...[fresh.id, fresh.id, old.id].map((leadId) => ({
        organizationId: t.org,
        leadId,
        createdAt: at(1),
        scheduledStart: at(-30),
      })),
      {
        organizationId: t.org,
        leadId: fresh.id,
        status: "cancelled" as const,
        createdAt: at(1),
        scheduledStart: at(1),
      },
      {
        organizationId: t.org,
        leadId: other.id,
        createdAt: at(1),
        scheduledStart: at(1),
      },
    ]);
    const report = await getRoiReport(t.org, 30, end);
    expect(report.leads.total).toBe(2);
    expect(report.appointments).toMatchObject({
      total: 3,
      leadsWithAppointment: 1,
      distinctBookedLeads: 2,
      appointmentRatePct: 50,
    });
    expect(report.dataQuality.unknownOriginalDates).toBe(2);
  });

  it("bounds events at both ends, preserves unknown win values and compares the prior equal period", async () => {
    const t = await tenant();
    await t.lead({ wonAt: at(1), status: "won", wonRevenueCents: null });
    await t.lead({ wonAt: at(31), status: "won", wonRevenueCents: 400_000 });
    await t.lead({ wonAt: end, status: "won", wonRevenueCents: 900_000 });
    await t.lead({ wonAt: at(-1), status: "won", wonRevenueCents: 800_000 });
    await t.lead({ status: "lost", createdAt: at(60), updatedAt: at(1) });
    const report = await getRoiReport(t.org, 30, end);
    expect(report.outcomes.won).toBe(1);
    expect(report.outcomes.revenueWonCents).toBeNull();
    expect(report.outcomes.lost).toBe(0);
    expect(report.comparison).toMatchObject({
      won: 1,
      recordedWinValueCents: 400_000,
    });
    expect(report.evidence).toHaveLength(1);
    expect(report.period).toEqual(period);
  });

  it("uses the same financial/acceptance/completion event window and rejects foreign lead links", async () => {
    const t = await tenant(),
      foreign = await tenant();
    const lead = await t.lead(),
      other = await foreign.lead();
    await db.insert(valueEntriesTable).values(
      [
        { leadId: lead.id, occurredAt: at(1), amountCents: 500 },
        { leadId: lead.id, occurredAt: at(31), amountCents: 1000 },
        { leadId: lead.id, occurredAt: end, amountCents: 2000 },
        { leadId: other.id, occurredAt: at(1), amountCents: 4000 },
      ].map((v) => ({
        ...v,
        organizationId: t.org,
        kind: "payment" as const,
        recordedByUserId: "local-qa",
        sourceReference: randomUUID(),
      })),
    );
    await db.insert(estimatesTable).values(
      [at(1), at(31), null].map((acceptedAt) => ({
        organizationId: t.org,
        leadId: lead.id,
        title: "QA",
        status: "accepted" as const,
        totalCents: 500,
        acceptedAt,
      })),
    );
    await db.insert(projectsTable).values(
      [at(1), at(31), null].map((completedAt) => ({
        organizationId: t.org,
        leadId: lead.id,
        name: "QA",
        status: "completed" as const,
        completedAt,
      })),
    );
    const ledger = await valueLedger(t.org, period);
    expect(ledger).toMatchObject({
      period,
      entryCount: 1,
      netReceiptsCents: 500,
      costEntryCount: 0,
      recordedContributionCents: null,
      acceptedEstimateCount: 1,
      completedProjectCount: 1,
      undatedAcceptedEstimateCount: 1,
      undatedCompletedProjectCount: 1,
    });
    expect(ledger.entries.map((e) => e.leadId)).toEqual([lead.id]);
  });

  it("neutralizes spreadsheet formulas in untrusted labels without changing numbers", async () => {
    const t = await tenant();
    await t.lead({
      campaign: '=HYPERLINK("https://example.invalid","open")',
      source: "\t@SUM(1,2)",
    });
    const report = await getRoiReport(t.org, 30, end);
    const csv = roiReportToCsv(report);
    expect(csv).toContain("'\t@SUM(1,2)");
    expect(csv).toContain("'=HYPERLINK");
    report.leads.bySource = [
      "=1+1",
      "+SUM(1)",
      "-SUM(1)",
      "@SUM(1)",
      " \r=1",
      "\n=1",
      "\t+1",
    ].map((key) => ({ key, count: 1 }));
    const safe = roiReportToCsv(report);
    for (const row of report.leads.bySource)
      expect(safe).toContain("'" + row.key);
    expect(safe).toContain('"\' \r=1"');
  });

  it("includes the start, excludes the end, and does not confuse booking creation with visit dates", async () => {
    const t = await tenant();
    const lead = await t.lead({ createdAt: at(30) });
    await t.lead({ createdAt: end });
    await db.insert(appointmentsTable).values(
      [
        { createdAt: at(30), scheduledStart: at(-20) },
        { createdAt: end, scheduledStart: at(1) },
        { createdAt: at(31), scheduledStart: at(1) },
      ].map((v) => ({ ...v, organizationId: t.org, leadId: lead.id })),
    );
    const report = await getRoiReport(t.org, 30, end);
    expect(report.leads.total).toBe(1);
    expect(report.appointments).toMatchObject({
      total: 1,
      leadsWithAppointment: 1,
      appointmentRatePct: 100,
    });
    expect(report.comparison.appointmentsRecorded).toBe(1);
  });

  it("keeps first-contact history unknown for imports and counts touch events at their own dates", async () => {
    const t = await tenant();
    const native = await t.lead();
    const imported = await t.lead({
      creationMethod: "import",
      importedHistory: history(at(10).toISOString()),
    });
    const older = await t.lead({ createdAt: at(60) });
    const [pb] = await db
      .insert(playbooksTable)
      .values({ organizationId: t.org, name: "QA outreach" })
      .returning();
    for (const lead of [native, imported, older]) {
      const [enrollment] = await db
        .insert(playbookEnrollmentsTable)
        .values({ organizationId: t.org, leadId: lead.id, playbookId: pb.id })
        .returning();
      const touch = {
        organizationId: t.org,
        leadId: lead.id,
        playbookId: pb.id,
        enrollmentId: enrollment.id,
        stepIndex: 0,
        channel: "email",
        provider: "synthetic",
        sentHourUtc: 12,
        sentAt: lead.id === older.id ? at(45) : at(1),
        repliedAt: lead.id === imported.id ? at(-1) : at(0.5),
        bookedAt: at(0.25),
        finalOutcome: "won",
        finalOutcomeAt: at(-1),
      };
      await db
        .insert(playbookTouchesTable)
        .values([touch, { ...touch, stepIndex: 1 }]);
    }
    await db.insert(appointmentsTable).values({
      organizationId: t.org,
      leadId: native.id,
      createdAt: at(0.25),
      scheduledStart: at(-5),
    });
    await db.insert(appointmentsTable).values({
      organizationId: t.org,
      leadId: older.id,
      status: "cancelled",
      createdAt: at(0.25),
      scheduledStart: at(-5),
    });
    const report = await getRoiReport(t.org, 30, end);
    expect(report.leads).toMatchObject({ total: 2, native: 1, imported: 1 });
    expect(report.dataQuality.importedFirstTouchExcluded).toBe(1);
    expect(report.responsiveness).toMatchObject({
      firstTouchMeasuredLeads: 1,
      medianMinutesToFirstTouch: 1440,
      leadsContacted: 2,
      leadsReplied: 1,
      responseRatePct: 50,
    });
    expect(report.playbooks).toEqual([
      expect.objectContaining({ sent: 4, replied: 2, booked: 1, won: 0 }),
    ]);
  });

  it("rejects touch rows with a foreign playbook, lead or mismatched enrollment", async () => {
    const t = await tenant(),
      foreign = await tenant();
    const lead = await t.lead(),
      other = await foreign.lead();
    const [pb, foreignPb] = await db
      .insert(playbooksTable)
      .values([
        { organizationId: t.org, name: "QA" },
        { organizationId: foreign.org, name: "Secret foreign" },
      ])
      .returning();
    const [enrollment] = await db
      .insert(playbookEnrollmentsTable)
      .values({ organizationId: t.org, leadId: lead.id, playbookId: pb.id })
      .returning();
    const touch = {
      organizationId: t.org,
      leadId: lead.id,
      playbookId: pb.id,
      enrollmentId: enrollment.id,
      stepIndex: 0,
      channel: "email",
      provider: "synthetic",
      sentHourUtc: 12,
      sentAt: at(1),
      repliedAt: at(0.5),
    };
    await db.insert(playbookTouchesTable).values([
      { ...touch, playbookId: foreignPb.id },
      { ...touch, leadId: other.id },
    ]);
    const report = await getRoiReport(t.org, 30, end);
    expect(report.playbooks).toEqual([]);
    expect(report.responsiveness).toMatchObject({
      leadsContacted: 0,
      leadsReplied: 0,
      firstTouchMeasuredLeads: 0,
      medianMinutesToFirstTouch: null,
    });
  });

  it("counts zero as a known value and shows missing amounts alongside known subtotals", async () => {
    const t = await tenant();
    await t.lead({
      wonAt: at(1),
      wonRevenueCents: 0,
      wonAttribution: "self_reported",
    });
    await t.lead({
      wonAt: at(1),
      wonRevenueCents: null,
      wonAttribution: "self_reported",
    });
    const report = await getRoiReport(t.org, 30, end);
    expect(report.outcomes.revenueWonCents).toBe(0);
    expect(report.dataQuality.unknownWinValues).toBe(1);
    expect(report.outcomes.revenueByAttribution).toEqual([
      {
        category: "self_reported",
        count: 2,
        revenueCents: 0,
        unknownValues: 1,
      },
    ]);
    expect(report.outcomes.pipelineValueCents).toBeNull();
  });

  it("counts real campaign launch/enrollment/reply timestamps instead of draft creation or pause text", async () => {
    const t = await tenant();
    const foreign = await tenant();
    const [foreignPlaybook] = await db
      .insert(playbooksTable)
      .values({ organizationId: foreign.org, name: "Foreign private campaign" })
      .returning();
    await db
      .insert(reactivationCampaignsTable)
      .values({
        organizationId: t.org,
        name: "Invalid linked campaign",
        playbookId: foreignPlaybook.id,
        segment: {},
        status: "running",
        launchedAt: at(1),
      });
    const lead = await t.lead({ createdAt: at(90) });
    const [pb] = await db
      .insert(playbooksTable)
      .values({
        organizationId: t.org,
        name: "QA winback",
        category: "reactivation",
      })
      .returning();
    const [campaign] = await db
      .insert(reactivationCampaignsTable)
      .values({
        organizationId: t.org,
        name: "Older launch",
        playbookId: pb.id,
        segment: {},
        status: "running",
        launchedAt: at(45),
      })
      .returning();
    await db.insert(reactivationCampaignsTable).values({
      organizationId: t.org,
      name: "Draft",
      playbookId: pb.id,
      segment: {},
      createdAt: at(1),
    });
    const [enrollment] = await db
      .insert(playbookEnrollmentsTable)
      .values({
        organizationId: t.org,
        leadId: lead.id,
        playbookId: pb.id,
        pauseReason: "replied long ago",
      })
      .returning();
    await db.insert(reactivationCampaignLeadsTable).values({
      organizationId: t.org,
      campaignId: campaign.id,
      leadId: lead.id,
      enrollmentId: enrollment.id,
      status: "enrolled",
      enrolledAt: at(1),
    });
    const before = await getRoiReport(t.org, 30, end);
    expect(before.reactivation).toEqual({
      campaignsLaunched: 0,
      leadsEnrolled: 1,
      leadsReplied: 0,
    });
    await db.insert(playbookTouchesTable).values({
      organizationId: t.org,
      leadId: lead.id,
      playbookId: pb.id,
      enrollmentId: enrollment.id,
      stepIndex: 0,
      channel: "email",
      provider: "synthetic",
      sentHourUtc: 12,
      sentAt: at(1),
      repliedAt: at(0.5),
    });
    expect((await getRoiReport(t.org, 30, end)).reactivation.leadsReplied).toBe(
      1,
    );
  });

  it("rejects ambiguous, future, partial or oversized ranges", () => {
    for (const query of [
      { startAt: period.startAt },
      { endAt: period.endAt },
      { startAt: end.toISOString(), endAt: period.startAt },
      { startAt: at(366).toISOString(), endAt: end.toISOString() },
      { startAt: at(1).toISOString(), endAt: at(-1).toISOString() },
      { startAt: "2026-02-30T00:00:00Z", endAt: end.toISOString() },
    ]) {
      expect(() => parseReportingPeriod(query)).toThrow();
    }
    for (const days of ["0", "366", "1.5", "not-a-number", ["30", "7"]])
      expect(reportQuerySchema.safeParse({ days }).success).toBe(false);
    expect(parseReportingPeriod({})).toBeUndefined();
  });
});
