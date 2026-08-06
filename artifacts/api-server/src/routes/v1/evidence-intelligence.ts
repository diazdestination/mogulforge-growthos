import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import {
  addEvidenceArtifact,
  analyzeEvidenceCase,
  createEvidenceCase,
  EvidenceIntelligenceError,
  getEvidenceArtifactContent,
  getEvidenceCase,
  issueEvidenceCertificate,
  listEvidenceCases,
  reviewEvidenceObservation,
  validateArtifactKind,
  validateEvidenceMimeType,
} from "../../services/evidence-intelligence";

const router: IRouter = Router();

function sendError(res: Response, error: unknown): void {
  if (error instanceof EvidenceIntelligenceError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: "Evidence Intelligence could not complete the request." });
}

router.get(
  "/bie/claims",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await listEvidenceCases(req.member!.organizationId));
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  "/bie/claims",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      if (!title || title.length > 240) {
        res.status(400).json({ error: "A case title between 1 and 240 characters is required." });
        return;
      }
      const lossDate = req.body?.lossDate ? new Date(String(req.body.lossDate)) : null;
      if (lossDate && Number.isNaN(lossDate.getTime())) {
        res.status(400).json({ error: "Loss date must be a valid date." });
        return;
      }
      const created = await createEvidenceCase(
        req.member!.organizationId,
        req.member!.user.id,
        {
          title,
          lossType: typeof req.body?.lossType === "string" ? req.body.lossType.slice(0, 120) : null,
          lossDate,
          description:
            typeof req.body?.description === "string" ? req.body.description.slice(0, 4_000) : null,
          leadId: typeof req.body?.leadId === "string" ? req.body.leadId : null,
          propertyId: typeof req.body?.propertyId === "string" ? req.body.propertyId : null,
        },
      );
      res.status(201).json(created);
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get(
  "/bie/claims/:id",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await getEvidenceCase(req.member!.organizationId, String(req.params.id)));
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  "/bie/claims/:id/artifacts",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { body = {} } = req;
      if (!validateArtifactKind(body.kind) || !validateEvidenceMimeType(body.mimeType)) {
        res.status(400).json({ error: "Evidence kind or file type is not supported." });
        return;
      }
      const filename = typeof body.filename === "string" ? body.filename.trim() : "";
      if (!filename) {
        res.status(400).json({ error: "Evidence filename is required." });
        return;
      }

      let data: Buffer;
      if (body.mimeType === "text/plain" && typeof body.text === "string") {
        data = Buffer.from(body.text, "utf8");
      } else if (typeof body.dataBase64 === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(body.dataBase64)) {
        data = Buffer.from(body.dataBase64, "base64");
      } else {
        res.status(400).json({ error: "Evidence data is missing or invalid." });
        return;
      }

      const artifact = await addEvidenceArtifact(
        req.member!.organizationId,
        String(req.params.id),
        req.member!.user.id,
        {
          kind: body.kind,
          filename,
          mimeType: body.mimeType,
          data,
          sourceLabel: typeof body.sourceLabel === "string" ? body.sourceLabel : null,
          approveForAi: body.approveForAi === true,
        },
      );
      res.status(201).json(artifact);
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get(
  "/bie/claims/:id/artifacts/:artifactId/content",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const artifact = await getEvidenceArtifactContent(
        req.member!.organizationId,
        String(req.params.id),
        String(req.params.artifactId),
      );
      res.setHeader("Content-Type", artifact.mimeType);
      res.setHeader("Content-Length", String(artifact.sizeBytes));
      res.setHeader("Content-Disposition", `inline; filename="${artifact.filename.replace(/["\\\r\n]/g, "_")}"`);
      res.setHeader("X-Content-SHA256", artifact.sha256);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "sandbox");
      res.send(artifact.blob);
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  "/bie/claims/:id/analyze",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(
        await analyzeEvidenceCase(
          req.member!.organizationId,
          String(req.params.id),
          req.member!.user.id,
        ),
      );
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  "/bie/claims/:id/observations/:observationId/review",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.body?.status !== "verified" && req.body?.status !== "rejected") {
        res.status(400).json({ error: "Review status must be verified or rejected." });
        return;
      }
      res.json(
        await reviewEvidenceObservation(
          req.member!.organizationId,
          String(req.params.id),
          String(req.params.observationId),
          req.member!.user.id,
          req.body.status,
        ),
      );
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  "/bie/claims/:id/certificates/:certificateId/issue",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(
        await issueEvidenceCertificate(
          req.member!.organizationId,
          String(req.params.id),
          String(req.params.certificateId),
          req.member!.user.id,
        ),
      );
    } catch (error) {
      sendError(res, error);
    }
  },
);

export default router;
