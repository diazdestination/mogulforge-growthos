/** Import-safe, fixed-identity, SELECT-only observer. The caller owns the socket
 * and authenticated Fly proxy. No application import, environment, files or logs.
 * A successful observation is evidence, never permission to migrate or deploy.
 */
import { CATALOG_QUERIES, catalogDigest, catalogDifferences } from '../reports/release-preparation-2026-10-09/schema-catalog.mjs';

const TARGET = Object.freeze({ database: 'growthos_staging', login: 'growthos-restore-reader', role: 'growthos-restore-reader' });
const PRINCIPALS = "SELECT oid, rolname FROM pg_catalog.pg_roles WHERE rolname IN ('growthos-restore-reader','growthos-staging-live')";
const PUBLIC_RELATIONS = "n.nspname = 'public' AND c.relkind IN ('r','p')";
export const OBSERVATION_LIMITS = Object.freeze({ operationMs: 240000, queryMs: 15000, cleanupMs: 5000, metadataRows: 20000, metadataBytes: 8000000, tableRows: 1000000, tableBytes: 268435456, totalRows: 5000000, totalBytes: 536870912 });

export const PRIVILEGE_QUERIES = Object.freeze({
  roles: `WITH principals AS (${PRINCIPALS})
    SELECT p.rolname AS principal, r.rolname AS name, r.rolsuper AS superuser,
      r.rolinherit AS inherit, r.rolcreaterole AS create_role, r.rolcreatedb AS create_database,
      r.rolcanlogin AS login, r.rolreplication AS replication, r.rolbypassrls AS bypass_rls,
      pg_catalog.pg_has_role(p.oid,r.oid,'MEMBER') AS member,
      pg_catalog.pg_has_role(p.oid,r.oid,'USAGE') AS usable,
      pg_catalog.pg_has_role(p.oid,r.oid,'SET') AS can_set
    FROM principals p CROSS JOIN pg_catalog.pg_roles r
    WHERE r.oid=p.oid OR pg_catalog.pg_has_role(p.oid,r.oid,'MEMBER')
    ORDER BY p.rolname,r.rolname`,
  memberships: `SELECT r.rolname AS role, m.rolname AS member, g.rolname AS grantor,
      a.admin_option, a.inherit_option, a.set_option
    FROM pg_catalog.pg_auth_members a JOIN pg_catalog.pg_roles r ON r.oid=a.roleid
    JOIN pg_catalog.pg_roles m ON m.oid=a.member JOIN pg_catalog.pg_roles g ON g.oid=a.grantor
    ORDER BY r.rolname,m.rolname,g.rolname`,
  tables: `WITH principals AS (${PRINCIPALS})
    SELECT p.rolname AS principal,c.relname AS name,owner.rolname AS owner,
      pg_catalog.has_table_privilege(p.oid,c.oid,'SELECT') AS select,
      pg_catalog.has_table_privilege(p.oid,c.oid,'INSERT') AS insert,
      pg_catalog.has_table_privilege(p.oid,c.oid,'UPDATE') AS update,
      pg_catalog.has_table_privilege(p.oid,c.oid,'DELETE') AS delete,
      pg_catalog.has_table_privilege(p.oid,c.oid,'TRUNCATE') AS truncate,
      pg_catalog.has_table_privilege(p.oid,c.oid,'REFERENCES') AS references,
      pg_catalog.has_table_privilege(p.oid,c.oid,'TRIGGER') AS trigger
    FROM principals p CROSS JOIN pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_roles owner ON owner.oid=c.relowner WHERE ${PUBLIC_RELATIONS}
    ORDER BY p.rolname,c.relname`,
  columns: `WITH principals AS (${PRINCIPALS})
    SELECT p.rolname AS principal,c.relname AS table_name,a.attname AS name,
      pg_catalog.has_column_privilege(p.oid,c.oid,a.attnum,'SELECT') AS select,
      pg_catalog.has_column_privilege(p.oid,c.oid,a.attnum,'INSERT') AS insert,
      pg_catalog.has_column_privilege(p.oid,c.oid,a.attnum,'UPDATE') AS update,
      pg_catalog.has_column_privilege(p.oid,c.oid,a.attnum,'REFERENCES') AS references
    FROM principals p CROSS JOIN pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE ${PUBLIC_RELATIONS} ORDER BY p.rolname,c.relname,a.attname`,
  namespaces: `WITH principals AS (${PRINCIPALS})
    SELECT p.rolname AS principal,n.nspname AS name,owner.rolname AS owner,
      pg_catalog.has_schema_privilege(p.oid,n.oid,'USAGE') AS usage,
      pg_catalog.has_schema_privilege(p.oid,n.oid,'CREATE') AS create
    FROM principals p CROSS JOIN pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles owner ON owner.oid=n.nspowner
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY p.rolname,n.nspname`,
  database: `WITH principals AS (${PRINCIPALS})
    SELECT p.rolname AS principal,d.datname AS name,owner.rolname AS owner,
      pg_catalog.has_database_privilege(p.oid,d.oid,'CONNECT') AS connect,
      pg_catalog.has_database_privilege(p.oid,d.oid,'CREATE') AS create,
      pg_catalog.has_database_privilege(p.oid,d.oid,'TEMP') AS temporary
    FROM principals p CROSS JOIN pg_catalog.pg_database d JOIN pg_catalog.pg_roles owner ON owner.oid=d.datdba
    WHERE d.datname=current_database() ORDER BY p.rolname`,
  sequences: `WITH principals AS (${PRINCIPALS})
    SELECT p.rolname AS principal,c.relname AS name,owner.rolname AS owner,
      pg_catalog.has_sequence_privilege(p.oid,c.oid,'SELECT') AS select,
      pg_catalog.has_sequence_privilege(p.oid,c.oid,'USAGE') AS usage,
      pg_catalog.has_sequence_privilege(p.oid,c.oid,'UPDATE') AS update
    FROM principals p CROSS JOIN pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_roles owner ON owner.oid=c.relowner WHERE n.nspname='public' AND c.relkind='S'
    ORDER BY p.rolname,c.relname`,
  functions: `WITH principals AS (${PRINCIPALS})
    SELECT p.rolname AS principal,f.proname AS name,pg_catalog.pg_get_function_identity_arguments(f.oid) AS arguments,
      owner.rolname AS owner,f.prosecdef AS security_definer,f.provolatile::text AS volatility,
      pg_catalog.format_type(f.prorettype,NULL) AS return_type,f.proretset AS returns_set,l.lanname AS language,
      extension.extname AS extension_name,extension.extversion AS extension_version,
      pg_catalog.has_function_privilege(p.oid,f.oid,'EXECUTE') AS execute
    FROM principals p CROSS JOIN pg_catalog.pg_proc f JOIN pg_catalog.pg_namespace n ON n.oid=f.pronamespace
    JOIN pg_catalog.pg_roles owner ON owner.oid=f.proowner JOIN pg_catalog.pg_language l ON l.oid=f.prolang
    LEFT JOIN pg_catalog.pg_depend dependency ON dependency.classid='pg_catalog.pg_proc'::regclass
      AND dependency.objid=f.oid AND dependency.objsubid=0 AND dependency.deptype='e'
      AND dependency.refclassid='pg_catalog.pg_extension'::regclass
    LEFT JOIN pg_catalog.pg_extension extension ON extension.oid=dependency.refobjid WHERE n.nspname='public'
    ORDER BY p.rolname,f.proname,pg_catalog.pg_get_function_identity_arguments(f.oid)`,
  publicGrants: `SELECT 'relation' AS kind,c.relname AS name,NULL::text AS sub_name,a.privilege_type,a.is_grantable
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a
    WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m','f') AND a.grantee=0
    UNION ALL SELECT 'column',c.relname,att.attname,a.privilege_type,a.is_grantable
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute att ON att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped
    CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a WHERE n.nspname='public' AND a.grantee=0
    UNION ALL SELECT 'schema',n.nspname,NULL,a.privilege_type,a.is_grantable FROM pg_catalog.pg_namespace n
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a
    WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND a.grantee=0
    UNION ALL SELECT 'database',d.datname,NULL,a.privilege_type,a.is_grantable FROM pg_catalog.pg_database d
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) a
    WHERE d.datname=current_database() AND a.grantee=0
    UNION ALL SELECT 'function',f.proname,pg_catalog.pg_get_function_identity_arguments(f.oid),a.privilege_type,a.is_grantable
    FROM pg_catalog.pg_proc f JOIN pg_catalog.pg_namespace n ON n.oid=f.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
    WHERE n.nspname='public' AND a.grantee=0 ORDER BY 1,2,3,4`,
  defaultGrants: `SELECT owner.rolname AS owner,COALESCE(n.nspname,'*') AS schema,d.defaclobjtype::text AS object_type,
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,a.privilege_type,a.is_grantable
    FROM pg_catalog.pg_default_acl d JOIN pg_catalog.pg_roles owner ON owner.oid=d.defaclrole
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=a.grantee
    ORDER BY owner.rolname,n.nspname,d.defaclobjtype,grantee,a.privilege_type`,
});

