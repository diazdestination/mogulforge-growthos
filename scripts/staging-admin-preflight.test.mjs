import { describe, it, expect } from 'vitest';
import { observeAdmin, QUERIES } from './staging-admin-preflight.mjs';

function fixture({ wrongIdentity=false, failAt=null, rollback=false }={}) {
  const calls=[];
  return { calls, client:{ query:async sql=>{
    calls.push(sql);
    if(sql==='ROLLBACK')return {command:rollback?'SELECT':'ROLLBACK',rows:[]};
    if(sql==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')return {command:'BEGIN',rows:[]};
    if(sql.startsWith('SET LOCAL'))return {command:'SET',rows:[]};
    if(sql===failAt)throw new Error('private diagnostics must never escape');
    if(sql===QUERIES.identity)return {rows:[{database:wrongIdentity?'wrong_database':'growthos_staging',login:'fly-user',role:'schema_admin',version:160015,pid:72,read_only:'on',isolation:'repeatable read'}]};
    if(sql===QUERIES.auditFunctions)return {rows:['pgaudit_ddl_command_end','pgaudit_sql_drop'].map(name=>({name,schema:'public',language:'c',owner:'postgres',security_definer:true,return_type:'event_trigger',library:'$libdir/pgaudit',symbol:name,extension_name:'pgaudit',extension_version:'16.1',configuration:['search_path="pg_catalog, pg_temp"']}))};
    return {rows:[]};
  }}};
}
describe('administrative metadata observation',()=>{
  it('selects a transaction-local role only after READ ONLY begins and always rolls back',async()=>{
    const f=fixture(),r=await observeAdmin(f.client);
    expect(f.calls[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(f.calls[1]).toContain('SET LOCAL ROLE schema_admin');
    expect(f.calls.at(-1)).toBe('ROLLBACK');
    expect(r.status).toBe('observed-awaiting-policy-review');
    expect(r.rollbackAcknowledged).toBe(true);
    expect(Object.keys(r.metadata).sort()).toEqual(Object.keys(QUERIES).sort());
  });
  it('rejects another database before any privilege or trigger observation',async()=>{
    const f=fixture({wrongIdentity:true}),r=await observeAdmin(f.client);
    expect(r.errorCode).toBe('admin_identity');
    expect(f.calls).not.toContain(QUERIES.roles);
    expect(r.rollbackAcknowledged).toBe(true);
  });
  it('does not certify cleanup when the ROLLBACK response is wrong',async()=>{
    const f=fixture({rollback:true}),r=await observeAdmin(f.client);
    expect(r.status).toBe('failed');expect(r.rollbackAcknowledged).toBe(false);
  });
  it('does not expose raw database error details',async()=>{
    const f=fixture({failAt:QUERIES.eventTriggers}),r=await observeAdmin(f.client);
    expect(r.status).toBe('failed');expect(r.errorCode).toBe('admin_query_failed');
    expect(JSON.stringify(r)).not.toContain('private diagnostics');
    expect(r.rollbackAcknowledged).toBe(true);
  });
  it('does not persist a changed audit function body or configuration',async()=>{
    const f=fixture(),query=f.client.query;
    f.client.query=async sql=>sql===QUERIES.auditFunctions?{rows:[{name:'pgaudit_sql_drop',symbol:'private body content'}]}:query(sql);
    const r=await observeAdmin(f.client);
    expect(r.status).toBe('failed');expect(r.errorCode).toBe('admin_audit_linkage_unrecognized');
    expect(r.metadata.auditFunctions).toBeUndefined();expect(JSON.stringify(r)).not.toContain('private body content');
    expect(r.rollbackAcknowledged).toBe(true);
  });
});
