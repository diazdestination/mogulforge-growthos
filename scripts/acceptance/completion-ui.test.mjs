import { test } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

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
          <dl><div><dt>Outcome: </dt><dd>completed</dd></div><div><dt>Performer: </dt><dd>00000000-0000-4000-8000-000000000010</dd></div></dl>
          <p>1 saved work entry · native visit marked completed.</p>
        </section>
      </section>
    </section>
  </section>
  <section aria-label="Schedule"><p>Completed</p><p>TEST unrelated customer</p></section>`;

async function inDom(action) {
  const dom = new JSDOM(markup),
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
  try {
    return await action(dom.window.document);
  } finally {
    globalThis.getComputedStyle = oldStyle;
    dom.window.close();
  }
}

test("projects the selected actual DOM and ignores an unrelated schedule Completed label", async () =>
  inDom((doc) => {
    const f = fixture();
    f.observation.visible = ui.readCompletedVisitDom(
      doc.querySelector('[aria-label="Selected appointment"]'),
    );
    assert.equal(claim(f.expected, f.observation).status, "PASS");
    doc.querySelector(
      '[aria-label="Selected appointment"] > dl dd',
    ).textContent = "Scheduled";
    f.observation.visible = ui.readCompletedVisitDom(
      doc.querySelector('[aria-label="Selected appointment"]'),
    );
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
      f.observation.visible = ui.readCompletedVisitDom(
        doc.querySelector('[aria-label="Selected appointment"]'),
      );
      assert.equal(claim(f.expected, f.observation).status, "FAIL");
    }));

// Only the transport/Playwright boundary is doubled. The collector, response
// binding, real DOM projection and acceptance predicate all execute unchanged.
function controlledPage(doc, f, changeWork = () => {}) {
  let url = origin + "/",
    pending = [],
    opened = false;
  function emit(value) {
    const response = {
      url: () => value.url,
      status: () => value.status,
      request: () => ({
        method: () => value.method,
        redirectedFrom: () => null,
      }),
      fromServiceWorker: () => false,
      json: async () => structuredClone(value.json),
    };
    for (const waiter of pending)
      if (waiter.predicate(response)) {
        clearTimeout(waiter.timer);
        waiter.resolve(response);
      }
  }
  const selected = {
    waitFor: async () => {},
    getByRole(role, options) {
      if (role === "button" && options.name === "Open visit work")
        return {
          click: async () => {
            opened = true;
            changeWork(f.observation.work);
            emit(f.observation.work);
          },
        };
      if (role === "region" && options.name === "Recorded work completion")
        return {
          waitFor: async () => {
            if (!opened) throw Error("work_not_open");
          },
        };
      throw Error("unexpected_selected_locator");
    },
    evaluate: async (fn) =>
      fn(doc.querySelector('[aria-label="Selected appointment"]')),
  };
  return {
    url: () => url,
    waitForResponse(predicate) {
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
      url = target;
      emit(f.observation.detail);
    },
    getByRole: (role, options) => {
      if (role !== "region" || options.name !== "Selected appointment")
        throw Error("unscoped_locator");
      return selected;
    },
  };
}
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
