import { seedCustomerWorkspaceFixture } from '../../../scripts/customer-workspace-fixture.mjs';
export async function seedCustomerWorkspacePreview(client, organizationId, actorUserId) {
  if (client.connectionParameters.host !== '127.0.0.1' || client.connectionParameters.database !== 'postgres')
    throw new Error('customer_workspace_preview_requires_disposable_loopback');
  const id = await seedCustomerWorkspaceFixture(client, 'local-runtime-customer-workspace', { organization: organizationId, user: actorUserId });
  console.log(`SYNTHETIC workspace: /contacts/${id.contact}?organizationId=${organizationId}; exact future visit: /appointments?appointmentId=${id.appointments[0]}&organizationId=${organizationId}. No provider authority, all DNC flags true.`);
}
