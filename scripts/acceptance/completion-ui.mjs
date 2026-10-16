// Future-run assertion only. Screenshots and a page-wide "Completed" string
// cannot identify the selected company, visit or immutable work completion.
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const one = (values, expected) =>
  Array.isArray(values) && values.length === 1 && values[0] === expected;
const instant = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const requireThat = (condition, reason) => {
  if (!condition) throw Error(reason);
};
function expectedTarget(e) {
  requireThat(
    e &&
      [
        "organizationId",
        "appointmentId",
        "contactId",
        "propertyId",
        "assetId",
        "entryId",
        "completionId",
        "completionRequestId",
        "checklistRevisionId",
      ].every((key) => uuid(e[key])) &&
      [
        "summary",
        "customerLabel",
        "assetLabel",
        "checklistName",
        "performerUserId",
      ].every(
        (key) => typeof e[key] === "string" && e[key].trim().length > 0,
      ) &&
      [e.updatedAt, e.performedAt, e.recordedAt].every(instant),
    "run_identity_missing",
  );
  const origin = new URL(e.origin);
  requireThat(
    origin.origin === e.origin && !origin.username && !origin.password,
    "run_origin_invalid",
  );
  return `${e.origin}/appointments?appointmentId=${e.appointmentId}&organizationId=${e.organizationId}`;
}
function exactPage(url, e) {
  const u = new URL(url),
    keys = [...u.searchParams.keys()];
  return (
    u.origin === e.origin &&
    !u.username &&
    !u.password &&
    !u.hash &&
    u.pathname === "/appointments" &&
    keys.length === 2 &&
    new Set(keys).size === 2 &&
    keys.every((key) => ["appointmentId", "organizationId"].includes(key)) &&
    u.searchParams.get("appointmentId") === e.appointmentId &&
    u.searchParams.get("organizationId") === e.organizationId
  );
}
function exactRead(response, suffix, e) {
  return (
    response?.url ===
      `${e.origin}/api/v1/appointments/${e.appointmentId}${suffix}` &&
    response.method === "GET" &&
    response.status === 200 &&
    response.redirected === false &&
    response.fromServiceWorker === false
  );
}

/** Correlate the freshly loaded UI with this run's known identities. No API
 * result substitutes for the required, scoped visible evidence below. */
export function completedVisitUiClaim(e, o) {
  try {
    expectedTarget(e);
    requireThat(exactPage(o?.url, e), "selected_visit_link_mismatch");
    const d = o.detail?.json,
      w = o.work?.json,
      c = w?.completion,
      v = o.visible;
    requireThat(
      exactRead(o.detail, "", e) &&
        d?.organizationId === e.organizationId &&
        d.appointment?.id === e.appointmentId &&
        d.appointment.contactId === e.contactId &&
        d.appointment.property?.id === e.propertyId &&
        d.appointment.status === "completed" &&
        d.appointment.updatedAt === e.updatedAt,
      "selected_visit_read_mismatch",
    );
    requireThat(
      exactRead(o.work, "/work", e) &&
        w?.organizationId === e.organizationId &&
        w.appointment?.id === e.appointmentId &&
        w.appointment.contactId === e.contactId &&
        w.appointment.propertyId === e.propertyId &&
        w.appointment.status === "completed" &&
        w.appointment.updatedAt === e.updatedAt &&
        w.appointment.customerLabel === e.customerLabel,
      "visit_work_read_mismatch",
    );
    requireThat(
      c?.id === e.completionId &&
        c.requestId === e.completionRequestId &&
        c.appointmentId === e.appointmentId &&
        c.contactId === e.contactId &&
        c.propertyId === e.propertyId &&
        c.nativeAppointmentStatus === "completed" &&
        c.outcome === "completed" &&
        c.summary === e.summary &&
        c.performedAt === e.performedAt &&
        c.recordedAt === e.recordedAt &&
        c.performerUserId === e.performerUserId &&
        c.entries?.length === 1 &&
        c.entries[0].id === e.entryId &&
        c.entries[0].assetId === e.assetId &&
        c.entries[0].checklistRevisionId === e.checklistRevisionId,
      "run_completion_mismatch",
    );
    requireThat(
      w.entries?.length === 1 &&
        w.entries[0].id === e.entryId &&
        w.entries[0].appointmentId === e.appointmentId &&
        w.entries[0].contactId === e.contactId &&
        w.entries[0].propertyId === e.propertyId &&
        w.entries[0].assetId === e.assetId &&
        w.entries[0].assetSnapshot?.id === e.assetId &&
        w.entries[0].assetSnapshot.label === e.assetLabel &&
        w.entries[0].completionId === e.completionId &&
        w.entries[0].state === "finalized" &&
        w.entries[0].checklist?.id === e.checklistRevisionId &&
        w.entries[0].checklist.definition?.name === e.checklistName,
      "run_finalized_entry_mismatch",
    );
    requireThat(
      v?.selectedCount === 1 &&
        v.selectedVisible === true &&
        v.refusalVisible === false &&
        one(v.recordedStatus, "completed") &&
        one(
          v.customerHrefs,
          `/contacts/${e.contactId}?organizationId=${e.organizationId}`,
        ) &&
        one(v.nativeStatus, "completed") &&
        one(v.customer, e.customerLabel) &&
        one(v.entryHeadings, `${e.assetLabel} · ${e.checklistName}`) &&
        v.finalizedEntryVisible === true &&
        v.completionCount === 1 &&
        v.completionVisible === true &&
        v.completionSummary === e.summary &&
        one(v.completionOutcome, "completed") &&
        one(v.completionPerformer, e.performerUserId) &&
        v.expectedTimeLabels?.performedAt === e.performedAt &&
        v.expectedTimeLabels.recordedAt === e.recordedAt &&
        typeof v.expectedTimeLabels.performedText === "string" &&
        typeof v.expectedTimeLabels.recordedText === "string" &&
        one(v.completionPerformedAt, v.expectedTimeLabels.performedText) &&
        one(v.completionRecordedAt, v.expectedTimeLabels.recordedText) &&
        v.completionEntryCount ===
          "1 saved work entry · native visit marked completed.",
      "required_completion_ui_missing",
    );
    return { status: "PASS", reason: "exact_completed_visit_visible" };
  } catch (error) {
    const allowed = [
      "run_identity_missing",
      "run_origin_invalid",
      "selected_visit_link_mismatch",
      "selected_visit_read_mismatch",
      "visit_work_read_mismatch",
      "run_completion_mismatch",
      "run_finalized_entry_mismatch",
      "required_completion_ui_missing",
    ];
    return {
      status: "FAIL",
      reason: allowed.includes(error.message)
        ? error.message
        : "completion_ui_unverifiable",
    };
  }
}

