// Synthetic local visual fixture. Excluded from the production entry and routes.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getGetMeQueryKey } from '@workspace/api-client-react';
import { LeadAlertCoverage } from '../src/components/lead-alert-coverage';
import { SpecialistContext } from '../src/components/specialist-context';
import '../src/index.css';
const company='local-qa-company',leadId='10000000-0000-4000-8000-000000000001';
const member={id:'local-qa-owner',email:'qa@example.invalid',firstName:'Preview',lastName:'Owner',role:'owner',isActive:true,organization:{id:company,name:'Integration preview',slug:'integration-preview',timezone:'UTC'}};
const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity},mutations:{retry:false}}});
client.setQueryData(getGetMeQueryKey(),member);
const counts={pending:0,dispatching:0,accepted:0,rejected:0,expired:0,cancelled:0,indeterminate:0,unavailable:0};
const recorded='2026-10-09T05:00:00.000Z';
let scenario='partial',reads=0;
let onRead=()=>{};
window.fetch=async(input,init)=>{
  const url=String(input);
  if(init?.method && init.method!=='GET')return new Response('{}',{status:405});
  if(url.endsWith('/api/v1/me'))return Response.json(member);
  if(url!==`/api/v1/staff-push/leads/${leadId}/coverage`)return new Response('{}',{status:404});
  reads++;onRead();
  if(scenario==='error')return new Response('{}',{status:503});
  const evidence={organizationId:company,leadId,status:scenario==='unknown'?'coverage_not_recorded':'evaluated',version:scenario==='unknown'?null:1,occurredAt:recorded,recordedAt:scenario==='unknown'?null:recorded,serverNow:new Date().toISOString(),receiptMeaning:'provider_accepted_not_received_or_read',recipients:scenario==='unknown'?[]:[
    {userId:'qa-owner',displayName:'Preview owner',outcome:'queued',queuedDeviceCount:2,deliveryStateCounts:{...counts,accepted:1,unavailable:1}},
    {userId:'qa-office',displayName:'Preview office manager',outcome:'no_eligible_device',queuedDeviceCount:0,deliveryStateCounts:{...counts}},
    {userId:'qa-unavailable',displayName:null,outcome:'recipient_unavailable',queuedDeviceCount:0,deliveryStateCounts:{...counts}},
  ]};
  return Response.json(evidence);
};
function Preview(){
  const [mode,setMode]=useState('partial'),[readCount,setReadCount]=useState(reads);
  onRead=()=>setReadCount(reads);
  const select=(value:string)=>{scenario=value;setMode(value);};
  return <QueryClientProvider client={client}><div className="min-h-screen bg-background text-foreground">
    <div className="border-b bg-card px-4 py-3 text-xs leading-5 text-muted-foreground">Local integration preview · Synthetic staff and lead · No connected services</div>
    <div className="mx-auto max-w-6xl">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b px-6 py-5"><div className="flex items-center gap-3"><img src="/brand/mogulforge-mark.svg" alt="" className="h-10 w-10"/><strong className="text-xl">GrowthOS</strong></div><a href="/specialists" className="text-sm text-primary">Meet the specialists</a></header>
      <SpecialistContext location="/pipeline"/>
      <main className="p-4 md:p-6"><h1 className="text-2xl font-bold">Website inquiry</h1><p className="mt-2 text-sm text-muted-foreground">Owner review · Original alert selection stays visible beside current receipt evidence.</p>
        <div className="mt-5 flex flex-wrap gap-2" aria-label="Synthetic preview scenarios">{[['partial','Partial coverage'],['unknown','Historical gap'],['error','Read unavailable']].map(([value,label])=><button key={value} type="button" onClick={()=>select(value)} aria-pressed={mode===value} className={`min-h-11 rounded-lg border px-3 text-xs ${mode===value?'border-primary bg-primary/10 text-primary':'border-border'}`}>{label}</button>)}</div>
        <div className="mt-5 grid items-start gap-5 lg:grid-cols-[1fr_390px]"><section className="rounded-xl border bg-card p-5"><h2 className="text-sm font-semibold">Inquiry ownership</h2><p className="mt-3 text-sm text-muted-foreground">The inquiry ownership tools from PR #28 remain on the native lead page. This view isolates the new read-only coverage panel for visual review.</p><dl className="mt-6 space-y-3 text-sm"><div><dt className="text-muted-foreground">Lead</dt><dd>Illustrative website inquiry</dd></div><div><dt className="text-muted-foreground">Review</dt><dd>All originally selected staff, including staff without a device</dd></div></dl></section><div className="overflow-hidden rounded-xl border bg-card"><LeadAlertCoverage key={mode} organizationId={company} leadId={leadId}/></div></div>
        <p className="mt-4 text-xs text-muted-foreground" aria-live="polite">Fixture coverage reads: {readCount} · Every fixture request is a read.</p>
      </main>
    </div>
  </div></QueryClientProvider>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
