import { z } from 'zod/v4';
import type { StaffLeadAlertCoverage } from '@workspace/api-client-react';

export const receiptLabels = {
  pending: 'Pending', dispatching: 'Dispatching', accepted: 'Push provider accepted',
  rejected: 'Rejected', expired: 'Expired', cancelled: 'Cancelled',
  indeterminate: 'Outcome unknown', unavailable: 'Receipt unavailable',
} as const;
export const coverageLabels = {
  coverage_not_recorded: 'Alert coverage was not recorded',
  historical_unknown: 'Earlier alerts exist; original coverage is unknown',
  policy_unavailable: 'Alert routing was not configured',
  policy_disabled: 'Lead alerts were off', evaluated: 'Alert coverage recorded',
} as const;
export const recipientLabels = {
  recipient_unavailable: 'Staff member was unavailable for alerts',
  no_eligible_device: 'No eligible device at the time',
  notification_expired: 'Alert window had elapsed',
} as const;
const count = z.number().int().min(0).max(5);
const counts = z.object({pending:count,dispatching:count,accepted:count,rejected:count,expired:count,cancelled:count,indeterminate:count,unavailable:count}).strict();
const recipient = z.object({
  userId:z.string().min(1).max(128), displayName:z.string().nullable(),
  outcome:z.enum(['queued','recipient_unavailable','no_eligible_device','notification_expired']),
  queuedDeviceCount:count, deliveryStateCounts:counts,
}).strict().superRefine((r,ctx)=>{
  const sum=Object.values(r.deliveryStateCounts).reduce((a,b)=>a+b,0);
  if(sum!==r.queuedDeviceCount || (r.outcome==='queued' ? r.queuedDeviceCount<1 : r.queuedDeviceCount!==0)) ctx.addIssue({code:'custom',message:'Invalid receipt counts'});
});
const timestamp = z.iso.datetime({offset:true});
const schema = z.object({
  organizationId:z.string().min(1),leadId:z.string().min(1),
  status:z.enum(['coverage_not_recorded','evaluated','policy_unavailable','policy_disabled','historical_unknown']),
  version:z.literal(1).nullable(),occurredAt:timestamp,recordedAt:timestamp.nullable(),serverNow:timestamp,
  receiptMeaning:z.literal('provider_accepted_not_received_or_read'),recipients:z.array(recipient).max(20),
}).strict().superRefine((r,ctx)=>{
  const missing=r.status==='coverage_not_recorded';
  if(missing ? r.version!==null || r.recordedAt!==null : r.version!==1 || r.recordedAt===null) ctx.addIssue({code:'custom',message:'Invalid original evidence'});
  if(r.status==='evaluated' ? r.recipients.length===0 : r.recipients.length!==0) ctx.addIssue({code:'custom',message:'Invalid cohort'});
  if(new Set(r.recipients.map(p=>p.userId)).size!==r.recipients.length) ctx.addIssue({code:'custom',message:'Duplicate recipient'});
});

/** Reject wrong-scope or corrupt evidence; never silently remove a selected person. */
export function parseLeadAlertCoverage(value:unknown,organizationId:string,leadId:string):StaffLeadAlertCoverage {
  const result=schema.safeParse(value);
  if(!result.success || result.data.organizationId!==organizationId || result.data.leadId!==leadId) throw new Error('Alert coverage evidence is unavailable.');
  return result.data;
}
export function validCoverageLeadId(id:string):boolean { return z.uuid().safeParse(id).success; }
