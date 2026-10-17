/** Native synthetic UI acceptance. Only the disposable runner may invoke this.
 * Playwright owns deterministic faults; literal Browser Harness is labeled separately.
 * No recording, tracing, saved auth, provider credentials or remote browsers. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const digest = (v) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const date = (value) => new Date(value).toISOString();
const wall = (value, zone = "America/New_York") => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(value))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};
const inventory = (o) =>
  Object.fromEntries(
    [
      "appointments",
      "projects",
      "scheduled_actions",
      "crm_tasks",
      "audit_events",
    ].map((k) => [k, o[k]]),
  );
const added = (before, after, key) =>
  after[key].filter((r) => !before[key].some((b) => b.id === r.id));

// Deliberately exact: the generic terminal acknowledgement is not a reason.
export const REFUSAL_EXPLANATIONS = Object.freeze({
  travel_conflict:
    "The original appointment conflicts with assigned staff work or the required travel gap. Acknowledge this refusal, then review a different interval or assignment.",
  company_capacity_conflict:
    "The original appointment would exceed the company reservation limit. Acknowledge this refusal, then review a different interval.",
  inspection_capacity_conflict:
    "The original appointment would exceed the inspection reservation limit. Acknowledge this refusal, then review a different interval.",
});

export async function assertVisibleRefusalReason(page, code) {
  assert.ok(
    Object.hasOwn(REFUSAL_EXPLANATIONS, code),
    "Unspecified refusal oracle",
  );
  const expected = REFUSAL_EXPLANATIONS[code];
  const reason = page.getByRole("dialog").getByText(expected, { exact: true });
  await reason.waitFor({ state: "visible", timeout: 5000 });
  await reason.scrollIntoViewIfNeeded();
  assert.equal((await reason.innerText()).trim(), expected);
  return expected;
}

export async function fillExistingSameSourceInterval(
  page,
  { contactId, propertyId, start, presetLabel, resourceLabel },
) {
  const dialog = page.getByRole("dialog");
  const assertSource = async () => {
    assert.equal(
      await dialog.getByTestId("appointment-contact").inputValue(),
      contactId,
    );
    assert.equal(
      await dialog
        .getByRole("combobox", { name: /^Property for this new appointment/ })
        .inputValue(),
      propertyId,
    );
  };
  await assertSource();
  const type = await dialog
    .getByLabel("Appointment type", { exact: true })
    .inputValue();
  // A remounted form has its own current type. Selecting type/source again
  // revokes the explicit intent; edit only the reviewed interval and resources.
  // Native fill waits for an enabled field; never force or unlock it.
  await dialog.getByLabel("Service start", { exact: true }).fill(start);
  await dialog
    .getByRole("combobox", { name: /^Duration preset/ })
    .selectOption({ label: presetLabel });
  await dialog
    .getByRole("checkbox", { name: resourceLabel, exact: true })
    .check();
  await assertSource();
  assert.equal(
    await dialog.getByLabel("Appointment type", { exact: true }).inputValue(),
    type,
  );
  return {
    type,
    start: await dialog
      .getByLabel("Service start", { exact: true })
      .inputValue(),
    end: await dialog.getByLabel("Service end", { exact: true }).inputValue(),
  };
}

export const INDEX_FONT_STYLESHEET_URL =
  "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap";
const requestBinding = [
  "requestId",
  "pageId",
  "url",
  "method",
  "phase",
  "operationId",
  "bodyHash",
];
const sameRequestBinding = (a, b) =>
  requestBinding.every((key) => a[key] === b[key]);

/** Request objects never leave this closure. Reports retain only non-auth metadata. */
export function createBrowserNetworkGate(origin) {
  const requests = new WeakMap(),
    expected = new WeakMap();
  const injections = [],
    failures = [];
  let sequence = 0;
  return {
    injections,
    failures,
    start(request, phase, pageId) {
      assert.ok(
        !requests.has(request),
        "Request start is recorded exactly once",
      );
      const url = new URL(request.url()),
        body = request.postData() ?? "";
      const entry = Object.freeze({
        requestId: `request-${++sequence}`,
        pageId,
        phase,
        url: url.href,
        path: url.pathname,
        method: request.method(),
        bodyHash: digest(body),
        operationId:
          url.origin === origin &&
          [
            "/api/v1/appointments",
            "/api/v1/scheduling/operations/reconcile",
          ].includes(url.pathname) &&
          body
            ? (JSON.parse(body).operationId ?? null)
            : null,
      });
      requests.set(request, entry);
      return entry;
    },
    get(request) {
      return requests.get(request);
    },
    inject(request, kind, proof = null) {
      const entry = requests.get(request);
      assert.ok(entry, "Injection must bind an observed Request object");
      assert.ok(
        !expected.has(request),
        "Exactly one injection per Request object",
      );
      let error, commitProof;
      if (kind === "declared-font-denial") {
        assert.equal(entry.url, INDEX_FONT_STYLESHEET_URL);
        assert.equal(entry.method, "GET");
        assert.equal(entry.bodyHash, digest(""));
        error = "net::ERR_BLOCKED_BY_CLIENT.Inspector";
      } else {
        assert.equal(kind, "proved-postcommit-abort");
        assert.equal(
          injections.filter((item) => item.kind === kind).length,
          0,
          "Only one lost ACK injection",
        );
        assert.equal(entry.url, `${origin}/api/v1/appointments`);
        assert.equal(entry.method, "POST");
        assert.equal(entry.phase, "lost-ack-same-tab-original-reconcile");
        assert.equal(proof.status, 201);
        assert.equal(proof.ack.outcome, "committed");
        assert.equal(proof.ack.operationId, entry.operationId);
        assert.equal(proof.receipt.id, entry.operationId);
        assert.equal(proof.receipt.action, "scheduling.manual_operation.v1");
        assert.equal(proof.receipt.metadata.outcome, "committed");
        assert.equal(
          proof.receipt.metadata.payloadSha256,
          proof.ack.payloadSha256,
        );
        assert.equal(proof.target.id, proof.ack.target.id);
        assert.equal(proof.target.organization_id, proof.ack.organizationId);
        commitProof = {
          status: 201,
          operationId: entry.operationId,
          targetId: proof.target.id,
          payloadSha256: proof.ack.payloadSha256,
        };
        error = "net::ERR_FAILED";
      }
      const injection = Object.freeze({
        ...entry,
        injectionId: `injection-${injections.length + 1}`,
        kind,
        error,
        ...(commitProof ? { commitProof } : {}),
      });
      expected.set(request, injection);
      injections.push(injection);
      return injection;
    },
    failed(request) {
      const entry = requests.get(request);
      const injection = expected.get(request); // Object identity, never URL-only lookup.
      const failure = {
        ...(entry ?? {
          requestId: null,
          phase: null,
          pageId: null,
          url: request.url(),
          method: request.method(),
        }),
        error: request.failure()?.errorText,
        injectionId: injection?.injectionId ?? null,
      };
      failures.push(failure);
      return failure;
    },
  };
}

/** Every failure is fatal unless one exact, deliberately injected request proves it. */
export function classifyBrowserNetwork({
  failures,
  injections,
  consoleEntries,
  responses = [],
  expectedDenials = [],
}) {
  const unclassifiedFailures = [],
    unclassifiedConsole = [],
    unmatchedInjections = [],
    unclassifiedResponses = [];
  const classifiedFailures = [],
    classifiedConsole = [],
    consumedConsoleProofs = new Set();
  for (const failure of failures) {
    const candidates = injections.filter(
      (injection) =>
        injection.injectionId === failure.injectionId &&
        sameRequestBinding(injection, failure) &&
        injection.error === failure.error,
    );
    const unique =
      failures.filter((other) => other.requestId === failure.requestId)
        .length === 1;
    if (candidates.length !== 1 || !unique) unclassifiedFailures.push(failure);
    else classifiedFailures.push({ ...failure, kind: candidates[0].kind });
  }
  for (const injection of injections)
    if (
      classifiedFailures.filter(
        (failure) => failure.injectionId === injection.injectionId,
      ).length !== 1
    )
      unmatchedInjections.push(injection);
  const expectedHttp = (response) =>
    (response.method === "POST" &&
      response.path === "/api/v1/appointments" &&
      response.status === 409 &&
      response.ack?.outcome === "no_commit_refused" &&
      response.ack.operationId === response.operationId) ||
    expectedDenials.some(
      (denial) =>
        sameRequestBinding(denial, response) &&
        response.method === "GET" &&
        response.status === 404 &&
        denial.code === "customer_workspace_not_found",
    );
  for (const response of responses)
    if (response.status >= 400 && !expectedHttp(response))
      unclassifiedResponses.push(response);
  for (const entry of consoleEntries) {
    const networkMatches = classifiedFailures.filter(
      (failure) =>
        failure.url === entry.location.url &&
        failure.phase === entry.phase &&
        failure.pageId === entry.pageId &&
        entry.text === `Failed to load resource: ${failure.error}`,
    );
    const loss = networkMatches.filter(
      (failure) => failure.kind === "proved-postcommit-abort",
    );
    const fonts = networkMatches.filter(
      (failure) =>
        failure.kind === "declared-font-denial" &&
        failure.url === INDEX_FONT_STYLESHEET_URL &&
        failure.method === "GET",
    );
    let proof;
    if (loss.length === 1) proof = loss[0];
    else if (loss.length === 0)
      proof = fonts.find(
        (failure) => !consumedConsoleProofs.has(failure.requestId),
      );
    if (!proof) {
      const httpMatches = responses.filter(
        (response) =>
          expectedHttp(response) &&
          response.phase === entry.phase &&
          response.pageId === entry.pageId &&
          response.url === entry.location.url &&
          entry.text ===
            `Failed to load resource: the server responded with a status of ${response.status} (${response.status === 409 ? "Conflict" : "Not Found"})`,
      );
      if (httpMatches.length === 1) proof = httpMatches[0];
    }
    if (!proof || consumedConsoleProofs.has(proof.requestId))
      unclassifiedConsole.push(entry);
    else {
      consumedConsoleProofs.add(proof.requestId);
      classifiedConsole.push({
        ...entry,
        requestId: proof.requestId,
        operationId: proof.operationId ?? null,
        injectionId: proof.injectionId ?? null,
      });
    }
  }
  return {
    passed: ![
      unclassifiedFailures,
      unclassifiedConsole,
      unmatchedInjections,
      unclassifiedResponses,
    ].some((items) => items.length),
    unclassifiedFailures,
    unclassifiedConsole,
    unmatchedInjections,
    unclassifiedResponses,
    classifiedFailures,
    classifiedConsole,
  };
}

