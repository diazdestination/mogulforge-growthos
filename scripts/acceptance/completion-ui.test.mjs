import { test } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

// jsdom is already a dev dependency of this workspace package. Resolve there;
// local verification may supply NODE_PATH for an existing dependency runtime.
const { JSDOM } = createRequire(
  new URL("../../artifacts/command-center/package.json", import.meta.url),
)("jsdom");

const ui = await import("./completion-ui.mjs").catch(() => ({}));
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin = "https://mogulforge-growthos-staging.fly.dev";
function fixture() {
  const expected = {
    origin,
    organizationId: id(1),
    appointmentId: id(2),
    contactId: id(3),
    propertyId: id(4),
    assetId: id(5),
    entryId: id(6),
    completionId: id(7),
    completionRequestId: id(8),
    checklistRevisionId: id(9),
    updatedAt: "2026-10-16T21:50:00.000Z",
    performedAt: "2026-10-16T21:49:00.123Z",
    recordedAt: "2026-10-16T21:50:00.456Z",
    performerUserId: id(10),
    summary: "TEST visit completed by acceptance automation",
    customerLabel: "TEST HVAC Inquirer",
    assetLabel: "TEST upstairs heat pump",
    checklistName: "TEST HVAC checklist",
  };
  const observation = {
    url: `${origin}/appointments?appointmentId=${id(2)}&organizationId=${id(1)}`,
    detail: {
      url: `${origin}/api/v1/appointments/${id(2)}`,
      method: "GET",
      status: 200,
      redirected: false,
      fromServiceWorker: false,
      json: {
        organizationId: id(1),
        appointment: {
          id: id(2),
          contactId: id(3),
          property: { id: id(4) },
          status: "completed",
          updatedAt: "2026-10-16T21:50:00.000Z",
        },
      },
    },
    work: {
      url: `${origin}/api/v1/appointments/${id(2)}/work`,
      method: "GET",
      status: 200,
      redirected: false,
      fromServiceWorker: false,
      json: {
        organizationId: id(1),
        appointment: {
          id: id(2),
          contactId: id(3),
          propertyId: id(4),
          status: "completed",
          updatedAt: "2026-10-16T21:50:00.000Z",
          customerLabel: "TEST HVAC Inquirer",
        },
        entries: [
          {
            id: id(6),
            appointmentId: id(2),
            contactId: id(3),
            propertyId: id(4),
            assetId: id(5),
            assetSnapshot: { id: id(5), label: "TEST upstairs heat pump" },
            state: "finalized",
            completionId: id(7),
            checklist: {
              id: id(9),
              definition: { name: "TEST HVAC checklist" },
            },
          },
        ],
        completion: {
          id: id(7),
          requestId: id(8),
          appointmentId: id(2),
          contactId: id(3),
          propertyId: id(4),
          nativeAppointmentStatus: "completed",
          outcome: "completed",
          performerUserId: id(10),
          performedAt: "2026-10-16T21:49:00.123Z",
          recordedAt: "2026-10-16T21:50:00.456Z",
          summary: "TEST visit completed by acceptance automation",
          entries: [{ id: id(6), assetId: id(5), checklistRevisionId: id(9) }],
        },
      },
    },
    visible: {
      selectedCount: 1,
      selectedVisible: true,
      recordedStatus: ["completed"],
      customerHrefs: [`/contacts/${id(3)}?organizationId=${id(1)}`],
      nativeStatus: ["completed"],
      customer: ["TEST HVAC Inquirer"],
      entryHeadings: ["TEST upstairs heat pump · TEST HVAC checklist"],
      finalizedEntryVisible: true,
      completionCount: 1,
      completionVisible: true,
      completionSummary: "TEST visit completed by acceptance automation",
      completionOutcome: ["completed"],
      completionPerformer: [id(10)],
      completionPerformedAt: ["10/16/2026, 2:49:00 PM"],
      completionRecordedAt: ["10/16/2026, 2:50:00 PM"],
      expectedTimeLabels: {
        performedAt: "2026-10-16T21:49:00.123Z",
        recordedAt: "2026-10-16T21:50:00.456Z",
        performedText: "10/16/2026, 2:49:00 PM",
        recordedText: "10/16/2026, 2:50:00 PM",
      },
      completionEntryCount:
        "1 saved work entry · native visit marked completed.",
      refusalVisible: false,
    },
  };
  return { expected, observation };
}
function claim(expected, observation) {
  assert.equal(
    typeof ui.completedVisitUiClaim,
    "function",
    "exact completion UI assertion is missing",
  );
  return ui.completedVisitUiClaim(expected, observation);
}

