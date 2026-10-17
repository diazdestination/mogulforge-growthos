// Package C contractor acceptance: automated workday chain for each TEST company.
//
//   BASE_URL=http://127.0.0.1:4192 node scripts/acceptance/acceptance-runtime.mjs --run
//
// LOCAL: the disposable runtime supplies its manifest and credentials in memory.
// STAGING: see reports/acceptance-2026-10-16/STAGING-RUN.md (BASE_URL,
// ACCEPTANCE_MANIFEST and its byte SHA256; hash-pinned TEST credential modules).
//
// Every record created is labeled TEST. No step sends a message: estimate and
// invoice delivery stop at the PREVIEW step (send is never called), and the
// target must keep GROWTHOS_OUTBOUND_HOLD on. Results map to the 33 case IDs in
// reports/acceptance-2026-10-16/CASES.md. Screenshots and JSON results go to
// the private evidence folder, never to Git.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_URL,
  Recorder,
  api,
  assertSafeTarget,
  launch,
  loginStaff,
  readManifest,
  shot,
  admitExecution,
  startEvidence,
  installContextGuard,
  preflightPage,
  publicPost as guardedPublicPost,
} from "./lib.mjs";
import {
  rescheduledExactly,
  lineageExactly,
  issuedDocumentUnchanged,
  exactBalance,
  recipientsExactly,
  credentialVerified,
  appointmentLink,
  withRestoredPolicy,
} from "./guards.mjs";
import {
  observeCompletedVisitUi,
  recordCompletedVisitUi,
} from "./completion-ui.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let target, manifest, rec;
const uuid = () => randomUUID();
const ymd = (d) => d.toISOString().slice(0, 10);
const daysFromNow = (n, hourUtc = 15) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};
const nyNow = () => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return {
    weekday:
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) + 1,
    hm: `${p.hour}:${p.minute}`,
  };
};
const openNow = (policy) => {
  const n = nyNow();
  return (
    policy.days.includes(n.weekday) &&
    n.hm >= policy.opensAt &&
    n.hm < policy.closesAt
  );
};
const brief = (r) =>
  `${r.status}${/^[a-zA-Z0-9_:-]{1,100}$/.test(r.json?.code ?? r.json?.error ?? "") ? ` ${r.json.code ?? r.json.error}` : ""}`;
const ok = (r) => r.status >= 200 && r.status < 300;

const PROFILE = {
  painless: {
    serviceTrade: "roofing",
    assetCategory: "roof_system",
    assetLabel: "TEST main roof (south slope)",
    apptType: "inspection",
  },
  css: {
    serviceTrade: "hvac",
    assetCategory: "hvac_equipment",
    assetLabel: "TEST heat pump — upstairs",
    apptType: "inspection",
  },
};