// Executed inside the selected section by Playwright. Read only visible content
// from that section; schedule rows elsewhere on the page cannot satisfy it.
export function readCompletedVisitDom(root, expected) {
  const visible = (el) =>
    !!el &&
    el.getClientRects().length > 0 &&
    ![el, ...parents(el)].some((node) => {
      const style = getComputedStyle(node);
      return (
        style.display === "none" ||
        style.visibility !== "visible" ||
        Number(style.opacity) === 0
      );
    });
  function parents(el) {
    const out = [];
    for (let p = el.parentElement; p; p = p.parentElement) out.push(p);
    return out;
  }
  const text = (el) => el?.innerText?.trim() ?? "";
  const fields = (scope, name) =>
    [...(scope?.querySelectorAll("dt") ?? [])]
      .filter((dt) => text(dt).replace(/:\s*$/, "") === name)
      .flatMap((dt) =>
        [...dt.parentElement.querySelectorAll(":scope > dd")]
          .filter(visible)
          .map(text),
      );
  const work = [
    ...root.querySelectorAll('section[aria-label="Visit work"]'),
  ].find((section) => section.querySelector(":scope > h3"));
  const completions = [
    ...(work?.querySelectorAll(
      'section[aria-label="Recorded work completion"]',
    ) ?? []),
  ];
  const completion = completions.length === 1 ? completions[0] : null;
  const entries = [
    ...(work?.querySelectorAll('section[aria-label^="Visit entry:"]') ?? []),
  ];
  const summary = completion?.querySelector(":scope > p.whitespace-pre-wrap");
  return {
    selectedCount: root.ownerDocument.querySelectorAll(
      'section[aria-label="Selected appointment"]',
    ).length,
    selectedVisible: visible(root),
    recordedStatus: fields(
      root.querySelector(":scope > dl"),
      "Recorded status",
    ).map((value) => value.toLowerCase()),
    customerHrefs: [...root.querySelectorAll("a")]
      .filter((a) => visible(a) && text(a) === "Open customer record")
      .map((a) => a.getAttribute("href")),
    nativeStatus: fields(
      work?.querySelector(":scope > dl"),
      "Native visit status",
    ),
    customer: fields(work?.querySelector(":scope > dl"), "Customer"),
    entryHeadings: entries
      .filter(visible)
      .map((entry) => entry.querySelector(":scope > h4"))
      .filter(visible)
      .map(text),
    finalizedEntryVisible:
      entries.length === 1 &&
      visible(entries[0]) &&
      [...entries[0].querySelectorAll(":scope > p")].some(
        (p) =>
          visible(p) &&
          /^finalized · saved version \d+ · company-reviewed checklist revision \d+$/.test(
            text(p),
          ),
      ),
    completionCount: completions.length,
    completionVisible: visible(completion),
    completionSummary: visible(summary) ? text(summary) : "",
    completionOutcome: fields(
      completion?.querySelector(":scope > dl"),
      "Outcome",
    ),
    completionPerformer: fields(
      completion?.querySelector(":scope > dl"),
      "Performer",
    ),
    completionPerformedAt: fields(
      completion?.querySelector(":scope > dl"),
      "Work performed",
    ),
    completionRecordedAt: fields(
      completion?.querySelector(":scope > dl"),
      "Recorded",
    ),
    // This function is serialized into the page. Use its own Date/Intl realm,
    // matching the existing product renderer's locale/time zone and precision.
    expectedTimeLabels: {
      performedAt: expected?.performedAt,
      recordedAt: expected?.recordedAt,
      performedText: new Date(expected?.performedAt).toLocaleString(),
      recordedText: new Date(expected?.recordedAt).toLocaleString(),
    },
    completionEntryCount: [
      ...(completion?.querySelectorAll(":scope > p") ?? []),
    ]
      .filter(
        (p) =>
          visible(p) &&
          /saved work entr(?:y|ies) · native visit marked completed\.$/.test(
            text(p),
          ),
      )
      .map(text)
      .join("\n"),
    refusalVisible: [
      ...root.ownerDocument.querySelectorAll('[role="alert"]'),
    ].some(
      (el) =>
        visible(el) &&
        /appointment link is invalid|appointment link belongs to another company|linked appointment is unavailable|no linked appointment was opened/i.test(
          text(el),
        ),
    ),
  };
}