test("passes only the exact run visit, finalized asset and visible recorded completion", () => {
  const f = fixture();
  assert.deepEqual(claim(f.expected, f.observation), {
    status: "PASS",
    reason: "exact_completed_visit_visible",
  });
});

// Each literal mutation names an unsafe false PASS that this assertion must reject.
const failures = [
  [
    "missing company in link",
    (f) => {
      f.observation.url = `${origin}/appointments?appointmentId=${id(2)}`;
    },
  ],
  [
    "duplicate appointment in link",
    (f) => {
      f.observation.url += `&appointmentId=${id(2)}`;
    },
  ],
  [
    "foreign link company",
    (f) => {
      f.observation.url = `${origin}/appointments?appointmentId=${id(2)}&organizationId=${id(99)}`;
    },
  ],
  [
    "foreign link origin",
    (f) => {
      f.observation.url = f.observation.url.replace(
        origin,
        "https://example.invalid",
      );
    },
  ],
  [
    "extra link parameter",
    (f) => {
      f.observation.url += "&returnTo=/appointments";
    },
  ],
  [
    "link fragment",
    (f) => {
      f.observation.url += "#completed";
    },
  ],
  [
    "unrelated detail request",
    (f) => {
      f.observation.detail.url = `${origin}/api/v1/appointments/${id(99)}`;
    },
  ],
  [
    "unsuccessful detail",
    (f) => {
      f.observation.detail.status = 404;
    },
  ],
  [
    "wrong detail tenant",
    (f) => {
      f.observation.detail.json.organizationId = id(99);
    },
  ],
  [
    "wrong detail visit",
    (f) => {
      f.observation.detail.json.appointment.id = id(99);
    },
  ],
  [
    "wrong detail customer",
    (f) => {
      f.observation.detail.json.appointment.contactId = id(99);
    },
  ],
  [
    "wrong detail property",
    (f) => {
      f.observation.detail.json.appointment.property.id = id(99);
    },
  ],
  [
    "scheduled detail despite completed text",
    (f) => {
      f.observation.detail.json.appointment.status = "scheduled";
    },
  ],
  [
    "stale detail version",
    (f) => {
      f.observation.detail.json.appointment.updatedAt =
        "2026-10-16T21:00:00.000Z";
    },
  ],
  [
    "unrelated work request",
    (f) => {
      f.observation.work.url = `${origin}/api/v1/appointments/${id(99)}/work`;
    },
  ],
  [
    "wrong work tenant",
    (f) => {
      f.observation.work.json.organizationId = id(99);
    },
  ],
  [
    "wrong work visit",
    (f) => {
      f.observation.work.json.appointment.id = id(99);
    },
  ],
  [
    "wrong work customer",
    (f) => {
      f.observation.work.json.appointment.contactId = id(99);
    },
  ],
  [
    "wrong work property",
    (f) => {
      f.observation.work.json.appointment.propertyId = id(99);
    },
  ],
  [
    "stale work version",
    (f) => {
      f.observation.work.json.appointment.updatedAt =
        "2026-10-16T21:00:00.000Z";
    },
  ],
  [
    "old completion for same visit",
    (f) => {
      f.observation.work.json.completion.id = id(99);
    },
  ],
  [
    "old completion request",
    (f) => {
      f.observation.work.json.completion.requestId = id(99);
    },
  ],
  [
    "completion from another visit",
    (f) => {
      f.observation.work.json.completion.appointmentId = id(99);
    },
  ],
  [
    "completion from another customer",
    (f) => {
      f.observation.work.json.completion.contactId = id(99);
    },
  ],
  [
    "wrong completion property",
    (f) => {
      f.observation.work.json.completion.propertyId = id(99);
    },
  ],
  [
    "missing recorded completion",
    (f) => {
      f.observation.work.json.completion = null;
    },
  ],
  [
    "other completed entry",
    (f) => {
      f.observation.work.json.completion.entries[0].id = id(99);
    },
  ],
  [
    "other completed asset",
    (f) => {
      f.observation.work.json.completion.entries[0].assetId = id(99);
    },
  ],
  [
    "other checklist revision",
    (f) => {
      f.observation.work.json.completion.entries[0].checklistRevisionId =
        id(99);
    },
  ],
  [
    "draft work entry",
    (f) => {
      f.observation.work.json.entries[0].state = "draft";
    },
  ],
  [
    "unrelated finalized entry",
    (f) => {
      f.observation.work.json.entries[0].appointmentId = id(99);
    },
  ],
  [
    "wrong asset snapshot",
    (f) => {
      f.observation.work.json.entries[0].assetSnapshot.id = id(99);
    },
  ],
  [
    "duplicated selected cards",
    (f) => {
      f.observation.visible.selectedCount = 2;
    },
  ],
  [
    "hidden selected card",
    (f) => {
      f.observation.visible.selectedVisible = false;
    },
  ],
  [
    "unrelated schedule completed label",
    (f) => {
      f.observation.visible.recordedStatus = ["scheduled"];
    },
  ],
  [
    "ambiguous status",
    (f) => {
      f.observation.visible.recordedStatus = ["completed", "scheduled"];
    },
  ],
  [
    "wrong customer navigation",
    (f) => {
      f.observation.visible.customerHrefs = [
        `/contacts/${id(99)}?organizationId=${id(1)}`,
      ];
    },
  ],
  [
    "customer navigation to another tenant",
    (f) => {
      f.observation.visible.customerHrefs = [
        `/contacts/${id(3)}?organizationId=${id(99)}`,
      ];
    },
  ],
  [
    "wrong visible customer",
    (f) => {
      f.observation.visible.customer = ["Unrelated customer"];
    },
  ],
  [
    "wrong visible asset",
    (f) => {
      f.observation.visible.entryHeadings = [
        "Other unit · TEST HVAC checklist",
      ];
    },
  ],
  [
    "hidden finalized entry",
    (f) => {
      f.observation.visible.finalizedEntryVisible = false;
    },
  ],
  [
    "missing completion UI",
    (f) => {
      f.observation.visible.completionCount = 0;
    },
  ],
  [
    "hidden completion UI",
    (f) => {
      f.observation.visible.completionVisible = false;
    },
  ],
  [
    "stale visible completion summary",
    (f) => {
      f.observation.visible.completionSummary = "An older unrelated completion";
    },
  ],
  [
    "wrong visible completion outcome",
    (f) => {
      f.observation.visible.completionOutcome = ["needs followup"];
    },
  ],
  [
    "wrong visible performer",
    (f) => {
      f.observation.visible.completionPerformer = [id(99)];
    },
  ],
  [
    "invalid link refusal with completed text elsewhere",
    (f) => {
      f.observation.visible.refusalVisible = true;
    },
  ],
  [
    "missing run completion id",
    (f) => {
      f.expected.completionId = undefined;
    },
  ],
];
for (const [name, change] of failures)
  test(`rejects ${name}`, () => {
    const f = fixture();
    change(f);
    assert.equal(claim(f.expected, f.observation).status, "FAIL");
  });

