/** Nonsecret recorded legacy privilege model. No I/O or provider authority. */
const freeze=v=>{if(v&&typeof v==="object"){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const MODEL=freeze({
  "roles": [
    {
      "name": "_crunchypgbouncer",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": true,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "_crunchyrepl",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": true,
      "replication": true,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "fly-monitoring",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": true,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": 5
    },
    {
      "name": "fly-user",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": true,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "growthos-staging-live",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": true,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "pg_checkpoint",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "pg_create_subscription",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "pg_database_owner",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "pg_execute_server_program",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "pg_monitor",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "pg_read_all_data",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "pg_read_all_settings",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "pg_read_all_stats",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "pg_read_server_files",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "pg_signal_backend",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "pg_stat_scan_tables",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "pg_use_reserved_connections",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "pg_write_all_data",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "pg_write_server_files",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "postgres",
      "superuser": true,
      "inherit": true,
      "create_role": true,
      "create_database": true,
      "login": true,
      "replication": true,
      "bypass_rls": true,
      "connection_limit": -1
    },
    {
      "name": "reader",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "schema_admin",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    },
    {
      "name": "writer",
      "superuser": false,
      "inherit": true,
      "create_role": false,
      "create_database": false,
      "login": false,
      "replication": false,
      "bypass_rls": false,
      "connection_limit": -1
    }
  ],
  "memberships": [
    {
      "role": "pg_monitor",
      "member": "fly-monitoring",
      "grantor": "postgres",
      "admin_option": false,
      "inherit_option": true,
      "set_option": true
    },
    {
      "role": "pg_read_all_data",
      "member": "reader",
      "grantor": "postgres",
      "admin_option": false,
      "inherit_option": true,
      "set_option": true
    },
    {
      "role": "pg_read_all_data",
      "member": "schema_admin",
      "grantor": "postgres",
      "admin_option": false,
      "inherit_option": true,
      "set_option": true
    },
    {
      "role": "pg_read_all_data",
      "member": "writer",
      "grantor": "postgres",
      "admin_option": false,
      "inherit_option": true,
      "set_option": true
    },
    {
      "role": "pg_read_all_settings",
      "member": "pg_monitor",
      "grantor": "postgres",
      "admin_option": false,
      "inherit_option": true,
      "set_option": true
    },
    {
      "role": "pg_read_all_stats",
      "member": "pg_monitor",
      "grantor": "postgres",
      "admin_option": false,
      "inherit_option": true,
      "set_option": true
    },
    {
      "role": "pg_signal_backend",
      "member": "schema_admin",
      "grantor": "postgres",
      "admin_option": false,
      "inherit_option": true,
      "set_option": true
    },
    {
      "role": "pg_stat_scan_tables",
      "member": "pg_monitor",
      "grantor": "postgres",
      "admin_option": false,
      "inherit_option": true,
      "set_option": true
    },
    {
      "role": "pg_write_all_data",
      "member": "schema_admin",
      "grantor": "postgres",
      "admin_option": false,
      "inherit_option": true,
      "set_option": true
    },
    {
      "role": "pg_write_all_data",
      "member": "writer",
      "grantor": "postgres",
      "admin_option": false,
      "inherit_option": true,
      "set_option": true
    },
    {
      "role": "schema_admin",
      "member": "fly-user",
      "grantor": "postgres",
      "admin_option": false,
      "inherit_option": true,
      "set_option": true
    },
    {
      "role": "schema_admin",
      "member": "growthos-staging-live",
      "grantor": "postgres",
      "admin_option": false,
      "inherit_option": true,
      "set_option": true
    }
  ],
  "defaultGrants": [
    {
      "owner": "fly-user",
      "schema": "public",
      "object_type": "S",
      "grantee": "schema_admin",
      "privilege_type": "SELECT",
      "is_grantable": false
    },
    {
      "owner": "fly-user",
      "schema": "public",
      "object_type": "S",
      "grantee": "schema_admin",
      "privilege_type": "UPDATE",
      "is_grantable": false
    },
    {
      "owner": "fly-user",
      "schema": "public",
      "object_type": "S",
      "grantee": "schema_admin",
      "privilege_type": "USAGE",
      "is_grantable": false
    },
    {
      "owner": "fly-user",
      "schema": "public",
      "object_type": "r",
      "grantee": "schema_admin",
      "privilege_type": "DELETE",
      "is_grantable": false
    },
    {
      "owner": "fly-user",
      "schema": "public",
      "object_type": "r",
      "grantee": "schema_admin",
      "privilege_type": "INSERT",
      "is_grantable": false
    },
    {
      "owner": "fly-user",
      "schema": "public",
      "object_type": "r",
      "grantee": "schema_admin",
      "privilege_type": "REFERENCES",
      "is_grantable": false
    },
    {
      "owner": "fly-user",
      "schema": "public",
      "object_type": "r",
      "grantee": "schema_admin",
      "privilege_type": "SELECT",
      "is_grantable": false
    },
    {
      "owner": "fly-user",
      "schema": "public",
      "object_type": "r",
      "grantee": "schema_admin",
      "privilege_type": "TRIGGER",
      "is_grantable": false
    },
    {
      "owner": "fly-user",
      "schema": "public",
      "object_type": "r",
      "grantee": "schema_admin",
      "privilege_type": "TRUNCATE",
      "is_grantable": false
    },
    {
      "owner": "fly-user",
      "schema": "public",
      "object_type": "r",
      "grantee": "schema_admin",
      "privilege_type": "UPDATE",
      "is_grantable": false
    }
  ],
  "databaseRules": {
    "fly-db": {
      "publicConnect": false,
      "publicTemporary": false,
      "directLoginGrant": true
    },
    "growthos_staging": {
      "publicConnect": false,
      "publicTemporary": false,
      "directLoginGrant": false
    },
    "mogulforge-growthos-db": {
      "publicConnect": false,
      "publicTemporary": false,
      "directLoginGrant": false
    },
    "postgres": {
      "publicConnect": true,
      "publicTemporary": true,
      "directLoginGrant": false
    }
  },
  "opaqueSettingsNativeEquivalence": false,
  "providerExtensionNativeEquivalence": false
});
const check=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{safeCode:code});};
const quote=v=>{check(typeof v==='string'&&/^[a-z_][a-z0-9_-]{0,62}$/.test(v),'production75_legacy_identifier');return `"${v}"`;};
export function legacyModel(){return MODEL;}
export function legacyRoleSql(){
 const sql=[];for(const r of MODEL.roles.filter(r=>r.name!=='postgres'&&!r.name.startsWith('pg_'))){
  sql.push(`CREATE ROLE ${quote(r.name)} ${r.login?'LOGIN':'NOLOGIN'} ${r.inherit?'INHERIT':'NOINHERIT'} ${r.superuser?'SUPERUSER':'NOSUPERUSER'} ${r.create_role?'CREATEROLE':'NOCREATEROLE'} ${r.create_database?'CREATEDB':'NOCREATEDB'} ${r.replication?'REPLICATION':'NOREPLICATION'} ${r.bypass_rls?'BYPASSRLS':'NOBYPASSRLS'} CONNECTION LIMIT ${r.connection_limit};`);
 }
 for(const e of MODEL.memberships)for(const [field,option] of [['admin_option','ADMIN'],['inherit_option','INHERIT'],['set_option','SET']])sql.push(`GRANT ${quote(e.role)} TO ${quote(e.member)} WITH ${option} ${e[field]?'TRUE':'FALSE'} GRANTED BY ${quote(e.grantor)};`);
 return sql.join('\n');
}
const dangerous=new Set(['schema_admin','writer','pg_write_all_data','pg_signal_backend','pg_execute_server_program','pg_read_server_files','pg_write_server_files','pg_create_subscription']);
export function assertLegacyReaderCapabilities(policy,{readerLogin,readerRole,writerRole}={}){
 check([readerLogin,readerRole,writerRole].every(v=>typeof v==='string')&&readerRole!==writerRole,'production75_legacy_reader_authority');
 const p=policy?.privileges;check(p&&['roles','memberships','tables','columns','namespaces','database','functions'].every(k=>Array.isArray(p[k])),'production75_legacy_reader_coverage');
 const own=(k,principal)=>p[k].filter(r=>r.principal===principal),loginRoles=own('roles',readerLogin);
 check(loginRoles.some(r=>r.name===readerRole&&(r.name===readerLogin||r.usable===true&&r.can_set===true)),'production75_legacy_reader_authority');
 const queue=[readerLogin,readerRole],assessed=new Set(),reachable=new Set(),keys={tables:r=>r.name,columns:r=>`${r.table_name}.${r.name}`,namespaces:r=>r.name,database:r=>r.name,functions:r=>`${r.schema??''}.${r.name}(${r.arguments??''})`};
 for(const principal of queue){
  if(assessed.has(principal))continue;assessed.add(principal);check(assessed.size<=8,'production75_legacy_reader_coverage');
  const roles=own('roles',principal),tables=own('tables',principal),columns=own('columns',principal),spaces=own('namespaces',principal),db=own('database',principal),functions=own('functions',principal);
  check(roles.some(r=>r.name===principal)&&tables.length>0&&columns.length>0&&spaces.some(r=>r.name==='public')&&db.length===1,'production75_legacy_reader_coverage');
  for(const [section,key] of Object.entries(keys))check(JSON.stringify(own(section,principal).map(key).sort())===JSON.stringify(own(section,readerLogin).map(key).sort()),'production75_legacy_reader_coverage');
  for(const r of roles){
   check(['superuser','create_role','create_database','replication','bypass_rls','usable','can_set'].every(k=>typeof r[k]==='boolean'),'production75_legacy_reader_authority');
   check(!['superuser','create_role','create_database','replication','bypass_rls'].some(k=>r[k])&&!((dangerous.has(r.name)||r.name===writerRole)&&(r.usable||r.can_set)),'production75_legacy_reader_authority');
   if(r.name===principal||r.usable||r.can_set)reachable.add(r.name);
   // An inherited capability is measured on this principal. A SET-only path
   // needs its own complete effective-role measurements; names are insufficient.
   if(r.can_set&&!r.usable)queue.push(r.name);
  }
  for(const r of tables)check(r.select===true&&['insert','update','delete','truncate','references','trigger'].every(k=>r[k]===false),'production75_legacy_reader_authority');
  for(const r of columns)check(r.select===true&&['insert','update','references'].every(k=>r[k]===false),'production75_legacy_reader_authority');
  for(const r of spaces)check(r.create===false&&typeof r.usage==='boolean','production75_legacy_reader_authority');
  check(db[0].create===false&&db[0].connect===true&&typeof db[0].temporary==='boolean','production75_legacy_reader_authority');
  for(const r of functions)check(typeof r.execute==='boolean'&&typeof r.security_definer==='boolean'&&['v','s','i'].includes(r.volatility),'production75_legacy_reader_authority');
 }
 for(const edge of p.memberships){check(['admin_option','inherit_option','set_option'].every(k=>typeof edge[k]==='boolean'),'production75_legacy_reader_authority');check(!(reachable.has(edge.member)&&edge.admin_option),'production75_legacy_reader_authority');}
 const functions=own('functions',readerRole),db=own('database',readerRole);
 return freeze({directApplicationWritesDenied:true,assessedEffectiveRoles:[...assessed].sort(),applicationDatabaseTemporary:db[0].temporary,callableVolatileFunctions:functions.filter(r=>r.execute&&r.volatility==='v').length,callableSecurityDefinerFunctions:functions.filter(r=>r.execute&&r.security_definer).length,zeroDdlClusterWideVerified:false,capabilityScopeReviewRequired:true,readerLogin,readerRole});
}
