import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, RefreshCw } from 'lucide-react';
import { getGetMeQueryKey, useGetMe, type MemberProfile, type StaffLeadAlertCoverage } from '@workspace/api-client-react';
import { canManageSettings } from '@/lib/permissions';
import { memberAuthorityScope } from '@/lib/member-authority-scope';
import { coverageLabels, parseLeadAlertCoverage, receiptLabels, recipientLabels, validCoverageLeadId } from '@/lib/lead-alert-coverage';
import { Button } from './ui/button';

type Props={organizationId:string;leadId:string};
type ReadState={kind:'loading'}|{kind:'error';accessDenied:boolean}|{kind:'loaded';data:StaffLeadAlertCoverage};

/** Owner/admin session-only evidence, never a delivery or routing action. */
export function LeadAlertCoverage({organizationId,leadId}:Props){
  useGetMe();
  const client=useQueryClient();
  // Query observers batch notifications. Subscribe to the authority store itself
  // so a cached revocation cannot leave old coverage visible for another render.
  const subscribe=useCallback((notify:()=>void)=>client.getQueryCache().subscribe(notify),[client]);
  const snapshot=useCallback(()=>client.getQueryState<MemberProfile>(getGetMeQueryKey()),[client]);
  const profile=useSyncExternalStore(subscribe,snapshot,snapshot);
  const me=profile?.data;
  if(profile?.status!=='success' || !me?.isActive || me.organization?.id!==organizationId || !canManageSettings(me.role) || !validCoverageLeadId(leadId)) return null;
  const scope=memberAuthorityScope(me);
  return <CoverageRead key={JSON.stringify([organizationId,me.id,scope,leadId])} organizationId={organizationId} leadId={leadId} scope={scope}/>;
}

function CoverageRead({organizationId,leadId,scope}:Props&{scope:string}){
  const client=useQueryClient();
  // Coverage deliberately stays out of QueryClient and persistent caches.
  // Every mount/read starts without evidence; semantic remounts clear it synchronously.
  const [state,setState]=useState<ReadState>({kind:'loading'});
  const active=useRef(false),generation=useRef(0),pending=useRef<AbortController|null>(null);
  const currentAuthority=useCallback(()=>{
    const current=client.getQueryState<MemberProfile>(getGetMeQueryKey());
    return active.current && current?.status==='success' && !!current.data?.isActive && canManageSettings(current.data.role) && memberAuthorityScope(current.data)===scope;
  },[client,scope]);
  const read=useCallback(async()=>{
    const request=++generation.current;
    pending.current?.abort();
    const controller=new AbortController(); pending.current=controller;
    setState({kind:'loading'});
    if(!currentAuthority()){setState({kind:'error',accessDenied:true});return;}
    const timeout=setTimeout(()=>{
      if(active.current && request===generation.current && !controller.signal.aborted){controller.abort();setState({kind:'error',accessDenied:!currentAuthority()});}
    },20000);
    try{
      const response=await fetch(`/api/v1/staff-push/leads/${encodeURIComponent(leadId)}/coverage`,{method:'GET',credentials:'include',cache:'no-store',headers:{Accept:'application/json'},signal:controller.signal});
      if(!response.ok){
        if(response.status===401 || response.status===403){
          if(currentAuthority() && request===generation.current && !controller.signal.aborted) {
            setState({kind:'error',accessDenied:true});
            void client.invalidateQueries({queryKey:getGetMeQueryKey()});
          }
          return;
        }
        throw new Error('Read unavailable');
      }
      const evidence=parseLeadAlertCoverage(await response.json(),organizationId,leadId);
      if(currentAuthority() && request===generation.current && !controller.signal.aborted) setState({kind:'loaded',data:evidence});
    }catch{
      if(active.current && request===generation.current && !controller.signal.aborted) setState({kind:'error',accessDenied:!currentAuthority()});
    }finally{
      clearTimeout(timeout);
      if(pending.current===controller) pending.current=null;
    }
  },[client,currentAuthority,leadId,organizationId]);
  useEffect(()=>{
    active.current=true;void read();
    return ()=>{active.current=false;generation.current++;pending.current?.abort();};
  },[read]);
  return <section aria-label="Staff lead alert coverage" className="border-b border-border p-4 md:p-6 space-y-4">
    <div className="flex items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-sm font-semibold"><Bell className="h-4 w-4" aria-hidden/>Staff alert coverage</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Original recipient selection and current push receipt evidence.</p></div>
      {state.kind==='loaded' && <Button type="button" variant="outline" size="sm" onClick={()=>void read()} aria-label="Refresh alert coverage"><RefreshCw className="h-4 w-4" aria-hidden/></Button>}
    </div>
    {state.kind==='loading' && <p role="status" className="text-sm text-muted-foreground">Loading alert coverage…</p>}
    {state.kind==='error' && <div role="alert" className="space-y-2 text-sm"><p>{state.accessDenied?'Your current staff session cannot access this evidence. Refresh account access before reviewing it.':'Alert coverage could not be loaded. This does not establish that an alert failed.'}</p>{!state.accessDenied && <Button type="button" variant="outline" onClick={()=>void read()}>Retry coverage read</Button>}</div>}
    {state.kind==='loaded' && <CoverageEvidence evidence={state.data}/>}
    <p className="text-xs leading-5 text-muted-foreground">Push provider acceptance does not prove phone display or human reading. This panel only reads evidence; it does not resend alerts or evaluate routing again.</p>
  </section>;
}