export const HARNESS_UI_ASSERTION_PYTHON = `def assert_ui_state(state, expected_focus):
    assert state.get('dialogVisible') is True, 'New Appointment dialog must be visible'
    assert state.get('dialogTitle') == 'New Appointment', 'Exact new-appointment dialog required'
    assert state.get('focusVisible') is True, 'Focused control must be visible'
    assert state.get('focusInDialog') is True, 'Focus must stay inside the opened dialog'
    assert state.get('focusName') == expected_focus, 'Unexpected keyboard focus: '+str(state.get('focusName'))
`;
export const HARNESS_UI_SNAPSHOT_JS = `(() => {
  const dialog = document.querySelector('[role="dialog"]'), focused = document.activeElement;
  const visible = (element) => {
    if (!element || !element.getClientRects().length || element.closest('[hidden],[aria-hidden="true"]')) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility !== 'visible' || style.display === 'none' || style.opacity === '0') return false;
    }
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight;
  };
  return { dialogVisible: visible(dialog), dialogTitle: dialog && document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent.trim(), focusVisible: visible(focused), focusInDialog: !!dialog && dialog.contains(focused), focusName: focused && (focused.getAttribute('aria-label') || focused.textContent.trim()) };
})()`;

export function literalHarnessPython(origin) {
  assert.equal(origin, "http://127.0.0.1:4193");
  return `import json,time
${HARNESS_UI_ASSERTION_PYTHON}
new_tab(${JSON.stringify(origin + "/login")})
wait_for_load()
def find(name,role=None):
    for attempt in range(100):
        nodes=cdp('Accessibility.getFullAXTree')['nodes']
        for n in nodes:
            if n.get('name',{}).get('value')==name and (role is None or n.get('role',{}).get('value')==role): return n['backendDOMNodeId']
        time.sleep(.1)
    raise Exception('Missing AX '+name)
def click(name,role=None):
    q=cdp('DOM.getBoxModel',backendNodeId=find(name,role))['model']['content']
    click_at_xy(sum(q[0::2])/4,sum(q[1::2])/4)
click('Email','textbox')
cdp('Input.insertText',text='runtime-qa@example.invalid')
click('Password','textbox')
cdp('Input.insertText',text='Local-QA-only-2026!')
click('SIGN IN','button')
for i in range(100):
    if '/login' not in page_info().get('url',''): break
    time.sleep(.1)
wait_for_load()
assert 'LOCAL RUNTIME QA - fictional' in js('document.body.innerText')
print(json.dumps({'authenticated':True,'page':page_info()}))
cdp('Page.navigate',url=${JSON.stringify(origin + "/appointments")})
wait_for_load()
click('Schedule appointment','button')
find('New Appointment','dialog')
opened=js(${JSON.stringify(HARNESS_UI_SNAPSHOT_JS)})
assert opened['dialogVisible'] is True and opened['dialogTitle']=='New Appointment', 'Visible opened Schedule appointment dialog required'
cdp('Input.dispatchKeyEvent',type='keyDown',key='Tab',code='Tab',windowsVirtualKeyCode=9)
cdp('Input.dispatchKeyEvent',type='keyUp',key='Tab',code='Tab',windowsVirtualKeyCode=9)
forward=js(${JSON.stringify(HARNESS_UI_SNAPSHOT_JS)})
assert_ui_state(forward,'Appointment type')
print(json.dumps({'forwardAssertion':forward}))
cdp('Input.dispatchKeyEvent',type='keyDown',key='Tab',code='Tab',windowsVirtualKeyCode=9,modifiers=8)
cdp('Input.dispatchKeyEvent',type='keyUp',key='Tab',code='Tab',windowsVirtualKeyCode=9,modifiers=8)
reverse=js(${JSON.stringify(HARNESS_UI_SNAPSHOT_JS)})
assert_ui_state(reverse,'Close')
print(json.dumps({'reverseAssertion':reverse}))
`;
}

/** Counts only the explicit owned-page observation window; UUID values stay native. */
export async function countNativeUuidCallsDuring(page, action) {
  await page.evaluate(() => {
    const key = "__savedSchedulingUuidCounter";
    if (Object.hasOwn(window, key))
      throw new Error("UUID observation already active");
    const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID"),
      original = crypto.randomUUID;
    if (typeof original !== "function")
      throw new Error("Native UUID function unavailable");
    let calls = 0;
    const wrapped = function (...args) {
      calls++;
      return Reflect.apply(original, this, args);
    };
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      writable: true,
      value: wrapped,
    });
    window[key] = () => {
      const wrapperUnchanged = crypto.randomUUID === wrapped;
      if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
      else delete crypto.randomUUID;
      delete window[key];
      return {
        calls,
        wrapperUnchanged,
        restored: crypto.randomUUID === original,
      };
    };
  });
  let observation;
  try {
    await action();
  } finally {
    observation = await page.evaluate(() =>
      window.__savedSchedulingUuidCounter(),
    );
    assert.equal(observation.wrapperUnchanged, true);
    assert.equal(
      observation.restored,
      true,
      "Native UUID function restored in finally",
    );
  }
  return observation;
}

