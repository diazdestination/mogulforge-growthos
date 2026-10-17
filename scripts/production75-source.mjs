/** Pure exact-byte bridge selection. No filesystem, transport or application. */
import { createHash } from 'node:crypto';
import { PINNED_FILES, SOURCE_COMMIT } from './production75-pins.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (v, code) => { if (!v) throw Object.assign(new Error(code), { safeCode: code }); };
const frozenSources = new WeakSet();
const missing = new Set(['service_obligations','missed_call_handoffs','twilio_calls','twilio_client_bindings',
  'twilio_consent_proofs','twilio_dispatches','twilio_enrollments','twilio_inbound_events','decision_rooms',
  'operating_profiles','project_stories','revenue_execution_events','revenue_executions','value_entries','scheduler_runtime']);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

export function buildProduction75Source(files) {
  check(Array.isArray(files) && files.length === 19, 'production75_source_count');
  const texts = files.map((file,index) => {
    const pin = PINNED_FILES[index];
    check(file.path === pin.path && Buffer.isBuffer(file.bytes) && file.bytes.length === pin.bytes && sha(file.bytes) === pin.sha256 &&
      !file.bytes.includes(13) && Buffer.from(file.bytes.toString('utf8')).equals(file.bytes), 'production75_source_drift');
    return file.bytes.toString('utf8');
  });
  const selected = [], counts = { create: 0, foreignKey: 0, index: 0 };
  let offset = 0;
  for (const [index,sql] of texts[0].split('--> statement-breakpoint').entries()) {
    const match = /^\s*(CREATE TABLE "([^"]+)"|ALTER TABLE "([^"]+)" ADD CONSTRAINT|CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([^"]+)")/.exec(sql);
    const table = match?.[2] ?? match?.[3] ?? match?.[4];
    if (missing.has(table)) {
      const kind = match[2] ? 'create' : match[3] ? 'foreignKey' : 'index'; counts[kind]++;
      selected.push({ index, table, kind, offset, bytes: Buffer.byteLength(sql), sha256: sha(sql),
        line: texts[0].slice(0,offset).split('\n').length, sql });
    }
    offset += sql.length + '--> statement-breakpoint'.length;
  }
  check(counts.create === 15 && counts.foreignKey === 32 && counts.index === 21 && selected.length === 68, 'production75_selection_count');
  // Selection preserves each source statement byte-for-byte and source order.
  // Delimiter insertion is explicit, stable and separately hashed.
  const bridge = selected.map(s => s.sql).join('--> statement-breakpoint');
  const steps = [{ path: 'production75-selected-0000', sha256: sha(bridge), bytes: Buffer.byteLength(bridge), sql: bridge },
    ...PINNED_FILES.slice(1).map((pin,index) => ({ ...pin, sql: texts[index+1] }))];
  const source = freeze({ sourceCommit: SOURCE_COMMIT, sourceFiles: PINNED_FILES,
    selectedStatements: selected.map(({sql: _sql,...entry}) => entry), steps,
    bridgeCounts: { create: 20, column: 1, foreignKey: 44, index: 27 },
    bridgeSha256: sha(steps.slice(0,3).map(s => s.sql).join('\n')) });
  frozenSources.add(source); return source;
}
export function assertProduction75Source(source) { check(frozenSources.has(source), 'production75_source_required'); }
