/**
 * Per-customer memory and customer context search.
 *
 * Company scope always comes from the authenticated membership, never from
 * the request. Reads need crm.read, memory writes crm.write, and the
 * company-wide retrieval backfill settings.manage (owner/admin, no API keys).
 * Mutations are audited without memory text (customer content stays out of
 * audit metadata).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import {
  CustomerMemoryError,
  createCustomerMemory,
  listCustomerMemories,
  retireCustomerMemory,
  toCustomerMemoryDto,
} from "../../services/customer-memory";
import { reindexRequestSchema } from "../../services/customer-memory-contract";
import { resolveCustomerReadAccess } from "../../services/customer-workspace";
import { CustomerWorkspaceError } from "../../services/customer-workspace-contract";
import { tryGetEmbeddingProvider } from "../../services/embeddings";
import { retrieveCustomerContext } from "../../services/retrieval";
import { reindexOrganization } from "../../services/retrieval-index";

const router: IRouter = Router();
const idSchema = z.uuid();
const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(500),
    limit: z.coerce.number().int().min(1).max(10).optional(),
  })
  .strict();

function privateResponse(res: Response): void {
  res.set("Cache-Control", "no-store").set("Pragma", "no-cache");
}

function contactIdOr404(req: Request, res: Response): string | null {
  const id = String(req.params.id);
  if (idSchema.safeParse(id).success) return id;
  res.status(404).json({ error: "Customer not found", code: "customer_not_found" });
  return null;
}

/**
 * The caller's effective customer-record visibility: stored user role AND the
 * effective role (an API key's capped role) must both allow it, exactly as in
 * the customer workspace.
 */
function callerAccess(req: Request) {
  const member = req.member!;
  return resolveCustomerReadAccess(member.organizationId, member.user.id, member.role);
}

function respondToError(error: unknown, req: Request, res: Response): void {
  if (error instanceof CustomerWorkspaceError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof CustomerMemoryError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  req.log?.error({ event: "customer_memory_unavailable" }, "Customer memory request failed");
  res.status(503).json({ error: "Customer memory is temporarily unavailable.", code: "customer_memory_unavailable" });
}

router.get(
  "/contacts/:id/memories",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    privateResponse(res);
    const contactId = contactIdOr404(req, res);
    if (!contactId) return;
    const status = req.query.status;
    if (Object.keys(req.query).some((key) => key !== "status") || (status !== undefined && status !== "active" && status !== "all")) {
      res.status(400).json({ error: "Use status=active or status=all only.", code: "memory_invalid" });
      return;
    }
    try {
      const organizationId = req.member!.organizationId;
      const rows = await listCustomerMemories(organizationId, contactId, { includeRetired: status === "all" });
      if (!rows) {
        res.status(404).json({ error: "Customer not found", code: "customer_not_found" });
        return;
      }
      res.json({ organizationId, contactId, memories: rows.map(toCustomerMemoryDto) });
    } catch (error) {
      respondToError(error, req, res);
    }
  },
);

router.post(
  "/contacts/:id/memories",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    privateResponse(res);
    const contactId = contactIdOr404(req, res);
    if (!contactId) return;
    try {
      const organizationId = req.member!.organizationId;
      const access = await callerAccess(req);
      const { memory, retrievalIndex } = await createCustomerMemory(organizationId, contactId, req.member!.user.id, req.body ?? {}, access);
      await recordAudit({
        organizationId,
        actorUserId: req.member!.user.id,
        action: "customer_memory.created",
        entityType: "customer_memory",
        entityId: memory.id,
        metadata: { contactId, kind: memory.kind, sourceType: memory.sourceType, retrievalIndex },
      });
      res.status(201).json(toCustomerMemoryDto(memory));
    } catch (error) {
      respondToError(error, req, res);
    }
  },
);

router.post(
  "/contacts/:id/memories/:memoryId/retire",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    privateResponse(res);
    const contactId = contactIdOr404(req, res);
    if (!contactId) return;
    const memoryId = String(req.params.memoryId);
    if (!idSchema.safeParse(memoryId).success) {
      res.status(404).json({ error: "Memory not found", code: "memory_not_found" });
      return;
    }
    try {
      const organizationId = req.member!.organizationId;
      const memory = await retireCustomerMemory(organizationId, contactId, memoryId, req.member!.user.id);
      await recordAudit({
        organizationId,
        actorUserId: req.member!.user.id,
        action: "customer_memory.retired",
        entityType: "customer_memory",
        entityId: memory.id,
        metadata: { contactId, kind: memory.kind },
      });
      res.json(toCustomerMemoryDto(memory));
    } catch (error) {
      respondToError(error, req, res);
    }
  },
);

router.get(
  "/contacts/:id/context-search",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    privateResponse(res);
    const contactId = contactIdOr404(req, res);
    if (!contactId) return;
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Provide q (1-500 characters) and an optional limit of 1-10.", code: "context_search_invalid" });
      return;
    }
    try {
      const organizationId = req.member!.organizationId;
      const access = await callerAccess(req);
      const result = await retrieveCustomerContext(organizationId, contactId, parsed.data.q, parsed.data.limit ?? 5, access);
      if (!result) {
        res.status(404).json({ error: "Customer not found", code: "customer_not_found" });
        return;
      }
      res.json({ organizationId, contactId, ...result });
    } catch (error) {
      if (error instanceof CustomerWorkspaceError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      req.log?.error({ event: "customer_context_search_unavailable" }, "Customer context search failed");
      res.status(503).json({ error: "Customer search is temporarily unavailable.", code: "context_search_unavailable" });
    }
  },
);

router.post(
  "/retrieval/reindex",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    privateResponse(res);
    const parsed = reindexRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Use an optional afterContactId and limit (1-200).", code: "reindex_invalid" });
      return;
    }
    const { provider, misconfigured } = tryGetEmbeddingProvider();
    if (!provider) {
      res.status(409).json({
        error: misconfigured
          ? "The embedding provider is misconfigured. Knowledge and customer search keep using keyword matching."
          : "No embedding provider is enabled. Knowledge and customer search keep using keyword matching.",
        code: misconfigured ? "embedding_provider_misconfigured" : "embedding_provider_not_configured",
      });
      return;
    }
    const organizationId = req.member!.organizationId;
    try {
      const result = await reindexOrganization(provider, organizationId, {
        afterContactId: parsed.data.afterContactId ?? null,
        limit: parsed.data.limit,
      });
      await recordAudit({
        organizationId,
        actorUserId: req.member!.user.id,
        action: "retrieval.reindexed",
        entityType: "retrieval_index",
        entityId: organizationId,
        metadata: { embeddingModel: result.embeddingModel, knowledge: result.knowledge, customers: result.customers },
      });
      res.json(result);
    } catch (error) {
      req.log?.error(
        { event: "retrieval_reindex_unavailable", code: (error as { code?: unknown })?.code ?? "unknown" },
        "Retrieval reindex failed",
      );
      res.status(503).json({ error: "Reindex did not finish. It is safe to run again; unchanged records are skipped.", code: "reindex_unavailable" });
    }
  },
);

export default router;
