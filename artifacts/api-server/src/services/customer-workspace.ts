import { db, usersTable, type UserRole } from "@workspace/db";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod/v4";
import { hasPermission } from "../lib/permissions";
import {
  CUSTOMER_WORKSPACE_SECTIONS, CustomerWorkspaceError,
  customerWorkspaceAppointmentDetailSchema, customerWorkspaceHeaderSchema,
  customerWorkspacePageSchema, customerWorkspaceSectionQuerySchema,
  type CustomerWorkspaceAppointmentDetail, type CustomerWorkspaceHeader,
  type CustomerWorkspacePage, type CustomerWorkspaceSection,
  type CustomerWorkspaceSectionQuery,
} from "./customer-workspace-contract";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const LIMIT = 25;
/** Longer or cyclic historical chains are withheld, not reinterpreted as roots. */
const MAX_SERVICE_ANCESTRY = 256;
const readOptions = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
const deny = () => new CustomerWorkspaceError(403, "customer_workspace_access_denied", "An accepted, verified, active company membership is required.");
const missing = () => new CustomerWorkspaceError(404, "customer_workspace_not_found", "This customer or work record is unavailable in your company.");
const invalid = () => new CustomerWorkspaceError(400, "customer_workspace_invalid_request", "Choose a valid customer, section and page from this company.");
function uuid(value: string): string { const result = z.uuid().safeParse(value); if (!result.success) throw invalid(); return result.data; }
function projection<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CustomerWorkspaceError(503, "customer_workspace_unavailable", "This saved record could not be safely read. No data was changed.");
  return parsed.data;
}
const iso = (value: unknown): string | null => value == null ? null : new Date(value as string).toISOString();
const dateFields = ["createdAt", "updatedAt", "scheduledStart", "scheduledEnd", "dueAt", "completedAt", "issuedAt", "occurredAt"];
function dates(raw: Record<string, unknown>) {
  const row = { ...raw };
  for (const key of dateFields) if (key in row) row[key] = iso(row[key]);
  return row;
}
async function actor(tx: Tx, organizationId: string, userId: string, effectiveRole?: UserRole) {
  const [user] = await tx.select({ id: usersTable.id, role: usersTable.role, emailVerifiedAt: usersTable.emailVerifiedAt })
    .from(usersTable).where(and(eq(usersTable.id, userId), eq(usersTable.organizationId, organizationId), eq(usersTable.isActive, true)));
  if (!user || user.id.startsWith("invite:") || !user.emailVerifiedAt || !hasPermission(user.role, "crm.read") ||
    (effectiveRole !== undefined && !hasPermission(effectiveRole, "crm.read"))) throw deny();
  return {
    canWrite: hasPermission(user.role, "crm.write") && hasPermission(effectiveRole ?? user.role, "crm.write"),
    canReadInvoices: hasPermission(user.role, "invoices.read") && hasPermission(effectiveRole ?? user.role, "invoices.read"),
  };
}
async function contact(tx: Tx, organizationId: string, contactId: string) {
  const result = await tx.execute(sql`SELECT id,first_name AS "firstName",last_name AS "lastName",email,phone,
    preferred_contact_method AS "preferredContactMethod",do_not_contact AS "doNotContact",
    do_not_contact_email AS "doNotContactEmail",do_not_contact_sms AS "doNotContactSms",
    created_at AS "createdAt",updated_at AS "updatedAt"
    FROM contacts WHERE organization_id=${organizationId} AND id=${contactId} LIMIT 1`);
  if (!result.rows[0]) throw missing();
  return dates(result.rows[0]);
}

/**
 * Each populated parent must agree before pagination. Historical FKs are ID-only,
 * so checking the child organization alone would expose another customer's work.
 * A null customer selector is used only by the exact same-company visit read.
 */
