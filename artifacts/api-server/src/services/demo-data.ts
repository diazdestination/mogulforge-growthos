import { lockCustomerWork, customerWorkFail } from "./customer-work-lineage";
import { assertNoSchedulingParticipantHistory } from "./scheduling-history";
import { hasRetainedEstimateEmailParticipant, ESTIMATE_EMAIL_HISTORY_RETAINED } from "./estimate-delivery-history";
import { db, contactsTable, leadsTable } from '@workspace/db';
import { and, eq, inArray, like } from 'drizzle-orm';

/**
 * One-click sample data so a fresh org isn't an empty CRM. Inserts a spread of
 * contacts + leads across the whole pipeline (multi-trade, generic home
 * services) with realistic values, sources, and won/lost outcomes — enough to
 * light up the dashboard, pipeline board, and ROI report.
 *
 * Everything is tagged (contact email domain + lead source) so it can be
 * cleared again cleanly. Raw inserts intentionally bypass the service layer, so
 * seeding never fires automations or outbound messages.
 */
const DEMO_EMAIL_DOMAIN = 'demo.mogulforge.dev';
const DEMO_SOURCE = 'demo-data';

type DemoLead = {
  firstName: string;
  lastName: string;
  phone: string;
  status: string;
  urgency: string;
  serviceType: string;
  source: string;
  score: number;
  valueCents: number;
  summary: string;
  outcome?: 'won' | 'lost';
  lostReason?: string;
};

const DEMO_LEADS: DemoLead[] = [
  { firstName: 'Sarah', lastName: 'Mitchell', phone: '(404) 555-0142', status: 'new', urgency: 'high', serviceType: 'HVAC', source: 'Google', score: 72, valueCents: 850000, summary: 'AC stopped cooling; wants a same-week diagnostic and quote.' },
  { firstName: 'James', lastName: 'Carter', phone: '(678) 555-0197', status: 'ai_qualified', urgency: 'normal', serviceType: 'Roofing', source: 'Facebook Ads', score: 81, valueCents: 1420000, summary: 'Storm damage on a 12-year-old shingle roof; insurance claim likely.' },
  { firstName: 'Emily', lastName: 'Nguyen', phone: '(470) 555-0163', status: 'contact_attempted', urgency: 'normal', serviceType: 'Solar', source: 'Website', score: 64, valueCents: 2200000, summary: 'Interested in a 9kW system; comparing two installers.' },
  { firstName: 'Michael', lastName: 'Brown', phone: '(404) 555-0128', status: 'inspection_scheduled', urgency: 'normal', serviceType: 'Windows', source: 'Referral', score: 77, valueCents: 980000, summary: 'Replacing 8 aging windows; measure appointment booked.' },
  { firstName: 'Olivia', lastName: 'Davis', phone: '(770) 555-0119', status: 'estimate_sent', urgency: 'normal', serviceType: 'Remodel', source: 'Google', score: 85, valueCents: 3500000, summary: 'Kitchen remodel; detailed estimate sent, awaiting decision.' },
  { firstName: 'Daniel', lastName: 'Wilson', phone: '(678) 555-0174', status: 'won', urgency: 'normal', serviceType: 'Roofing', source: 'Referral', score: 92, valueCents: 1675000, summary: 'Full roof replacement approved; production scheduling next.', outcome: 'won' },
  { firstName: 'Sophia', lastName: 'Martinez', phone: '(470) 555-0155', status: 'completed', urgency: 'low', serviceType: 'HVAC', source: 'Website', score: 88, valueCents: 730000, summary: 'New furnace installed and signed off; review requested.', outcome: 'won' },
  { firstName: 'William', lastName: 'Anderson', phone: '(404) 555-0186', status: 'follow_up', urgency: 'normal', serviceType: 'Solar', source: 'Facebook Ads', score: 58, valueCents: 1950000, summary: 'Wants to revisit financing options next month.' },
  { firstName: 'Ava', lastName: 'Thomas', phone: '(770) 555-0133', status: 'nurture', urgency: 'low', serviceType: 'Windows', source: 'Google', score: 41, valueCents: 620000, summary: 'Early-stage; gathering ideas for next year.' },
  { firstName: 'Ethan', lastName: 'Moore', phone: '(678) 555-0108', status: 'lost', urgency: 'normal', serviceType: 'Remodel', source: 'Website', score: 35, valueCents: 2800000, summary: 'Chose a competitor on price.', outcome: 'lost', lostReason: 'Price — went with a lower bid' },
];

