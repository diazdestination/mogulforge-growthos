import { and, eq, sql } from "drizzle-orm";
import { auditEventsTable, db, estimatesTable, projectsTable, type EstimateLineItem } from "@workspace/db";
import { customerWorkCommandsTable as commands } from "../../../../lib/db/src/schema/customer-work";
import { assertHistoricalStaff, assertOperationalStaff, assertResourceWindow, assertScheduleInterval, ensureInvoicePreparationTask } from "./contractor-scheduling";
import { assertCustomerWorkActive, createCustomerWorkRoot, customerWorkActor, customerWorkFail, customerWorkHash, lockCustomerWork, nativeWorkLabels, readNativeWorkLineage, type CustomerWorkActor, type CustomerWorkReader, type CustomerWorkTx } from "./customer-work-lineage";
import { createCustomerWorkEstimateSchema, createCustomerWorkProjectSchema, customerWorkEstimateMutationSchema, customerWorkProjectMutationSchema, updateCustomerWorkEstimateSchema, updateCustomerWorkProjectSchema, type CustomerWorkEstimateMutation, type CustomerWorkProjectMutation } from "./returning-customer-contract";

type Command = typeof commands.$inferSelect;
function dates<T extends Record<string, unknown>>(row: T) { return Object.fromEntries(Object.entries(row).map(([k,v]) => [k,v instanceof Date ? v.toISOString() : v])); }
function version(actual: number | null, expected: number) { if (!actual || actual !== expected) customerWorkFail("customer_work_stale_version", "This saved record changed. Refresh it before submitting another command."); }
export async function readNativeEstimate(reader: CustomerWorkReader, org: string, id: string, locked = false) {
  const q = reader.select().from(estimatesTable).where(and(eq(estimatesTable.organizationId, org), eq(estimatesTable.id, id)));
  const [row] = await (locked ? q.for("share") : q); if (!row) return null;
  const lineage = await readNativeWorkLineage(reader, org, row, locked);
  return { ...row, ...nativeWorkLabels(lineage) };
}
export async function readNativeProject(reader: CustomerWorkReader, org: string, id: string, locked = false) {
  const q = reader.select().from(projectsTable).where(and(eq(projectsTable.organizationId, org), eq(projectsTable.id, id)));
  const [row] = await (locked ? q.for("share") : q); if (!row) return null;
  const lineage = await readNativeWorkLineage(reader, org, row, locked);
  if (row.estimateId) {
    const eqry = reader.select().from(estimatesTable).where(and(eq(estimatesTable.organizationId, org), eq(estimatesTable.id, row.estimateId)));
    const [estimate] = await (locked ? eqry.for("share") : eqry);
    if (!estimate || estimate.leadId !== row.leadId || estimate.customerWorkId !== row.customerWorkId) customerWorkFail("customer_work_parent_mismatch");
  }
  return { ...row, ...nativeWorkLabels(lineage) };
}
async function commandResponse(reader: CustomerWorkReader, org: string, command: Command, duplicate: boolean) {
  const common = { organizationId: org, command: { requestId: command.requestId, action: command.action, customerWorkId: command.customerWorkId, targetId: command.estimateId ?? command.projectId, version: command.resultVersion, duplicate } };
  if (command.estimateId) {
    const estimate = await readNativeEstimate(reader, org, command.estimateId);
    if (!estimate || estimate.customerWorkId !== command.customerWorkId) customerWorkFail("customer_work_result_unavailable");
    return customerWorkEstimateMutationSchema.parse({ ...common, estimate: dates(estimate) });
  }
  const project = await readNativeProject(reader, org, command.projectId!);
  if (!project || project.customerWorkId !== command.customerWorkId) customerWorkFail("customer_work_result_unavailable");
  return customerWorkProjectMutationSchema.parse({ ...common, project: dates(project) });
}
async function runCommand(org: string, actor: CustomerWorkActor, action: Command["action"], input: {requestId: string}, targetId: string | null, work: (tx: CustomerWorkTx) => Promise<{customerWorkId: string;estimateId?: string;projectId?: string;version: number}>) {
  const hash = customerWorkHash({ action, targetId, input, actorUserId: actor.userId });
  return db.transaction(async tx => {
    await lockCustomerWork(tx, org, true);
    await customerWorkActor(tx, org, actor, "crm.write", true);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-work-command:${org}:${input.requestId}`},0))`);
    const [prior] = await tx.select().from(commands).where(and(eq(commands.organizationId, org), eq(commands.requestId, input.requestId)));
    if (prior) {
      if (prior.action !== action || prior.actorUserId !== actor.userId || prior.payloadSha256 !== hash || (targetId !== null && (prior.estimateId ?? prior.projectId) !== targetId)) customerWorkFail("customer_work_request_conflict", "This request already owns different work. Reconcile the original submitted command.");
      return commandResponse(tx, org, prior, true);
    }
    await assertCustomerWorkActive(tx, org);
    const result = await work(tx);
    const [command] = await tx.insert(commands).values({organizationId: org, requestId: input.requestId, action, actorUserId: actor.userId, payloadSha256: hash, customerWorkId: result.customerWorkId, estimateId: result.estimateId ?? null, projectId: result.projectId ?? null, resultVersion: result.version}).returning();
    await tx.insert(auditEventsTable).values({organizationId: org, actorUserId: actor.userId, action: `customer_work.${action}`, entityType: result.estimateId ? "estimate" : "project", entityId: result.estimateId ?? result.projectId!, metadata: { requestId: input.requestId, customerWorkId: result.customerWorkId, workVersion: result.version, staffRecorded: true, providerEffect: false }});
    return commandResponse(tx, org, command!, false);
  });
}
function totals(input: {lineItems: {description: string;quantity: number;unitPriceCents: number}[];taxCents: number}) {
  const lineItems: EstimateLineItem[] = input.lineItems.map(line => {
    const [whole, fraction = ""] = String(line.quantity).split(".");
    const total = ((BigInt(whole) * 1000n + BigInt(fraction.padEnd(3,"0"))) * BigInt(line.unitPriceCents) + 500n) / 1000n;
    if (total > 1_000_000_000n) customerWorkFail("customer_work_invalid_amount", "A line exceeds the supported whole-cent amount.", 400);
    return {...line,totalCents: Number(total)};
  });
  const subtotalCents = lineItems.reduce((sum,line) => sum+line.totalCents,0), totalCents = subtotalCents+input.taxCents;
  if (!Number.isSafeInteger(totalCents) || totalCents > 1_000_000_000) customerWorkFail("customer_work_invalid_amount", "The estimate exceeds the supported whole-cent amount.", 400);
  return {lineItems,subtotalCents,taxCents:input.taxCents,totalCents};
}
export async function createCustomerWorkEstimate(org: string, actor: CustomerWorkActor, raw: unknown): Promise<CustomerWorkEstimateMutation> {
  const input = createCustomerWorkEstimateSchema.parse(raw);
  return runCommand(org, actor, "estimate_created", input, null, async tx => {
    const amounts = totals(input), root = await createCustomerWorkRoot(tx,org,actor.userId,input.source);
    const [row] = await tx.insert(estimatesTable).values({organizationId:org,leadId:null,customerWorkId:root.id,workVersion:1,title:input.title,notes:input.notes,status:"draft",...amounts}).returning();
    return {customerWorkId:root.id,estimateId:row!.id,version:1};
  }) as Promise<CustomerWorkEstimateMutation>;
}
export async function updateCustomerWorkEstimate(org: string, actor: CustomerWorkActor, id: string, raw: unknown): Promise<CustomerWorkEstimateMutation> {
  const input = updateCustomerWorkEstimateSchema.parse(raw);
  return runCommand(org,actor,"estimate_updated",input,id,async tx => {
    const current = await readNativeEstimate(tx,org,id,true);
    if (!current?.customerWorkId || current.leadId !== null) customerWorkFail("customer_work_not_found","Use the versioned returning estimate in this company.",404);
    version(current.workVersion,input.expectedWorkVersion);
    const [project] = await tx.select({id:projectsTable.id}).from(projectsTable).where(and(eq(projectsTable.organizationId,org),eq(projectsTable.customerWorkId,current.customerWorkId))).limit(1);
    const amounts = totals(input);
    if (project && (customerWorkHash(amounts) !== customerWorkHash({lineItems:current.lineItems,subtotalCents:current.subtotalCents,taxCents:current.taxCents,totalCents:current.totalCents}) || input.status !== current.status)) customerWorkFail("customer_work_estimate_retained","This job retains its accepted estimate. Its price and acceptance cannot be replaced.");
    if (input.status === "accepted" && (!amounts.lineItems.length || amounts.totalCents < 1)) customerWorkFail("customer_work_invalid_amount","Review at least one positive priced line before recording acceptance.",400);
    const [row] = await tx.update(estimatesTable).set({...amounts,title:input.title,notes:input.notes,status:input.status,workVersion:current.workVersion!+1,updatedAt:new Date(),sentAt:input.status==="sent" && !current.sentAt ? new Date() : current.sentAt,acceptedAt:input.status==="accepted" && !current.acceptedAt ? new Date() : current.acceptedAt}).where(and(eq(estimatesTable.organizationId,org),eq(estimatesTable.id,id),eq(estimatesTable.workVersion,current.workVersion!))).returning();
    if (!row) customerWorkFail("customer_work_stale_version");
    return {customerWorkId:current.customerWorkId,estimateId:id,version:row.workVersion!};
  }) as Promise<CustomerWorkEstimateMutation>;
}
async function schedule(tx: CustomerWorkTx, org: string, input: ReturnType<typeof createCustomerWorkProjectSchema.parse>, existing?: typeof projectsTable.$inferSelect) {
  const start = input.scheduledStart ? new Date(input.scheduledStart) : null, end = input.scheduledEnd ? new Date(input.scheduledEnd) : null;
  if (existing && ["completed","cancelled"].includes(input.status)) { await assertHistoricalStaff(tx,org,input.crewUserIds); await assertOperationalStaff(tx,org,input.crewUserIds.filter(id => !existing.crewUserIds.includes(id))); }
  else await assertOperationalStaff(tx,org,input.crewUserIds);
  assertScheduleInterval(start,end);
  if (start && input.crewUserIds.length && !end) customerWorkFail("customer_work_invalid_interval","Set an end time for assigned crew work.",400);
  if (start && ["scheduled","in_progress"].includes(input.status)) await assertResourceWindow(tx,org,input.crewUserIds,start,end ?? new Date(start.getTime()+86_400_000),{projectId:existing?.id});
  return {scheduledStart:start,scheduledEnd:end};
}
export async function createCustomerWorkProject(org: string, actor: CustomerWorkActor, raw: unknown): Promise<CustomerWorkProjectMutation> {
  const input = createCustomerWorkProjectSchema.parse(raw);
  return runCommand(org,actor,"project_created",input,null,async tx => {
    let customerWorkId: string, estimateId: string | null = null;
    if (input.source.kind === "estimate") {
      const estimate = await readNativeEstimate(tx,org,input.source.estimateId,true);
      if (!estimate?.customerWorkId || estimate.leadId !== null) customerWorkFail("customer_work_not_found","Choose an accepted returning-customer estimate.",404);
      version(estimate.workVersion,input.source.expectedWorkVersion);
      if (estimate.status !== "accepted" || !estimate.acceptedAt) customerWorkFail("customer_work_estimate_not_accepted","Record the saved estimate's staff acceptance first.");
      customerWorkId = estimate.customerWorkId; estimateId = estimate.id;
      const [existing] = await tx.select({id:projectsTable.id}).from(projectsTable).where(and(eq(projectsTable.organizationId,org),eq(projectsTable.customerWorkId,customerWorkId))).limit(1);
      if (existing) customerWorkFail("customer_work_project_exists","This estimate already has its original job. Open that job; a new request cannot duplicate it.");
    } else customerWorkId = (await createCustomerWorkRoot(tx,org,actor.userId,input.source)).id;
    const window = await schedule(tx,org,input);
    const [row] = await tx.insert(projectsTable).values({organizationId:org,leadId:null,customerWorkId,workVersion:1,estimateId,name:input.name,status:input.status,...window,crewUserIds:input.crewUserIds,crewNotes:input.crewNotes,completedAt:input.status==="completed" ? new Date() : null}).returning();
    await ensureInvoicePreparationTask(tx,row!);
    return {customerWorkId,projectId:row!.id,version:1};
  }) as Promise<CustomerWorkProjectMutation>;
}
export async function updateCustomerWorkProject(org: string, actor: CustomerWorkActor, id: string, raw: unknown): Promise<CustomerWorkProjectMutation> {
  const input = updateCustomerWorkProjectSchema.parse(raw);
  return runCommand(org,actor,"project_updated",input,id,async tx => {
    const current = await readNativeProject(tx,org,id,true);
    if (!current?.customerWorkId || current.leadId !== null) customerWorkFail("customer_work_not_found","Use the versioned returning job in this company.",404);
    version(current.workVersion,input.expectedWorkVersion);
    const window = await schedule(tx,org,{...input,source:{kind:"existing_customer",contactId:current.contactId,propertyId:current.propertyId}},current);
    const [row] = await tx.update(projectsTable).set({name:input.name,status:input.status,...window,crewUserIds:input.crewUserIds,crewNotes:input.crewNotes,completedAt:input.status==="completed" ? current.completedAt ?? new Date() : null,workVersion:current.workVersion!+1,updatedAt:new Date()}).where(and(eq(projectsTable.organizationId,org),eq(projectsTable.id,id),eq(projectsTable.workVersion,current.workVersion!))).returning();
    if (!row) customerWorkFail("customer_work_stale_version");
    await ensureInvoicePreparationTask(tx,row);
    return {customerWorkId:current.customerWorkId,projectId:id,version:row.workVersion!};
  }) as Promise<CustomerWorkProjectMutation>;
}