/** Only navigation and opening the read-only disclosure. Each response must
 * belong to a matching main-frame request observed to start after the action
 * boundary, not merely a response that arrives after listener registration. */
export async function observeCompletedVisitUi(page, expected) {
  try {
    const target = expectedTarget(expected);
    const read = async (url, action) => {
      const started = new WeakSet(),
        frame = page.mainFrame();
      let actionStarted = false;
      const requestStarted = (request) => {
        try {
          if (
            actionStarted &&
            request.url() === url &&
            request.method() === "GET" &&
            request.frame() === frame
          )
            started.add(request);
        } catch {
          /* Service-worker/detached-frame requests cannot qualify. */
        }
      };
      page.on("request", requestStarted);
      try {
        const pending = page
          .waitForResponse(
            (response) =>
              response.url() === url &&
              response.request().method() === "GET" &&
              started.has(response.request()),
            { timeout: 10_000 },
          )
          .catch(() => null);
        actionStarted = true;
        await action();
        const response = await pending;
        if (!response) throw Error("missing_ui_response");
        return {
          url: response.url(),
          method: response.request().method(),
          status: response.status(),
          redirected: response.request().redirectedFrom() !== null,
          fromServiceWorker: response.fromServiceWorker(),
          json: await response.json(),
        };
      } finally {
        actionStarted = false;
        page.off("request", requestStarted);
      }
    };
    const detail = await read(
      `${expected.origin}/api/v1/appointments/${expected.appointmentId}`,
      () => page.goto(target),
    );
    const selected = page.getByRole("region", {
      name: "Selected appointment",
      exact: true,
    });
    await selected.waitFor({ state: "visible", timeout: 10_000 });
    const work = await read(
      `${expected.origin}/api/v1/appointments/${expected.appointmentId}/work`,
      () =>
        selected
          .getByRole("button", { name: "Open visit work", exact: true })
          .click({ timeout: 10_000 }),
    );
    await selected
      .getByRole("region", { name: "Recorded work completion", exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    return completedVisitUiClaim(expected, {
      url: page.url(),
      detail,
      work,
      visible: await selected.evaluate(readCompletedVisitDom, {
        performedAt: expected.performedAt,
        recordedAt: expected.recordedAt,
      }),
    });
  } catch {
    return { status: "FAIL", reason: "completion_ui_observation_failed" };
  }
}

/** The actual runner's attempted-UI recording boundary. Retain a company-scoped
 * failure even if preflight, observation or evidence capture throws. Rethrowing
 * the original error preserves the enclosing runner's fatal safety handling. */
export async function recordCompletedVisitUi({
  company,
  record,
  preflight,
  observe,
  screenshot,
}) {
  const caseId = company.key === "painless" ? "P-G" : "H-G";
  try {
    await preflight();
    const ui = await observe();
    const evidence = [await screenshot()];
    record(
      caseId,
      ui.status,
      `${company.name}: exact selected visit and recorded completion UI: ${ui.reason}`,
      evidence,
      {
        company: company.name,
        step: "complete-ui",
        uiStatus: ui.status,
        partial:
          "Synthetic visible UI correlated to fresh exact-visit reads; no physical photo or company acceptance claim.",
      },
    );
    return ui;
  } catch (error) {
    record(
      caseId,
      "FAIL",
      `${company.name}: attempted completion UI could not verify or retain its required evidence`,
      [],
      {
        company: company.name,
        step: "complete-ui",
        uiStatus: "FAIL",
        scriptError: true,
      },
    );
    throw error;
  }
}