export interface SeedResult {
  contacts: number;
  leads: number;
}

export async function seedDemoData(organizationId: string): Promise<SeedResult> {
  let contacts = 0;
  let leads = 0;
  for (const d of DEMO_LEADS) {
    const email = `${d.firstName}.${d.lastName}@${DEMO_EMAIL_DOMAIN}`.toLowerCase();
    const [contact] = await db
      .insert(contactsTable)
      .values({
        organizationId,
        firstName: d.firstName,
        lastName: d.lastName,
        email,
        phone: d.phone,
      })
      .returning({ id: contactsTable.id });
    contacts += 1;

    await db.insert(leadsTable).values({
      organizationId,
      contactId: contact.id,
      status: d.status as never,
      urgency: d.urgency as never,
      serviceType: d.serviceType,
      source: DEMO_SOURCE,
      sourceDetail: d.source,
      latestSource: d.source,
      creationMethod: 'import',
      score: d.score,
      summary: d.summary,
      estimatedValueCents: d.valueCents,
      ...(d.outcome === 'won'
        ? {
            wonAt: new Date(),
            wonRevenueCents: d.valueCents,
            wonAttribution: 'self_reported',
          }
        : {}),
      ...(d.outcome === 'lost' ? { lostReason: d.lostReason } : {}),
    });
    leads += 1;
  }
  return { contacts, leads };
}

export async function clearDemoData(organizationId: string): Promise<SeedResult> {
  return db.transaction(async tx => {
  await lockCustomerWork(tx,organizationId);
  const leads=await tx.select({id:leadsTable.id}).from(leadsTable).where(and(eq(leadsTable.organizationId,organizationId),eq(leadsTable.source,DEMO_SOURCE)));
  const contacts=await tx.select({id:contactsTable.id}).from(contactsTable).where(and(eq(contactsTable.organizationId,organizationId),like(contactsTable.email,`%@${DEMO_EMAIL_DOMAIN}`)));
  for(const row of leads) if(await hasRetainedEstimateEmailParticipant(tx,organizationId,"leadId",row.id)) customerWorkFail(ESTIMATE_EMAIL_HISTORY_RETAINED,"Demo cleanup cannot remove retained estimate email history.");
  for(const row of contacts) if(await hasRetainedEstimateEmailParticipant(tx,organizationId,"contactId",row.id)) customerWorkFail(ESTIMATE_EMAIL_HISTORY_RETAINED,"Demo cleanup cannot remove retained estimate email history.");
  await assertNoSchedulingParticipantHistory(tx,organizationId,[...leads.map(row=>row.id),...contacts.map(row=>row.id)]);
  // Ordinary source/email edits do not take the lifecycle lock. Delete only
  // the exact participants selected and checked above, never a fresh predicate match.
  const demoLeads = await tx
    .delete(leadsTable)
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        inArray(leadsTable.id, leads.map(row => row.id)),
      ),
    )
    .returning({ id: leadsTable.id });

  const demoContacts = await tx
    .delete(contactsTable)
    .where(
      and(
        eq(contactsTable.organizationId, organizationId),
        inArray(contactsTable.id, contacts.map(row => row.id)),
      ),
    )
    .returning({ id: contactsTable.id });

  return { contacts: demoContacts.length, leads: demoLeads.length };
  });
}
