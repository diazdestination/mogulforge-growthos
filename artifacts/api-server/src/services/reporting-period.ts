import { and, sql, type SQLWrapper } from "drizzle-orm";
import { z } from "zod/v4";

export interface ReportingPeriod {
  startAt: string;
  endAt: string;
  timeZone: "UTC";
}
const day = 86_400_000;
const instant = z.iso.datetime({ offset: true });
export const reportQuerySchema = z
  .object({
    days: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(365))
      .optional()
      .default(30),
    endAt: instant.optional(),
  })
  .strict();

export function reportingPeriod(
  windowDays: number,
  end = new Date(),
): ReportingPeriod {
  z.number().int().min(1).max(365).parse(windowDays);
  const endAt = instant.parse(end.toISOString());
  return parseReportingPeriod({
    startAt: new Date(end.getTime() - windowDays * day).toISOString(),
    endAt,
  })!;
}

/** Omitted pair retains the existing all-time ledger. Partial or invented dates fail closed. */
export function parseReportingPeriod(
  query: unknown,
): ReportingPeriod | undefined {
  const range = z
    .object({ startAt: instant.optional(), endAt: instant.optional() })
    .strict()
    .superRefine((v, ctx) => {
      if (v.startAt === undefined && v.endAt === undefined) return;
      if (!v.startAt || !v.endAt) {
        ctx.addIssue({
          code: "custom",
          message: "Both startAt and endAt are required.",
        });
        return;
      }
      const start = Date.parse(v.startAt),
        end = Date.parse(v.endAt);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start >= end ||
        end - start > 365 * day ||
        end > Date.now()
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "Use a past UTC range of at most 365 days, with start before end.",
        });
      }
    })
    .parse(query);
  if (!range.startAt || !range.endAt) return undefined;
  return {
    startAt: new Date(range.startAt).toISOString(),
    endAt: new Date(range.endAt).toISOString(),
    timeZone: "UTC",
  };
}

/** Half-open bounds ensure an event at midnight belongs to exactly one period. */
export function inReportingPeriod(value: SQLWrapper, period: ReportingPeriod) {
  return and(
    sql`${value} >= ${period.startAt}::timestamptz`,
    sql`${value} < ${period.endAt}::timestamptz`,
  )!;
}