const markup = `
  <section aria-label="Selected appointment">
    <h2>Selected appointment</h2>
    <dl><div><dt>Recorded status</dt><dd class="capitalize">Completed</dd></div></dl>
    <a href="/contacts/00000000-0000-4000-8000-000000000003?organizationId=00000000-0000-4000-8000-000000000001">Open customer record</a>
    <section aria-label="Visit work"><button>Close visit work</button>
      <section aria-label="Visit work"><h3>Visit work</h3>
        <dl><div><dt>Customer</dt><dd>TEST HVAC Inquirer</dd></div><div><dt>Native visit status</dt><dd>completed</dd></div></dl>
        <section aria-label="Visit entry: TEST HVAC checklist"><h4>TEST upstairs heat pump · TEST HVAC checklist</h4>
          <p>finalized · saved version 3 · company-reviewed checklist revision 1</p>
        </section>
        <section aria-label="Recorded work completion"><h4>Recorded work completion</h4>
          <p>Immutable staff-recorded evidence — not customer acceptance.</p>
          <p class="whitespace-pre-wrap">TEST visit completed by acceptance automation</p>
          <dl><div><dt>Outcome: </dt><dd>completed</dd></div><div><dt>Performer: </dt><dd>00000000-0000-4000-8000-000000000010</dd></div>
            <div><dt>Work performed: </dt><dd>placeholder performed time</dd></div>
            <div><dt>Recorded: </dt><dd>placeholder recorded time</dd></div>
          </dl>
          <p>1 saved work entry · native visit marked completed.</p>
        </section>
      </section>
    </section>
  </section>
  <section aria-label="Schedule"><p>Completed</p><p>TEST unrelated customer</p></section>`;