async function runCompany(browser, company, runtimeSecrets) {
  const P = PROFILE[company.key];
  const tag = company.key;
  const ctxA = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const ctxB = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  await installContextGuard(ctxA);
  await installContextGuard(ctxB);
  const publicPost = (...args) => guardedPublicPost(a, ...args);
  const [staffA, staffB] = company.staff;
  const s = {}; // state
  const step = async (caseIds, label, fn) => {
    try {
      await fn();
    } catch (error) {
      const code = error?.code ?? error?.message;
      const fatal = [
        "policy_restore_failed",
        "credential_check_failed",
        "admission_missing_or_expired",
        "session_not_admitted",
        "foreign_page_origin",
        "session_changed",
        "observed_session",
        "observed_actor",
        "observed_site",
        "observed_staff",
        "observed_release",
      ].includes(code);
      rec.record(
        caseIds,
        "FAIL",
        `${company.name}: ${label} could not verify its required assertion${fatal ? `; safety gate ${code}, execution stopped` : ""}`,
        [],
        { company: company.name, scriptError: true },
      );
      if (fatal) throw Error("acceptance_safety_gate_lost");
    }
  };

  const signIn = runtimeSecrets?.signIn ?? loginStaff;
  await signIn(a, staffA);
  await signIn(b, staffB);
  await preflightPage(a, company, staffA);
  await preflightPage(b, company, staffB);
  const siteKey =
    runtimeSecrets?.siteKey(company.siteId) ??
    process.env[
      company.key === "painless"
        ? "TEST_PAINLESS_SITE_KEY"
        : "TEST_CSS_SITE_KEY"
    ];
  if (!/^ss_[a-f0-9]{64}$/.test(siteKey ?? ""))
    throw Error("fixture_key_unavailable");
  rec.record(
    "SETUP",
    "PASS",
    `${company.name}: both TEST staff signed in (${staffA.last}, ${staffB.last})`,
    [await shot(a, `${tag}-00-today`)],
    { company: company.name },
  );

  // ---- Smart site: credential check, activation, staff alert policy ----
  await step(
    company.key === "painless" ? "P-B" : "H-J",
    "smart-site activation",
    async () => {
      const check = await publicPost(
        `/api/v1/public/smart-sites/${company.siteId}/check`,
        siteKey,
        { schemaVersion: 1 },
      );
      if (!credentialVerified(check, company.siteId))
        throw Error("credential_check_failed");
      const activate = await api(
        a,
        "PATCH",
        `/api/v1/smart-sites/${company.siteId}`,
        { isActive: true, confirmedLaunch: true },
      );
      const readiness = await api(
        a,
        "GET",
        "/api/v1/smart-sites/launch-readiness",
      );
      s.siteActive = ok(activate);
      rec.record(
        company.key === "painless" ? "P-B" : "H-J",
        credentialVerified(check, company.siteId) && ok(activate)
          ? "PASS"
          : "FAIL",
        `${company.name}: TEST site credential check ${check.status}; activation ${brief(activate)}`,
        [],
        {
          company: company.name,
          step: "site-activation",
          readiness: readiness.json,
        },
      );
    },
  );

  await step("P-C/A-01", "staff alert policy", async () => {
    s.policy = {
      enabled: true,
      serviceAlertsEnabled: false,
      timezone: "America/New_York",
      days: company.key === "painless" ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5],
      opensAt: company.key === "painless" ? "09:00" : "07:00",
      closesAt: company.key === "painless" ? "18:00" : "17:00",
      businessHoursUserIds: [staffA.id, staffB.id],
      afterHoursUserIds: [staffA.id],
    };
    const policy = await api(a, "PUT", "/api/v1/staff-push/policy", s.policy);
    s.policySaved = ok(policy);
    rec.record(
      company.key === "painless" ? "P-C" : "H-J",
      ok(policy) ? "PASS" : "FAIL",
      `${company.name}: owner alert policy (both owners business hours; one after-hours owner = TEST placeholder) saved ${policy.status}`,
      [],
      {
        company: company.name,
        step: "push-policy",
        partial:
          "Policy save only; actual after-hours delivery needs real devices (real-device-only).",
      },
    );
  });

  // ---- Website inquiry -> lead, alerts, claim ----
  const intakeBody = {
    schemaVersion: 1,
    requestId: uuid(),
    contact: {
      name: `TEST ${company.key === "painless" ? "Roof" : "HVAC"} Inquirer`,
      email: `test-${tag}-${manifest.runId}@example.invalid`,
      phone: "(202) 555-0199",
    },
    project: {
      serviceCode: "",
      address: "100 TEST Street",
      city: "Testville",
      state: "NY",
      postalCode: "10001",
      summary: "TEST acceptance inquiry — not a real customer",
      timing: "soon",
    },
    consent: {
      contact: true,
      policyVersion: "test-2026-10-16",
      analytics: false,
      channels: ["phone", "email", "sms"],
    },
  };
  await step(
    company.key === "painless" ? "P-B" : "H-J",
    "website inquiry",
    async () => {
      const before = await api(
        a,
        "GET",
        `/api/v1/contacts?search=${encodeURIComponent(intakeBody.contact.email)}`,
      );
      if (!ok(before)) throw Error("contact_read_failed");
      s.beforeContacts = (
        Array.isArray(before.json)
          ? before.json
          : (before.json?.contacts ?? before.json?.data ?? [])
      ).filter((c) => c.email === intakeBody.contact.email).length;
      const profiles = await api(a, "GET", "/api/v1/smart-sites/profiles");
      const profile = (
        Array.isArray(profiles.json)
          ? profiles.json
          : (profiles.json?.profiles ?? [])
      ).find(
        (p) =>
          p.id === (company.key === "painless" ? "roofing-exteriors" : "hvac"),
      );
      const services = profile?.services ?? [];
      intakeBody.project.serviceCode = Array.isArray(services[0])
        ? services[0][0]
        : (services[0]?.slug ?? services[0]?.code ?? "repair");
      const first = await publicPost(
        `/api/v1/public/smart-sites/${company.siteId}/intake`,
        siteKey,
        intakeBody,
      );
      const replay = await publicPost(
        `/api/v1/public/smart-sites/${company.siteId}/intake`,
        siteKey,
        intakeBody,
      );
      s.leadId = first.json?.leadId;
      const caseId = company.key === "painless" ? "P-B" : "H-J";
      rec.record(
        caseId,
        ok(first) && s.leadId ? "PASS" : "FAIL",
        `${company.name}: TEST smart-site inquiry -> ${brief(first)}`,
        [],
        { company: company.name, step: "intake" },
      );
      rec.record(
        caseId,
        replay.json?.duplicate === true && replay.json?.leadId === s.leadId
          ? "PASS"
          : "FAIL",
        `${company.name}: identical resubmission (P-10) -> ${brief(replay)}`,
        [],
        { company: company.name, step: "intake-replay" },
      );
    },
  );

  if (s.leadId) {
    await step("P-B", "alert coverage", async () => {
      const coverage = await api(
        a,
        "GET",
        `/api/v1/staff-push/leads/${s.leadId}/coverage`,
      );
      const outcomes = (coverage.json?.recipients ?? [])
        .map((r) => `${r.displayName}:${r.outcome}`)
        .join(", ");
      const expected =
        s.policy && !openNow(s.policy) ? [staffA.id] : [staffA.id, staffB.id];
      const both = recipientsExactly(coverage.json?.recipients ?? [], expected);
      rec.record(
        company.key === "painless" ? "P-B" : "H-J",
        coverage.json?.status === "evaluated" && both ? "PASS" : "FAIL",
        `${company.name}: owner alert coverage status=${coverage.json?.status} recipients=[${outcomes}] (held: no device/provider; delivery to phones is real-device-only)`,
        [],
        { company: company.name, step: "coverage", coverage: coverage.json },
      );
    });
    await step("P-B", "lead page + claim", async () => {
      await a.goto(`${BASE_URL}/leads/${s.leadId}`);
      await a.waitForLoadState("networkidle").catch(() => {});
      const ev = [await shot(a, `${tag}-01-lead`)];
      const claimA = await api(
        a,
        "PATCH",
        `/api/v1/smart-sites/leads/${s.leadId}/owner`,
        { assignedUserId: staffA.id, expectedOwnerId: null },
      );
      const claimB = await api(
        b,
        "PATCH",
        `/api/v1/smart-sites/leads/${s.leadId}/owner`,
        { assignedUserId: staffB.id, expectedOwnerId: null },
      );
      await b.goto(`${BASE_URL}/leads/${s.leadId}`);
      await b.waitForLoadState("networkidle").catch(() => {});
      ev.push(await shot(b, `${tag}-02-lead-ownerB-mobile`));
      const pass = ok(claimA) && claimB.status === 409;
      rec.record(
        company.key === "painless" ? "P-B" : "H-J",
        pass ? "PASS" : "FAIL",
        `${company.name}: owner A claim ${claimA.status}; owner B takeover attempt ${brief(claimB)} (P-07 one claim)`,
        ev,
        { company: company.name, step: "claim" },
      );
      const drafts = await api(
        a,
        "GET",
        `/api/v1/leads/${s.leadId}/manual-sms`,
      );
      rec.record(
        company.key === "painless" ? "P-D" : "H-K",
        drafts.json?.allowed === true &&
          (drafts.json?.templates ?? []).length >= 1
          ? "PASS"
          : "FAIL",
        `${company.name}: "Reply from your phone" drafts for the inquiry: allowed=${drafts.json?.allowed} reason=${drafts.json?.reason ?? "-"} templates=${(drafts.json?.templates ?? []).length} (nothing sent; handset send/reply is real-device-only, G-18)`,
        [],
        { company: company.name, step: "manual-sms-drafts" },
      );
      const lead = await api(a, "GET", `/api/v1/leads/${s.leadId}`);
      s.contactId =
        lead.json?.contactId ??
        lead.json?.lead?.contactId ??
        lead.json?.contact?.id;
      s.propertyId =
        lead.json?.propertyId ?? lead.json?.lead?.propertyId ?? null;
    });
  }

  // ---- After-hours routing (A-01): alerts route by the server's capture time, so the
  // TEST policy is temporarily made "closed today" (today's weekday removed), one
  // inquiry is captured, then the real TEST policy is restored. ----
  await step("P-C", "after-hours routing", async () => {
    const today = nyNow().weekday;
    const closed = {
      ...s.policy,
      days: [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== today),
    };
    const set = async (policy) => {
      const r = await api(a, "PUT", "/api/v1/staff-push/policy", policy);
      if (!ok(r)) throw Error("policy_write_failed");
      return r;
    };
    const body = {
      ...intakeBody,
      requestId: uuid(),
      contact: {
        name: intakeBody.contact.name,
        email: `test-${tag}-afterhours@example.invalid`,
      },
    };
    const { intake, cov } = await withRestoredPolicy({
      set,
      original: s.policy,
      temporary: closed,
      run: async () => {
        const intake = await publicPost(
          `/api/v1/public/smart-sites/${company.siteId}/intake`,
          siteKey,
          body,
        );
        const cov = intake.json?.leadId
          ? await api(
              a,
              "GET",
              `/api/v1/staff-push/leads/${intake.json.leadId}/coverage`,
            )
          : { json: null };
        return { intake, cov };
      },
    });
    const ids = (cov.json?.recipients ?? []).map((r) => r.userId);
    rec.record(
      company.key === "painless" ? "P-C" : "H-J",
      ok(intake) &&
        cov.json?.status === "evaluated" &&
        recipientsExactly(cov.json?.recipients ?? [], [staffA.id])
        ? "PASS"
        : "FAIL",
      `${company.name}: inquiry captured while TEST policy closed -> intake ${intake.status}; exact owner-only coverage checked; original TEST policy restored in finally`,
      [],
      {
        company: company.name,
        step: "after-hours-routing",
        coverageStatus: cov.json?.status,
        note: "Routing uses capture time, not x-smart-site-received-at; buffered site submissions are routed by delivery time.",
      },
    );
  });
  // ---- Tenant isolation: the other company's owner cannot read this lead ----
  await step("P-D", "tenant isolation", async () => {
    const other = manifest.companies.find((c) => c.key !== company.key);
    if (!other || !s.leadId) return;
    const ctxO = await browser.newContext();
    await installContextGuard(ctxO);
    const o = await ctxO.newPage();
    await signIn(o, other.staff[0]);
    await preflightPage(o, other, other.staff[0]);
    const read = await api(o, "GET", `/api/v1/leads/${s.leadId}`);
    await o.goto(`${BASE_URL}/leads/${s.leadId}`);
    await o.waitForLoadState("networkidle").catch(() => {});
    const ev = [await shot(o, `${tag}-02b-cross-tenant-lead`)];
    await ctxO.close();
    rec.record(
      company.key === "painless" ? "P-D" : "H-K",
      [403, 404].includes(read.status) ? "PASS" : "FAIL",
      `${company.name}: ${other.name} owner opening this lead link -> API ${read.status} (no company switch)`,
      ev,
      {
        company: company.name,
        step: "tenant-isolation",
        partial:
          "API refusal only; image does not independently prove settled UI refusal. Phone tap-through remains device-only.",
      },
    );
  });

  // ---- Customer + property ----
  await step("P-E", "customer/property", async () => {
    const lead = await api(a, "GET", `/api/v1/leads/${s.leadId}`),
      contacts = await api(
        a,
        "GET",
        `/api/v1/contacts?search=${encodeURIComponent(intakeBody.contact.email)}`,
      ),
      props = await api(
        a,
        "GET",
        `/api/v1/properties?contactId=${s.contactId}`,
      );
    const l = lead.json?.lead ?? lead.json,
      cs = (
        Array.isArray(contacts.json)
          ? contacts.json
          : (contacts.json?.contacts ?? contacts.json?.data ?? [])
      ).filter((c) => c.email === intakeBody.contact.email),
      ps = Array.isArray(props.json)
        ? props.json
        : (props.json?.properties ?? props.json?.data ?? []);
    s.lineageReady =
      ok(lead) &&
      ok(contacts) &&
      ok(props) &&
      lineageExactly({
        lead: l,
        contacts: cs,
        properties: ps,
        expectedEmail: intakeBody.contact.email,
        expectedAddress: intakeBody.project.address,
        beforeContacts: s.beforeContacts,
      });
    if (!s.lineageReady) throw Error("exact_inquiry_lineage_unverified");
    s.contactId = l.contactId;
    s.propertyId = l.propertyId;
    await a.goto(`${BASE_URL}/contacts/${s.contactId}`);
    await a.waitForLoadState("networkidle").catch(() => {});
    rec.record(
      company.key === "painless" ? "P-E" : "H-E",
      s.contactId && s.propertyId ? "PASS" : "FAIL",
      `${company.name}: inquiry customer ${s.contactId ? "linked" : "missing"}; property ${s.propertyId ? "linked" : "missing"} (no duplicate customer created)`,
      [await shot(a, `${tag}-03-customer`)],
      { company: company.name, step: "customer" },
    );
  });

  // ---- Estimate on the lead + delivery preview (held, never sent) ----
  await step("G06-01", "estimate", async () => {
    if (!s.lineageReady) throw Error("lineage_required");
    const est = await api(a, "POST", "/api/v1/estimates", {
      leadId: s.leadId,
      title: `TEST ${company.key === "painless" ? "roof repair" : "HVAC repair"} estimate`,
      lineItems: [
        {
          description: "TEST labor",
          quantity: 2,
          unitPriceCents: 12500,
          totalCents: 25000,
        },
        {
          description: "TEST materials",
          quantity: 1,
          unitPriceCents: 8000,
          totalCents: 8000,
        },
      ],
      taxCents: 0,
      notes: "TEST acceptance record",
    });
    s.estimateId = est.json?.id;
    rec.record(
      company.key === "painless" ? "P-E" : "H-I",
      ok(est) ? "PASS" : "FAIL",
      `${company.name}: line-item estimate created ${brief(est)}`,
      [],
      { company: company.name, step: "estimate" },
    );
    if (s.estimateId) {
      const preview = await api(
        a,
        "POST",
        `/api/v1/estimates/${s.estimateId}/delivery/preview`,
        { expectedUpdatedAt: est.json.updatedAt, expectedWorkVersion: null },
      );
      await a.goto(`${BASE_URL}/estimates`);
      await a.waitForLoadState("networkidle").catch(() => {});
      rec.record(
        "G06-01",
        ok(preview) ? "PASS" : "BLOCKED",
        `${company.name}: estimate email delivery PREVIEW (send not called) -> ${brief(preview)}`,
        [await shot(a, `${tag}-04-estimates`)],
        {
          company: company.name,
          step: "estimate-preview",
          note: "Real send needs a connected company sender + approved test inbox (O-03/O-04/O-05) on staging.",
        },
      );
    }
  });

  // ---- Scheduling: create, conflict, reschedule ----
  await step("G04-02", "scheduling", async () => {
    if (!s.lineageReady) throw Error("lineage_required");
    const start = daysFromNow(2, 15);
    const end = new Date(start.getTime() + 2 * 3600_000);
    const appt = await api(a, "POST", "/api/v1/appointments", {
      leadId: s.leadId,
      contactId: s.contactId,
      propertyId: s.propertyId,
      assignedUserId: staffA.id,
      type: P.apptType,
      scheduledStart: start.toISOString(),
      scheduledEnd: end.toISOString(),
      notes: "TEST acceptance visit",
    });
    s.appointment = appt.json;
    rec.record(
      "G04-02",
      ok(appt) ? "PASS" : "FAIL",
      `${company.name}: native ${P.apptType} visit created ${brief(appt)}`,
      [],
      { company: company.name, step: "appointment" },
    );
    const overlap = await api(a, "POST", "/api/v1/appointments", {
      contactId: s.contactId,
      propertyId: s.propertyId,
      assignedUserId: staffA.id,
      type: P.apptType,
      scheduledStart: new Date(start.getTime() + 30 * 60_000).toISOString(),
      scheduledEnd: new Date(start.getTime() + 90 * 60_000).toISOString(),
      notes: "TEST overlap check",
    });
    rec.record(
      "G04-03",
      overlap.status === 409 ? "PASS" : "FAIL",
      `${company.name}: overlapping visit for the same technician -> ${brief(overlap)}`,
      [],
      {
        company: company.name,
        step: "conflict",
        expected: "refused with explanation (409)",
      },
    );
    if (ok(overlap) && overlap.json?.id)
      await api(a, "PATCH", `/api/v1/appointments/${overlap.json.id}`, {
        status: "cancelled",
      });
    if (s.appointment?.id) {
      const newStart = daysFromNow(3, 15);
      const expected = {
        id: s.appointment.id,
        contactId: s.contactId,
        propertyId: s.propertyId,
        assignedUserId: staffA.id,
        scheduledStart: newStart.toISOString(),
        scheduledEnd: new Date(newStart.getTime() + 2 * 3600_000).toISOString(),
      };
      const moved = await api(
        a,
        "PATCH",
        `/api/v1/appointments/${s.appointment.id}`,
        {
          scheduledStart: expected.scheduledStart,
          scheduledEnd: expected.scheduledEnd,
        },
      );
      if (ok(moved)) s.appointment = { ...s.appointment, ...moved.json };
      const list = await api(a, "GET", `/api/v1/appointments`);
      const rows = Array.isArray(list.json)
        ? list.json
        : (list.json?.appointments ?? list.json?.data ?? []);
      const mine = rows.filter(
        (r) => r.contactId === s.contactId && r.status !== "cancelled",
      );
      await a.goto(`${BASE_URL}/appointments`);
      await a.waitForLoadState("networkidle").catch(() => {});
      rec.record(
        "G04-02",
        ok(moved) && ok(list) && rescheduledExactly(rows, expected)
          ? "PASS"
          : "FAIL",
        `${company.name}: reschedule ${moved.status}; active visits for customer=${mine.length} (no duplicate)`,
        [await shot(a, `${tag}-05-appointments`)],
        { company: company.name, step: "reschedule" },
      );
    }
  });

  // ---- Equipment / warranty asset ----
  await step("H-F", "asset", async () => {
    if (!s.lineageReady) throw Error("lineage_required");
    const asset = await api(
      a,
      "POST",
      `/api/v1/contacts/${s.contactId}/assets`,
      {
        requestId: uuid(),
        propertyId: s.propertyId,
        category: P.assetCategory,
        label: P.assetLabel,
        manufacturer: "TEST Maker",
        model: "TEST-M1",
        serial: "TEST-SN-0001",
        location: "TEST location",
        installedOn: "2024-05-01",
        notes: "TEST asset",
        warrantyStartsOn: "2024-05-01",
        warrantyEndsOn: "2034-05-01",
        warrantySource: "TEST: manufacturer registration card (fictional)",
        attributes: [],
      },
    );
    s.asset = asset.json?.asset;
    s.assetId = s.asset?.id;
    rec.record(
      company.key === "painless" ? "P-G" : "H-F",
      ok(asset) ? "PASS" : "FAIL",
      `${company.name}: equipment/roof asset with warranty dates + source recorded ${asset.status}`,
      [],
      { company: company.name, step: "asset" },
    );
  });

  // ---- Checklist approval + visit completion ----
  await step(
    company.key === "painless" ? "P-G" : "H-G",
    "visit work",
    async () => {
      if (!s.lineageReady || !s.appointment?.id)
        throw Error("visit_lineage_required");
      const catalog = await api(a, "GET", "/api/v1/work-checklists");
      const starter = (catalog.json?.starters ?? []).find(
        (x) => x.definition?.trade === P.serviceTrade,
      );
      if (!starter) throw Error("trade_starter_required");
      const definition = {
        ...starter.definition,
        name: `TEST ${starter.definition.name}`,
      };
      const created = await api(a, "POST", "/api/v1/work-checklists", {
        requestId: uuid(),
        definition,
        baselineId: starter.id,
      });
      const tpl = created.json?.template;
      const preview = await api(
        a,
        "POST",
        `/api/v1/work-checklists/${tpl?.id}/preview`,
        { expectedVersion: tpl?.version, revisionId: tpl?.latestRevision?.id },
      );
      const approve = await api(
        a,
        "POST",
        `/api/v1/work-checklists/${tpl?.id}/approve`,
        {
          requestId: uuid(),
          previewToken: preview.json?.previewToken,
          confirmed: true,
        },
      );
      rec.record(
        company.key === "painless" ? "P-G" : "H-F",
        ok(approve) ? "PASS" : "FAIL",
        `${company.name}: company checklist created from starter, previewed and approved: create ${created.status}, preview ${preview.status}, approve ${brief(approve)}`,
        [],
        { company: company.name, step: "checklist" },
      );
      const work = await api(
        a,
        "GET",
        `/api/v1/appointments/${s.appointment.id}/work`,
      );
      const entry = await api(
        a,
        "POST",
        `/api/v1/appointments/${s.appointment.id}/work/entries`,
        {
          requestId: uuid(),
          expectedAppointmentUpdatedAt: work.json?.appointment?.updatedAt,
          checklistRevisionId: tpl?.latestRevision?.id,
          assetId: s.assetId ?? null,
          serviceObligationId: null,
        },
      );
      const e =
        entry.json?.entry ??
        entry.json?.work?.entries?.[0] ??
        (entry.json?.entries ?? [])[0];
      const answers = definition.items.map((item) =>
        item.kind === "photo"
          ? {
              itemKey: item.key,
              result: "not_applicable",
              value: null,
              reason: "TEST run: no photo taken",
            }
          : item.kind === "text"
            ? {
                itemKey: item.key,
                result: "done",
                value: "TEST observation recorded by automation",
                reason: null,
              }
            : item.kind === "number"
              ? { itemKey: item.key, result: "done", value: 1, reason: null }
              : {
                  itemKey: item.key,
                  result: "done",
                  value: null,
                  reason: null,
                },
      );
      const saved = await api(
        a,
        "PATCH",
        `/api/v1/appointments/${s.appointment.id}/work/entries/${e?.id}`,
        {
          requestId: uuid(),
          expectedVersion: e?.version,
          answers,
          notes: "TEST notes",
        },
      );
      const savedEntry =
        saved.json?.entry ??
        saved.json?.work?.entries?.find?.((x) => x.id === e?.id) ??
        e;
      rec.record(
        company.key === "painless" ? "P-G" : "H-F",
        ok(entry) && ok(saved) ? "PASS" : "FAIL",
        `${company.name}: visit work entry prepared for exact asset (${entry.status}) and answers saved (${brief(saved)})`,
        [],
        { company: company.name, step: "entry" },
      );
      await a.goto(
        BASE_URL + appointmentLink(company.organizationId, s.appointment.id),
      );
      await a.waitForLoadState("networkidle").catch(() => {});
      const work2 = await api(
        a,
        "GET",
        `/api/v1/appointments/${s.appointment.id}/work`,
      );
      const entries = (work2.json?.entries ?? []).map((x) => ({
        id: x.id,
        version: x.version,
      }));
      const performedAt = new Date(Date.now() - 60_000).toISOString();
      const cp = await api(
        a,
        "POST",
        `/api/v1/appointments/${s.appointment.id}/work/completion-preview`,
        {
          expectedAppointmentUpdatedAt: work2.json?.appointment?.updatedAt,
          entries,
          serviceObligationIds: [],
          performedAt,
          summary: "TEST visit completed by acceptance automation",
          outcome: "completed",
          followup: null,
        },
      );
      const completionRequestId = uuid();
      const done = await api(
        a,
        "POST",
        `/api/v1/appointments/${s.appointment.id}/work/complete`,
        {
          requestId: completionRequestId,
          previewToken: cp.json?.previewToken,
          confirmed: true,
        },
      );
      rec.record(
        company.key === "painless" ? "P-G" : "H-G",
        ok(cp) && ok(done) ? "PASS" : "FAIL",
        `${company.name}: API completion only: preview ${brief(cp)}; complete ${brief(done)}`,
        [],
        {
          company: company.name,
          step: "complete-api",
          savedEntryVersion: savedEntry?.version,
          apiStatus: done.status,
        },
      );
      const uiExpected = {
        origin: BASE_URL,
        organizationId: company.organizationId,
        appointmentId: s.appointment.id,
        contactId: s.contactId,
        propertyId: s.propertyId,
        assetId: s.assetId,
        entryId: e?.id,
        checklistRevisionId: tpl?.latestRevision?.id,
        checklistName: definition.name,
        assetLabel: P.assetLabel,
        customerLabel: intakeBody.contact.name,
        completionId: done.json?.work?.completion?.id,
        completionRequestId,
        updatedAt: done.json?.work?.appointment?.updatedAt,
        performedAt,
        recordedAt: done.json?.work?.completion?.recordedAt,
        performerUserId: staffA.id,
        summary: "TEST visit completed by acceptance automation",
      };
      await recordCompletedVisitUi({
        company,
        record: (...args) => rec.record(...args),
        preflight: () => preflightPage(a, company, staffA),
        observe: () => observeCompletedVisitUi(a, uiExpected),
        screenshot: () => shot(a, `${tag}-06-visit`),
      });
      s.completionId = done.json?.work?.completion?.id;
      if (s.completionId) {
        const corr = await api(
          a,
          "POST",
          `/api/v1/appointments/${s.appointment.id}/work/completions/${s.completionId}/corrections`,
          { requestId: uuid(), note: "TEST note-only correction" },
        );
        rec.record(
          company.key === "painless" ? "P-H" : "H-H",
          ok(corr) ? "PASS" : "FAIL",
          `${company.name}: completed evidence accepts note-only correction ${brief(corr)}`,
          [],
          {
            company: company.name,
            step: "correction",
            partial:
              "Asset/address-change hold and cancel/reprepare not automated.",
          },
        );
      }
    },
  );

  // ---- Invoice with equipment/warranty, issue, held delivery preview, partial receipt ----
  await step("P-I", "invoice", async () => {
    if (!s.lineageReady) throw Error("lineage_required");
    const document = {
      title: `TEST ${company.key === "painless" ? "roof repair" : "HVAC maintenance"} invoice`,
      currency: "USD",
      issuerName: company.name,
      customerName: "TEST Inquirer",
      dueDate: ymd(daysFromNow(30)),
      notes: "TEST acceptance record — not a real bill",
      lineItems: [
        { description: "TEST labor", quantity: "2", unitPriceCents: 12500 },
        { description: "TEST materials", quantity: "1", unitPriceCents: 8000 },
      ],
      taxCents: 0,
    };
    const inv = await api(a, "POST", "/api/v1/invoices", {
      requestId: uuid(),
      source: {
        kind: "existing_customer",
        contactId: s.contactId,
        propertyId: s.propertyId,
      },
      document,
      ...(s.assetId
        ? {
            equipment: {
              assetIds: [s.assetId],
              warrantyTerms: "TEST workmanship terms (fictional)",
            },
          }
        : {}),
    });
    let invoice = inv.json?.invoice;
    const eq =
      invoice?.draftDocument?.equipment ?? invoice?.document?.equipment;
    rec.record(
      "N-01",
      ok(inv) && eq ? "PASS" : "FAIL",
      `${company.name}: draft invoice with equipment + warranty snapshot ${inv.status}; equipment=${JSON.stringify(eq)?.slice(0, 160)}`,
      [],
      {
        company: company.name,
        step: "invoice-draft",
        linkedCases: ["P-I", "H-I", "G-03"],
      },
    );
    if (!invoice?.id) return;
    const issued = await api(
      a,
      "POST",
      `/api/v1/invoices/${invoice.id}/issue`,
      { requestId: uuid(), expectedVersion: invoice.version, confirmed: true },
    );
    invoice = issued.json?.invoice ?? invoice;
    const issuedSnapshot = structuredClone(invoice);
    await a.goto(`${BASE_URL}/invoices/${invoice.id}`);
    await a.waitForLoadState("networkidle").catch(() => {});
    rec.record(
      company.key === "painless" ? "P-I" : "H-I",
      ok(issued) ? "PASS" : "FAIL",
      `${company.name}: invoice issued ${brief(issued)}`,
      [await shot(a, `${tag}-07-invoice-issued`)],
      { company: company.name, step: "issue" },
    );
    if (s.asset) {
      const {
        id,
        version,
        status,
        organizationId,
        contactId,
        createdAt,
        updatedAt,
        ...rest
      } = s.asset;
      const fields = Object.fromEntries(
        [
          "category",
          "label",
          "manufacturer",
          "model",
          "serial",
          "location",
          "installedOn",
          "notes",
          "warrantyStartsOn",
          "warrantyEndsOn",
          "warrantySource",
          "attributes",
        ].map((k) => [k, rest[k] ?? null]),
      );
      const edit = await api(a, "PATCH", `/api/v1/assets/${s.assetId}`, {
        ...fields,
        attributes: fields.attributes ?? [],
        label: `${fields.label} (relabeled after issue)`,
        requestId: uuid(),
        expectedVersion: version,
        status: status ?? "active",
      });
      const reread = await api(a, "GET", `/api/v1/invoices/${invoice.id}`);
      const unchanged =
        ok(edit) &&
        ok(reread) &&
        issuedDocumentUnchanged(
          issuedSnapshot,
          reread.json?.invoice ?? reread.json,
        );
      rec.record(
        "N-02",
        unchanged ? "PASS" : "FAIL",
        `${company.name}: full issued document compared after asset edit (${edit.status}); unchanged=${unchanged}`,
        [],
        { company: company.name, step: "issued-immutability" },
      );
    }
    const preview = await api(
      a,
      "POST",
      `/api/v1/invoices/${invoice.id}/delivery/preview`,
      { expectedVersion: invoice.version },
    );
    rec.record(
      "N-03",
      ok(preview) ? "PASS" : "BLOCKED",
      `${company.name}: invoice email PREVIEW (send not called) -> ${brief(preview)}`,
      [],
      {
        company: company.name,
        step: "invoice-preview",
        linkedCases: ["P-I", "H-I"],
        note: "Real email needs a connected sender and approved test inbox; Painless Yahoo sender unsupported (G-19).",
      },
    );
    const pay = await api(
      a,
      "POST",
      `/api/v1/invoices/${invoice.id}/payments`,
      {
        requestId: uuid(),
        expectedVersion: invoice.version,
        confirmed: true,
        amountCents: 10000,
        sourceReference: "TEST check #0001",
        occurredAt: new Date(Date.now() - 60_000).toISOString(),
      },
    );
    const paidRead = await api(a, "GET", `/api/v1/invoices/${invoice.id}`),
      paidInvoice = paidRead.json?.invoice ?? paidRead.json;
    await a.goto(`${BASE_URL}/invoices/${invoice.id}`);
    await a.waitForLoadState("networkidle").catch(() => {});
    const text = await a
      .locator("#main-content")
      .innerText()
      .catch(() => "");
    rec.record(
      company.key === "painless" ? "P-I" : "H-I",
      ok(pay) &&
        ok(paidRead) &&
        paidInvoice?.id === invoice.id &&
        exactBalance(paidInvoice)
        ? "PASS"
        : "FAIL",
      `${company.name}: staff-recorded partial external receipt $100.00 -> ${pay.status}; balance shown: ${(/Balance due[\s\S]{0,40}/.exec(text)?.[0] ?? "n/a").replace(/\s+/g, " ")}`,
      [await shot(a, `${tag}-08-invoice-paid`)],
      { company: company.name, step: "payment" },
    );
  });

  // ---- Service obligation + recurrence + standing reminder (held) ----
  await step("H-B", "service reminders", async () => {
    if (!s.lineageReady) throw Error("lineage_required");
    const ob = await api(a, "POST", "/api/v1/service-obligations", {
      contactId: s.contactId,
      propertyId: s.propertyId,
      kind: company.key === "css" ? "maintenance" : "warranty_check",
      equipmentLabel: P.assetLabel,
      dueDate: ymd(daysFromNow(40)),
      noticeDays: 30,
      assignedUserId: staffA.id,
      notes: "TEST service agreement (fictional)",
    });
    const recur = ok(ob)
      ? await api(
          a,
          "POST",
          `/api/v1/service-obligations/${ob.json.id}/recurrence`,
          {
            expectedUpdatedAt: ob.json.updatedAt,
            intervalMonths: 6,
            endDate: ymd(daysFromNow(730)),
            agreementNote: "TEST agreement: every 6 months (fictional)",
          },
        )
      : { status: 0, json: null };
    const caseId = company.key === "css" ? "H-B" : "P-J";
    rec.record(
      caseId,
      ok(ob) && ok(recur) ? "PASS" : "FAIL",
      `${company.name}: service date + 6-month recurrence: obligation ${ob.status}, recurrence ${brief(recur)}`,
      [],
      { company: company.name, step: "obligation" },
    );
    if (ok(ob)) {
      const fresh = await api(
        a,
        "GET",
        `/api/v1/service-obligations/${ob.json.id}/standing-reminders`,
      );
      const updatedAt =
        recur.json?.updatedAt ??
        recur.json?.obligation?.updatedAt ??
        ob.json.updatedAt;
      const prev = await api(
        a,
        "POST",
        `/api/v1/service-obligations/${ob.json.id}/standing-reminders/preview`,
        {
          expectedVersion: fresh.json?.version ?? 0,
          expectedUpdatedAt: updatedAt,
          policy: {
            enabled: true,
            channel: "email",
            agreementStartsOn: ymd(new Date()),
            agreementEndsOn: ymd(daysFromNow(730)),
            agreementEvidence: "TEST signed agreement (fictional)",
            sourceReview: {
              kind: "native",
              verifiedAt: new Date(Date.now() - 60_000).toISOString(),
              cutoverAt: null,
              evidence: "TEST native record reviewed by automation",
            },
          },
        },
      );
      let appr = { status: 0, json: null };
      if (ok(prev))
        appr = await api(
          a,
          "POST",
          `/api/v1/service-obligations/${ob.json.id}/standing-reminders/approve`,
          {
            expectedVersion: prev.json.expectedVersion,
            expectedSnapshot: prev.json.expectedSnapshot,
            previewHash: prev.json.previewHash,
            confirmed: true,
          },
        );
      await a.goto(`${BASE_URL}/service`);
      await a.waitForLoadState("networkidle").catch(() => {});
      rec.record(
        company.key === "css" ? "H-C" : "P-J",
        ok(appr) ? "PASS" : "BLOCKED",
        `${company.name}: standing email reminder review: preview ${brief(prev)}; approve ${appr.status}. Dispatch stays held (outbound hold).`,
        [await shot(a, `${tag}-09-service`)],
        { company: company.name, step: "standing-reminder" },
      );
    }
  });

  // ---- Housecall Pro customer import (onboarding UI) ----
  await step("P-A", "HCP import", async () => {
    const csvPath = path.join(here, "fixtures/hcp-customers-TEST.csv");
    const before = await api(a, "GET", "/api/v1/leads?limit=200");
    const leadCountBefore = (
      Array.isArray(before.json)
        ? before.json
        : (before.json?.leads ?? before.json?.data ?? [])
    ).length;
    await a.goto(`${BASE_URL}/onboarding`);
    await a.waitForLoadState("networkidle").catch(() => {});
    const opener = a.getByText(/Housecall Pro/i).first();
    if (await opener.count()) await opener.click().catch(() => {});
    const input = a.getByLabel("Housecall Pro customer CSV", { exact: true });
    await input.waitFor({ timeout: 10000 });
    await input.setInputFiles(csvPath);
    await a
      .getByRole("button", { name: "Preview import", exact: true })
      .click();
    const previewBox = a.getByTestId("hcp-import-preview");
    await previewBox.waitFor({ timeout: 15000 });
    const previewText = await previewBox.innerText();
    const ev = [await shot(a, `${tag}-10-hcp-preview`)];
    await previewBox.getByRole("checkbox").check();
    await a
      .getByRole("button", { name: "Import customers", exact: true })
      .click();
    const doneBox = a.getByTestId("hcp-import-done");
    await doneBox.waitFor({ timeout: 15000 });
    const doneText = await doneBox.innerText();
    ev.push(await shot(a, `${tag}-11-hcp-done`));
    const after = await api(a, "GET", "/api/v1/leads?limit=200");
    const leadCountAfter = (
      Array.isArray(after.json)
        ? after.json
        : (after.json?.leads ?? after.json?.data ?? [])
    ).length;
    // Re-import same file (N-07): nothing new.
    const csv = await readFile(csvPath, "utf8");
    const again = await api(a, "POST", "/api/v1/lead-imports", {
      csv,
      mapping: {
        externalCustomerId: 0,
        firstName: 1,
        lastName: 2,
        email: 3,
        phone: 4,
      },
      fileName: "hcp-customers-TEST.csv",
      hasHeader: true,
      sourceKey: "housecall-pro",
      mode: "customers",
      dryRun: true,
    });
    const changed = csv.replace(
      "test-hcp-0001@example.invalid",
      "test-hcp-0001-changed@example.invalid",
    );
    const conflict = await api(a, "POST", "/api/v1/lead-imports", {
      csv: changed,
      mapping: {
        externalCustomerId: 0,
        firstName: 1,
        lastName: 2,
        email: 3,
        phone: 4,
      },
      fileName: "hcp-customers-TEST-changed.csv",
      hasHeader: true,
      sourceKey: "housecall-pro",
      mode: "customers",
      dryRun: true,
    });
    const caseId = company.key === "painless" ? "P-A" : "H-A";
    rec.record(
      caseId,
      /new/.test(previewText) &&
        /Imported/.test(doneText) &&
        leadCountAfter === leadCountBefore
        ? "PASS"
        : "FAIL",
      `${company.name}: synthetic HCP customer CSV via onboarding: preview "${previewText.replace(/\s+/g, " ").slice(0, 160)}"; result "${doneText.slice(0, 140)}"; lead count ${leadCountBefore}->${leadCountAfter}`,
      ev,
      {
        company: company.name,
        step: "hcp-import",
        partial:
          "Customers only. Jobs/estimates/invoices/equipment/media history not importable (G-05). Real export needs O-12/O-13 and owner approval.",
      },
    );
    rec.record(
      caseId,
      again.json?.imported === 0 && (conflict.json?.conflicts ?? 0) >= 1
        ? "PASS"
        : "FAIL",
      `${company.name}: re-import preview new=${again.json?.imported} dup=${again.json?.duplicates}; changed-email preview conflicts=${conflict.json?.conflicts} new=${conflict.json?.imported} (N-07)`,
      [],
      { company: company.name, step: "hcp-reimport" },
    );
  });

  // ---- Returning customer work (no invented lead) ----
  await step("P-F", "returning work", async () => {
    const contacts = await api(
      a,
      "GET",
      "/api/v1/contacts?search=Customer%20One",
    );
    const list = Array.isArray(contacts.json)
      ? contacts.json
      : (contacts.json?.contacts ?? contacts.json?.data ?? []);
    const matches = list.filter(
      (c) => c.email === "test-hcp-0001@example.invalid",
    );
    const imported = matches.length === 1 ? matches[0] : null;
    if (!imported) throw new Error("imported TEST customer not found");
    const leadsBefore = await api(a, "GET", "/api/v1/leads?limit=200");
    const prop = await api(a, "POST", "/api/v1/properties", {
      contactId: imported.id,
      addressLine1: "1 TEST Lane",
      city: "Testville",
      state: "NY",
      postalCode: "10001",
    });
    if (!ok(prop) || !prop.json?.id || prop.json.contactId !== imported.id)
      throw Error("returning_property_lineage");
    const est = await api(a, "POST", "/api/v1/customer-work/estimates", {
      requestId: uuid(),
      confirmed: true,
      source: {
        kind: "existing_customer",
        contactId: imported.id,
        propertyId: prop.json?.id ?? null,
      },
      title: "TEST returning-customer repair",
      lineItems: [
        {
          description: "TEST repeat repair",
          quantity: 1,
          unitPriceCents: 45000,
        },
      ],
      taxCents: 0,
      notes: "TEST",
    });
    const leadsAfter = await api(a, "GET", "/api/v1/leads?limit=200");
    const n = (r) =>
      (Array.isArray(r.json) ? r.json : (r.json?.leads ?? r.json?.data ?? []))
        .length;
    await a.goto(`${BASE_URL}/contacts/${imported.id}`);
    await a.waitForLoadState("networkidle").catch(() => {});
    rec.record(
      company.key === "painless" ? "P-F" : "H-I",
      ok(est) &&
        est.json?.estimate?.leadId == null &&
        n(leadsBefore) === n(leadsAfter)
        ? "PASS"
        : "FAIL",
      `${company.name}: returning-customer estimate on imported customer ${brief(est)}; leads ${n(leadsBefore)}->${n(leadsAfter)} (no invented lead)`,
      [await shot(a, `${tag}-12-returning-customer`)],
      { company: company.name, step: "returning-work" },
    );
  });

  await ctxA.close();
  await ctxB.close();
}

export async function runWorkday({
  inputManifest,
  runtimeSecrets,
  browserFactory = launch,
} = {}) {
  target = assertSafeTarget();
  if (inputManifest && target !== "local")
    throw Error("staging_manifest_file_required");
  manifest = inputManifest ?? (await readManifest());
  admitExecution(manifest);
  await startEvidence(manifest);
  rec = new Recorder(`workday-${target}`);
  const browser = await browserFactory();
  try {
    for (const company of manifest.companies)
      await runCompany(browser, company, runtimeSecrets);
  } finally {
    await browser.close();
    const file = await rec.save({ target });
    const counts = rec.results.reduce(
      (acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc),
      {},
    );
    console.log(JSON.stringify({ file, counts }));
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  runWorkday().catch(() => {
    console.error("ACCEPTANCE_HELD");
    process.exitCode = 1;
  });
