import { act,cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { getGetMeQueryKey } from '@workspace/api-client-react';
import { afterEach,expect,it,vi } from 'vitest';
import { sampleMe } from '@/test/mock-api';
import { LeadAlertCoverage } from './lead-alert-coverage';
import { parseLeadAlertCoverage } from '@/lib/lead-alert-coverage';
const leadId='10000000-0000-4000-8000-000000000001',otherLead='10000000-0000-4000-8000-000000000002';
const counts={pending:0,dispatching:0,accepted:0,rejected:0,expired:0,cancelled:0,indeterminate:0,unavailable:0};
const now='2026-10-09T05:00:00.000Z';
const evidence=()=>({organizationId:'o1',leadId,status:'evaluated',version:1,occurredAt:now,recordedAt:now,serverNow:now,receiptMeaning:'provider_accepted_not_received_or_read',recipients:[
  {userId:'first',displayName:'Owner A',outcome:'queued',queuedDeviceCount:1,deliveryStateCounts:{...counts,accepted:1}},
  {userId:'second',displayName:'Owner B',outcome:'no_eligible_device',queuedDeviceCount:0,deliveryStateCounts:{...counts}},
]});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
function setup(handler:(url:string,init?:RequestInit)=>Response|Promise<Response>,role='owner'){
  let me={...sampleMe(role),organization:{...sampleMe(role).organization,name:'Integration QA'}};
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity},mutations:{retry:false}}});
  client.setQueryData(getGetMeQueryKey(),me);
  const fetchMock=vi.fn((url:RequestInfo|URL,init?:RequestInit)=>String(url).endsWith('/api/v1/me')?json(me):handler(String(url),init));
  vi.stubGlobal('fetch',fetchMock);
  const panel=(org='o1',id=leadId)=><QueryClientProvider client={client}><LeadAlertCoverage organizationId={org} leadId={id}/></QueryClientProvider>;
  const view=render(panel());
  return {client,fetchMock,rerender:(org='o1',id=leadId)=>view.rerender(panel(org,id)),unmount:view.unmount,setMember:(value:typeof me)=>{me=value;act(()=>client.setQueryData(getGetMeQueryKey(),value));},member:me};
}
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