export async function runSavedSchedulingBrowserQA(options) {
  const {
    origin,
    manifest: m,
    observe,
    reportDir,
    ownedSentinel,
    assertFictional,
    scopeSwitchOnly = false,
  } = options;
  assert.equal(ownedSentinel, "saved-scheduling-local-only");
  assert.equal(origin, "http://127.0.0.1:4193");
  const { chromium } = createRequire(
    path.join(
      os.homedir(),
      "AppData/Roaming/npm/node_modules/@playwright/cli/package.json",
    ),
  )("playwright");
  const report = {
    runId: m.runId,
    mode: scopeSwitchOnly
      ? "FOCUSED scope-switch-only; not full matrix, literal Harness or Task12 acceptance"
      : "full-matrix",
    engine: "owned Playwright context",
    browserTimezone: "America/Los_Angeles",
    phases: [],
    mutations: [],
    schedulingReads: [],
    responses: [],
    console: [],
    pageerrors: [],
    requestfailed: [],
    layouts: [],
    cleanup: {},
    findings: [],
    limitations: [
      "PGlite single-backend UI proof, not native multi-session races",
      "Direct-customer source only; native suites own full source protocols",
      "No provider delivery, hosted migration, deployment or launch proof",
    ],
  };
  let browser,
    context,
    settings,
    phase = "login",
    fault = null,
    currentPolicy = null;
  let actorKey = "primary";
  const scopePhases = new Set([
    "scope-switch-sameOrganization",
    "scope-switch-otherOrganization",
    "scope-switch-primary",
  ]);
  const expectedDenials = [];
  const networkGate = createBrowserNetworkGate(origin),
    pending = new Set();
  let pageSequence = 0;
  const pageIds = new WeakMap();
  const identifyPage = (page) => {
    if (!pageIds.has(page)) pageIds.set(page, `page-${++pageSequence}`);
    return pageIds.get(page);
  };
  report.networkInjections = networkGate.injections;
  const allow = new Set([
    "POST /api/auth/login",
    "POST /api/auth/logout",
    "PUT /api/v1/settings/scheduling-policy",
    "POST /api/v1/appointments",
    "POST /api/v1/scheduling/operations/reconcile",
    "POST /api/v1/scheduling/conflict-explanation",
    "PUT /api/v1/settings",
    `PATCH /api/v1/platform/orgs/${m.organizationId}`,
  ]);
  const saveEvidence = async (name, value) =>
    writeFile(
      path.join(reportDir, `${name}.json`),
      JSON.stringify(value, null, 2),
    );
  const recordFinding = (name, error) =>
    report.findings.push({
      phase: name,
      message: error.message,
      stack: error.stack,
    });
  async function settled(page) {
    await page.waitForLoadState("networkidle");
    await Promise.all([...pending]);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  }
  async function guard(page) {
    await settled(page);
    const expected = m.actors[actorKey];
    await assertFictional(actorKey);
    const me = await page.evaluate(async () => {
      const response = await fetch("/api/v1/me", {
        credentials: "include",
        cache: "no-store",
      });
      return { status: response.status, profile: await response.json() };
    });
    assert.equal(me.status, 200);
    const p = me.profile;
    assert.equal(p.id, expected.actorUserId);
    assert.equal(p.email, expected.email);
    assert.equal(p.organization.id, expected.organizationId);
    assert.equal(p.organization.slug, expected.slug);
    assert.equal(p.role, "owner");
    assert.equal(p.isActive, true);
    return p; /* Platform-admin is verified by the exact DB actor guard; /me does not expose it. */
  }
  const count = (pathName, method = "POST") =>
    report.mutations.filter((x) => x.path === pathName && x.method === method)
      .length;
  async function login(page, key) {
    assert.ok(Object.hasOwn(m.actors, key));
    actorKey = key;
    await assertFictional(key);
    const before = count("/api/auth/login");
    await page.goto(`${origin}/login`);
    await page
      .getByPlaceholder("Email", { exact: true })
      .fill(m.actors[key].email);
    await page
      .getByPlaceholder("Password", { exact: true })
      .fill("Local-QA-only-2026!");
    await page.getByRole("button", { name: "SIGN IN", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.includes("/login"));
    const profile = await guard(page);
    assert.equal(count("/api/auth/login"), before + 1);
    return profile;
  }
  async function custody(page, operationId) {
    const prefix = `growthos.scheduling.pending.v1:${m.organizationId}:${m.actorUserId}:appointment_create:`;
    const entries = await page.evaluate(
      ({ prefix, operationId }) =>
        Object.keys(sessionStorage)
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key, bytes: sessionStorage.getItem(key) }))
          .filter(
            (entry) =>
              JSON.parse(entry.bytes).command.operationId === operationId,
          ),
      { prefix, operationId },
    );
    assert.equal(
      entries.length,
      1,
      "Exact original scheduling custody retained",
    );
    return { ...entries[0], bytesSha256: digest(entries[0].bytes) };
  }
  async function scopeSwitches(page, original) {
    const originalPhase = phase;
    const retained = await custody(page, original.wire.operationId);
    const parsed = JSON.parse(retained.bytes);
    assert.equal(parsed.ack, null);
    assert.equal(parsed.organizationId, m.organizationId);
    assert.equal(parsed.actorUserId, m.actorUserId);
    assert.equal(
      parsed.payloadSha256,
      original.body.schedulingOperation.payloadSha256,
    );
    assert.equal(parsed.command.operationId, original.wire.operationId);
    const schedulingKeys = await page.evaluate(() =>
      Object.keys(sessionStorage)
        .filter((key) => key.startsWith("growthos.scheduling.pending.v1:"))
        .sort(),
    );
    const before = await options.observeAuth();
    const postCount = count("/api/v1/appointments"),
      reconcileCount = count("/api/v1/scheduling/operations/reconcile");
    const transitions = [];
    for (const next of ["sameOrganization", "otherOrganization", "primary"]) {
      phase = `scope-switch-${next}`;
      await guard(page);
      const previous = actorKey,
        logoutCount = count("/api/auth/logout");
      const logout = await page.evaluate(async () => {
        const r = await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "include",
        });
        return { status: r.status, body: await r.json() };
      });
      assert.deepEqual(logout, { status: 200, body: { success: true } });
      await settled(page);
      assert.equal(count("/api/auth/logout"), logoutCount + 1);
      const signedOut = await options.observeAuth();
      assert.equal(
        signedOut[previous].sessionCount,
        0,
        "Actual old session revoked",
      );
      await login(page, next);
      await page.goto(`${origin}/appointments`);
      await guard(page);
      assert.deepEqual(
        await custody(page, original.wire.operationId),
        retained,
      );
      await page
        .getByRole("button", { name: "Schedule appointment", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      if (next !== "otherOrganization") {
        await dialog
          .getByTestId("appointment-contact")
          .selectOption(m.contactId);
        if (next === "sameOrganization")
          await dialog
            .getByRole("combobox", {
              name: /^Property for this new appointment/,
            })
            .selectOption(m.propertyId);
      }
      await settled(page);
      if (next === "primary") {
        await dialog
          .getByText("Original appointment result is unknown.", {
            exact: false,
          })
          .waitFor();
        assert.equal(
          await dialog
            .getByRole("button", {
              name: "Reconcile original appointment",
              exact: true,
            })
            .isEnabled(),
          true,
        );
        const positive = await page.evaluate(async (id) => {
          const response = await fetch(`/api/v1/appointments/${id}`, {
            credentials: "include",
            cache: "no-store",
          });
          return { status: response.status, body: await response.json() };
        }, original.body.id);
        assert.equal(positive.status, 200);
        assert.ok(JSON.stringify(positive.body).includes(original.body.id));
        await saveEvidence("scope-original-positive-readback", positive);
      } else {
        const text = await dialog.innerText();
        assert.ok(
          !text.includes("Original appointment result is unknown."),
          "Other actor cannot render original pending operation",
        );
        assert.equal(
          await dialog
            .getByRole("button", {
              name: "Reconcile original appointment",
              exact: true,
            })
            .count(),
          0,
        );
        assert.ok(!text.includes(original.wire.operationId));
        assert.equal(
          await dialog.getByTestId("appointment-contact").isDisabled(),
          false,
        );
        assert.notEqual(
          await dialog
            .getByLabel("Service start", { exact: true })
            .inputValue(),
          wall(original.wire.scheduledStart),
          "Other actor does not reuse private pending interval",
        );
        if (next === "otherOrganization") {
          const visible = await page.locator("body").innerText();
          for (const privateValue of [
            m.contactId,
            m.propertyId,
            original.body.id,
            "FICTIONAL SCHEDULING CUSTOMER",
            "12 FICTIONAL Scheduling Lane",
          ])
            assert.ok(
              !visible.includes(privateValue),
              "Foreign org cannot render original source or target",
            );
          assert.equal(
            await dialog
              .getByTestId("appointment-contact")
              .locator(`option[value="${m.contactId}"]`)
              .count(),
            0,
          );
          const targetPath = `/api/v1/appointments/${original.body.id}`;
          const deniedResponse = page.waitForResponse(
            (response) =>
              response.request().method() === "GET" &&
              response.url() === `${origin}${targetPath}`,
          );
          const denial = await page.evaluate(async (path) => {
            const r = await fetch(path, {
              credentials: "include",
              cache: "no-store",
            });
            return { status: r.status, body: await r.json() };
          }, targetPath);
          assert.deepEqual(denial, {
            status: 404,
            body: {
              code: "customer_workspace_not_found",
              error:
                "This customer or work record is unavailable in your company.",
            },
          });
          expectedDenials.push({
            ...networkGate.get((await deniedResponse).request()),
            status: 404,
            code: denial.body.code,
          });
          await saveEvidence("scope-foreign-target-denial", {
            phase,
            method: "GET",
            path: targetPath,
            ...denial,
            meaning: "Tenant privacy denial only; never no-commit proof",
          });
        }
      }
      assert.deepEqual(
        await custody(page, original.wire.operationId),
        retained,
      );
      assert.deepEqual(
        await page.evaluate(() =>
          Object.keys(sessionStorage)
            .filter((key) => key.startsWith("growthos.scheduling.pending.v1:"))
            .sort(),
        ),
        schedulingKeys,
        "Identity switches do not mint another pending operation",
      );
      assert.equal(count("/api/v1/appointments"), postCount);
      assert.equal(
        count("/api/v1/scheduling/operations/reconcile"),
        reconcileCount,
      );
      const after = await observe({
        operationId: original.wire.operationId,
        targetId: original.body.id,
      });
      assert.deepEqual(
        inventory(after),
        inventory(original.after),
        "Identity switches do not alter scheduling effects",
      );
      const auth = await options.observeAuth();
      for (const key of Object.keys(m.actors)) {
        assert.equal(auth[key].sessionCount, key === next ? 1 : 0);
        assert.deepEqual(
          auth[key].auditIdentities,
          before[key].auditIdentities,
          "Native login/logout adds no audit effects",
        );
      }
      transitions.push({
        phase,
        previous,
        current: next,
        logout,
        auth,
        custody: retained,
        schedulingInventorySha256: digest(inventory(after)),
        appointmentPostCount: postCount,
        reconcileCount,
      });
    }
    phase = originalPhase;
    await saveEvidence("scope-switch-proof", {
      before,
      retained,
      transitions,
      noSchedulingMutationDuringSwitches: true,
    });
  }
  async function checkpoint(name, fn) {
    phase = name;
    console.log(`Saved scheduling browser: ${name}`);
    const findingStart = report.findings.length;
    const entry = {
      name,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    report.phases.push(entry);
    try {
      await fn();
      entry.status =
        report.findings.length === findingStart
          ? "passed"
          : "failed-assertions";
    } catch (e) {
      entry.status = "failed";
      recordFinding(name, e);
      throw e;
    } finally {
      entry.finishedAt = new Date().toISOString();
      await saveEvidence("browser-report", report);
    }
  }
  async function layouts(page, name) {
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({
        width,
        height: width === 1440 ? 1000 : 844,
      });
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const box = await page.evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
      report.layouts.push({ name, width, ...box });
      try {
        assert.ok(
          box.document <= width + 1 && box.body <= width + 1,
          `${name}: horizontal overflow at ${width}: ${JSON.stringify(box)}`,
        );
      } catch (e) {
        recordFinding(name, e);
      }
      await page.screenshot({
        path: path.join(reportDir, `${name}-${width}.png`),
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  async function keyboard(page, name) {
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Close", exact: true }).focus();
    const steps = [];
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      const item = await page.evaluate(() => {
        const e = document.activeElement;
        return {
          tag: e.tagName,
          label:
            e.getAttribute("aria-label") ||
            e.labels?.[0]?.innerText ||
            e.innerText,
          disabled: e.matches(":disabled"),
          visible: e.getBoundingClientRect().width > 0,
        };
      });
      steps.push(item);
      if (item.label === "Close") break;
    }
    assert.ok(
      steps.every((s) => s.visible && !s.disabled),
      "Keyboard focuses only enabled visible controls",
    );
    assert.ok(
      steps.some((s) => String(s.label).includes("Review interval")),
      "Keyboard reaches explicit review",
    );
    await page.keyboard.press("Shift+Tab");
    report.layouts.push({
      name,
      keyboard: steps,
      reverseFocus: await page.evaluate(
        () => document.activeElement.textContent,
      ),
    });
  }
  async function newForm() {
    const page = await context.newPage();
    await page.goto(`${origin}/appointments`);
    await guard(page);
    await page
      .getByRole("button", { name: "Schedule appointment", exact: true })
      .click();
    const d = page.getByRole("dialog");
    await d.getByTestId("appointment-contact").selectOption(m.contactId);
    await d
      .getByRole("combobox", { name: /^Property for this new appointment/ })
      .selectOption(m.propertyId);
    await settled(page);
    return page;
  }
  async function fill(
    page,
    {
      start,
      end,
      type = "other",
      resource = 0,
      preset = true,
      occurrence,
    } = {},
  ) {
    const d = page.getByRole("dialog");
    await d.getByLabel("Appointment type", { exact: true }).selectOption(type);
    await settled(page);
    await d.getByLabel("Service start", { exact: true }).fill(start);
    if (occurrence)
      await d
        .getByRole("combobox", { name: /^Service start occurrence/ })
        .selectOption({ index: occurrence });
    if (preset)
      await d
        .getByRole("combobox", { name: /^Duration preset/ })
        .selectOption({ label: "FICTIONAL one hour · 60 elapsed minutes" });
    else if (end) await d.getByLabel("Service end", { exact: true }).fill(end);
    if (resource !== null)
      await d
        .getByRole("checkbox", {
          name: m.resources[resource].label,
          exact: true,
        })
        .check();
    await settled(page);
  }
  async function review(page) {
    await page
      .getByRole("button", { name: "Review interval", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save Appt", exact: true })
      .waitFor({ state: "visible" });
    assert.equal(
      await page
        .getByRole("button", { name: "Save Appt", exact: true })
        .isEnabled(),
      true,
    );
  }
  function assertAck(ack, wire, expected) {
    assert.equal(ack.organizationId, m.organizationId);
    assert.equal(ack.actorUserId, m.actorUserId);
    assert.equal(ack.operationId, wire.operationId);
    assert.equal(ack.kind, "appointment_create");
    assert.equal(ack.outcome, expected);
    assert.deepEqual(ack.source, wire.schedulingReview.context.source);
    assert.equal(ack.source.sourceKind, "direct_customer");
    assert.equal(ack.source.contactId, m.contactId);
    assert.equal(ack.source.propertyId, m.propertyId);
    assert.match(ack.payloadSha256, /^[a-f0-9]{64}$/);
  }
  function assertEffects(before, after, body, wire, refusal) {
    for (const key of [
      "appointments",
      "projects",
      "scheduled_actions",
      "crm_tasks",
      "audit_events",
    ])
      for (const row of before[key])
        assert.deepEqual(
          after[key].find((r) => r.id === row.id),
          row,
          `Existing ${key} row remains unchanged`,
        );
    const ack = body.schedulingOperation;
    assertAck(ack, wire, refusal ? "no_commit_refused" : "committed");
    assert.equal(after.receipt.length, 1);
    const receipt = after.receipt[0];
    assert.equal(receipt.id, wire.operationId);
    assert.equal(receipt.action, "scheduling.manual_operation.v1");
    assert.equal(receipt.actor_user_id, m.actorUserId);
    assert.equal(receipt.metadata.payloadSha256, ack.payloadSha256);
    assert.equal(receipt.metadata.outcome, ack.outcome);
    assert.deepEqual(added(before, after, "projects"), []);
    assert.deepEqual(added(before, after, "crm_tasks"), []);
    const audits = added(before, after, "audit_events");
    if (refusal) {
      assert.equal(ack.refusalCode, refusal);
      assert.equal(ack.target, null);
      assert.deepEqual(added(before, after, "appointments"), []);
      assert.deepEqual(added(before, after, "scheduled_actions"), []);
      assert.deepEqual(audits.map((r) => r.action).sort(), [
        "scheduling.manual_operation.v1",
        "scheduling.operation_refused.v1",
      ]);
      assert.equal(
        audits.find((r) => r.action === "scheduling.operation_refused.v1")
          .metadata.reason,
        refusal,
      );
    } else {
      assert.equal(ack.target.id, body.id);
      assert.equal(ack.target.available, true);
      const targets = added(before, after, "appointments");
      assert.equal(targets.length, 1);
      assert.equal(targets[0].id, body.id);
      assert.equal(after.target.length, 1);
      assert.equal(date(targets[0].scheduled_start), date(wire.scheduledStart));
      assert.equal(date(targets[0].scheduled_end), date(wire.scheduledEnd));
      assert.deepEqual(
        targets[0].scheduling_reservation,
        body.schedulingReservation,
      );
      assert.deepEqual(audits.map((r) => r.action).sort(), [
        "scheduling.manual_operation.v1",
        "scheduling.reservation_transition.v1",
      ]);
      assert.ok(audits.every((r) => r.entity_id === body.id));
      const reminders = added(before, after, "scheduled_actions");
      const expectedReminder =
        Date.parse(wire.scheduledStart) - Date.now() > 2 * 3600000;
      assert.equal(reminders.length, expectedReminder ? 1 : 0);
      for (const r of reminders) {
        assert.equal(r.action.type, "appointment_reminder");
        assert.equal(r.context.event, "appointment.reminder");
        assert.equal(r.context.appointmentId, body.id);
        assert.equal(r.context.contactId, m.contactId);
        assert.equal(
          r.context.fields["appointment.scheduledStart"],
          date(wire.scheduledStart),
        );
        assert.equal(r.status, "pending");
      }
    }
  }
  async function submit(page, { refusal = null, lost = false } = {}) {
    await guard(page);
    const before = await observe(),
      prior = count("/api/v1/appointments");
    await review(page);
    if (lost) fault = { before, completed: null };
    const waiting = lost
      ? null
      : page.waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            new URL(r.url()).pathname === "/api/v1/appointments",
        );
    await page.getByRole("button", { name: "Save Appt", exact: true }).click();
    let response, body, wire;
    if (lost) {
      await page
        .getByText("Original appointment result is unknown.", { exact: false })
        .waitFor();
      assert.ok(fault.completed);
      ({ body, wire } = fault.completed);
    } else {
      response = await waiting;
      assert.equal(response.status(), refusal ? 409 : 201);
      body = await response.json();
      wire = response.request().postDataJSON();
    }
    await settled(page);
    assert.equal(
      count("/api/v1/appointments"),
      prior + 1,
      "Exactly one intentional create POST",
    );
    const after = await observe({
      operationId: wire.operationId,
      targetId: body.id ?? null,
    });
    assertEffects(before, after, body, wire, refusal);
    await saveEvidence(`${phase}-${wire.operationId}-effects`, {
      before,
      after,
      wire,
      body,
    });
    if (refusal) {
      await page
        .getByText(
          "Original appointment was refused with authoritative no-commit proof.",
          { exact: false },
        )
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Save Appt", exact: true })
          .isDisabled(),
        true,
      );
      const code = body.schedulingOperation.refusalCode; // assertEffects bound this ACK to the exact original.
      try {
        const visibleReason = await assertVisibleRefusalReason(page, code);
        await saveEvidence(`${phase}-${wire.operationId}-refusal-ui`, {
          operationId: wire.operationId,
          payloadSha256: body.schedulingOperation.payloadSha256,
          refusalCode: code,
          visibleReason,
        });
        await page.screenshot({
          path: path.join(
            reportDir,
            `${phase}-${wire.operationId}-refusal-ui.png`,
          ),
        });
      } catch (error) {
        recordFinding(
          phase,
          new Error(
            `Refusal UI assertion failed for original ${wire.operationId}, code ${code}: expected its exact visible typed explanation. ${error.message}`,
          ),
        );
      }
    } else if (!lost)
      await page
        .getByText("Original appointment committed.", { exact: false })
        .waitFor();
    return { page, body, wire, before, after };
  }
  async function create(config, behavior) {
    const p = await newForm();
    await fill(p, config);
    return submit(p, behavior);
  }
  async function repeatAfterReconcile(page, original) {
    await guard(page);
    await page
      .getByText("Original appointment committed.", { exact: false })
      .waitFor();
    const prior = await custody(page, original.wire.operationId);
    const storedOriginal = JSON.parse(prior.bytes);
    assert.deepEqual(storedOriginal.ack, original.body.schedulingOperation);
    assert.equal(storedOriginal.ack.outcome, "committed");
    const before = await observe({
      operationId: original.wire.operationId,
      targetId: original.body.id,
    });
    const createCount = count("/api/v1/appointments"),
      reconcileCount = count("/api/v1/scheduling/operations/reconcile");
    const newIntent = page.getByRole("button", {
      name: "Start a new appointment",
      exact: true,
    });
    assert.equal(
      await newIntent.count(),
      1,
      "PRODUCT RED: known committed original has no explicit same-source new-appointment intent",
    );
    assert.equal(
      await newIntent.isEnabled(),
      true,
      "PRODUCT RED: known committed original permanently holds another intentional same-source booking",
    );
    const uuidObservation = await countNativeUuidCallsDuring(page, async () => {
      await newIntent.click();
      await settled(page);
    });
    assert.equal(
      uuidObservation.calls,
      0,
      "Explicit new-intent click/settle generates no UUID",
    );
    assert.equal(
      count("/api/v1/appointments"),
      createCount,
      "New-intent click has no create transport",
    );
    assert.equal(
      count("/api/v1/scheduling/operations/reconcile"),
      reconcileCount,
    );
    assert.deepEqual(
      await custody(page, original.wire.operationId),
      prior,
      "New-intent click cannot replace original custody/UUID/ACK",
    );
    const dialog = page.getByRole("dialog");
    assert.equal(
      await dialog.getByTestId("appointment-contact").inputValue(),
      m.contactId,
    );
    assert.equal(
      await dialog
        .getByRole("combobox", { name: /^Property for this new appointment/ })
        .inputValue(),
      m.propertyId,
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "Save Appt", exact: true })
        .isEnabled(),
      false,
      "Old interval review cannot authorize a new booking",
    );
    const repeatFields = await fillExistingSameSourceInterval(page, {
      contactId: m.contactId,
      propertyId: m.propertyId,
      start: "2026-10-30T09:00",
      presetLabel: "FICTIONAL one hour · 60 elapsed minutes",
      resourceLabel: m.resources[0].label,
    });
    await settled(page);
    assert.equal(count("/api/v1/appointments"), createCount);
    assert.deepEqual(await custody(page, original.wire.operationId), prior);
    const next = await submit(page); // Explicit fresh Review interval, then one Save.
    assert.equal(next.wire.type, repeatFields.type);
    assert.equal(next.body.type, repeatFields.type);
    assert.equal(next.after.target[0].type, repeatFields.type);
    assert.notEqual(next.wire.operationId, original.wire.operationId);
    assert.ok(
      !storedOriginal.retiredOperationIds.includes(next.wire.operationId),
    );
    assert.notEqual(next.body.id, original.body.id);
    assert.deepEqual(
      next.wire.schedulingReview.context.source,
      original.wire.schedulingReview.context.source,
    );
    assert.notEqual(next.wire.scheduledStart, original.wire.scheduledStart);
    assert.equal(count("/api/v1/appointments"), createCount + 1);
    assert.equal(
      count("/api/v1/scheduling/operations/reconcile"),
      reconcileCount,
    );
    const nextCustody = await custody(page, next.wire.operationId),
      storedNext = JSON.parse(nextCustody.bytes);
    assert.equal(
      nextCustody.key,
      prior.key,
      "Same actor/company/customer/property custody namespace",
    );
    assert.ok(
      storedNext.retiredOperationIds.includes(original.wire.operationId),
    );
    assert.ok(!storedNext.retiredOperationIds.includes(next.wire.operationId));
    assert.deepEqual(storedNext.ack, next.body.schedulingOperation);
    const originalAfter = await observe({
      operationId: original.wire.operationId,
      targetId: original.body.id,
    });
    assert.deepEqual(originalAfter.target, before.target);
    assert.deepEqual(originalAfter.receipt, before.receipt);
    assertEffects(before, next.after, next.body, next.wire, null);
    await saveEvidence("known-commit-repeat-same-source", {
      before,
      originalCustody: prior,
      originalAck: storedOriginal.ack,
      nextWire: next.wire,
      nextAck: next.body.schedulingOperation,
      nextCustody,
      after: next.after,
      originalAfter,
      createCountBefore: createCount,
      createCountAfter: count("/api/v1/appointments"),
      reconcileCount,
      uuidObservation,
      repeatFields,
    });
  }
  async function policy({ gap, enabled = true, cap = null }) {
    phase = `policy-${enabled ? gap : "disabled"}-cap-${cap}`;
    await settings.goto(`${origin}/settings`);
    await guard(settings);
    await settings
      .getByRole("tab", { name: "Scheduling", exact: true })
      .click();
    const panel = settings.locator('[aria-label="Scheduling policy"]');
    await panel
      .getByLabel("Minimum travel gap (minutes)", { exact: true })
      .waitFor();
    await panel
      .getByRole("button", { name: "Refresh scheduling settings", exact: true })
      .click();
    await settled(settings);
    const toggle = panel.getByRole("switch", {
      name: "Enable scheduling policy",
      exact: true,
    });
    if ((await toggle.getAttribute("aria-checked")) !== String(enabled))
      await toggle.click();
    await panel
      .getByLabel("Minimum travel gap (minutes)", { exact: true })
      .fill(String(gap));
    await panel
      .getByLabel("Company concurrent reservation limit", { exact: true })
      .fill(cap === null ? "" : String(cap));
    if (!currentPolicy) {
      await panel
        .getByRole("button", { name: "Add duration preset", exact: true })
        .click();
      await panel
        .getByLabel("Preset 1 label", { exact: true })
        .fill("FICTIONAL one hour");
      await panel
        .getByLabel("Preset 1 elapsed minutes", { exact: true })
        .fill("60");
    }
    await guard(settings);
    const prior = count("/api/v1/settings/scheduling-policy", "PUT");
    const responsePromise = settings.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        r.url().endsWith("/api/v1/settings/scheduling-policy"),
    );
    await panel
      .getByRole("button", { name: "Save scheduling settings", exact: true })
      .click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    const saved = await response.json();
    assert.equal(saved.policy.revision, (currentPolicy?.revision ?? 0) + 1);
    assert.equal(saved.policy.minimumTravelGapMinutes, gap);
    assert.equal(saved.policy.enabled, enabled);
    assert.equal(saved.policy.maxConcurrentReservations, cap);
    if (currentPolicy)
      assert.equal(
        saved.policy.durationPresets[0].id,
        currentPolicy.durationPresets[0].id,
      );
    currentPolicy = saved.policy;
    await settled(settings);
    assert.equal(count("/api/v1/settings/scheduling-policy", "PUT"), prior + 1);
    await panel
      .getByRole("button", { name: "Refresh scheduling settings", exact: true })
      .click();
    await settled(settings);
    const actual = await observe();
    assert.deepEqual(actual.settings[0].scheduling_policy, currentPolicy);
    await saveEvidence(`policy-revision-${currentPolicy.revision}`, {
      saved,
      readback: actual.settings,
    });
    return saved;
  }
  async function persisted(result, name) {
    const p = await context.newPage();
    await p.goto(
      `${origin}/appointments?appointmentId=${result.body.id}&organizationId=${m.organizationId}`,
    );
    await settled(p);
    const region = p.getByRole("region", {
      name: "Selected appointment",
      exact: true,
    });
    await region
      .getByRole("button", { name: "Show this day in schedule", exact: true })
      .click();
    await settled(p);
    assert.equal(
      await p.getByLabel("Start date", { exact: true }).inputValue(),
      wall(
        result.wire.scheduledStart,
        (await assertFictional()).timezone,
      ).slice(0, 10),
    );
    await region
      .getByRole("group", { name: "Scheduling reservation", exact: true })
      .waitFor();
    const summary = region.getByRole("group", {
      name: "Scheduling reservation",
      exact: true,
    });
    const times = await summary
      .locator("time")
      .evaluateAll((es) => es.map((e) => e.dateTime));
    assert.deepEqual(times.map(date), [
      date(result.wire.scheduledStart),
      date(result.wire.scheduledEnd),
    ]);
    const snapshot = result.after.target[0].scheduling_reservation;
    assert.ok(
      (await summary.innerText()).includes(
        `Saved travel gap: ${snapshot.minimumTravelGapMinutes} minutes`,
      ),
    );
    assert.ok(
      (await summary.innerText()).includes(snapshot.sourcePolicyDigest),
    );
    assert.ok(
      (await summary.innerText()).includes(
        "Approved company zone: America/New_York (historical)",
      ),
    );
    const fresh = await observe({ targetId: result.body.id });
    assert.deepEqual(fresh.target[0], result.after.target[0]);
    await saveEvidence(`${name}-persisted`, {
      url: p.url(),
      text: await summary.innerText(),
      times,
      target: fresh.target,
    });
    return p;
  }
  try {
    const indexSource = await readFile(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../artifacts/command-center/index.html",
      ),
      "utf8",
    );
    assert.ok(
      indexSource.includes(
        `href="${INDEX_FONT_STYLESHEET_URL}" rel="stylesheet"`,
      ),
      "Only the exact current index-declared font URL may be denied as expected",
    );
    browser = await chromium.launch({
      executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: true,
      env: options.cleanEnv,
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      timezoneId: report.browserTimezone,
    });
    context.on("page", (page) => {
      const pageId = identifyPage(page);
      page.on("pageerror", (e) =>
        report.pageerrors.push({ phase, message: e.message }),
      );
      page.on("console", (msg) => {
        if (msg.type() === "error")
          report.console.push({
            phase,
            pageId,
            text: msg.text(),
            location: msg.location(),
          });
      });
    });
    context.on("request", (req) => {
      let pageId = "non-page-request";
      try {
        pageId = identifyPage(req.frame().page());
      } catch {
        /* Context-wide capture retains worker/non-page failures too. */
      }
      const started = networkGate.start(req, phase, pageId);
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) {
        const url = new URL(req.url()),
          isLogin = url.pathname === "/api/auth/login";
        const entry = {
          ...started,
          ...(isLogin ? { syntheticEmail: m.actors[actorKey].email } : {}),
        };
        if (req.method() === "POST" && url.pathname === "/api/v1/scheduling/conflict-explanation") report.schedulingReads.push(entry);
        else report.mutations.push(entry);
      }
    });
    context.on("requestfailed", (req) =>
      report.requestfailed.push(networkGate.failed(req)),
    );
    context.on("response", (response) => {
      const task = (async () => {
        const req = response.request();
        if (
          response.status() >= 400 ||
          !["GET", "HEAD", "OPTIONS"].includes(req.method())
        ) {
          const entry = {
            ...networkGate.get(req),
            status: response.status(),
          };
          if (
            entry.path === "/api/v1/appointments" ||
            entry.path.endsWith("/reconcile")
          ) {
            const data = await response.json().catch(() => null);
            entry.code = data?.code;
            entry.ack =
              data?.schedulingOperation ??
              (entry.path.endsWith("/reconcile") ? data : null);
          }
          report.responses.push(entry);
        }
      })();
      pending.add(task);
      task.finally(() => pending.delete(task));
    });
    await context.route("**/*", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (req.url() === INDEX_FONT_STYLESHEET_URL && req.method() === "GET") {
        networkGate.inject(req, "declared-font-denial");
        return route.abort("blockedbyclient");
      }
      if (url.origin !== origin) {
        report.findings.push({
          phase,
          message: `Blocked non-loopback browser request ${url.origin}${url.pathname}`,
        });
        return route.abort("blockedbyclient");
      }
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method()) &&
        !allow.has(`${req.method()} ${url.pathname}`)
      ) {
        report.findings.push({
          phase,
          message: `Unapproved mutation ${req.method()} ${url.pathname}`,
        });
        return route.abort("blockedbyclient");
      }
      if (req.method() === "PATCH") {
        assert.equal(phase, "company-zone-history");
        assert.equal(url.pathname, `/api/v1/platform/orgs/${m.organizationId}`);
        assert.deepEqual(req.postDataJSON(), {
          timezone: "America/Los_Angeles",
          expectedTimeZone: "America/New_York",
        });
      }
      if (req.method() === "POST" && url.pathname === "/api/auth/logout") {
        assert.ok(
          scopePhases.has(phase),
          "Logout only in fixed synthetic switch phases",
        );
        assert.equal(req.postData(), null, "Native logout has no body");
      }
      if (req.method() === "POST" && url.pathname === "/api/auth/login") {
        assert.ok(
          phase === "fictional-login-null-policy" || scopePhases.has(phase),
        );
        assert.deepEqual(req.postDataJSON(), {
          email: m.actors[actorKey].email,
          password: "Local-QA-only-2026!",
        });
      }
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method()) &&
        !["/api/auth/login", "/api/auth/logout", "/api/v1/scheduling/conflict-explanation"].includes(url.pathname)
      )
        assert.equal(
          actorKey,
          "primary",
          "Only primary fixture owner may mutate scheduling/configuration",
        );
      if (req.method() === "PUT" && url.pathname === "/api/v1/settings") {
        assert.equal(phase, "inspection-zone-history");
        assert.deepEqual(req.postDataJSON(), {
          inspectionAvailability: {
            timezone: "America/Denver",
            days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
            windows: [{ startHour: 0, endHour: 24 }],
            maxBookingsPerWindow: 1,
            blackoutDates: [],
          },
        });
      }
      if (
        fault &&
        req.method() === "POST" &&
        url.pathname === "/api/v1/appointments"
      ) {
        const active = fault;
        assert.equal(active.completed, null, "Only one fault-forwarded POST");
        const real = await route.fetch({ maxRetries: 0, maxRedirects: 0 });
        assert.equal(real.status(), 201);
        const body = await real.json(),
          wire = req.postDataJSON();
        const after = await observe({
          operationId: wire.operationId,
          targetId: body.id,
        });
        assertEffects(active.before, after, body, wire, null);
        active.completed = { body, wire, after };
        report.responses.push({
          ...networkGate.get(req),
          status: 201,
          operationId: wire.operationId,
          ack: body.schedulingOperation,
          deliberatelyWithheld: true,
        });
        networkGate.inject(req, "proved-postcommit-abort", {
          status: real.status(),
          ack: body.schedulingOperation,
          receipt: after.receipt[0],
          target: after.target[0],
        });
        await route.abort("failed");
        return;
      }
      return route.continue();
    });
    settings = await context.newPage();
    await checkpoint("fictional-login-null-policy", async () => {
      const profile = await login(settings, "primary");
      assert.equal(profile.organization.timezone, m.companyZone);
      const initial = await observe();
      assert.equal(initial.settings[0].scheduling_policy, null);
      assert.deepEqual(inventory(initial), {
        appointments: [],
        projects: [],
        scheduled_actions: [],
        crm_tasks: [],
        audit_events: [],
      });
      assert.equal(
        initial.automations.length,
        0,
        "No automation rule means booked event has no rule effects",
      );
      await saveEvidence("initial", {
        profile: {
          id: profile.id,
          role: profile.role,
          isActive: profile.isActive,
          organization: profile.organization,
        },
        initial,
      });
    });
    await checkpoint("policy-first-save", async () => {
      await policy({ gap: 60 });
      await layouts(settings, "settings");
    });
    const baselines = [];
    if (!scopeSwitchOnly) {
      await checkpoint("saved-60-baselines", async () => {
        for (const day of [18, 19, 20]) {
          const r = await create({ start: `2026-10-${day}T09:00` });
          assert.equal(
            r.after.target[0].scheduling_reservation.minimumTravelGapMinutes,
            60,
          );
          assert.equal(
            r.after.target[0].scheduling_reservation.duration.preset
              .elapsedMinutes,
            60,
          );
          assert.equal(
            (Date.parse(r.wire.scheduledEnd) -
              Date.parse(r.wire.scheduledStart)) /
              60000,
            60,
          );
          baselines.push(r);
          await r.page.close();
        }
        const p = await persisted(baselines[0], "baseline");
        await layouts(p, "linked-card");
        await p.close();
      });
      await checkpoint("current-conflict-explicit-review", async () => {
        const before = await observe(), p = await newForm();
        await fill(p, { start: "2026-10-18T08:00", end: "2026-10-18T09:00", preset: false });
        await p.getByLabel("Service start", { exact: true }).fill("2026-10-18T10:30");
        assert.equal(await p.getByLabel("Service end", { exact: true }).inputValue(), "2026-10-18T11:30");
        const custodyBefore = await p.evaluate(() => JSON.stringify(Object.entries(sessionStorage).sort()));
        const readsBefore = report.schedulingReads.length;
        const uuidObservation = await countNativeUuidCallsDuring(p, async () => {
          const response = p.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/scheduling/conflict-explanation");
          await review(p);
          const read = await response; assert.equal(read.status(), 200);
          const value = await read.json();
          assert.deepEqual(Object.keys(value).sort(), ["basis", "conflict", "context", "evaluatedAt"]);
          assert.equal(value.basis, "current_schedule"); assert.equal(value.conflict.reservationId, baselines[0].body.id);
          await p.getByText(/Current schedule explanation/).waitFor();
          assert.match(await p.getByRole("dialog").innerText(), /60 elapsed minutes/);
          assert.match(await p.getByRole("dialog").innerText(), /This does not establish the original refusal reason/);
          await saveEvidence("current-conflict-read", { response: value, wire: read.request().postDataJSON() });
        });
        assert.equal(uuidObservation.calls, 0);
        assert.equal(report.schedulingReads.length, readsBefore + 1);
        assert.equal(await p.evaluate(() => JSON.stringify(Object.entries(sessionStorage).sort())), custodyBefore);
        assert.deepEqual(inventory(await observe()), inventory(before));
        await p.getByLabel("Service start", { exact: true }).fill("2026-10-18T11:30");
        assert.equal(await p.getByText(/Current schedule explanation/).count(), 0);
        await saveEvidence("current-conflict-read-effects", { uuidObservation, applicationWrites: 0, custodyUnchanged: true });
        await p.close();
      });
      await checkpoint("manual-create-shift-explicit-duration", async () => {
        const p = await newForm();
        await fill(p, { start: "2026-10-23T13:00", end: "2026-10-23T14:00", preset: false });
        await p.getByLabel("Service start", { exact: true }).fill("2026-10-23T15:00");
        assert.equal(await p.getByLabel("Service end", { exact: true }).inputValue(), "2026-10-23T16:00");
        const result = await submit(p);
        assert.deepEqual(result.wire.schedulingReview.duration, { kind: "explicit", preset: null });
        assert.deepEqual(result.body.schedulingReservation.duration, { kind: "explicit", preset: null });
        await p.close();
      });
      for (const [i, mode] of [
        { gap: 0 },
        { gap: 5 },
        { gap: 0, enabled: false },
      ].entries())
        await checkpoint(`retained-gap-${i}`, async () => {
          await policy(mode);
          phase = `retained-gap-${i}`;
          const p = await persisted(baselines[i], `retained-gap-${i}`);
          await p.close();
          const day = 18 + i,
            r = await create(
              {
                start: `2026-10-${day}T10:59`,
                end: `2026-10-${day}T11:59`,
                preset: mode.enabled !== false,
              },
              { refusal: "travel_conflict" },
            );
          if (mode.enabled === false)
            assert.equal(
              await r.page
                .getByRole("combobox", { name: /^Duration preset/ })
                .locator("option")
                .count(),
              1,
              "Disabled policy offers no presets",
            );
          await layouts(r.page, `refusal-${i}`);
          const beforeAck = count("/api/v1/appointments");
          await r.page
            .getByRole("button", {
              name: "Acknowledge refusal and review a new appointment",
              exact: true,
            })
            .click();
          assert.equal(count("/api/v1/appointments"), beforeAck);
          await fill(r.page, {
            start: `2026-10-${day}T11:00`,
            end: `2026-10-${day}T12:00`,
            preset: mode.enabled !== false,
          });
          const equality = await submit(r.page);
          assert.notEqual(equality.wire.operationId, r.wire.operationId);
          await r.page.close();
        });
      await checkpoint("independent-capacity-gates", async () => {
        await policy({ gap: 0, cap: 1 });
        phase = "company-cap";
        const a = await create({ start: "2026-10-21T09:00" });
        await a.page.close();
        const b = await create(
          { start: "2026-10-21T09:30", resource: 1 },
          { refusal: "company_capacity_conflict" },
        );
        await b.page.close();
        await policy({ gap: 0, cap: 10 });
        phase = "inspection-cap";
        const c = await create({
          start: "2026-10-22T09:00",
          type: "inspection",
        });
        await c.page.close();
        const p = await persisted(c, "inspection-historical");
        assert.match(
          await p
            .getByRole("region", { name: "Selected appointment" })
            .innerText(),
          /Inspection rule zone: America\/Chicago/,
        );
        await p.close();
        const d = await create(
          { start: "2026-10-22T09:30", type: "inspection", resource: 1 },
          { refusal: "inspection_capacity_conflict" },
        );
        await d.page.close();
        report.inspectionTarget = c.body.id;
      });
      await checkpoint("dst-gap-fold-and-manual-duration", async () => {
        const p = await newForm();
        await fill(p, {
          start: "2026-03-08T02:30",
          end: "2026-03-08T04:30",
          preset: false,
        });
        const before = count("/api/v1/appointments");
        await p
          .getByText(
            "Start: This local time does not exist in America/New_York.",
            { exact: true },
          )
          .waitFor();
        assert.equal(
          await p
            .getByRole("button", { name: "Review interval", exact: true })
            .isDisabled(),
          true,
        );
        assert.equal(count("/api/v1/appointments"), before);
        await p.close();
        const starts = [];
        for (const occurrence of [1, 2]) {
          const page = await newForm();
          await fill(page, {
            start: "2026-11-01T01:30",
            end: "2026-11-01T03:30",
            preset: false,
            resource: occurrence - 1,
          });
          const n = count("/api/v1/appointments");
          assert.equal(
            await page
              .getByRole("button", { name: "Review interval", exact: true })
              .isDisabled(),
            true,
          );
          assert.equal(count("/api/v1/appointments"), n);
          await page
            .getByRole("combobox", { name: /^Service start occurrence/ })
            .selectOption({ index: occurrence });
          await page
            .getByRole("combobox", { name: /^Duration preset/ })
            .selectOption({ label: "FICTIONAL one hour · 60 elapsed minutes" });
          await keyboard(page, `fold-${occurrence}`);
          await layouts(page, `fold-${occurrence}`);
          const r = await submit(page);
          starts.push(date(r.wire.scheduledStart));
          assert.equal(
            (Date.parse(r.wire.scheduledEnd) -
              Date.parse(r.wire.scheduledStart)) /
              60000,
            60,
          );
          await page.close();
        }
        assert.deepEqual(starts, [
          "2026-11-01T05:30:00.000Z",
          "2026-11-01T06:30:00.000Z",
        ]);
        const midnight = await create({
          start: "2026-10-25T23:30",
          end: "2026-10-27T01:15",
          preset: false,
        });
        assert.equal(
          (Date.parse(midnight.wire.scheduledEnd) -
            Date.parse(midnight.wire.scheduledStart)) /
            60000,
          1545,
        );
        await midnight.page.close();
      });
    }
    await checkpoint("lost-ack-same-tab-original-reconcile", async () => {
      const p = await newForm();
      await fill(p, { start: "2026-10-29T09:00" });
      const r = await submit(p, { lost: true });
      fault = null;
      const unknownNewIntent = p.getByRole("button", {
        name: "Start a new appointment",
        exact: true,
      });
      if (await unknownNewIntent.count())
        assert.equal(
          await unknownNewIntent.isEnabled(),
          false,
          "UNKNOWN cannot rearm a new intent",
        );
      const originalCustody = await custody(p, r.wire.operationId);
      await layouts(p, "unknown");
      const countBefore = count("/api/v1/appointments"),
        reconcileBefore = count("/api/v1/scheduling/operations/reconcile");
      await p.reload();
      await settled(p);
      assert.deepEqual(
        await custody(p, r.wire.operationId),
        originalCustody,
        "Reload preserves exact original bytes/key/hash",
      );
      await p
        .getByRole("button", { name: "Schedule appointment", exact: true })
        .click();
      await p.getByTestId("appointment-contact").selectOption(m.contactId);
      await p
        .getByText("Original appointment result is unknown.", { exact: false })
        .waitFor();
      await settled(p);
      assert.equal(count("/api/v1/appointments"), countBefore);
      assert.equal(
        count("/api/v1/scheduling/operations/reconcile"),
        reconcileBefore,
      );
      assert.equal(
        await p.getByTestId("appointment-contact").isDisabled(),
        true,
      );
      assert.equal(
        await p.getByLabel("Appointment notes", { exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await p
          .getByRole("combobox", { name: /^Property for this new appointment/ })
          .isDisabled(),
        true,
      );
      await scopeSwitches(p, r);
      await guard(p);
      const responsePromise = p.waitForResponse(
        (resp) =>
          resp.request().method() === "POST" &&
          resp.url().endsWith("/scheduling/operations/reconcile"),
      );
      await p
        .getByRole("button", {
          name: "Reconcile original appointment",
          exact: true,
        })
        .focus();
      await p.keyboard.press("Enter");
      const response = await responsePromise;
      assert.equal(response.status(), 200);
      const reconcileWire = response.request().postDataJSON(),
        ack = await response.json();
      assert.deepEqual(reconcileWire, {
        operationId: r.wire.operationId,
        kind: "appointment_create",
        body: Object.fromEntries(
          Object.entries(r.wire).filter(
            ([k]) => !["operationId", "schedulingReview"].includes(k),
          ),
        ),
        review: r.wire.schedulingReview,
      });
      assert.deepEqual(ack, r.body.schedulingOperation);
      await settled(p);
      const after = await observe({
        operationId: r.wire.operationId,
        targetId: r.body.id,
      });
      assert.deepEqual(inventory(after), inventory(r.after));
      assert.equal(count("/api/v1/appointments"), countBefore);
      assert.equal(
        count("/api/v1/scheduling/operations/reconcile"),
        reconcileBefore + 1,
      );
      await saveEvidence("lost-ack-reconciled", {
        original: r.body.schedulingOperation,
        reconcileWire,
        ack,
        before: r.after,
        after,
      });
      if (!scopeSwitchOnly)
        await checkpoint("known-commit-explicit-repeat-same-source", () =>
          repeatAfterReconcile(p, r),
        );
      await p.close();
    });
    if (!scopeSwitchOnly) {
      await checkpoint("today-company-day", async () => {
        const instant = new Date(
          Math.ceil((Date.now() + 5 * 60000) / 60000) * 60000,
        );
        const start = wall(instant),
          end = wall(new Date(instant.getTime() + 30 * 60000));
        assert.equal(
          start.slice(0, 10),
          wall(new Date()).slice(0, 10),
          "Today fixture remains company day",
        );
        const r = await create({ start, end, preset: false });
        await r.page.close();
        const p = await context.newPage();
        await p.goto(`${origin}/today`);
        await settled(p);
        await p
          .getByRole("combobox", { name: "Show", exact: true })
          .selectOption("company");
        await settled(p);
        const link = p.locator(
          `a[href="/appointments?appointmentId=${r.body.id}&organizationId=${m.organizationId}"]`,
        );
        await link.first().waitFor();
        assert.equal(
          await p.evaluate(
            () => Intl.DateTimeFormat().resolvedOptions().timeZone,
          ),
          "America/Los_Angeles",
        );
        await layouts(p, "today");
        await saveEvidence("today-company-day", {
          browserZone: "America/Los_Angeles",
          companyZone: m.companyZone,
          day: start.slice(0, 10),
          appointment: r.body.id,
          url: p.url(),
        });
        await p.close();
      });
      await checkpoint("inspection-zone-history", async () => {
        await settings.goto(`${origin}/settings`);
        await guard(settings);
        await settings
          .getByRole("tab", { name: "Scheduling", exact: true })
          .click();
        await settled(settings);
        const before = await observe({ targetId: report.inspectionTarget }),
          prior = count("/api/v1/settings", "PUT");
        const select = settings.getByRole("combobox", {
          name: "Timezone",
          exact: true,
        });
        await select.click();
        await settings
          .getByRole("option", { name: "America/Denver", exact: true })
          .click();
        const pending = settings.waitForResponse(
          (r) =>
            r.request().method() === "PUT" &&
            r.url().endsWith("/api/v1/settings"),
        );
        await settings
          .getByRole("button", { name: "Save availability", exact: true })
          .click();
        assert.equal((await pending).status(), 200);
        await settled(settings);
        assert.equal(count("/api/v1/settings", "PUT"), prior + 1);
        const after = await observe({ targetId: report.inspectionTarget });
        assert.deepEqual(after.target, before.target);
        assert.equal(
          after.settings[0].inspection_availability.timezone,
          "America/Denver",
        );
        const p = await context.newPage();
        await p.goto(
          `${origin}/appointments?appointmentId=${report.inspectionTarget}&organizationId=${m.organizationId}`,
        );
        await settled(p);
        await p
          .getByRole("button", {
            name: "Show this day in schedule",
            exact: true,
          })
          .click();
        await settled(p);
        assert.match(
          await p
            .getByRole("region", { name: "Selected appointment" })
            .innerText(),
          /Inspection rule zone: America\/Chicago/,
        );
        await saveEvidence("inspection-zone-history", {
          before,
          after,
          text: await p
            .getByRole("region", { name: "Selected appointment" })
            .innerText(),
        });
        await p.close();
      });
      await checkpoint("company-zone-history", async () => {
        await guard(settings);
        const before = await observe({ targetId: baselines[0].body.id }),
          route = `/api/v1/platform/orgs/${m.organizationId}`,
          prior = count(route, "PATCH");
        const wire = {
          timezone: "America/Los_Angeles",
          expectedTimeZone: "America/New_York",
        };
        const response = await settings.evaluate(
          async ({ route, wire }) => {
            const r = await fetch(route, {
              method: "PATCH",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(wire),
            });
            return { status: r.status, body: await r.json() };
          },
          { route, wire },
        );
        assert.equal(response.status, 200);
        assert.equal(response.body.organization.id, m.organizationId);
        assert.equal(
          response.body.organization.timezone,
          "America/Los_Angeles",
        );
        await settled(settings);
        assert.equal(count(route, "PATCH"), prior + 1);
        assert.equal((await assertFictional()).timezone, "America/Los_Angeles");
        const p = await persisted(baselines[0], "company-zone-history");
        assert.match(
          await p
            .getByRole("region", { name: "Selected appointment" })
            .innerText(),
          /Current company zone: America\/Los_Angeles/,
        );
        const after = await observe({ targetId: baselines[0].body.id });
        assert.deepEqual(after.target, before.target);
        await saveEvidence("company-zone-change", {
          method: "PATCH",
          route,
          wire,
          bodyHash: digest(wire),
          response,
          before,
          after,
          proof:
            "API configuration followed by real UI reload, no company timezone editor claimed",
        });
        await p.close();
      });
      await checkpoint("literal-browser-harness", async () => {
        report.harness = await runLiteralHarness({ ...options, chromium });
      });
    }
  } catch (error) {
    if (!report.findings.some((f) => f.message === error.message))
      recordFinding(phase, error);
  } finally {
    try {
      await context?.close();
      report.cleanup.context = "closed";
    } catch (e) {
      recordFinding("cleanup", e);
    }
    try {
      await browser?.close();
      report.cleanup.browser = "closed";
    } catch (e) {
      recordFinding("cleanup", e);
    }
    report.blockedExternalFonts = [
      ...new Set(
        networkGate.injections
          .filter((item) => item.kind === "declared-font-denial")
          .map((item) => item.url),
      ),
    ];
    report.limitations.push(
      "External Google font stylesheet deliberately blocked; screenshots use local fallback fonts",
    );
    report.networkClassification = classifyBrowserNetwork({
      failures: report.requestfailed,
      injections: networkGate.injections,
      consoleEntries: report.console,
      responses: report.responses,
      expectedDenials,
    });
    report.unclassifiedConsole =
      report.networkClassification.unclassifiedConsole;
    if (!report.networkClassification.passed)
      report.findings.push({
        phase: "errors",
        message:
          "Unmatched request failure, injection, HTTP error or console evidence",
      });
    if (report.pageerrors.length)
      report.findings.push({
        phase: "errors",
        message: "Unclassified page errors",
      });
    if (report.unclassifiedConsole.length)
      report.findings.push({
        phase: "errors",
        message: "Unclassified console errors",
      });
    report.status = report.findings.length ? "failed" : "passed";
    await saveEvidence("browser-report", report);
  }
  if (report.status === "failed") process.exitCode = 1;
  return report;
}