function graph(organizationId: string, contactId: string | null): SQL {
  return sql`WITH RECURSIVE
  scoped_contacts AS (
    SELECT c.id FROM contacts c WHERE c.organization_id=${organizationId}
      ${contactId ? sql`AND c.id=${contactId}` : sql``}
  ),
  valid_properties AS (
    SELECT p.* FROM properties p JOIN scoped_contacts c ON c.id=p.contact_id
    WHERE p.organization_id=${organizationId}
  ),
  valid_leads AS (
    SELECT l.* FROM leads l JOIN scoped_contacts c ON c.id=l.contact_id
    LEFT JOIN valid_properties p ON p.id=l.property_id AND p.contact_id=l.contact_id
    LEFT JOIN users u ON u.id=l.assigned_user_id AND u.organization_id=${organizationId}
    WHERE l.organization_id=${organizationId} AND (l.property_id IS NULL OR p.id IS NOT NULL)
      AND (l.assigned_user_id IS NULL OR u.id IS NOT NULL)
  ),
  valid_estimates AS (
    SELECT e.* FROM estimates e JOIN valid_leads l ON l.id=e.lead_id
    WHERE e.organization_id=${organizationId}
  ),
  valid_projects AS (
    SELECT j.* FROM projects j JOIN valid_leads l ON l.id=j.lead_id
    LEFT JOIN valid_estimates e ON e.id=j.estimate_id AND e.lead_id=j.lead_id
    WHERE j.organization_id=${organizationId} AND (j.estimate_id IS NULL OR e.id IS NOT NULL)
      AND jsonb_typeof(j.crew_user_ids)='array'
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(j.crew_user_ids)='array' THEN j.crew_user_ids ELSE '[]'::jsonb END) crew(id)
        WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id=crew.id AND u.organization_id=${organizationId}))
  ),
  valid_tasks AS (
    SELECT t.*,coalesce(c.id,l.contact_id) AS resolved_contact_id,l.property_id AS lead_property_id
    FROM crm_tasks t
    LEFT JOIN scoped_contacts c ON c.id=t.contact_id
    LEFT JOIN valid_leads l ON l.id=t.lead_id
    LEFT JOIN users u ON u.id=t.assigned_user_id AND u.organization_id=${organizationId}
    WHERE t.organization_id=${organizationId}
      AND (t.contact_id IS NULL OR c.id IS NOT NULL) AND (t.lead_id IS NULL OR l.id IS NOT NULL)
      AND (t.contact_id IS NULL OR l.id IS NULL OR t.contact_id=l.contact_id)
      AND (t.assigned_user_id IS NULL OR u.id IS NOT NULL)
  ),
  valid_appointments AS (
    SELECT a.*,coalesce(c.id,l.contact_id,p.contact_id) AS resolved_contact_id
    FROM appointments a
    LEFT JOIN scoped_contacts c ON c.id=a.contact_id
    LEFT JOIN valid_leads l ON l.id=a.lead_id
    LEFT JOIN valid_properties p ON p.id=a.property_id
    LEFT JOIN users u ON u.id=a.assigned_user_id AND u.organization_id=${organizationId}
    WHERE a.organization_id=${organizationId}
      AND (a.contact_id IS NULL OR c.id IS NOT NULL) AND (a.lead_id IS NULL OR l.id IS NOT NULL)
      AND (a.property_id IS NULL OR p.id IS NOT NULL)
      AND (a.contact_id IS NULL OR l.id IS NULL OR a.contact_id=l.contact_id)
      AND (a.contact_id IS NULL OR p.id IS NULL OR a.contact_id=p.contact_id)
      AND (l.id IS NULL OR p.id IS NULL OR l.contact_id=p.contact_id)
      AND (l.property_id IS NULL OR a.property_id IS NULL OR l.property_id=a.property_id)
      AND (a.assigned_user_id IS NULL OR u.id IS NOT NULL)
  ),
  service_candidates AS (
    SELECT s.* FROM service_obligations s JOIN scoped_contacts c ON c.id=s.contact_id
    JOIN valid_tasks t ON t.id=s.task_id
    LEFT JOIN valid_properties p ON p.id=s.property_id AND p.contact_id=s.contact_id
    LEFT JOIN valid_appointments a ON a.id=s.appointment_id AND a.resolved_contact_id=s.contact_id
    WHERE s.organization_id=${organizationId}
      AND (s.property_id IS NULL OR p.id IS NOT NULL)
      AND (t.resolved_contact_id IS NULL OR t.resolved_contact_id=s.contact_id)
      AND (s.property_id IS NULL OR t.lead_property_id IS NULL OR s.property_id=t.lead_property_id)
      AND (s.appointment_id IS NULL OR a.id IS NOT NULL)
      AND (s.property_id IS NULL OR a.property_id IS NULL OR s.property_id=a.property_id)
      AND s.occurrence_index>=0
  ),
  valid_services AS (
    SELECT s.*,1 AS lineage_depth FROM service_candidates s
      WHERE s.predecessor_obligation_id IS NULL AND s.occurrence_index=0
    UNION ALL
    SELECT s.*,p.lineage_depth+1 FROM service_candidates s JOIN valid_services p
      ON p.id=s.predecessor_obligation_id AND p.contact_id=s.contact_id
        AND p.property_id IS NOT DISTINCT FROM s.property_id
        AND s.occurrence_index=p.occurrence_index+1
      WHERE p.lineage_depth<${MAX_SERVICE_ANCESTRY}
  ),
  valid_invoices AS (
    SELECT i.* FROM invoices i JOIN valid_leads l ON l.id=i.lead_id
    LEFT JOIN valid_projects j ON j.id=i.project_id AND j.lead_id=i.lead_id
    LEFT JOIN valid_estimates e ON e.id=i.estimate_id AND e.lead_id=i.lead_id
    WHERE i.organization_id=${organizationId}
      AND (i.project_id IS NULL OR j.id IS NOT NULL) AND (i.estimate_id IS NULL OR e.id IS NOT NULL)
      AND (j.estimate_id IS NULL OR i.estimate_id IS NULL OR j.estimate_id=i.estimate_id)
  )`;
}
// SQL aliases below are fixed source identifiers, never input or saved URLs.
function propertyJson(alias = "p") {
  const p = sql.raw(alias);
  return sql`CASE WHEN ${p}.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id',${p}.id,'addressLine1',${p}.address_line_1,'addressLine2',${p}.address_line_2,
    'city',${p}.city,'state',${p}.state,'postalCode',${p}.postal_code,'propertyType',${p}.property_type) END`;
}
function ownerJson() {
  return sql`CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object('id',u.id,
    'name',nullif(concat_ws(' ',u.first_name,u.last_name),'')) END`;
}
const appointmentSelection = sql`SELECT a.id,'appointment' AS kind,a.created_at AS "createdAt",a.created_at AS "_createdAt",
  a.type,a.status,a.scheduled_start AS "scheduledStart",a.scheduled_end AS "scheduledEnd",a.updated_at AS "updatedAt",
  a.resolved_contact_id AS "contactId",a.lead_id AS "leadId",${propertyJson()} AS property,${ownerJson()} AS owner
  FROM valid_appointments a LEFT JOIN valid_properties p ON p.id=a.property_id
  LEFT JOIN users u ON u.id=a.assigned_user_id AND u.organization_id=a.organization_id`;