const IDENTITY_SQL = `SELECT current_database() AS database,session_user::text AS login,current_user::text AS role,
  current_setting('server_version_num') AS server_version_num,current_setting('transaction_read_only') AS read_only,
  current_setting('transaction_isolation') AS isolation,current_setting('row_security') AS row_security,
  current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout,
  current_setting('idle_in_transaction_session_timeout') AS idle_timeout,
  COALESCE((SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_backend_pid()),false) AS sql_tls`;

const UNSUPPORTED_SQL = `SELECT n.nspname AS schema,c.relname AS name,c.relkind::text AS kind,
  c.relispartition AS is_partition,c.relrowsecurity AS row_security,
  extension.oid IS NOT NULL AS extension_owned,extension.extname AS extension_name,extension.extversion AS extension_version,
  EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_catalog.pg_depend dependency ON dependency.classid='pg_catalog.pg_class'::regclass
    AND dependency.objid=c.oid AND dependency.objsubid=0 AND dependency.deptype='e'
    AND dependency.refclassid='pg_catalog.pg_extension'::regclass
  LEFT JOIN pg_catalog.pg_extension extension ON extension.oid=dependency.refobjid
  WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
  ORDER BY n.nspname,c.relname`;

class ObservationError extends Error { constructor(code) { super(code); this.safeCode = code; } }
const fail = (code) => { throw new ObservationError(code); };
function safeCode(error) {
  if (error instanceof ObservationError) return error.safeCode;
  if (error?.code === '42501') return 'database_permission_denied';
  if (error?.code === '57014') return 'database_statement_timeout';
  if (error?.code === '25006') return 'read_only_violation';
  if (error?.code === '55P03') return 'database_lock_timeout';
  return 'database_observation_failed';
}
function boundedRows(result, limits) {
  if (!result || !Array.isArray(result.rows) || result.rows.length > limits.metadataRows) fail('metadata_result_invalid');
  if (Buffer.byteLength(JSON.stringify(result.rows)) > limits.metadataBytes) fail('metadata_size_exceeded');
  for (const row of result.rows) if (!row || typeof row !== 'object' || Array.isArray(row)) fail('metadata_result_invalid');
  return result.rows;
}
function validateCatalog(catalog, limits) {
  if (!catalog || catalog.formatVersion !== 1) fail('catalog_shape_invalid');
  for (const section of Object.keys(CATALOG_QUERIES)) {
    const rows = boundedRows({ rows: catalog[section] }, limits);
    const keys = new Set();
    for (const row of rows) {
      if (typeof row.name !== 'string' || !row.name || row.name.includes('\0')) fail('catalog_shape_invalid');
      const key = JSON.stringify([row.schema ?? '', row.table_name ?? '', row.name]);
      if (keys.has(key)) fail('catalog_duplicate_key');
      keys.add(key);
    }
  }
  for (const table of catalog.tables) if (table.schema !== 'public' || !['r','p'].includes(table.kind) || typeof table.row_security !== 'boolean' || typeof table.force_row_security !== 'boolean' || typeof table.is_partition !== 'boolean') fail('catalog_shape_invalid');
  if (Buffer.byteLength(JSON.stringify(catalog)) > limits.metadataBytes) fail('metadata_size_exceeded');
}
function validateFixtures(expectedCatalogs, limits) {
  if (!expectedCatalogs || Object.keys(expectedCatalogs).sort().join(',') !== '141,142,95') fail('expected_catalogs_invalid');
  for (const [count, catalog] of Object.entries(expectedCatalogs)) {
    validateCatalog(catalog, limits);
    if (catalog.tables.length !== Number(count)) fail('expected_catalogs_invalid');
  }
}
function safeCatalogComparison(catalog, expectedCatalogs) {
  return Object.entries(expectedCatalogs).map(([version, expected]) => {
    const differences = catalogDifferences(catalog, expected);
    const reviewedFields = new Set(Object.values(expected).filter(Array.isArray).flatMap((rows) => rows.flatMap((row) => Object.keys(row))));
    return { version, differences: differences.length,
      sections: [...new Set(differences.map((difference) => difference.section))].sort(),
      changedFields: [...new Set(differences.flatMap((difference) => difference.fields ?? []).filter((field) => reviewedFields.has(field)))].sort() };
  });
}
function validatePrivileges(privileges) {
  const shapes = {
    roles: { strings: ['principal','name'], booleans: ['superuser','inherit','create_role','create_database','login','replication','bypass_rls','member','usable','can_set'] },
    memberships: { strings: ['role','member','grantor'], booleans: ['admin_option','inherit_option','set_option'] },
    tables: { strings: ['principal','name','owner'], booleans: ['select','insert','update','delete','truncate','references','trigger'] },
    columns: { strings: ['principal','table_name','name'], booleans: ['select','insert','update','references'] },
    namespaces: { strings: ['principal','name','owner'], booleans: ['usage','create'] },
    database: { strings: ['principal','name','owner'], booleans: ['connect','create','temporary'] },
    sequences: { strings: ['principal','name','owner'], booleans: ['select','usage','update'] },
    functions: { strings: ['principal','name','arguments','owner','volatility','return_type','language'], booleans: ['security_definer','execute','returns_set'] },
    publicGrants: { strings: ['kind','name','privilege_type'], booleans: ['is_grantable'] },
    defaultGrants: { strings: ['owner','schema','object_type','grantee','privilege_type'], booleans: ['is_grantable'] },
  };
  for (const [section, shape] of Object.entries(shapes)) for (const row of privileges[section]) {
    for (const key of shape.strings) if (typeof row[key] !== 'string') fail('privilege_shape_invalid');
    for (const key of shape.booleans) if (typeof row[key] !== 'boolean') fail('privilege_shape_invalid');
    if (row.principal && !['growthos-restore-reader','growthos-staging-live'].includes(row.principal)) fail('privilege_shape_invalid');
    if (section === 'publicGrants' && row.sub_name !== null && typeof row.sub_name !== 'string') fail('privilege_shape_invalid');
    if (section === 'functions') validateExtensionIdentity(row, 'privilege_shape_invalid');
  }
}
function validateExtensionIdentity(row, errorCode) {
  const present = typeof row.extension_name === 'string' && row.extension_name.length > 0 && typeof row.extension_version === 'string' && row.extension_version.length > 0;
  const absent = row.extension_name === null && row.extension_version === null;
  if (!present && !absent) fail(errorCode);
  if (typeof row.extension_owned === 'boolean' && row.extension_owned !== present) fail(errorCode);
}
function privilegeCoverageComplete(privileges, catalog) {
  for (const principal of ['growthos-restore-reader','growthos-staging-live']) {
    const tables = privileges.tables.filter((row) => row.principal === principal);
    const columns = privileges.columns.filter((row) => row.principal === principal);
    const tableNames = new Set(tables.map((row) => row.name));
    const columnNames = new Set(columns.map((row) => JSON.stringify([row.table_name,row.name])));
    if (tableNames.size !== tables.length || columnNames.size !== columns.length || tables.length !== catalog.tables.length || columns.length !== catalog.columns.length || catalog.tables.some((table) => !tableNames.has(table.name)) || catalog.columns.some((column) => !columnNames.has(JSON.stringify([column.table_name,column.name])))) return false;
    if (!privileges.namespaces.some((row) => row.principal === principal && row.name === 'public') || privileges.database.filter((row) => row.principal === principal && row.name === TARGET.database).length !== 1) return false;
  }
  return true;
}
function decimal(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value))) fail('fingerprint_shape_invalid');
  return Number(value);
}
function timeoutMilliseconds(value) {
  const match = typeof value === 'string' && /^(\d+)(ms|s|min|h|d)?$/.exec(value);
  if (!match) return NaN;
  return Number(match[1]) * ({ ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000 }[match[2] ?? 'ms']);
}
const identifier = (name) => `"${name.replaceAll('"', '""')}"`;