async function inDom(action) {
  const dom = new JSDOM(markup, { runScripts: "outside-only" }),
    oldStyle = globalThis.getComputedStyle;
  // jsdom has no layout engine. Supply geometry only; the production extractor
  // still checks the actual CSS visibility/display/opacity through ancestors.
  Object.defineProperty(dom.window.HTMLElement.prototype, "getClientRects", {
    value() {
      return [{}];
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
  });
  dom.window.document.querySelectorAll("*").forEach((el) => {
    el.style.opacity = "1";
  });
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  setVisibleTimes(dom.window.document);
  try {
    return await action(dom.window.document);
  } finally {
    globalThis.getComputedStyle = oldStyle;
    dom.window.close();
  }
}

function timeElement(doc, label) {
  return [...doc.querySelectorAll('[aria-label="Recorded work completion"] dt')]
    .find((dt) => dt.textContent.trim().replace(/:$/, "") === label)
    ?.parentElement.querySelector("dd");
}
function setVisibleTimes(doc) {
  timeElement(doc, "Work performed").textContent = new doc.defaultView.Date(
    "2026-10-16T21:49:00.123Z",
  ).toLocaleString();
  timeElement(doc, "Recorded").textContent = new doc.defaultView.Date(
    "2026-10-16T21:50:00.456Z",
  ).toLocaleString();
}
function readDom(doc, expected) {
  return doc.defaultView.eval(`(${ui.readCompletedVisitDom.toString()})`)(
    doc.querySelector('[aria-label="Selected appointment"]'),
    expected,
  );
}

test("projects the selected actual DOM and ignores an unrelated schedule Completed label", async () =>
  inDom((doc) => {
    const f = fixture();
    f.observation.visible = readDom(doc, f.expected);
    assert.equal(claim(f.expected, f.observation).status, "PASS");
    doc.querySelector(
      '[aria-label="Selected appointment"] > dl dd',
    ).textContent = "Scheduled";
    f.observation.visible = readDom(doc, f.expected);
    assert.equal(claim(f.expected, f.observation).status, "FAIL");
  }));

for (const [name, change] of [
  [
    "hidden recorded completion",
    (doc) => {
      doc.querySelector(
        '[aria-label="Recorded work completion"]',
      ).style.display = "none";
    },
  ],
  [
    "hidden completion summary",
    (doc) => {
      doc.querySelector("p.whitespace-pre-wrap").style.visibility = "hidden";
    },
  ],
  [
    "transparent work disclosure",
    (doc) => {
      doc.querySelector('[aria-label="Visit work"]').style.opacity = "0";
    },
  ],
  [
    "unrelated completed panel outside selected visit",
    (doc) => {
      doc.body.append(
        doc.querySelector('[aria-label="Recorded work completion"]'),
      );
    },
  ],
  [
    "wrong customer link",
    (doc) => {
      doc.querySelector("a").href =
        `/contacts/${id(99)}?organizationId=${id(1)}`;
    },
  ],
  [
    "visible invalid-link refusal",
    (doc) => {
      const p = doc.createElement("p");
      p.setAttribute("role", "alert");
      p.textContent =
        "This appointment link is invalid. No linked appointment was opened.";
      p.style.opacity = "1";
      doc.body.append(p);
    },
  ],
])
  test(`actual DOM rejects ${name}`, async () =>
    inDom((doc) => {
      const f = fixture();
      change(doc);
      f.observation.visible = readDom(doc, f.expected);
      assert.equal(claim(f.expected, f.observation).status, "FAIL");
    }));

// Only the transport/Playwright boundary is doubled. The collector, response
// binding, real DOM projection and acceptance predicate all execute unchanged.
function controlledPage(doc, f, changeWork = () => {}, options = {}) {
  let url = origin + "/",
    pending = [],
    opened = false;
  const requestEvents = new EventEmitter(),
    mainFrame = {},
    requests = new Map();
  const browserNow = () =>
    doc.defaultView.performance.timeOrigin + doc.defaultView.performance.now();
  // The installed Playwright1.63 transport uses these two setImmediate
  // dispatch directions (independently retained in the R2 queued-event probe).
  // No browser is launched here; this is a controlled protocol schedule.
  const clientConnection = { dispatch: (message) => message() };
  const dispatcherConnection = { dispatch: (message) => message() };
  dispatcherConnection.onmessage = (message) =>
    setImmediate(() => clientConnection.dispatch(message));
  clientConnection.onmessage = (message) =>
    setImmediate(() => dispatcherConnection.dispatch(message));
  function requestFor(value) {
    let request = requests.get(value);
    if (!request) {
      request = {
        url: () => value.url,
        method: () => value.method,
        redirectedFrom: () => null,
        frame: () => (options.foreignFrame ? {} : mainFrame),
        _actualStart:
          Object.hasOwn(options, "timingStart") &&
          (!options.timingScope ||
            options.timingScope ===
              (value === f.observation.detail ? "detail" : "work"))
            ? options.timingStart
            : browserNow(),
        _timing: { startTime: 0 },
        timing() {
          return this._timing;
        },
      };
      requests.set(value, request);
    }
    return request;
  }
  if (options.precreatedScope)
    requestFor(
      options.precreatedScope === "detail"
        ? f.observation.detail
        : f.observation.work,
    );
  function emit(value) {
    const request = requestFor(value);
    const dispatch = (message) =>
      options.queuedTransport
        ? dispatcherConnection.onmessage(message)
        : message();
    if (options.oldBeforeCurrent) {
      const olderRequest = {
        ...request,
        _timing: { startTime: 0 },
        timing() {
          return this._timing;
        },
      };
      const olderResponse = {
        url: () => value.url,
        status: () => value.status,
        request: () => olderRequest,
        fromServiceWorker: () => false,
        json: async () => {
          const body = structuredClone(value.json);
          if (body.completion) body.completion.requestId = id(99);
          else body.appointment.status = "scheduled";
          return body;
        },
      };
      dispatch(() => requestEvents.emit("request", olderRequest));
      dispatch(() => {
        olderRequest._timing.startTime = request._actualStart - 1000;
        for (const waiter of pending)
          if (waiter.predicate(olderResponse)) {
            clearTimeout(waiter.timer);
            waiter.resolve(olderResponse);
          }
      });
    }
    if (
      (value === f.observation.detail
        ? options.startDetail
        : options.startWork) !== false
    )
      dispatch(() => requestEvents.emit("request", request));
    const response = {
      url: () => value.url,
      status: () => value.status,
      request: () => request,
      fromServiceWorker: () => false,
      json: async () => structuredClone(value.json),
    };
    dispatch(() => {
      request._timing.startTime = request._actualStart;
      for (const waiter of pending) {
        if (options.oldResponseFirst) {
          const older = {
            ...response,
            request: () => ({ ...request }),
            json: async () => {
              const body = structuredClone(value.json);
              if (body.completion) body.completion.requestId = id(99);
              else body.appointment.status = "scheduled";
              return body;
            },
          };
          if (waiter.predicate(older)) {
            clearTimeout(waiter.timer);
            waiter.resolve(older);
          }
        }
        if (waiter.predicate(response)) {
          clearTimeout(waiter.timer);
          waiter.resolve(response);
        }
      }
    });
  }
  const selected = {
    waitFor: async () => {},
    getByRole(role, roleOptions) {
      if (role === "button" && roleOptions.name === "Open visit work")
        return {
          click: async () => {
            if (options.throwClick) throw Error("disclosure_failed");
            const action = () => {
              opened = true;
              changeWork(f.observation.work);
              emit(f.observation.work);
            };
            if (options.queuedTransport)
              return new Promise((resolve) =>
                clientConnection.onmessage(() => {
                  action();
                  dispatcherConnection.onmessage(resolve);
                }),
              );
            action();
          },
        };
      if (role === "region" && roleOptions.name === "Recorded work completion")
        return {
          waitFor: async () => {
            if (!opened) throw Error("work_not_open");
          },
        };
      throw Error("unexpected_selected_locator");
    },
    evaluate: async (fn, argument) =>
      doc.defaultView.eval(`(${fn.toString()})`)(
        doc.querySelector('[aria-label="Selected appointment"]'),
        argument,
      ),
  };
  return {
    requestEvents,
    mainFrame: () => mainFrame,
    on: (...args) => requestEvents.on(...args),
    off: (...args) => requestEvents.off(...args),
    url: () => url,
    evaluate: async (fn) => {
      if (options.throwClock) throw Error("clock_sample_failed");
      if (Object.hasOwn(options, "clockSample")) return options.clockSample;
      return doc.defaultView.eval(`(${fn.toString()})`)();
    },
    waitForResponse(predicate) {
      if (options.throwWait) throw Error("response_wait_setup_failed");
      if (options.armRequestEvent)
        requestEvents.emit(
          "request",
          requestFor(
            pending.length === 0 ? f.observation.detail : f.observation.work,
          ),
        );
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => reject(Error("no_fresh_response")), 25),
        };
        pending.push(waiter);
      });
    },
    goto: async (target) => {
      if (options.throwGoto) throw Error("navigation_failed");
      url = target;
      if (options.queuedTransport)
        return new Promise((resolve) =>
          clientConnection.onmessage(() => {
            emit(f.observation.detail);
            dispatcherConnection.onmessage(resolve);
          }),
        );
      emit(f.observation.detail);
    },
    getByRole: (role, options) => {
      if (role !== "region" || options.name !== "Selected appointment")
        throw Error("unscoped_locator");
      return selected;
    },
  };
}