function selection(section: CustomerWorkspaceSection, organizationId: string, contactId: string, canReadInvoices: boolean): SQL {
  switch (section) {
    case "properties": return sql`SELECT p.id,'property' AS kind,p.created_at AS "createdAt",p.created_at AS "_createdAt",
      p.address_line_1 AS "addressLine1",p.address_line_2 AS "addressLine2",p.city,p.state,
      p.postal_code AS "postalCode",p.property_type AS "propertyType" FROM valid_properties p`;
    case "appointments": return sql`${appointmentSelection} WHERE a.resolved_contact_id=${contactId}`;
    case "leads": return sql`SELECT l.id,'lead' AS kind,l.created_at AS "createdAt",l.created_at AS "_createdAt",
      l.status,l.urgency,l.service_type AS "serviceType",${propertyJson()} AS property,${ownerJson()} AS owner
      FROM valid_leads l LEFT JOIN valid_properties p ON p.id=l.property_id
      LEFT JOIN users u ON u.id=l.assigned_user_id AND u.organization_id=l.organization_id`;
    case "estimates": return sql`SELECT e.id,'estimate' AS kind,e.created_at AS "createdAt",e.created_at AS "_createdAt",
      e.title,e.status,e.lead_id AS "leadId",${propertyJson()} AS property
      FROM valid_estimates e JOIN valid_leads l ON l.id=e.lead_id LEFT JOIN valid_properties p ON p.id=l.property_id`;
    case "projects": return sql`SELECT j.id,'project' AS kind,j.created_at AS "createdAt",j.created_at AS "_createdAt",
      j.name,j.status,j.scheduled_start AS "scheduledStart",j.scheduled_end AS "scheduledEnd",j.completed_at AS "completedAt",
      j.lead_id AS "leadId",j.estimate_id AS "estimateId",${propertyJson()} AS property
      FROM valid_projects j JOIN valid_leads l ON l.id=j.lead_id LEFT JOIN valid_properties p ON p.id=l.property_id`;
    case "invoices": return sql`SELECT i.id,'invoice' AS kind,i.created_at AS "createdAt",i.created_at AS "_createdAt",
      i.invoice_number AS "invoiceNumber",coalesce(i.issued_document->>'title',i.draft_document->>'title','Invoice') AS title,
      i.status,i.issued_at AS "issuedAt",i.lead_id AS "leadId",i.project_id AS "projectId",i.estimate_id AS "estimateId",
      ${propertyJson()} AS property FROM valid_invoices i JOIN valid_leads l ON l.id=i.lead_id LEFT JOIN valid_properties p ON p.id=l.property_id`;
    case "services": return sql`SELECT s.id,'service' AS kind,s.created_at AS "createdAt",s.created_at AS "_createdAt",
      s.kind AS "serviceKind",s.equipment_label AS "equipmentLabel",s.status,s.due_at AS "dueAt",s.completed_at AS "completedAt",
      s.coverage_starts_on AS "coverageStartsOn",s.coverage_ends_on AS "coverageEndsOn",s.occurrence_index AS "occurrenceIndex",
      s.predecessor_obligation_id AS "predecessorObligationId",s.task_id AS "taskId",s.appointment_id AS "appointmentId",
      ${propertyJson()} AS property,${ownerJson()} AS owner FROM valid_services s
      JOIN valid_tasks t ON t.id=s.task_id LEFT JOIN valid_properties p ON p.id=s.property_id
      LEFT JOIN users u ON u.id=t.assigned_user_id AND u.organization_id=s.organization_id`;
    case "tasks": return sql`SELECT t.id,'task' AS kind,t.created_at AS "createdAt",t.created_at AS "_createdAt",
      t.title,t.status,t.priority,t.due_at AS "dueAt",t.completed_at AS "completedAt",t.lead_id AS "leadId",${ownerJson()} AS owner
      FROM valid_tasks t LEFT JOIN users u ON u.id=t.assigned_user_id AND u.organization_id=t.organization_id
      WHERE t.resolved_contact_id=${contactId} OR EXISTS (SELECT 1 FROM valid_services s WHERE s.task_id=t.id)`;
    case "activity": return sql`SELECT a.id,'activity' AS kind,a.created_at AS "createdAt",a.created_at AS "_createdAt",
      CASE WHEN a.type='note' THEN 'note' WHEN a.type IN ('lead_captured','lead_status_changed') THEN 'lead'
        WHEN a.type IN ('appointment_scheduled','appointment_updated') THEN 'appointment'
        WHEN a.type IN ('service_created','service_completed','service_updated') THEN 'service'
        WHEN a.type IN ('task_created','task_completed','task_updated') THEN 'task'
        WHEN a.type='invoice_event' THEN 'invoice' ELSE 'communication' END AS category,
      CASE WHEN a.type='note' THEN 'Note recorded' WHEN a.type IN ('lead_captured','lead_status_changed') THEN 'Opportunity updated'
        WHEN a.type IN ('appointment_scheduled','appointment_updated') THEN 'Visit updated'
        WHEN a.type IN ('service_created','service_completed','service_updated') THEN 'Service updated'
        WHEN a.type IN ('task_created','task_completed','task_updated') THEN 'Task updated'
        WHEN a.type='invoice_event' THEN 'Invoice updated'
        WHEN a.type IN ('customer_reply','portal_message') THEN 'Customer response recorded'
        ELSE 'Communication event recorded' END AS label,
      a.occurred_at AS "occurredAt",a.lead_id AS "leadId"
      FROM activities a LEFT JOIN scoped_contacts c ON c.id=a.contact_id LEFT JOIN valid_leads l ON l.id=a.lead_id
      LEFT JOIN users u ON u.id=a.actor_user_id AND u.organization_id=${organizationId}
      WHERE a.organization_id=${organizationId}
        AND (a.contact_id IS NULL OR c.id IS NOT NULL) AND (a.lead_id IS NULL OR l.id IS NOT NULL)
        AND (a.contact_id IS NULL OR l.id IS NULL OR a.contact_id=l.contact_id)
        AND (a.actor_user_id IS NULL OR u.id IS NOT NULL)
        AND (c.id=${contactId} OR l.contact_id=${contactId})
        AND a.type IN ('note','lead_captured','lead_status_changed','appointment_scheduled','appointment_updated',
          'service_created','service_completed','service_updated','task_created','task_completed','task_updated',
          'customer_reply','portal_message','email_sent','bie_email_sent','automation_message_sent',
          'playbook_touch_sent','confirmation_sent','appointment_reminder_sent','smart_site_contact_attempt',
          'message_bounced','message_delivery_delayed','message_delivery_failed','message_unsubscribed','invoice_event')
        AND (a.type<>'invoice_event' OR ${canReadInvoices})`;
  }
}

