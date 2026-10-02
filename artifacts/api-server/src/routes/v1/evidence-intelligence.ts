import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

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
import {
  ClaimExecutionError,
  compileClaimRoutePacket,
  listClaimRoutePackets,
} from "../../services/claim-execution";
import {
  ClaimGraphError,
  compileClaimGraphForTarget,
  compileNativeEstimateForClaim,
  isClaimGraphTarget,
  listClaimGraphs,
} from "../../services/claim-graphs";
import {
  compileLossCorroboration,
  listLossCorroborations,
  LossCorroborationError,
  reviewLossCorroboration,
} from "../../services/loss-corroborations";

const router: IRouter = Router();

function sendError(res: Response, error: unknown): void {
  if (
    error instanceof EvidenceIntelligenceError ||
    error instanceof ClaimExecutionError ||
    error instanceof ClaimGraphError ||
    error instanceof LossCorroborationError
  ) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: "Evidence Intelligence could not complete the request." });
}

const coordinatesSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});

const corroborationInputSchema = z.object({
  canonicalGraphId: z.string().uuid(),
  propertyCoordinates: coordinatesSchema.nullable().default(null),
  roofFacets: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(120),
        azimuthDegrees: z.number().finite(),
        weight: z.number().finite().gt(0).lte(1).optional(),
      }),
    )
    .max(24)
    .default([]),
  sources: z
    .array(
      z.object({
        sourceArtifactId: z.string().uuid(),
        sourceKind: z.enum(["weather", "property", "inspection", "photo", "document", "other"]),
        provider: z.string().trim().min(1).max(160),
        providerVersion: z.string().trim().min(1).max(160),
        retrievedAt: z.string().trim().min(1).max(64),
        qualityScore: z.number().finite().min(0).max(100),
        coverageScore: z.number().finite().min(0).max(100),
        missingFields: z.array(z.string().trim().min(1).max(160)).max(24).default([]),
        temporalCoverage: z.object({
          startsAt: z.string().trim().min(1).max(64),
          endsAt: z.string().trim().min(1).max(64),
        }),
        observations: z
          .array(
            z.object({
              id: z.string().trim().min(1).max(120),
              signal: z.enum(["supporting", "contradicting", "neutral"]),
              phenomenon: z.string().trim().min(1).max(120),
              observedAt: z.string().trim().min(1).max(64),
              magnitudeScore: z.number().finite().min(0).max(100),
              coordinates: coordinatesSchema.nullable().optional(),
              directionDegrees: z.number().finite().nullable().optional(),
            }),
          )
          .min(1)
          .max(30),
      }),
    )
    .min(1)
    .max(24),
});

const corroborationReviewSchema = z.object({
  status: z.enum(["verified", "rejected"]),
  reviewNote: z.string().trim().max(2_000).nullable().optional(),
});

function boundedString(value: unknown, field: string, maxLength = 240): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) {
    throw new ClaimExecutionError(`${field} is required and must be ${maxLength} characters or fewer.`);
  }
  return normalized;
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

router.get(
  "/bie/claims/:id/graphs",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await listClaimGraphs(req.member!.organizationId, String(req.params.id)));
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  "/bie/claims/:id/graphs/native-estimate",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.status(201).json(
        await compileNativeEstimateForClaim(
          req.member!.organizationId,
          String(req.params.id),
          boundedString(req.body?.estimateId, "Estimate ID", 80),
          req.member!.user.id,
        ),
      );
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get(
  "/bie/claims/:id/graphs/:graphId/targets/:target",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const target = String(req.params.target);
      if (!isClaimGraphTarget(target)) {
        throw new ClaimGraphError("Unsupported target compilation profile.");
      }
      res.json(
        await compileClaimGraphForTarget(
          req.member!.organizationId,
          String(req.params.id),
          String(req.params.graphId),
          target,
        ),
      );
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get(
  "/bie/claims/:id/corroborations",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await listLossCorroborations(req.member!.organizationId, String(req.params.id)));
    } catch (error) {
      sendError(res, error);
    }
  },
);

/**
 * This endpoint accepts only structured, source-linked observations. It does
 * not call a weather provider or an AI model: those adapters must preserve
 * their source artifact first, then submit an explicit normalized reading.
 */
router.post(
  "/bie/claims/:id/corroborations",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = corroborationInputSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Loss corroboration input is invalid.", details: parsed.error.issues.map((issue) => issue.message) });
        return;
      }
      res.status(201).json(
        await compileLossCorroboration(
          req.member!.organizationId,
          String(req.params.id),
          req.member!.user.id,
          parsed.data,
        ),
      );
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  "/bie/claims/:id/corroborations/:corroborationId/review",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = corroborationReviewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Loss corroboration review is invalid." });
        return;
      }
      res.json(
        await reviewLossCorroboration(
          req.member!.organizationId,
          String(req.params.id),
          String(req.params.corroborationId),
          req.member!.user.id,
          parsed.data.status,
          parsed.data.reviewNote ?? null,
        ),
      );
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get(
  "/bie/claims/:id/routes",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.json(await listClaimRoutePackets(req.member!.organizationId, String(req.params.id)));
    } catch (error) {
      sendError(res, error);
    }
  },
);

/**
 * Compilation is deliberately separate from execution. This endpoint creates
 * an immutable, reviewable handoff packet but never contacts a carrier, CRM,
 * browser, or third-party target.
 */
router.post(
  "/bie/claims/:id/routes",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const postconditions = Array.isArray(req.body?.postconditions)
        ? req.body.postconditions.map((item: unknown) => {
            const value = item as Record<string, unknown>;
            return {
              code: boundedString(value?.code, "Postcondition code", 120),
              description: boundedString(value?.description, "Postcondition description", 500),
            };
          })
        : [];
      const capabilityRequirements = Array.isArray(req.body?.capabilityRequirements)
        ? req.body.capabilityRequirements.map((item: unknown) => boundedString(item, "Capability", 160))
        : [];
      if (postconditions.length === 0 || postconditions.length > 12) {
        throw new ClaimExecutionError("Provide between one and twelve target-side postconditions.");
      }
      if (capabilityRequirements.length === 0 || capabilityRequirements.length > 12) {
        throw new ClaimExecutionError("Provide between one and twelve required capabilities.");
      }
      const maxExternalWrites = req.body?.maxExternalWrites ?? 1;
      const maxAttempts = req.body?.maxAttempts ?? 1;
      if (!Number.isInteger(maxExternalWrites) || !Number.isInteger(maxAttempts)) {
        throw new ClaimExecutionError("Route budgets must be whole numbers.");
      }
      res.status(201).json(
        await compileClaimRoutePacket(req.member!.organizationId, String(req.params.id), req.member!.user.id, {
          certificateId: boundedString(req.body?.certificateId, "Certificate ID", 80),
          corroborationId:
            req.body?.corroborationId === undefined || req.body?.corroborationId === null
              ? undefined
              : boundedString(req.body?.corroborationId, "Corroboration ID", 80),
          target: boundedString(req.body?.target, "Target", 120),
          operation: boundedString(req.body?.operation, "Operation", 160),
          adapterName: boundedString(req.body?.adapterName, "Adapter name", 120),
          adapterVersion: boundedString(req.body?.adapterVersion, "Adapter version", 120),
          adapterFingerprint: boundedString(req.body?.adapterFingerprint, "Adapter fingerprint", 256),
          postconditions,
          capabilityRequirements,
          maxExternalWrites,
          maxAttempts,
        }),
      );
    } catch (error) {
      sendError(res, error);
    }
  },
);

export default router;
