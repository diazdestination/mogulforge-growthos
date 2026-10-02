import { Router, type Request, type Response } from "express";
import { requireMember } from "../../middlewares/requireMember";
import { getRoiReport, roiReportToCsv } from "../../services/roi-report";
import { reportQuerySchema } from "../../services/reporting-period";
import { z } from "zod/v4";

const router = Router();

async function reportFor(req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { days, endAt } = reportQuerySchema.parse(req.query);
    return await getRoiReport(
      req.member!.organizationId,
      days,
      endAt ? new Date(endAt) : undefined,
    );
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    res
      .status(400)
      .json({
        error:
          "Use whole days from 1 to 365 and an optional endAt ISO timestamp in the past.",
      });
    return null;
  }
}

/** Organization ROI report with honest revenue attribution. */
router.get(
  "/reports/roi",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const report = await reportFor(req, res);
    if (report) res.json(report);
  },
);

/** Same report, flattened to CSV for download. */
router.get(
  "/reports/roi/export",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const report = await reportFor(req, res);
    if (!report) return;
    res
      .status(200)
      .set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="roi-report-${report.windowDays}d.csv"`,
      })
      .send(roiReportToCsv(report));
  },
);

export default router;