for (const scope of ["detail", "work"])
  test(`rejects a pre-existing ${scope} request whose issue event is queued after the action`, async () =>
    inDom(async (doc) => {
      const oldStart =
        doc.defaultView.performance.timeOrigin +
        doc.defaultView.performance.now() -
        1000;
      const f = fixture(),
        page = controlledPage(doc, f, () => {}, {
          queuedTransport: true,
          precreatedScope: scope,
          timingScope: scope,
          timingStart: oldStart,
        });
      assert.equal(
        (await ui.observeCompletedVisitUi(page, f.expected)).status,
        "FAIL",
      );
      assert.equal(page.requestEvents.listenerCount("request"), 0);
    }));

for (const [name, timingStart] of [
  ["unavailable", undefined],
  ["zero", 0],
  ["negative", -1],
  ["NaN", NaN],
  ["infinite", Infinity],
  ["string", "1792188000000"],
]) {
  test(`rejects ${name} response request timing and cleans up`, async () =>
    inDom(async (doc) => {
      const f = fixture(),
        page = controlledPage(doc, f, () => {}, { timingStart });
      assert.equal(
        (await ui.observeCompletedVisitUi(page, f.expected)).status,
        "FAIL",
      );
      assert.equal(page.requestEvents.listenerCount("request"), 0);
    }));
}
for (const [name, clockSample] of [
  ["unavailable", undefined],
  ["zero", 0],
  ["negative", -1],
  ["NaN", NaN],
  ["infinite", Infinity],
  ["string", "1792188000000"],
]) {
  test(`rejects ${name} browser clock sample and cleans up`, async () =>
    inDom(async (doc) => {
      const f = fixture(),
        page = controlledPage(doc, f, () => {}, { clockSample });
      assert.equal(
        (await ui.observeCompletedVisitUi(page, f.expected)).status,
        "FAIL",
      );
      assert.equal(page.requestEvents.listenerCount("request"), 0);
    }));
}
test("rejects a thrown browser clock sample and removes its listener", async () =>
  inDom(async (doc) => {
    const f = fixture(),
      page = controlledPage(doc, f, () => {}, { throwClock: true });
    assert.equal(
      (await ui.observeCompletedVisitUi(page, f.expected)).status,
      "FAIL",
    );
    assert.equal(page.requestEvents.listenerCount("request"), 0);
  }));