export function CoverageEvidence({evidence}:{evidence:StaffLeadAlertCoverage}){
  return <div className="space-y-4 text-sm">
    <p className="font-medium">{coverageLabels[evidence.status]}</p>
    <dl className="grid gap-2 text-xs text-muted-foreground">
      <div><dt className="inline font-medium">Lead occurred: </dt><dd className="inline"><time dateTime={evidence.occurredAt}>{new Date(evidence.occurredAt).toLocaleString()}</time></dd></div>
      <div><dt className="inline font-medium">Original coverage recorded: </dt><dd className="inline">{evidence.recordedAt?<time dateTime={evidence.recordedAt}>{new Date(evidence.recordedAt).toLocaleString()}</time>:'Not recorded'}</dd></div>
      <div><dt className="inline font-medium">Current receipts checked: </dt><dd className="inline"><time dateTime={evidence.serverNow}>{new Date(evidence.serverNow).toLocaleString()}</time></dd></div>
    </dl>
    {evidence.status==='evaluated'?<><h3 className="text-xs font-semibold uppercase tracking-wide">Every originally selected recipient ({evidence.recipients.length})</h3><ul className="space-y-3">{evidence.recipients.map(person=><li key={person.userId} className="rounded-lg border border-border bg-background p-3 space-y-2">
      <p className="break-words font-medium">{person.displayName??'Unavailable staff member'}</p>
      <p className="text-xs"><span className="font-semibold">Original admission: </span>{person.outcome==='queued'?`Queued for ${person.queuedDeviceCount} ${person.queuedDeviceCount===1?'device':'devices'}`:recipientLabels[person.outcome]}</p>
      {person.outcome==='queued' && <div><p className="mb-1 text-xs font-semibold">Current receipts</p><ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">{(Object.keys(receiptLabels) as Array<keyof typeof receiptLabels>).filter(key=>person.deliveryStateCounts[key]>0).map(key=><li key={key}>{receiptLabels[key]}: {person.deliveryStateCounts[key]}</li>)}</ul></div>}
    </li>)}</ul></>:<p className="text-xs leading-5 text-muted-foreground">{evidence.status==='policy_disabled'?'Routing was disabled at original admission; no recipients were selected.':evidence.status==='policy_unavailable'?'Routing was not configured at original admission; no alerts were queued.':'The original recipient cohort is unknown. Current device registrations or routing settings cannot fill historical gaps.'}</p>}
  </div>;
}
