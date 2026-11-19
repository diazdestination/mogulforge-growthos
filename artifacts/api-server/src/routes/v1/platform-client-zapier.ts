import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requirePlatformAdmin } from "./orgs";
import {
  assignZapier,
  ManagedZapierError,
  platformZapierStatus,
  revokeZapier,
} from "../../services/zapier/zapier-managed";
import { ZapierMcpError } from "../../services/zapier/zapier-mcp-client";

const router = Router();
const path = "/platform/clients/:orgId/integrations/zapier";
const version = z
  .object({
    expectedConnectionFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
const assignment = version
  .extend({
    serverReference: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    connectionToken: z
      .string()
      .trim()
      .regex(/^[!-~]{1,4096}$/),
    monthlyActionLimit: z.number().int().min(0).max(100000).optional(),
    ownershipConfirmed: z.literal(true),
    dedicatedConnectionConfirmed: z.literal(true),
  })
  .strict();

function handle(
  fn: (req: Request, res: Response, id: string) => Promise<void>,
) {
  return async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (req.headers["x-api-key"] !== undefined)
        throw new ManagedZapierError(403, "Human platform session required.");
      if (req.method !== "GET") {
        if (!req.is("application/json"))
          throw new ManagedZapierError(415, "JSON required.");
        if (req.headers.origin && req.headers.origin !== process.env.APP_ORIGIN)
          throw new ManagedZapierError(403, "Origin denied.");
      }
      await fn(req, res, z.string().uuid().parse(req.params.orgId));
    } catch (error) {
      if (error instanceof ManagedZapierError)
        res.status(error.status).json({ error: error.message });
      else if (error instanceof z.ZodError)
        res.status(400).json({ error: "Invalid connection request." });
      else if (error instanceof ZapierMcpError)
        res
          .status(502)
          .json({
            error: "Could not verify the dedicated Zapier connection.",
            code: error.code,
          });
      else
        res
          .status(503)
          .json({ error: "Connection management temporarily unavailable." });
    }
  };
}

router.get(
  path,
  requirePlatformAdmin,
  handle(async (_req, res, id) => {
    res.json(await platformZapierStatus(id));
  }),
);
router.put(
  path,
  requirePlatformAdmin,
  handle(async (req, res, id) => {
    res.json(
      await assignZapier(id, req.sessionUser!.id, assignment.parse(req.body)),
    );
  }),
);
router.delete(
  path,
  requirePlatformAdmin,
  handle(async (req, res, id) => {
    await revokeZapier(
      id,
      req.sessionUser!.id,
      version.parse(req.body).expectedConnectionFingerprint,
    );
    res.sendStatus(204);
  }),
);
export default router;