for (const [name, timingStart, wanted] of [
  ["before the fractional browser sample", 1700000000000.25, "FAIL"],
  ["equal to the browser sample", 1700000000000.5, "PASS"],
  ["after the browser sample", 1700000000000.75, "PASS"],
]) {
  test(`compares request start ${name} without using the Node clock`, async () =>
    inDom(async (doc) => {
      const f = fixture(),
        page = controlledPage(doc, f, () => {}, {
          clockSample: 1700000000000.5,
          timingStart,
        });
      assert.equal(
        (await ui.observeCompletedVisitUi(page, f.expected)).status,
        wanted,
      );
      assert.equal(page.requestEvents.listenerCount("request"), 0);
    }));
}
test("accepts current requests through the installed setImmediate transport schedule", async () =>
  inDom(async (doc) => {
    const f = fixture(),
      page = controlledPage(doc, f, () => {}, { queuedTransport: true });
    assert.equal(
      (await ui.observeCompletedVisitUi(page, f.expected)).status,
      "PASS",
    );
    assert.equal(page.requestEvents.listenerCount("request"), 0);
  }));
test("ignores a queued old matching start and consumes a later current request through the transport schedule", async () =>
  inDom(async (doc) => {
    const f = fixture(),
      page = controlledPage(doc, f, () => {}, {
        queuedTransport: true,
        oldBeforeCurrent: true,
      });
    assert.equal(
      (await ui.observeCompletedVisitUi(page, f.expected)).status,
      "PASS",
    );
    assert.equal(page.requestEvents.listenerCount("request"), 0);
  }));
