export * from '../../../api-server/src/services/contractor-workday-contract';
import { appointmentWorkSchema, workdayAssetPageSchema, workdayTemplateCatalogSchema, type AppointmentWork } from '../../../api-server/src/services/contractor-workday-contract';

export function assetPageFor(organizationId: string, contactId: string, propertyId: string | null = null) {
  return workdayAssetPageSchema.refine(page => page.organizationId === organizationId && page.contactId === contactId && page.propertyId === propertyId &&
    page.hasMore === (page.nextCursor !== null) && (!page.nextCursor || /^[A-Za-z0-9_-]+$/.test(page.nextCursor)) && new Set(page.items.map(item => item.id)).size === page.items.length &&
    page.items.every(item => item.organizationId === organizationId && item.contactId === contactId && (!propertyId || item.propertyId === propertyId)), 'Asset response context changed');
}
export function catalogFor(organizationId: string) {
  return workdayTemplateCatalogSchema.refine(view => view.organizationId === organizationId && new Set(view.templates.map(item => item.id)).size === view.templates.length && view.templates.every(item => item.organizationId === organizationId && item.latestRevision.templateId === item.id && (!item.approvedRevision || item.approvedRevision.templateId === item.id)), 'Checklist company changed');
}
export function workContextMatches(work: AppointmentWork, organizationId: string, appointmentId: string) {
  const photos = work.entries.flatMap(entry => entry.photos);
  return work.organizationId === organizationId && work.appointment.id === appointmentId &&
    new Set(work.entries.map(entry => entry.id)).size === work.entries.length &&
    new Set(work.linkedServices.map(service => service.id)).size === work.linkedServices.length &&
    new Set(photos.map(photo => photo.id)).size === photos.length &&
    work.entries.every(entry => entry.appointmentId === appointmentId && entry.contactId === work.appointment.contactId &&
      (entry.assetId === null ? entry.assetSnapshot === null : entry.assetSnapshot?.id === entry.assetId) &&
      entry.photos.every(photo => photo.entryId === entry.id &&
        (!photo.contentPath || photo.contentPath === `/api/v1/appointments/${appointmentId}/work/photos/${photo.id}/content`) &&
        (!photo.available || photo.state === 'attached' && photo.contentPath !== null))) &&
    (!work.completion ? work.corrections.length === 0 : work.completion.appointmentId === appointmentId && work.completion.contactId === work.appointment.contactId &&
      work.corrections.every(note => note.originalCompletionId === work.completion!.id));
}
export const workFor = (organizationId: string, appointmentId: string) => appointmentWorkSchema.refine(work => workContextMatches(work, organizationId, appointmentId), 'Visit response context changed');
