import { useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import {
  ApiError,
  createCustomerWorkProject,
  updateCustomerWorkProject,
} from "@workspace/api-client-react";
import { ContractorApiError, contractorRequest } from "@/lib/contractor-api";
import { useSchedulingAuthority } from "./use-scheduling-review";
import { freezeSchedulingValue } from "@/lib/scheduling-command";
import {
  canonicalCustomerWorkValue,
  createCustomerWorkEstimateSchema,
  updateCustomerWorkEstimateSchema,
  createCustomerWorkProjectSchema,
  updateCustomerWorkProjectSchema,
  customerWorkProjectMutationSchema,
  customerWorkProjectOutcomeSchema,
  customerWorkProjectUnavailableSchema,
  type CustomerWorkProjectOutcome,
} from "../../../api-server/src/services/returning-customer-contract";

const commandSchema = z
  .object({
    path: z.string(),
    method: z.enum(["POST", "PATCH"]),
    body: z
      .record(z.string(), z.unknown())
      .and(z.object({ requestId: z.uuid() })),
    label: z.string(),
  })
  .strict();
export type SubmittedWorkCommand = z.infer<typeof commandSchema>;
const completedWorkSchema = z.strictObject({
  command: commandSchema,
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: customerWorkProjectOutcomeSchema,
});
const custodySchema = z
  .object({
    formatVersion: z.literal(1),
    organizationId: z.uuid(),
    actorUserId: z.string().min(1),
    target: z.string(),
    command: commandSchema,
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: customerWorkProjectOutcomeSchema.nullable(),
    retiredRequestIds: z.array(z.uuid()).optional(),
    completed: z.array(completedWorkSchema).optional(),
  })
  .strict();
type Custody = z.infer<typeof custodySchema>;
export const customerWorkCommandKey = (
  userId: string,
  organizationId: string,
  target: string,
) =>
  "growthos:customer-work-command:" +
  userId +
  ":" +
  organizationId +
  ":" +
  target;
export const sameCustomerWorkId = (
  a: string | null | undefined,
  b: string | null | undefined,
) =>
  typeof a === "string" &&
  typeof b === "string" &&
  z.uuid().safeParse(a).success &&
  z.uuid().safeParse(b).success
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
const sameId = sameCustomerWorkId;
function selectedSchema(target: string) {
  const [kind, id, extra] = target.split(":");
  if (
    extra ||
    !["estimates", "projects"].includes(kind) ||
    (id !== "new" && !z.uuid().safeParse(id).success)
  )
    throw new Error("Invalid target");
  return kind === "estimates"
    ? id === "new"
          ? createCustomerWorkEstimateSchema
          : updateCustomerWorkEstimateSchema
    : id === "new"
      ? createCustomerWorkProjectSchema
      : updateCustomerWorkProjectSchema;
}
function parseCommand(value: unknown, target: string): SubmittedWorkCommand {
  const command = commandSchema.parse(value),
    [kind, id] = target.split(":");
  if (
    command.path !==
      "/customer-work/" + kind + (id === "new" ? "" : "/" + id) ||
    command.method !== (id === "new" ? "POST" : "PATCH")
  )
    throw new Error("Wrong command target");
  selectedSchema(target).parse(command.body);
  // Hash the server-parsed input, but retain the original wire spelling separately.
  return freezeSchedulingValue(structuredClone(command));
}
export function readCustomerWorkCommand(
  key: string,
  target: string,
): SubmittedWorkCommand | null {
  const bytes = sessionStorage.getItem(key);
  if (bytes === null) return null;
  const value = JSON.parse(bytes);
  return parseCommand(
    value?.formatVersion === 1 ? custodySchema.parse(value).command : value,
    target,
  );
}
async function commandHash(
  command: SubmittedWorkCommand,
  target: string,
  actorUserId: string,
) {
  const [kind, id] = target.split(":");
  const input = selectedSchema(target).parse(command.body);
  const canonical = canonicalCustomerWorkValue({
    action:
      (kind === "projects" ? "project" : "estimate") +
      "_" +
      (id === "new" ? "created" : "updated"),
    targetId: id === "new" ? null : id,
    input,
    actorUserId,
  });
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical),
      ),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