test("observer binds fresh exact responses to the visible selected visit after opening its work", async () =>
  inDom(async (doc) => {
    const f = fixture();
    assert.equal(
      (await ui.observeCompletedVisitUi(controlledPage(doc, f), f.expected))
        .status,
      "PASS",
    );
  }));
test("observer rejects an old same-visit completion even when current DOM says Completed", async () =>
  inDom(async (doc) => {
    const f = fixture();
    assert.equal(
      (
        await ui.observeCompletedVisitUi(
          controlledPage(doc, f, (work) => {
            work.json.completion.requestId = id(99);
          }),
          f.expected,
        )
      ).status,
      "FAIL",
    );
  }));
test("observer cannot substitute an earlier or unrelated response for the fresh exact work read", async () =>
  inDom(async (doc) => {
    const f = fixture();
    assert.equal(
      (
        await ui.observeCompletedVisitUi(
          controlledPage(doc, f, (work) => {
            work.url = `${origin}/api/v1/appointments/${id(99)}/work`;
          }),
          f.expected,
        )
      ).status,
      "FAIL",
    );
  }));

test("rejects stale visible performed/recorded times despite current exact API timestamps", async () =>
  inDom((doc) => {
    const f = fixture();
    f.expected.performedAt = "2026-10-16T21:49:00.123Z";
    f.expected.recordedAt = "2026-10-16T21:50:00.456Z";
    f.observation.work.json.completion.performedAt = f.expected.performedAt;
    f.observation.work.json.completion.recordedAt = f.expected.recordedAt;
    const dl = doc.querySelector(
      '[aria-label="Recorded work completion"] > dl',
    );
    timeElement(doc, "Work performed").textContent = "1/1/1900, 12:00:00 AM";
    timeElement(doc, "Recorded").textContent = "1/1/1900, 12:00:00 AM";
    dl.querySelectorAll("*").forEach((el) => {
      el.style.opacity = "1";
    });
    f.observation.visible = readDom(doc, f.expected);
    assert.equal(claim(f.expected, f.observation).status, "FAIL");
  }));

for (const [name, options] of [
  ["pre-existing matching detail request", { startDetail: false }],
  ["pre-existing matching work request", { startWork: false }],
  ["matching requests from another frame", { foreignFrame: true }],
  [
    "request event before action begins",
    { armRequestEvent: true, startDetail: false },
  ],
  ["failed navigation", { throwGoto: true }],
  ["failed disclosure click", { throwClick: true }],
  ["response listener setup throws", { throwWait: true }],
])
  test(`observer rejects ${name} and removes request listeners`, async () =>
    inDom(async (doc) => {
      const f = fixture(),
        page = controlledPage(doc, f, () => {}, options);
      assert.equal(
        (await ui.observeCompletedVisitUi(page, f.expected)).status,
        "FAIL",
      );
      assert.equal(page.requestEvents.listenerCount("request"), 0);
    }));

test("observer ignores an older response but still reaches a legitimate action-created request", async () =>
  inDom(async (doc) => {
    const f = fixture(),
      page = controlledPage(doc, f, () => {}, { oldResponseFirst: true });
    assert.equal(
      (await ui.observeCompletedVisitUi(page, f.expected)).status,
      "PASS",
    );
    assert.equal(page.requestEvents.listenerCount("request"), 0);
  }));

for (const [name, change] of [
  [
    "missing acknowledged performedAt",
    (f) => {
      delete f.expected.performedAt;
    },
  ],
  [
    "malformed acknowledged recordedAt",
    (f) => {
      f.expected.recordedAt = "not-a-time";
    },
  ],
  [
    "fresh performedAt differs by a millisecond",
    (f) => {
      f.observation.work.json.completion.performedAt =
        "2026-10-16T21:49:00.124Z";
    },
  ],
  [
    "fresh recordedAt differs by a millisecond",
    (f) => {
      f.observation.work.json.completion.recordedAt =
        "2026-10-16T21:50:00.457Z";
    },
  ],
])
  test(`pure timestamp comparison rejects ${name}`, () => {
    const f = fixture();
    change(f);
    assert.equal(claim(f.expected, f.observation).status, "FAIL");
  });

