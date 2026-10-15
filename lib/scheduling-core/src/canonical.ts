import { z } from 'zod';
import { manualSchedulingCommandSchema, userIdSchema, uuidSchema, type ManualSchedulingCommand, type SchedulingMutationReview, type UserId, type UUID } from './models';

function sortedJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter(key => object[key] !== undefined).map(key => `${JSON.stringify(key)}:${sortedJSON(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA256 callers must hash the UTF8 bytes of this exact string, before defaults. */
export function canonicalSchedulingEnvelope(args: { organizationId: UUID; actorUserId: UserId; kind: ManualSchedulingCommand['kind']; body: ManualSchedulingCommand['body']; review: SchedulingMutationReview }): string {
  z.strictObject({ organizationId: uuidSchema, actorUserId: userIdSchema, kind: z.unknown(), body: z.unknown(), review: z.unknown() }).parse(args);
  // The envelope deliberately excludes operationId. Validate the submitted body
  // without defaults or transformations; retain its exact optional/null spelling.
  manualSchedulingCommandSchema.parse({ operationId: args.organizationId, kind: args.kind, body: args.body, review: args.review });
  return sortedJSON(args);
}