function boundOutcome(
  raw: unknown,
  saved: Custody,
): CustomerWorkProjectOutcome {
  const proof = customerWorkProjectOutcomeSchema.parse(raw),
    [, id] = saved.target.split(":");
  if (
    !sameId(proof.organizationId, saved.organizationId) ||
    proof.actorUserId !== saved.actorUserId ||
    !sameId(proof.requestId, saved.command.body.requestId) ||
    proof.payloadSha256 !== saved.payloadSha256 ||
    proof.action !== (id === "new" ? "project_created" : "project_updated") ||
    (id !== "new" && !sameId(proof.target.id, id)) ||
    proof.resultWorkVersion !==
      (id === "new" ? 1 : Number(saved.command.body.expectedWorkVersion) + 1)
  )
    throw new Error("Unbound original work outcome");
  return proof;
}
type State = {
  identity: string;
  active: boolean;
  running: boolean;
  initialized: boolean;
  blocked: boolean;
  bytes: string | null;
  saved: Custody | null;
  legacy: SubmittedWorkCommand | null;
  error: string;
  needsRefresh: boolean;
  separate: boolean;
};

/** Source A keeps its original request/hash and explicit same-request recovery. */
export function useCustomerWorkCommand<T>({
  userId,
  organizationId,
  scopeKey,
  target,
  parse,
  onSuccess,
}: {
  userId: string;
  organizationId: string;
  scopeKey: string;
  target: string;
  parse: (value: unknown, command: SubmittedWorkCommand) => T;
  onSuccess: (value: T) => void;
}) {
  const [, render] = useState(0),
    ref = useRef<State | null>(null);
  const authority = useSchedulingAuthority({
    organizationId,
    actorUserId: userId,
    scopeKey,
  });
  const identity = JSON.stringify([
    organizationId,
    userId,
    scopeKey,
    target,
    authority.identity,
  ]);
  const allowed = authority.isCurrent;
  const key = customerWorkCommandKey(userId, organizationId, target);
  if (
    !ref.current ||
    ref.current.identity !== identity ||
    !ref.current.active
  ) {
    const next: State = {
      identity,
      active: true,
      running: false,
      initialized: false,
      blocked: false,
      bytes: null,
      saved: null,
      legacy: null,
      error: "",
      needsRefresh: false,
      separate: false,
    };
    if (allowed())
      try {
        next.bytes = sessionStorage.getItem(key);
        if (next.bytes !== null) {
          const value = JSON.parse(next.bytes);
          if (value?.formatVersion === 1) {
            const saved = custodySchema.parse(value);
            if (
              saved.organizationId !== organizationId ||
              saved.actorUserId !== userId ||
              saved.target !== target
            )
              throw new Error("Wrong custody scope");
            parseCommand(saved.command, target);
            next.saved = freezeSchedulingValue(saved);
          } else next.legacy = parseCommand(value, target);
        }
      } catch {
        next.blocked = true;
        next.error =
          "Original request custody is unavailable or invalid. Nothing new can be submitted.";
      }
    ref.current = next;
  }
  const token = ref.current;
  const current = () => ref.current === token && token.active && allowed();
  const show = () => {
    if (current()) render((n) => n + 1);
  };
  useEffect(() => {
    token.active = true;
    void (async () => {
      if (!current() || token.blocked) return;
      try {
        if (
          token.saved &&
          (await commandHash(token.saved.command, target, userId)) !==
            token.saved.payloadSha256
        )
          throw new Error("Corrupt hash");
        if (
          token.saved?.retiredRequestIds?.some((id) =>
            sameId(id, token.saved!.command.body.requestId),
          )
        )
          throw new Error("Retired request reused");
        if (token.saved?.outcome)
          boundOutcome(token.saved.outcome, token.saved);
        for (const prior of token.saved?.completed ?? []) {
          parseCommand(prior.command, target);
          if (
            (await commandHash(prior.command, target, userId)) !==
              prior.payloadSha256 ||
            !token.saved?.retiredRequestIds?.some((id) =>
              sameId(id, prior.command.body.requestId),
            )
          )
            throw new Error("Invalid retired proof");
          boundOutcome(prior.outcome, { ...token.saved!, ...prior });
        }
        if (!current()) return;
        token.initialized = true;
        if (token.saved?.outcome)
          token.error = token.saved.outcome.target.available
            ? "The original job command committed. Its original proof is retained."
            : "The original job command committed, but its display is unavailable. Do not recreate it.";
        else if (token.saved || token.legacy)
          token.error =
            "The original result is unconfirmed. Reconcile only the exact retained request.";
      } catch {
        if (current()) {
          token.blocked = true;
          token.error =
            "Original request custody could not be verified. Nothing new can be submitted.";
        }
      }
      show();
    })();
    return () => {
      token.active = false;
    };
  }, [identity, token]);
  async function write(saved: Custody) {
    if (!current() || sessionStorage.getItem(key) !== token.bytes)
      throw new Error("Custody changed");
    const bytes = JSON.stringify(saved);
    sessionStorage.setItem(key, bytes);
    if (sessionStorage.getItem(key) !== bytes)
      throw new Error("Custody readback failed");
    const restored = custodySchema.parse(JSON.parse(bytes));
    if (
      (await commandHash(restored.command, target, userId)) !==
      restored.payloadSha256
    )
      throw new Error("Custody hash mismatch");
    if (!current() || sessionStorage.getItem(key) !== bytes)
      throw new Error("Authority or custody changed");
    token.bytes = bytes;
    token.saved = freezeSchedulingValue(restored);
    token.legacy = null;
  }
  async function execute(command: SubmittedWorkCommand, replay: boolean) {
    if (
      !current() ||
      token.running ||
      token.blocked ||
      (token.saved?.outcome && !token.separate)
    )
      return;
    token.running = true;
    token.error = "";
    show();
    let saved: Custody;
    try {
      const retiredRequestIds = [
        ...(token.saved?.retiredRequestIds ?? []),
        ...(token.saved?.outcome ? [token.saved.command.body.requestId] : []),
      ];
      if (retiredRequestIds.some((id) => sameId(id, command.body.requestId)))
        throw new Error("Original request is retired");
      const original = parseCommand(command, target);
      const review = original.body.schedulingReview as
        | {
            context?: {
              organizationId?: string;
              source?: {
                sourceKind?: string;
                contactId?: string | null;
                propertyId?: string | null;
                estimateId?: string | null;
              };
              targetFingerprint?: string | null;
            };
          }
        | undefined;
      if (review && !sameId(review.context?.organizationId, organizationId))
        throw new Error("Wrong review organization");
      if (!replay && target === "projects:new" && !review)
        throw new Error("Fresh job review required");
      const source = original.body.source as
        | {
            kind?: string;
            contactId?: string;
            propertyId?: string | null;
            estimateId?: string;
          }
        | undefined;
      if (
        review &&
        source?.kind === "existing_customer" &&
        (review.context?.source?.sourceKind !== "direct_customer" ||
          !sameId(review.context.source.contactId, source.contactId) ||
          !sameId(review.context.source.propertyId, source.propertyId) ||
          review.context.source.estimateId !== null)
      )
        throw new Error("Wrong reviewed customer source");
      if (
        review &&
        source?.kind === "estimate" &&
        !sameId(review.context?.source?.estimateId, source.estimateId)
      )
        throw new Error("Wrong reviewed estimate");
      if (
        review &&
        target.startsWith("projects:") &&
        target !== "projects:new" &&
        review.context?.targetFingerprint !==
          original.body.expectedTargetFingerprint
      )
        throw new Error("Wrong reviewed work target");
      const completed = [
        ...(token.saved?.completed ?? []),
        ...(token.saved?.outcome
          ? [
              {
                command: token.saved.command,
                payloadSha256: token.saved.payloadSha256,
                outcome: token.saved.outcome,
              },
            ]
          : []),
      ];
      saved = {
        formatVersion: 1,
        organizationId,
        actorUserId: userId,
        target,
        command: original,
        payloadSha256: await commandHash(command, target, userId),
        outcome: null,
        retiredRequestIds,
        completed,
      };
      await write(saved);
      token.separate = false;
    } catch {
      if (current()) {
        token.blocked = true;
        token.separate = false;
        token.error =
          "The browser could not verify original request custody. Nothing was submitted.";
      }
      token.running = false;
      show();
      return;
    }
    if (!current()) {
      token.running = false;
      return;
    }
    const isProject = target.startsWith("projects:");
    try {
      let raw: unknown;
      try {
        raw = isProject
          ? command.method === "POST"
            ? await createCustomerWorkProject(
                command.body as ReturnType<
                  typeof createCustomerWorkProjectSchema.parse
                >,
              )
            : await updateCustomerWorkProject(
                target.split(":")[1],
                command.body as ReturnType<
                  typeof updateCustomerWorkProjectSchema.parse
                >,
              )
          :
        await contractorRequest(command.path, {
          method: command.method,
          body: command.body,
        });
      } catch (failure) {
        if (!current()) return;
        if (
          isProject &&
          failure instanceof ApiError &&
          failure.status === 409
        ) {
          const unavailable = customerWorkProjectUnavailableSchema.safeParse(
            failure.data,
          );
          if (unavailable.success) {
            const proof = boundOutcome(unavailable.data.commandOutcome, saved);
            await write({ ...saved, outcome: proof });
            if (current())
              token.error =
                "The original job command committed, but its display is unavailable. Do not recreate it.";
            return;
          }
        }
        throw failure;
      }
      if (!current()) return;
      let proof: CustomerWorkProjectOutcome | null = null;
      if (isProject) {
        const result = customerWorkProjectMutationSchema.parse(raw);
        proof = boundOutcome(result.commandOutcome, saved);
        if (
          !proof.target.available ||
          !sameId(result.organizationId, organizationId) ||
          !sameId(result.project.id, proof.target.id) ||
          !sameId(result.project.customerWorkId!, proof.customerWorkId) ||
          !sameId(result.command.targetId, proof.target.id) ||
          !sameId(result.command.customerWorkId, proof.customerWorkId) ||
          !sameId(result.command.requestId, proof.requestId) ||
          result.command.action !== proof.action ||
          result.command.version !== proof.resultWorkVersion
        )
          throw new Error("Contradictory original outcome");
      }
      const value = parse(raw, saved.command);
      if (!current()) return;
      if (proof) await write({ ...saved, outcome: proof });
      else {
        if (sessionStorage.getItem(key) !== token.bytes)
          throw new Error("Custody changed");
        sessionStorage.removeItem(key);
        if (sessionStorage.getItem(key) !== null)
          throw new Error("Custody not cleared");
        token.bytes = null;
        token.saved = null;
      }
      if (current()) {
        token.needsRefresh = false;
        onSuccess(value);
      }
    } catch (failure) {
      if (!current()) return;
      // Existing estimate transport/refusals remain separate from project proofs.
      const knownEstimateRefusal =
        !isProject &&
        failure instanceof ContractorApiError &&
        failure.status >= 400 &&
        failure.status < 500 &&
        failure.code.startsWith("customer_work_") &&
        failure.code !== "customer_work_request_conflict" &&
        !(replay && [401, 403, 404, 408, 429].includes(failure.status));
      if (knownEstimateRefusal) {
        try {
          if (sessionStorage.getItem(key) !== token.bytes)
            throw new Error("Custody changed");
          sessionStorage.removeItem(key);
          if (sessionStorage.getItem(key) !== null)
            throw new Error("Custody not cleared");
          token.bytes = null;
          token.saved = null;
          token.needsRefresh = failure.status === 409;
          token.error =
            "The request was refused. Reload the exact saved record and review before another change.";
        } catch {
          token.blocked = true;
          token.error = "Original request custody could not be verified.";
        }
      } else
        token.error =
          "The result is unconfirmed. The exact submitted request is retained in this tab. Reconcile it explicitly; no new work or request key will be created automatically.";
    } finally {
      token.running = false;
      show();
    }
  }
  const authorized = current(),
    terminal = !!token.saved?.outcome;
  const pending =
    authorized && token.initialized && !token.blocked && !terminal
      ? (token.saved?.command ?? token.legacy)
      : null;
  return {
    busy: authorized && token.running,
    pending,
    error: authorized
      ? token.error
      : "Current work access changed. Reopen this work with current authority.",
    needsRefresh: authorized && token.needsRefresh,
    committed:
      authorized && token.initialized
        ? (token.saved?.outcome ?? null)
        : null,
    separate: token.separate,
    prepareSeparate: () => {
      if (
        current() &&
        token.initialized &&
        !token.blocked &&
        token.saved?.outcome &&
        target === "projects:new"
      ) {
        token.separate = true;
        token.error = "";
        show();
      }
    },
    locked:
      !authorized ||
      !token.initialized ||
      token.blocked ||
      token.running ||
      !!pending ||
      (terminal && !token.separate) ||
      token.needsRefresh,
    refreshed: () => {
      if (current() && !token.saved && !token.legacy) {
        token.needsRefresh = false;
        show();
      }
    },
    submit: (
      path: string,
      method: "POST" | "PATCH",
      body: Record<string, unknown>,
      label: string,
    ) => {
      if (
        !current() ||
        !token.initialized ||
        token.running ||
        token.blocked ||
        (token.saved && !(token.saved.outcome && token.separate)) ||
        token.legacy ||
        token.needsRefresh
      )
        return;
      // Freeze before the first await; caller edits cannot change the original.
      try {
        const original = selectedSchema(target).parse({
          ...structuredClone(body),
          requestId: crypto.randomUUID(),
        });
        return execute(
          freezeSchedulingValue({ path, method, body: original, label }),
          false,
        );
      } catch {
        token.error =
          "The exact original work request is invalid. Nothing was submitted.";
        show();
      }
    },
    retry: () =>
      current() && pending && token.initialized && !token.blocked
        ? execute(pending, true)
        : undefined,
  };
}