for (const label of ["Work performed", "Recorded"])
  for (const problem of [
    "missing",
    "malformed",
    "duplicated",
    "hidden",
    "stale",
  ]) {
    test(`actual DOM and observer reject ${problem} ${label} timestamp`, async () =>
      inDom(async (doc) => {
        const f = fixture(),
          element = timeElement(doc, label);
        if (problem === "missing") element.parentElement.remove();
        if (problem === "malformed") element.textContent = "Invalid Date";
        if (problem === "duplicated")
          element.parentElement.after(element.parentElement.cloneNode(true));
        if (problem === "hidden") element.style.display = "none";
        if (problem === "stale") element.textContent = "1/1/1900, 12:00:00 AM";
        f.observation.visible = readDom(doc, f.expected);
        assert.equal(claim(f.expected, f.observation).status, "FAIL");
        const page = controlledPage(doc, f);
        assert.equal(
          (await ui.observeCompletedVisitUi(page, f.expected)).status,
          "FAIL",
        );
        assert.equal(page.requestEvents.listenerCount("request"), 0);
      }));
  }

test("DOM and observer compare timestamp display in the page realm and its locale/time zone", async () =>
  inDom(async (doc) => {
    const f = fixture(),
      intrinsic = doc.defaultView.Date.prototype.toLocaleString;
    doc.defaultView.Date.prototype.toLocaleString = function () {
      return intrinsic.call(this, "de-DE", { timeZone: "Europe/Berlin" });
    };
    setVisibleTimes(doc);
    const page = controlledPage(doc, f);
    assert.equal(
      (await ui.observeCompletedVisitUi(page, f.expected)).status,
      "PASS",
    );
    f.observation.visible = readDom(doc, f.expected);
    assert.deepEqual(
      [...f.observation.visible.completionPerformedAt],
      ["16.10.2026, 23:49:00"],
    );
    assert.deepEqual(
      [...f.observation.visible.completionRecordedAt],
      ["16.10.2026, 23:50:00"],
    );
    assert.equal(page.requestEvents.listenerCount("request"), 0);
  }));

for (const key of ["painless", "css"])
  for (const boundary of ["preflight", "observation", "screenshot"]) {
    test(`${key} preserves API PASS and attributes ${boundary} failure to its attempted completion UI`, async () => {
      assert.equal(
        typeof ui.recordCompletedVisitUi,
        "function",
        "async completion UI recording boundary is missing",
      );
      const caseId = key === "painless" ? "P-G" : "H-G";
      const prior = { caseIds: caseId, status: "PASS", step: "complete-api" },
        records = [prior];
      const error = Object.assign(
        Error(
          boundary === "preflight" ? "observed_session" : "image_write_failed",
        ),
        {
          code:
            boundary === "preflight"
              ? "observed_session"
              : "image_write_failed",
        },
      );
      await assert.rejects(
        ui.recordCompletedVisitUi({
          company: { key, name: `TEST ${key}` },
          record: (caseIds, status, _label, evidence, extra) =>
            records.push({ caseIds, status, evidence, ...extra }),
          preflight: async () => {
            if (boundary === "preflight") throw error;
          },
          observe: async () => {
            if (boundary === "observation") throw error;
            return { status: "PASS", reason: "exact_completed_visit_visible" };
          },
          screenshot: async () => {
            if (boundary === "screenshot") throw error;
            return "test.png";
          },
        }),
        (failure) => failure === error,
      );
      assert.equal(records[0], prior);
      assert.equal(records.length, 2);
      assert.equal(records[1].caseIds, caseId);
      assert.equal(records[1].status, "FAIL");
      assert.equal(records[1].step, "complete-ui");
      assert.deepEqual(records[1].evidence, []);
    });
  }

for (const key of ["painless", "css"])
  for (const status of ["PASS", "FAIL"])
    test(`${key} records the separate observed UI ${status} with its retained evidence`, async () => {
      const rows = [],
        caseId = key === "painless" ? "P-G" : "H-G";
      await ui.recordCompletedVisitUi({
        company: { key, name: `TEST ${key}` },
        record: (caseIds, uiStatus, _label, evidence, extra) =>
          rows.push({ caseIds, status: uiStatus, evidence, ...extra }),
        preflight: async () => {},
        observe: async () => ({
          status,
          reason:
            status === "PASS"
              ? "exact_completed_visit_visible"
              : "required_completion_ui_missing",
        }),
        screenshot: async () => "synthetic-ui.png",
      });
      assert.deepEqual(rows, [
        {
          caseIds: caseId,
          status,
          evidence: ["synthetic-ui.png"],
          company: `TEST ${key}`,
          step: "complete-ui",
          uiStatus: status,
          partial:
            "Synthetic visible UI correlated to fresh exact-visit reads; no physical photo or company acceptance claim.",
        },
      ]);
    });
