import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/** Read-only, dependency-neutral disjoint business lineage; never contact pooling. */
export function validWorkReadScope(
  org: string,
  leadId: SQLWrapper,
  workId: SQLWrapper,
): SQL {
  return sql`((${leadId} IS NOT NULL AND ${workId} IS NULL AND EXISTS
    (SELECT 1 FROM leads l JOIN contacts c ON c.id=l.contact_id AND c.organization_id=${org}
      LEFT JOIN properties p ON p.id=l.property_id AND p.organization_id=${org} AND p.contact_id=l.contact_id
      WHERE l.id=${leadId} AND l.organization_id=${org} AND (l.property_id IS NULL OR p.id IS NOT NULL)))
    OR (${leadId} IS NULL AND ${workId} IS NOT NULL AND EXISTS
      (SELECT 1 FROM customer_work_roots w JOIN contacts c ON c.id=w.contact_id AND c.organization_id=${org}
        LEFT JOIN properties p ON p.id=w.property_id AND p.organization_id=${org} AND p.contact_id=w.contact_id
        JOIN users u ON u.id=w.created_by_user_id AND u.organization_id=${org}
        WHERE w.id=${workId} AND w.organization_id=${org} AND (w.property_id IS NULL OR p.id IS NOT NULL))))`;
}