const cursorSchema = z.object({
  version: z.literal(1), organizationId: z.uuid(), contactId: z.uuid(),
  section: z.enum(CUSTOMER_WORKSPACE_SECTIONS),
  createdAt: z.iso.datetime({ precision: 6 }), id: z.uuid(),
}).strict();
function decodeCursor(value: string | undefined, organizationId: string, contactId: string, section: CustomerWorkspaceSection) {
  if (!value) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw invalid();
    const decoded = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (decoded.organizationId !== organizationId || decoded.contactId !== contactId || decoded.section !== section) throw invalid();
    return decoded;
  } catch { throw invalid(); }
}

export async function getCustomerWorkspace(organizationId: string, userId: string, contactId: string, effectiveRole?: UserRole): Promise<CustomerWorkspaceHeader> {
  uuid(organizationId); uuid(contactId);
  return db.transaction(async (tx) => {
    const permissions = await actor(tx, organizationId, userId, effectiveRole);
    return projection(customerWorkspaceHeaderSchema, { organizationId, contact: await contact(tx, organizationId, contactId),
      permissions, availableSections: CUSTOMER_WORKSPACE_SECTIONS.filter(section => section !== "invoices" || permissions.canReadInvoices) });
  }, readOptions);
}

export async function getCustomerWorkspaceSection(organizationId: string, userId: string, contactId: string, input: CustomerWorkspaceSectionQuery, effectiveRole?: UserRole): Promise<CustomerWorkspacePage> {
  uuid(organizationId); uuid(contactId);
  const parsed = customerWorkspaceSectionQuerySchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const { section } = parsed.data;
  const cursor = decodeCursor(parsed.data.cursor, organizationId, contactId, section);
  return db.transaction(async (tx) => {
    const permissions = await actor(tx, organizationId, userId, effectiveRole);
    await contact(tx, organizationId, contactId);
    if (section === "invoices" && !permissions.canReadInvoices)
      throw new CustomerWorkspaceError(403, "customer_workspace_invoice_access_denied", "Invoice access is not available for your current role.");
    const result = await tx.execute(sql`${graph(organizationId, contactId)}
      SELECT work.*,to_char(work."_createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "_cursorTime"
      FROM (${selection(section, organizationId, contactId, permissions.canReadInvoices)}) work
      ${cursor ? sql`WHERE (work."_createdAt",work.id)<(${cursor.createdAt}::timestamptz,${cursor.id}::uuid)` : sql``}
      ORDER BY work."_createdAt" DESC,work.id DESC LIMIT ${LIMIT + 1}`);
    const hasMore = result.rows.length > LIMIT;
    const visible = result.rows.slice(0, LIMIT);
    const last = visible.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify(cursorSchema.parse({
      version: 1, organizationId, contactId, section, createdAt: last._cursorTime, id: last.id,
    }))).toString("base64url") : null;
    const items = visible.map(raw => { const { _createdAt, _cursorTime, ...row } = raw; return dates(row); });
    return projection(customerWorkspacePageSchema, { organizationId, contactId, section, order: "created_desc", limit: LIMIT, items, nextCursor, hasMore });
  }, readOptions);
}

export async function getCustomerWorkspaceAppointment(organizationId: string, userId: string, appointmentId: string, effectiveRole?: UserRole): Promise<CustomerWorkspaceAppointmentDetail> {
  uuid(organizationId); uuid(appointmentId);
  return db.transaction(async (tx) => {
    const permissions = await actor(tx, organizationId, userId, effectiveRole);
    const result = await tx.execute(sql`${graph(organizationId, null)} ${appointmentSelection} WHERE a.id=${appointmentId} LIMIT 1`);
    if (!result.rows[0]) throw missing();
    const { _createdAt, ...row } = result.rows[0];
    return projection(customerWorkspaceAppointmentDetailSchema, { organizationId, appointment: dates(row), permissions: { canWrite: permissions.canWrite } });
  }, readOptions);
}