async function runLiteralHarness({
  origin,
  manifest: m,
  cacheRoot,
  reportDir,
  cleanEnv,
  assertFictional,
}) {
  // Installed 0.1.13 supports BU_NAME + BU_CDP_URL and isolated BH_HOME/runtime.
  // --reload stops only the named daemon; admin.py verifies its live IPC identity.
  let chrome, ownedDir;
  const result = {
    engine: "installed browser-harness",
    status: "starting",
    cleanup: {},
  };
  const env = Object.fromEntries(
    Object.entries(cleanEnv).filter(([k]) =>
      /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC)$/i.test(k),
    ),
  );
  const executable = path.join(os.homedir(), ".local/bin/browser-harness.exe");
  async function command(code, args = []) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "",
        err = "";
      child.stdout.on("data", (b) => (out += b));
      child.stderr.on("data", (b) => (err += b));
      child.once("error", reject);
      child.once("exit", (status) =>
        status === 0
          ? resolve(out)
          : reject(
              new Error(
                `Owned Browser Harness exited ${status}: ${err || out}`,
              ),
            ),
      );
      child.stdin.end(code);
    });
  }
  try {
    await assertFictional();
    ownedDir = await mkdtemp(path.join(cacheRoot, "saved-harness-"));
    const profile = path.join(ownedDir, "profile");
    chrome = spawn(
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      [
        "--headless=new",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
        "about:blank",
      ],
      { env, stdio: "ignore", windowsHide: true },
    );
    const deadline = Date.now() + 20000;
    let port;
    while (Date.now() < deadline && !port) {
      try {
        port = Number(
          (
            await readFile(path.join(profile, "DevToolsActivePort"), "utf8")
          ).split("\n")[0],
        );
      } catch {}
      if (!port) await wait(100);
    }
    assert.ok(port > 0);
    const endpoint = `http://127.0.0.1:${port}`;
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    assert.ok(
      version.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`),
    );
    Object.assign(env, {
      BU_NAME: `sched-${m.runId.slice(0, 8)}`,
      BU_CDP_URL: endpoint,
      BH_RECORD: "0",
      BH_TAB_MARKER: "0",
      BH_TELEMETRY: "0",
      BROWSER_HARNESS_TELEMETRY: "0",
      ANONYMIZED_TELEMETRY: "false",
      BH_HOME: path.join(ownedDir, "harness"),
      BH_RUNTIME_DIR: path.join(ownedDir, "ipc"),
      BH_TMP_DIR: path.join(ownedDir, "tmp"),
      BH_AGENT_WORKSPACE: path.join(ownedDir, "helpers"),
    });
    result.chromePid = chrome.pid;
    result.port = port;
    result.name = env.BU_NAME;
    result.recording = "BH_RECORD=0";
    result.telemetry = await command("", ["telemetry", "status"]);
    result.ui = await command(literalHarnessPython(origin));
    result.status = "passed";
  } catch (e) {
    result.status = "failed";
    result.error = e.message;
  } finally {
    if (env.BU_NAME) {
      try {
        await command("", ["--reload"]);
        result.cleanup.daemon = "named daemon stopped";
      } catch (e) {
        result.cleanup.daemon = e.message;
        result.status = "failed";
      }
    }
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill();
      await exited;
      result.cleanup.chrome = "owned process exited";
    }
    if (ownedDir) {
      assert.equal(
        path.dirname(path.resolve(ownedDir)),
        path.resolve(cacheRoot),
      );
      await rm(ownedDir, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 250,
      });
      result.cleanup.temp = "exact owned directory removed";
    }
    await writeFile(
      path.join(reportDir, "browser-harness.json"),
      JSON.stringify(result, null, 2),
    );
  }
  assert.equal(result.status, "passed", result.error);
  return result;
}
