/** GrowthOS website adapter v1. Server only. Node >=22.13, persistent local volume. */
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const ADAPTER_VERSION = 'growthos-website-adapter-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 16_000;
const DAY = 86_400_000;
const sha = (value) => createHash('sha256').update(value).digest('hex');
export class WebsiteAdapterError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'WebsiteAdapterError'; this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new WebsiteAdapterError(code, status); };
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail('invalid_intake');
  return value;
}
function text(value, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail('invalid_intake');
  return value.trim();
}

/** Deliberately supports contact requests without analytics identity/linkage. */
export function normalizeWebsiteIntake(raw) {
  const value = record(raw, ['schemaVersion', 'requestId', 'contact', 'project', 'consent']);
  if (value.schemaVersion !== 1 || !UUID.test(value.requestId ?? '')) fail('invalid_request_id');
  const contact = record(value.contact, ['name', 'email', 'phone']);
  const project = record(value.project, ['serviceCode', 'postalCode', 'address', 'city', 'state', 'summary', 'timing']);
  const consent = record(value.consent, ['contact', 'policyVersion', 'channels', 'analytics']);
  if (consent.contact !== true || consent.analytics !== false || !/^[a-zA-Z0-9._-]{1,80}$/.test(consent.policyVersion ?? '') ||
      !Array.isArray(consent.channels) || consent.channels.length < 1 || consent.channels.length > 3 || consent.channels.some((c) => !['phone', 'email', 'sms'].includes(c))) fail('invalid_consent');
  const normalized = { schemaVersion: 1, requestId: value.requestId.toLowerCase(), contact: { name: text(contact.name, 2, 100) }, project: { serviceCode: text(project.serviceCode, 1, 60) },
    consent: { contact: true, policyVersion: consent.policyVersion, analytics: false, channels: [...new Set(consent.channels)].sort() } };
  if (contact.email !== undefined) {
    const email = text(contact.email, 3, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('invalid_intake');
    normalized.contact.email = email;
  }
  if (contact.phone !== undefined) {
    const phone = text(contact.phone, 10, 30);
    if (!/^\+?[0-9 ().-]+$/.test(phone) || phone.replace(/\D/g, '').length < 10) fail('invalid_intake');
    normalized.contact.phone = phone.replace(/\D/g, '');
  }
  if (!normalized.contact.email && !normalized.contact.phone) fail('invalid_intake');
  if (consent.channels.some((channel) => channel === 'email' ? !normalized.contact.email : !normalized.contact.phone)) fail('invalid_consent');
  for (const [key, max] of [['address', 180], ['city', 100], ['summary', 2000]]) if (project[key] !== undefined) normalized.project[key] = text(project[key], 0, max);
  if (project.postalCode !== undefined) {
    if (!/^\d{5}$/.test(project.postalCode)) fail('invalid_intake');
    normalized.project.postalCode = project.postalCode;
  }
  if (project.state !== undefined) {
    if (!/^[A-Z]{2}$/.test(project.state)) fail('invalid_intake');
    normalized.project.state = project.state;
  }
  normalized.project.timing = project.timing ?? 'unsure';
  if (!['urgent', 'soon', 'planning', 'unsure'].includes(normalized.project.timing)) fail('invalid_intake');
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_BODY) fail('request_too_large', 413);
  return normalized;
}

export function validateAdapterConfig(config) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) fail('unsupported_node_runtime', 503);
  let url;
  try { url = new URL(config.apiOrigin); } catch { fail('adapter_unconfigured', 503); }
  const local = config.allowLocal === true && process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const allowed = config.allowedApiOrigins ?? ['https://app.mogulforge.ai'];
  if ((!local && !(url.protocol === 'https:' && allowed.includes(url.origin))) || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !UUID.test(config.siteId ?? '') || !/^ss_[a-f0-9]{64}$/.test(config.siteSecret ?? '') || !/^[a-f0-9]{64}$/i.test(config.encryptionKey ?? '') ||
      !config.journalPath || !path.isAbsolute(config.journalPath) || /(?:^|[\\/])(?:public|\.next|dist|out)(?:[\\/]|$)/i.test(config.journalPath)) fail('adapter_unconfigured', 503);
  return { ...config, apiOrigin: url.origin, siteId: config.siteId.toLowerCase() };
}