/** Bounds can only be lowered; provider SQL errors never enter returned evidence.
 * query_timeout is supplied to node-postgres, plus a JS deadline for an injected
 * or stalled client. The caller MUST end/destroy the socket after any failure;
 * rollbackAcknowledged=false is a failure, not proof of server-side cleanup.
 */
export async function observeStaging(client, { expectedCatalogs, limits: requested = {} } = {}) {
  const receipt = { formatVersion: 1, status: 'failed', target: TARGET, fingerprints: [], privileges: {}, unresolved: [],
    transaction: { readOnly: false, isolation: null, rollbackAcknowledged: false },
    scope: { releaseAuthorized: false, recoveryVerified: false, applicationPermissionPolicyVerified: false,
      protectedDomainSemanticsVerified: false, sqlDataReadOnly: true, fingerprintScope: 'recognized_public_application_tables',
      fullClusterDataCoverage: false, excludedExtensionViews: [],
      fingerprint: 'md5(sorted complete-row md5), duplicates retained; equality evidence, not cryptographic authenticity' } };
  let began = false;
  let limits;
  try {
    if (!client || typeof client.query !== 'function') fail('query_client_required');
    if (Object.keys(requested).some((key) => !(key in OBSERVATION_LIMITS))) fail('limits_invalid');
    limits = { ...OBSERVATION_LIMITS, ...requested };
    for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > OBSERVATION_LIMITS[key]) fail('limits_invalid');
    validateFixtures(expectedCatalogs, limits);
    const deadline = Date.now() + limits.operationMs;
    const query = async (text, { rows = false, cleanup = false } = {}) => {
      const remaining = cleanup ? limits.cleanupMs : deadline - Date.now();
      if (remaining <= 0) fail('operation_deadline_exceeded');
      const timeout = Math.min(cleanup ? limits.cleanupMs : limits.queryMs, remaining);
      let timer;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => client.query({ text: rows ? `${text} LIMIT ${limits.metadataRows + 1}` : text, query_timeout: timeout })),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new ObservationError(cleanup ? 'rollback_timeout' : 'query_deadline_exceeded')), timeout); }),
        ]);
        return rows ? boundedRows(result, limits) : result;
      } finally { clearTimeout(timer); }
    };
    // Set transaction-local limits in the same bounded command as BEGIN. No
    // session settings survive rollback, including on a connection pool.
    began = true;
    try {
      await query(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout = '${limits.queryMs}ms'; SET LOCAL lock_timeout = '2000ms'; SET LOCAL idle_in_transaction_session_timeout = '20000ms'; SET LOCAL row_security = off; SET LOCAL search_path = pg_catalog,public; SET LOCAL timezone = 'UTC'; SET LOCAL datestyle = 'ISO, YMD'; SET LOCAL intervalstyle = 'postgres'; SET LOCAL extra_float_digits = 3; SET LOCAL bytea_output = 'hex'`);
      const identities = await query(IDENTITY_SQL, { rows: true });
      if (identities.length !== 1) fail('session_identity_invalid');
      const identity = identities[0];
      if (identity.database !== TARGET.database || identity.login !== TARGET.login || identity.role !== TARGET.role) fail('session_identity_mismatch');
      if (!/^16[0-9]{4}$/.test(identity.server_version_num)) fail('postgres_version_mismatch');
      if (identity.read_only !== 'on' || identity.isolation !== 'repeatable read' || identity.row_security !== 'off') fail('transaction_protection_invalid');
      if (typeof identity.sql_tls !== 'boolean' || timeoutMilliseconds(identity.statement_timeout) !== limits.queryMs || timeoutMilliseconds(identity.lock_timeout) !== 2000 || timeoutMilliseconds(identity.idle_timeout) !== 20000) fail('transaction_protection_invalid');
      receipt.identity = identity;
      receipt.transaction.readOnly = true;
      receipt.transaction.isolation = identity.isolation;
      const catalog = { formatVersion: 1 };
      for (const [section, sql] of Object.entries(CATALOG_QUERIES)) catalog[section] = await query(sql, { rows: true });
      validateCatalog(catalog, limits);
      const matches = Object.entries(expectedCatalogs).filter(([, expected]) => catalogDifferences(catalog, expected).length === 0);
      receipt.catalog = { classification: matches.length === 1 ? matches[0][0] : 'unknown', tables: catalog.tables.length,
        logicalDigest: catalogDigest(catalog), physicalDigest: catalogDigest(catalog, { physical: true }),
        physicalMatch: matches.length === 1 && catalogDifferences(catalog, matches[0][1], { physical: true }).length === 0,
        metadataCounts: Object.fromEntries(Object.keys(CATALOG_QUERIES).map((section) => [section, catalog[section].length])),
        comparison: safeCatalogComparison(catalog, expectedCatalogs) };
      // Catalog SQL expressions can contain secrets or customer literals. Keep
      // their complete values in memory for comparison; persist only digests,
      // counts and reviewed field names, never raw defaults/policies/triggers.
      if (matches.length !== 1) receipt.unresolved.push('catalog_not_recognized');
      else if (!receipt.catalog.physicalMatch) receipt.unresolved.push('physical_catalog_difference');
      const objects = await query(UNSUPPORTED_SQL, { rows: true });
      for (const object of objects) {
        if (typeof object.schema !== 'string' || typeof object.name !== 'string' || !['r','p','v','m','f'].includes(object.kind) || ['is_partition','row_security','extension_owned','inherited'].some((key) => typeof object[key] !== 'boolean')) fail('object_shape_invalid');
        validateExtensionIdentity(object, 'object_shape_invalid');
      }
      receipt.objects = objects;
      const ordinaryNames = objects.filter((object) => object.schema === 'public' && ['r','p'].includes(object.kind) && !object.extension_owned).map((object) => object.name);
      if (ordinaryNames.length !== catalog.tables.length || new Set(ordinaryNames).size !== ordinaryNames.length || catalog.tables.some((table) => !ordinaryNames.includes(table.name))) fail('object_coverage_incomplete');
      const unsupportedObjects = objects.filter((object) => object.schema !== 'public' || object.kind !== 'r' || object.is_partition || object.extension_owned || object.inherited);
      const excludedExtensionView = (object) => object.schema === 'public' && object.kind === 'v' && object.extension_owned && !object.is_partition && !object.inherited;
      receipt.scope.excludedExtensionViews = unsupportedObjects.filter(excludedExtensionView).map(({ schema,name,kind,extension_name,extension_version }) => ({ schema,name,kind,extension_name,extension_version }));
      if (unsupportedObjects.length) receipt.unresolved.push('unsupported_database_objects');
      if (unsupportedObjects.some((object) => !excludedExtensionView(object))) receipt.unresolved.push('application_fingerprint_scope_blocked');
      if (catalog.tables.some((table) => table.row_security || table.force_row_security) || objects.some((object) => object.row_security)) receipt.unresolved.push('row_security_requires_separate_proof');
      for (const [name, sql] of Object.entries(PRIVILEGE_QUERIES)) receipt.privileges[name] = await query(sql, { rows: true });
      validatePrivileges(receipt.privileges);
      if (!privilegeCoverageComplete(receipt.privileges, catalog)) receipt.unresolved.push('privilege_evidence_incomplete');
      if (!['growthos-restore-reader', 'growthos-staging-live'].every((principal) => receipt.privileges.roles.some((role) => role.principal === principal && role.name === principal))) receipt.unresolved.push('required_role_missing');
      const reader = TARGET.role;
      const reachableReaderRoles = receipt.privileges.roles.filter((role) => role.principal === reader && (role.name === reader || role.usable || role.can_set));
      if (reachableReaderRoles.some((role) => role.name !== reader && role.can_set)) receipt.unresolved.push('reader_set_role_paths_unassessed');
      const ownershipRoles = new Set(reachableReaderRoles.map((role) => role.name));
      if ([...receipt.privileges.tables,...receipt.privileges.namespaces,...receipt.privileges.database,...receipt.privileges.sequences,...receipt.privileges.functions].some((row) => row.principal === reader && ownershipRoles.has(row.owner))) receipt.unresolved.push('reader_has_ownership_powers');
      if (receipt.privileges.defaultGrants.length) receipt.unresolved.push('default_grant_policy_unassessed');
      if (receipt.privileges.functions.some((row) => row.principal === reader && row.security_definer && row.execute)) receipt.unresolved.push('reader_security_definer_functions_unassessed');
      if (receipt.privileges.roles.some((role) => role.principal === reader && (role.usable || role.can_set) && ['superuser','create_role','create_database','replication','bypass_rls'].some((key) => role[key]))) receipt.unresolved.push('reader_elevated_role');
      if (receipt.privileges.tables.some((row) => row.principal === reader && ['insert','update','delete','truncate','references','trigger'].some((key) => row[key])) || receipt.privileges.columns.some((row) => row.principal === reader && ['insert','update','references'].some((key) => row[key])) || receipt.privileges.sequences.some((row) => row.principal === reader && (row.usage || row.update)) || [...receipt.privileges.namespaces, ...receipt.privileges.database].some((row) => row.principal === reader && row.create)) receipt.unresolved.push('reader_has_write_privileges');
      if (receipt.privileges.publicGrants.some((row) => ['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','CREATE'].includes(row.privilege_type))) receipt.unresolved.push('public_has_write_privileges');
      // A provider extension view is excluded without evaluating it. Its presence
      // remains unresolved, while exact recognized application tables can still
      // be fingerprinted. Other unexpected objects/RLS block that scoped proof.
      if (!receipt.unresolved.some((reason) => ['catalog_not_recognized','application_fingerprint_scope_blocked','row_security_requires_separate_proof'].includes(reason))) {
        let totalRows = 0;
        let totalBytes = 0;
        for (const table of catalog.tables) {
          const name = `${identifier(table.schema)}.${identifier(table.name)}`;
          const counts = await query(`SELECT count(*)::text AS row_count,COALESCE(sum(octet_length(row_to_json(t)::text)),0)::text AS payload_bytes FROM ${name} AS t`, { rows: true });
          if (counts.length !== 1) fail('fingerprint_shape_invalid');
          const rowCount = decimal(counts[0].row_count);
          const payloadBytes = decimal(counts[0].payload_bytes);
          totalRows += rowCount;
          totalBytes += payloadBytes;
          if (rowCount > limits.tableRows || payloadBytes > limits.tableBytes || totalRows > limits.totalRows || totalBytes > limits.totalBytes) fail('fingerprint_bounds_exceeded');
          const hashes = await query(`SELECT count(*)::text AS row_count,md5(COALESCE(string_agg(row_hash,'' ORDER BY row_hash COLLATE "C"),'')) AS digest FROM (SELECT md5(row_to_json(t)::text) AS row_hash FROM ${name} AS t) AS complete_rows`, { rows: true });
          if (hashes.length !== 1 || decimal(hashes[0].row_count) !== rowCount || typeof hashes[0].digest !== 'string' || !/^[a-f0-9]{32}$/.test(hashes[0].digest)) fail('fingerprint_shape_invalid');
          receipt.fingerprints.push({ schema: table.schema, table: table.name, rows: rowCount, payloadBytes, digest: hashes[0].digest });
        }
        receipt.fingerprintSummary = { complete: receipt.fingerprints.length === catalog.tables.length, tables: receipt.fingerprints.length, rows: totalRows, payloadBytes: totalBytes };
      } else receipt.fingerprintSummary = { complete: false, tables: 0 };
      receipt.status = receipt.unresolved.length ? 'unresolved' : 'observed';
    } finally {
      try {
        const rollback = await query('ROLLBACK', { cleanup: true });
        receipt.transaction.rollbackAcknowledged = rollback?.command === 'ROLLBACK';
        if (!receipt.transaction.rollbackAcknowledged) receipt.unresolved.push('rollback_not_acknowledged');
      } catch { receipt.unresolved.push('rollback_not_acknowledged'); }
    }
    if (!receipt.transaction.rollbackAcknowledged) fail('rollback_not_acknowledged');
  } catch (error) {
    receipt.status = 'failed';
    receipt.errorCode = safeCode(error);
    if (!began) receipt.unresolved.push('transaction_not_established');
    if (!receipt.fingerprintSummary?.complete) {
      receipt.unresolved.push('protected_data_fingerprint_incomplete');
      receipt.fingerprintSummary = { complete: false, tables: receipt.fingerprints.length };
    }
  }
  return receipt;
}