it('reads the exact lead beyond a capped alert list and shows every selected recipient without a send',async()=>{
  const {fetchMock}=setup(()=>json(evidence()));
  await screen.findByText('Owner B');
  expect(screen.getByText('No eligible device at the time')).toBeTruthy();
  expect(screen.getByText('Push provider accepted: 1')).toBeTruthy();
  expect(screen.getByText(/does not prove phone display or human reading/)).toBeTruthy();
  const [url,init]=fetchMock.mock.calls[0];
  expect(url).toBe(`/api/v1/staff-push/leads/${leadId}/coverage`);
  expect(init).toMatchObject({method:'GET',credentials:'include',cache:'no-store'});
  expect(init?.headers).toEqual({Accept:'application/json'});
  expect(screen.queryByRole('button',{name:/resend/i})).toBeNull();
});
it.each(['viewer','office','sales_manager','sales_rep','production','inspector'])('does not read owner/admin coverage as %s',async role=>{
  const {fetchMock}=setup(()=>json(evidence()),role);
  await act(async()=>{});
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.queryByRole('region',{name:'Staff lead alert coverage'})).toBeNull();
});
it.each(['coverage_not_recorded','historical_unknown','policy_unavailable','policy_disabled'])('preserves %s without deriving a cohort from current devices',async status=>{
  const data={...evidence(),status,version:status==='coverage_not_recorded'?null:1,recordedAt:status==='coverage_not_recorded'?null:now,recipients:[]};
  setup(()=>json(data));
  await screen.findByText(status==='policy_disabled'?'Lead alerts were off':status==='policy_unavailable'?'Alert routing was not configured':status==='historical_unknown'?'Earlier alerts exist; original coverage is unknown':'Alert coverage was not recorded');
  expect(screen.queryByText('Owner A')).toBeNull();
  expect(screen.queryByText(/Every originally selected/)).toBeNull();
});
it('renders every receipt state without interpreting acceptance as display/read',async()=>{
  const recipients=Object.keys(counts).map((state,index)=>({userId:'u'+index,displayName:index===0?null:'Staff '+index,outcome:'queued',queuedDeviceCount:1,deliveryStateCounts:{...counts,[state]:1}}));
  setup(()=>json({...evidence(),recipients}));
  await screen.findByText('Unavailable staff member');
  for(const label of ['Pending','Dispatching','Push provider accepted','Rejected','Expired','Cancelled','Outcome unknown','Receipt unavailable']) expect(screen.getByText(label+': 1')).toBeTruthy();
});
it('shows zero devices and elapsed windows as original admission outcomes',async()=>{
  setup(()=>json({...evidence(),recipients:[{...evidence().recipients[1],displayName:null,outcome:'recipient_unavailable'},{...evidence().recipients[1],userId:'third',outcome:'notification_expired'}]}));
  await screen.findByText('Staff member was unavailable for alerts');
  expect(screen.getByText('Alert window had elapsed')).toBeTruthy();
  expect(screen.queryByText('Current receipts')).toBeNull();
});
it('clears visible evidence during a failed refresh and offers only a read retry',async()=>{
  let failed=false;const {fetchMock}=setup(()=>failed?json({error:'secret raw provider failure'},500):json(evidence()));
  await screen.findByText('Owner A');failed=true;
  fireEvent.click(screen.getByRole('button',{name:'Refresh alert coverage'}));
  await screen.findByText(/could not be loaded/);
  expect(screen.queryByText('Owner A')).toBeNull();
  expect(screen.queryByText(/secret raw/)).toBeNull();
  failed=false;fireEvent.click(screen.getByRole('button',{name:'Retry coverage read'}));await screen.findByText('Owner B');
  expect(fetchMock.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
});
it.each([401,403,404])('clears evidence for access/unavailable HTTP %s',async status=>{
  let fail=false;setup(()=>json(fail?{}:evidence(),fail?status:200));
  await screen.findByText('Owner A');fail=true;fireEvent.click(screen.getByRole('button',{name:'Refresh alert coverage'}));
  await screen.findByRole('alert');expect(screen.queryByText('Owner A')).toBeNull();
  expect(screen.queryByText('Alert coverage was not recorded')).toBeNull();
});
it('rejects a foreign lead/company or a corrupt cohort instead of dropping people',async()=>{
  setup(()=>json({...evidence(),organizationId:'other-company'}));
  await screen.findByText(/could not be loaded/);expect(screen.queryByText('Owner A')).toBeNull();
  expect(()=>parseLeadAlertCoverage({...evidence(),leadId:otherLead},'o1',leadId)).toThrow();
  expect(()=>parseLeadAlertCoverage({...evidence(),policyFingerprint:'secret'},'o1',leadId)).toThrow();
  expect(()=>parseLeadAlertCoverage({...evidence(),recipients:[...evidence().recipients,evidence().recipients[0]]},'o1',leadId)).toThrow();
  expect(()=>parseLeadAlertCoverage({...evidence(),recipients:[{...evidence().recipients[0],queuedDeviceCount:2}]},'o1',leadId)).toThrow();
});
it('discards late results and synchronously clears evidence across member/company/lead scope',async()=>{
  let finish!:(r:Response)=>void;const late=new Promise<Response>(resolve=>{finish=resolve;});
  const {rerender,fetchMock}=setup(url=>url.includes(otherLead)?json({...evidence(),leadId:otherLead,recipients:[{...evidence().recipients[1],displayName:'New scope'}]}):late);
  await waitFor(()=>expect(fetchMock).toHaveBeenCalled());
  rerender('o1',otherLead);await screen.findByText('New scope');
  await act(async()=>{finish(json(evidence()));await late;});
  expect(screen.queryByText('Owner A')).toBeNull();
  rerender('other-company',otherLead);expect(screen.queryByText('New scope')).toBeNull();
});
it('unmounts on role revocation and never retains evidence in a coverage query cache',async()=>{
  const {client,setMember,member}=setup(()=>json(evidence()));await screen.findByText('Owner A');
  setMember({...member,role:'viewer'});expect(screen.queryByText('Owner A')).toBeNull();
  expect(client.getQueryCache().findAll().some(query=>query.queryKey.some(key=>String(key).includes('coverage')))).toBe(false);
});
it('refuses a late unauthorized callback from an old member scope',async()=>{
  let finish!:(r:Response)=>void;const late=new Promise<Response>(resolve=>{finish=resolve;});
  const {setMember,member,client,fetchMock}=setup(()=>late);
  await waitFor(()=>expect(fetchMock).toHaveBeenCalled());
  const invalidation=vi.spyOn(client,'invalidateQueries');setMember({...member,role:'viewer'});
  await act(async()=>{finish(json({},403));await late;});
  expect(invalidation).not.toHaveBeenCalled();expect(screen.queryByRole('region',{name:'Staff lead alert coverage'})).toBeNull();
});
it('clears loaded evidence for cached member errors and inactive membership',async()=>{
  const first=setup(()=>json(evidence()));await screen.findByText('Owner A');
  act(()=>first.client.getQueryCache().find({queryKey:getGetMeQueryKey(),exact:true})!.setState({status:'error',error:new Error('Access unavailable')}));
  expect(screen.queryByText('Owner A')).toBeNull();
  first.unmount();
  const second=setup(()=>json(evidence()));await screen.findByText('Owner A');
  second.setMember({...second.member,isActive:false});
  expect(screen.queryByRole('region',{name:'Staff lead alert coverage'})).toBeNull();
});
it('reads fresh evidence after a member-ID switch and switchback in the same company',async()=>{
  let reads=0;const {setMember,member}=setup(()=>json({...evidence(),recipients:[{...evidence().recipients[0],displayName:'Read '+(++reads)}]}));
  await screen.findByText('Read 1');
  setMember({...member,id:'other-member'});expect(screen.queryByText('Read 1')).toBeNull();await screen.findByText('Read 2');
  setMember(member);expect(screen.queryByText('Read 2')).toBeNull();await screen.findByText('Read 3');
  expect(reads).toBe(3);
});
it('bounds a hung read and ignores a successful response after the abort deadline',async()=>{
  vi.useFakeTimers();let finish!:(value:Response)=>void;
  const late=new Promise<Response>(resolve=>{finish=resolve;});
  const {fetchMock}=setup(()=>late);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(20001);});
  expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await act(async()=>{finish(json(evidence()));await late;});
  expect(screen.queryByText('Owner A')).toBeNull();
  expect(screen.getByRole('button',{name:'Retry coverage read'})).toBeTruthy();
});