export function createWebsiteAdapter(rawConfig, dependencies = {}) {
  const config = validateAdapterConfig(rawConfig);
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const timeoutMs = Math.max(1, Math.min(dependencies.timeoutMs ?? 8_000, 8_000));
  const capacity = Math.max(1, Math.min(config.capacity ?? 10_000, 10_000));
  const partition = `${config.apiOrigin}|${config.siteId}`;
  const key = Buffer.from(config.encryptionKey, 'hex');
  const directory = path.dirname(config.journalPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (/(?:^|[\\/])(?:public|\.next|dist|out)(?:[\\/]|$)/i.test(realpathSync(directory))) fail('unsafe_journal_path', 503);
  const db = new DatabaseSync(config.journalPath);
  db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA max_page_count=65536;
    CREATE TABLE IF NOT EXISTS adapter_meta (id INTEGER PRIMARY KEY CHECK(id=1), key_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS website_delivery (
      partition TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, encrypted TEXT,
      received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, claim TEXT, claim_until INTEGER,
      reason TEXT, lead_id TEXT, receipt_id TEXT, PRIMARY KEY(partition, request_id));
    CREATE INDEX IF NOT EXISTS website_delivery_due ON website_delivery(partition,state,next_attempt_at);`);
  const keyHash = sha(`growthos-journal-key-v1:${config.encryptionKey}`);
  db.prepare('INSERT OR IGNORE INTO adapter_meta(id,key_hash) VALUES(1,?)').run(keyHash);
  if (db.prepare('SELECT key_hash FROM adapter_meta WHERE id=1').get().key_hash !== keyHash) { db.close(); fail('journal_key_mismatch', 503); }

  const get = (requestId) => db.prepare('SELECT * FROM website_delivery WHERE partition=? AND request_id=?').get(partition, requestId);
  function expire() {
    const timestamp = now();
    // Retention covers the entire journal even after destination configuration
    // changes. Erase old ciphertext, but do not steal a live delivery claim:
    // its already-sent body may still receive a valid acknowledgement.
    db.prepare("UPDATE website_delivery SET encrypted=NULL, updated_at=? WHERE encrypted IS NOT NULL AND received_at<?")
      .run(timestamp, timestamp - 7 * DAY);
    db.prepare("UPDATE website_delivery SET state='expired', claim=NULL, claim_until=NULL, reason='retention_expired', updated_at=? WHERE state NOT IN ('saved','expired') AND received_at<? AND (state<>'processing' OR coalesce(claim_until,0)<=?)")
      .run(timestamp, timestamp - 7 * DAY, timestamp);
    db.prepare("UPDATE website_delivery SET state='needs-review', claim=NULL, claim_until=NULL, reason='retry_window_exhausted', updated_at=? WHERE partition=? AND (state='queued' OR (state='processing' AND coalesce(claim_until,0)<=?)) AND (received_at<? OR attempts>=20) AND coalesce(reason,'')<>'operator_retry'")
      .run(timestamp, partition, timestamp, timestamp - 3 * DAY);
  }
  function seal(body, requestId) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${ADAPTER_VERSION}|${partition}|${requestId}`));
    const encrypted = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
    return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: encrypted.toString('base64') });
  }
  function unseal(row) {
    const sealed = JSON.parse(row.encrypted);
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    cipher.setAAD(Buffer.from(`${ADAPTER_VERSION}|${partition}|${row.request_id}`));
    cipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const body = Buffer.concat([cipher.update(Buffer.from(sealed.body, 'base64')), cipher.final()]).toString('utf8');
    if (sha(body) !== row.payload_hash) fail('journal_payload_mismatch', 503);
    return body;
  }
  function result(row) {
    if (row.state === 'saved') return { status: 'saved', requestId: row.request_id, leadId: row.lead_id, receiptId: row.receipt_id, notification: 'staff-inbox', appointmentStatus: 'pending_office_approval' };
    return { status: row.state === 'queued' || row.state === 'processing' ? 'queued' : 'needs-review', requestId: row.request_id,
      retained: Boolean(row.encrypted), reason: row.reason ?? 'delivery_pending', appointmentStatus: 'pending_office_approval' };
  }
  async function request(endpoint, body, receivedAt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${config.apiOrigin}/api/v1/public/smart-sites/${config.siteId}/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.siteSecret}`,
          ...(receivedAt ? { 'x-smart-site-received-at': new Date(receivedAt).toISOString() } : {}) },
        body, signal: controller.signal, redirect: 'error', cache: 'no-store',
      });
      if (Number(response.headers.get('content-length')) > MAX_BODY) return { status: response.status, body: null };
      const reader = response.body?.getReader();
      let length = 0;
      const chunks = [];
      if (reader) while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_BODY) { await reader.cancel(); return { status: response.status, body: null }; }
        chunks.push(Buffer.from(chunk.value));
      }
      let data = null;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Unknown receipt is never success. */ }
      return { status: response.status, body: data };
    } finally { clearTimeout(timer); }
  }
  async function attempt(requestId) {
    expire();
    const token = randomUUID();
    const timestamp = now();
    const claimed = db.prepare("UPDATE website_delivery SET state='processing', claim=?, claim_until=?, attempts=attempts+1, updated_at=? WHERE partition=? AND request_id=? AND ((state='queued' AND next_attempt_at<=?) OR (state='processing' AND claim_until<?)) RETURNING *")
      .get(token, timestamp + 60_000, timestamp, partition, requestId, timestamp, timestamp);
    if (!claimed) return result(get(requestId));
    let status = 'queued';
    let reason = 'upstream_unavailable';
    let receipt = null;
    try {
      const upstream = await request('intake', unseal(claimed), claimed.received_at);
      const body = upstream.body;
      if ([200, 201].includes(upstream.status) && body?.status === 'saved' && UUID.test(body.leadId ?? '') && UUID.test(body.receiptId ?? '') && body.notification === 'staff-inbox' && typeof body.duplicate === 'boolean') {
        status = 'saved'; receipt = body; reason = null;
      } else if (['site_staffing_unavailable', 'site_capture_disabled', 'site_disabled', 'customer_lifecycle_paused', 'invalid_site_credentials', 'idempotency_conflict', 'site_missing'].includes(body?.error)) {
        status = 'needs-review'; reason = body.error;
      } else if (upstream.status >= 400 && upstream.status < 500 && ![408, 429].includes(upstream.status)) {
        status = 'needs-review'; reason = `upstream_rejected_${upstream.status}`;
      } else if (upstream.status >= 200 && upstream.status < 300) reason = 'unconfirmed_receipt';
    } catch (error) {
      if (error instanceof WebsiteAdapterError || error?.code === 'ERR_OSSL_BAD_DECRYPT' || error?.message?.includes('authenticate data')) {
        status = 'needs-review'; reason = 'journal_unreadable';
      }
    }
    db.prepare("UPDATE website_delivery SET state=?, reason=?, encrypted=CASE WHEN ?='saved' THEN NULL ELSE encrypted END, lead_id=?, receipt_id=?, claim=NULL, claim_until=NULL, next_attempt_at=?, updated_at=? WHERE partition=? AND request_id=? AND state='processing' AND claim=?")
      .run(status, reason, status, receipt?.leadId ?? null, receipt?.receiptId ?? null,
        now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(claimed.attempts - 1, 7)), now(), partition, requestId, token);
    expire();
    return result(get(requestId));
  }
  return {
    async checkConnection() {
      let response;
      try { response = await request('check', JSON.stringify({ schemaVersion: 1 })); }
      catch { fail('connection_check_unavailable', 503); }
      const body = response.body;
      if (response.status !== 200 || body?.status !== 'credential_verified' || body.siteId !== config.siteId || body.createsLead !== false ||
          !Number.isInteger(body.credentialVersion) || body.credentialVersion < 1 || typeof body.captureEnabled !== 'boolean' ||
          typeof body.profile !== 'string' || !Number.isFinite(Date.parse(body.checkedAt))) fail('connection_not_verified', 503);
      return { status: 'credential_verified', siteId: config.siteId, profile: body.profile, credentialVersion: body.credentialVersion,
        captureEnabled: body.captureEnabled, checkedAt: body.checkedAt, createsLead: false, publicWebsiteVerified: false };
    },
    async submit(raw) {
      const payload = normalizeWebsiteIntake(raw);
      const body = JSON.stringify(payload);
      const hash = sha(body);
      expire();
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = get(payload.requestId);
        if (existing && existing.payload_hash !== hash) fail('idempotency_conflict', 409);
        if (!existing) {
          if (db.prepare('SELECT count(*) AS count FROM website_delivery').get().count >= capacity) fail('journal_capacity_reached', 503);
          const timestamp = now();
          db.prepare("INSERT INTO website_delivery(partition,request_id,payload_hash,encrypted,received_at,updated_at,state,next_attempt_at) VALUES(?,?,?,?,?,?,'queued',?)")
            .run(partition, payload.requestId, hash, seal(body, payload.requestId), timestamp, timestamp, timestamp);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return attempt(payload.requestId);
    },
    async drain({ retryRequestId } = {}) {
      expire();
      if (retryRequestId !== undefined) {
        if (!UUID.test(retryRequestId)) fail('invalid_request_id');
        const row = get(retryRequestId);
        if (!row || row.state !== 'needs-review' || !row.encrypted) fail('request_not_retryable', 409);
        // A bounded operator retry does not change the original request, target or receipt time.
        db.prepare("UPDATE website_delivery SET state='queued', next_attempt_at=?, reason='operator_retry', updated_at=? WHERE partition=? AND request_id=?")
          .run(now(), now(), partition, retryRequestId);
      }
      const due = db.prepare("SELECT request_id FROM website_delivery WHERE partition=? AND ((state='queued' AND next_attempt_at<=?) OR (state='processing' AND claim_until<?)) ORDER BY received_at LIMIT 5")
        .all(partition, now(), now());
      for (const row of due) await attempt(row.request_id);
      return this.inspect();
    },
    lookup(requestId) {
      if (!UUID.test(requestId ?? '')) fail('invalid_request_id');
      expire();
      const row = get(requestId.toLowerCase());
      if (!row) fail('request_unknown', 404);
      return result(row);
    },
    inspect() {
      expire();
      const counts = { queued: 0, processing: 0, saved: 0, 'needs-review': 0, expired: 0 };
      for (const row of db.prepare('SELECT state,count(*) AS count FROM website_delivery WHERE partition=? GROUP BY state').all(partition)) counts[row.state] = row.count;
      const review = db.prepare("SELECT request_id AS requestId, state, reason, attempts, received_at AS receivedAt FROM website_delivery WHERE partition=? AND state IN ('needs-review','expired') ORDER BY CASE state WHEN 'needs-review' THEN 0 ELSE 1 END, received_at LIMIT 25").all(partition);
      const reviewTotal = counts['needs-review'] + counts.expired;
      return { contract: ADAPTER_VERSION, counts, review, reviewTotal, reviewTruncated: reviewTotal > review.length, capacity, totalRecords: db.prepare('SELECT count(*) AS count FROM website_delivery').get().count };
    },
    close() { db.close(); },
  };
}
