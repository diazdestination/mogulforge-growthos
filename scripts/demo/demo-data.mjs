// Fictional TEST data for the October 17 soft-onboarding demo.
//
// Every person, phone, email and address here is invented. Phones use the
// reserved 555-01xx range, emails use example.com, and every record carries a
// visible TEST label. No real customer data, ever.
//
// Times are wall-clock times in the company time zone on a day offset from the
// demo date (day 0 = demo day). The seeder converts them to instants.
//
// The reviewed demo date is frozen. Staging runs must use exactly this date
// (and each company's reviewed time zone below); only the disposable local
// runtime may rehearse on another date. Existing visits are never relabeled.
export const DEMO_DATE = "2026-10-17";

const css = {
  key: "css",
  name: "TEST Demo - Climate Simulation Solutions (HVAC)",
  slug: "test-demo-css-hvac",
  profile: "hvac",
  trade: "hvac",
  // Placeholder until the owner confirms hours/time zone (O-15). TEST only.
  timezone: "America/New_York",
  staff: [
    { key: "owner", email: "demo-css-owner@example.com", first: "Marcus", last: "Reyes (TEST owner)", role: "owner" },
    { key: "tech", email: "demo-css-tech@example.com", first: "Jordan", last: "Pike (TEST tech)", role: "production" },
  ],
  customers: [
    { key: "whitfield", first: "Dana", last: "Whitfield (TEST)", phone: "(555) 555-0101", email: "dana.whitfield@example.com", address: ["412 Larkspur Ln", "Cedar Glen", "NC", "28790"] },
    { key: "ortega", first: "Luis", last: "Ortega (TEST)", phone: "(555) 555-0102", email: "luis.ortega@example.com", address: ["88 Old Mill Rd", "Cedar Glen", "NC", "28790"] },
    { key: "natarajan", first: "Priya", last: "Natarajan (TEST)", phone: "(555) 555-0103", email: "priya.natarajan@example.com", address: ["1507 Brookstone Ct", "Pine Hollow", "NC", "28791"] },
    { key: "moss", first: "Gerald", last: "Moss (TEST)", phone: "(555) 555-0104", email: "gerald.moss@example.com", address: ["23 Chestnut Hollow", "Ashbury Springs", "NC", "28792"] },
    { key: "brown", first: "Keisha", last: "Brown (TEST)", phone: "(555) 555-0105", email: "keisha.brown@example.com", address: ["640 Ridgecrest Ave", "Pine Hollow", "NC", "28791"] },
    { key: "albright", first: "Tom", last: "Albright (TEST)", phone: "(555) 555-0106", email: "tom.albright@example.com", address: ["9 Willow Bend", "Ashbury Springs", "NC", "28792"] },
    { key: "delgado", first: "Rosa", last: "Delgado (TEST)", phone: "(555) 555-0107", email: "rosa.delgado@example.com", address: ["301 Summit View Dr", "Cedar Glen", "NC", "28790"] },
    { key: "kim", first: "Harold", last: "Kim (TEST)", phone: "(555) 555-0108", email: "harold.kim@example.com", address: ["77 Cedar Knoll", "Pine Hollow", "NC", "28791"] },
  ],
  leads: [
    { key: "nocool", customer: "whitfield", serviceType: "AC repair - no cooling", source: "phone", urgency: "emergency", status: "inspection_scheduled", valueCents: 48500,
      summary: "TEST: Upstairs AC blowing warm since last night. Outdoor unit hums but fan not spinning. Two kids at home." },
    { key: "tuneup", customer: "ortega", serviceType: "Furnace tune-up", source: "google", urgency: "normal", status: "inspection_scheduled", valueCents: 14900,
      summary: "TEST: Wants furnace checked before cold weather. Gas furnace, about 9 years old." },
    { key: "heatpump", customer: "natarajan", serviceType: "Heat pump replacement quote", source: "referral", urgency: "normal", status: "estimate_preparing", valueCents: 1185000,
      summary: "TEST: 17-year-old heat pump, rising power bills, asked for replacement options. Referred by a neighbor." },
    { key: "moss-repair", customer: "moss", serviceType: "Furnace repair - ignitor", source: "phone", urgency: "high", status: "completed", valueCents: 38500,
      summary: "TEST: Furnace short-cycling and not lighting. Replaced hot surface ignitor and cleaned flame sensor." },
    { key: "brown-drain", customer: "brown", serviceType: "AC repair - condensate drain", source: "website", urgency: "normal", status: "completed", valueCents: 18900,
      summary: "TEST: Water around the indoor unit. Cleared clogged condensate line and added a float switch." },
    { key: "kim-minisplit", customer: "kim", serviceType: "Ductless mini-split quote", source: "facebook", urgency: "low", status: "contact_attempted", valueCents: 640000,
      summary: "TEST: Wants a ductless unit for a converted garage office. Left voicemail, waiting on callback." },
  ],
  smartSiteLead: {
    customer: "delgado",
    summary: "TEST: Outdoor AC unit making a grinding noise when it starts. Still cooling for now. Prefers mornings.",
    timing: "soon",
  },
  estimates: [
    { key: "nocool-repair", lead: "nocool", title: "TEST - AC repair: capacitor and contactor", status: "draft", notes: "TEST: Price includes diagnostic fee credit.",
      lines: [["Dual run capacitor 45/5 MFD", 1, 18500], ["Contactor, 2-pole 30A", 1, 12500], ["Labor - repair visit", 1.5, 11000]] },
    { key: "hp-good", lead: "heatpump", title: "TEST - Heat pump replacement - GOOD (14.3 SEER2, single-stage)", status: "draft", notes: "TEST option 1 of 3. 10-year parts warranty.",
      lines: [["3-ton heat pump + matching air handler, single-stage", 1, 785000], ["Line set flush, pad, disconnect", 1, 65000], ["Permit and haul-away", 1, 35000]] },
    { key: "hp-better", lead: "heatpump", title: "TEST - Heat pump replacement - BETTER (16 SEER2, two-stage)", status: "draft", notes: "TEST option 2 of 3. 10-year parts + 2-year labor.",
      lines: [["3-ton heat pump + air handler, two-stage", 1, 965000], ["Smart thermostat", 1, 32000], ["Line set flush, pad, disconnect", 1, 65000], ["Permit and haul-away", 1, 35000]] },
    { key: "hp-best", lead: "heatpump", title: "TEST - Heat pump replacement - BEST (19 SEER2, variable speed)", status: "draft", notes: "TEST option 3 of 3. 12-year parts + 10-year labor.",
      lines: [["3-ton variable-speed heat pump + air handler", 1, 1240000], ["Communicating thermostat", 1, 48000], ["Media air filter cabinet", 1, 42000], ["New line set, pad, disconnect", 1, 110000], ["Permit and haul-away", 1, 35000]] },
    { key: "kim-minisplit-est", lead: "kim-minisplit", title: "TEST - Ductless mini-split, 12k BTU single zone", status: "draft", notes: "TEST: Pending site visit to confirm line route.",
      lines: [["12k BTU ductless heat pump, single zone", 1, 485000], ["Line hide kit and pad", 1, 45000], ["Electrical circuit (by licensed electrician)", 1, 95000]] },
  ],
  appointments: [
    { key: "a-moss", customer: "moss", lead: "moss-repair", staff: "tech", type: "production", day: 0, start: "07:30", minutes: 90, complete: true,
      notes: "TEST: Furnace ignitor replacement - done. Customer paid by check on site." },
    { key: "a-nocool", customer: "whitfield", lead: "nocool", staff: "tech", type: "inspection", day: 0, start: "10:00", minutes: 90,
      notes: "TEST: No-cool diagnostic. Bring 45/5 capacitor and contactor on the truck." },
    { key: "a-tuneup", customer: "ortega", lead: "tuneup", staff: "tech", type: "production", day: 1, start: "09:00", minutes: 60,
      notes: "TEST: Fall furnace tune-up (maintenance plan visit)." },
    { key: "a-heatpump", customer: "natarajan", lead: "heatpump", staff: "owner", type: "estimate_review", day: 2, start: "13:00", minutes: 60,
      notes: "TEST: Walk through Good / Better / Best heat pump options at the kitchen table." },
    { key: "a-albright", customer: "albright", staff: "tech", type: "production", day: 3, start: "14:00", minutes: 60,
      notes: "TEST: Service agreement visit - AC/heat pump fall check." },
  ],
  tasks: [
    { key: "t-whitfield", customer: "whitfield", lead: "nocool", staff: "owner", day: 0, due: "09:00", priority: "high", title: "TEST: Text Dana Whitfield the tech's arrival window" },
    { key: "t-kim", customer: "kim", lead: "kim-minisplit", staff: "owner", day: 0, due: "15:00", priority: "normal", title: "TEST: Call Harold Kim back about the mini-split quote" },
  ],
  assets: [
    { key: "moss-furnace", customer: "moss", category: "hvac_equipment", label: "TEST gas furnace - basement", manufacturer: "TEST Comfortline", model: "TF-80-60", serial: "TEST-CSS-0001",
      installedOn: "2015-10-02", warrantyStartsOn: "2015-10-02", warrantyEndsOn: "2025-10-02", warrantySource: "TEST: manufacturer registration (fictional)" },
    { key: "albright-hp", customer: "albright", category: "hvac_equipment", label: "TEST heat pump - side yard", manufacturer: "TEST Comfortline", model: "TH-36-16", serial: "TEST-CSS-0002",
      installedOn: "2021-05-14", warrantyStartsOn: "2021-05-14", warrantyEndsOn: "2031-05-14", warrantySource: "TEST: manufacturer registration (fictional)" },
  ],
  invoices: [
    { key: "inv-moss", customer: "moss", title: "TEST - Furnace repair: ignitor and flame sensor", issue: true, paidInFull: true, payRef: "TEST check #1043",
      lines: [["Hot surface ignitor", 1, 14500], ["Flame sensor clean and test", 1, 6500], ["Labor - repair visit", 1.5, 11500]] },
    { key: "inv-brown", customer: "brown", title: "TEST - AC condensate drain clearing", issue: true, paidInFull: false,
      lines: [["Condensate line clearing", 1, 11900], ["Float safety switch", 1, 7000]] },
  ],
  serviceAgreements: [
    { key: "sa-albright", customer: "albright", kind: "maintenance", equipmentLabel: "TEST heat pump - side yard", dueInDays: 3, noticeDays: 3, intervalMonths: 6, staff: "tech",
      note: "TEST: Comfort Club plan - spring AC and fall heat checks (fictional)" },
    { key: "sa-ortega", customer: "ortega", kind: "maintenance", equipmentLabel: "TEST gas furnace", dueInDays: 1, noticeDays: 1, intervalMonths: 12, staff: "tech",
      note: "TEST: Annual furnace tune-up plan (fictional)" },
  ],
  returningWork: [],
};

const painless = {
  key: "painless",
  name: "TEST Demo - Painless Roofing",
  slug: "test-demo-painless-roofing",
  profile: "roofing-exteriors",
  trade: "roofing",
  timezone: "America/New_York",
  staff: [
    { key: "owner", email: "demo-painless-owner@example.com", first: "Renee", last: "Calloway (TEST owner)", role: "owner" },
    { key: "inspector", email: "demo-painless-inspector@example.com", first: "Dwayne", last: "Ellis (TEST inspector)", role: "inspector" },
  ],
  customers: [
    { key: "castellano", first: "Brian", last: "Castellano (TEST)", phone: "(555) 555-0121", email: "brian.castellano@example.com", address: ["1820 Hawthorne Dr", "Hartwell Ridge", "OH", "44690"] },
    { key: "grant", first: "Melissa", last: "Grant (TEST)", phone: "(555) 555-0122", email: "melissa.grant@example.com", address: ["56 Juniper St", "Hartwell Ridge", "OH", "44690"] },
    { key: "oduya", first: "Frank", last: "Oduya (TEST)", phone: "(555) 555-0123", email: "frank.oduya@example.com", address: ["930 Stillwater Rd", "Brookline Falls", "OH", "44691"] },
    { key: "jimenez", first: "Carla", last: "Jimenez (TEST)", phone: "(555) 555-0124", email: "carla.jimenez@example.com", address: ["14 Orchard Gate", "Hartwell Ridge", "OH", "44690"] },
    { key: "park", first: "Steve", last: "Park (TEST)", phone: "(555) 555-0125", email: "steve.park@example.com", address: ["2207 Lakeshore Blvd", "Brookline Falls", "OH", "44691"] },
    { key: "harper", first: "Linda", last: "Harper (TEST)", phone: "(555) 555-0126", email: "linda.harper@example.com", address: ["455 Foxglove Way", "Hartwell Ridge", "OH", "44690"] },
    { key: "haddad", first: "Omar", last: "Haddad (TEST)", phone: "(555) 555-0127", email: "omar.haddad@example.com", address: ["71 Birch Hollow", "Brookline Falls", "OH", "44691"] },
    { key: "fowler", first: "Janet", last: "Fowler (TEST)", phone: "(555) 555-0128", email: "janet.fowler@example.com", address: ["388 Meadowlark Ln", "Hartwell Ridge", "OH", "44690"] },
  ],
  leads: [
    { key: "storm", customer: "castellano", serviceType: "Storm damage inspection (hail)", source: "phone", urgency: "high", status: "inspection_scheduled", valueCents: 1650000,
      summary: "TEST: Hail on Tuesday. Neighbors getting roofs replaced. Wants an inspection before calling insurance." },
    { key: "leak", customer: "grant", serviceType: "Roof leak repair", source: "google", urgency: "emergency", status: "inspection_scheduled", valueCents: 85000,
      summary: "TEST: Water stain spreading on kitchen ceiling after rain. Bucket under it. Wants someone out today." },
    { key: "replacement", customer: "oduya", serviceType: "Full roof replacement quote", source: "referral", urgency: "normal", status: "estimate_preparing", valueCents: 1845000,
      summary: "TEST: 24-year-old 3-tab roof, curling shingles, selling the house next spring. Inspection done, measurements taken." },
    { key: "gutters", customer: "jimenez", serviceType: "Flashing and gutter check", source: "website", urgency: "normal", status: "new", valueCents: 60000,
      summary: "TEST: Gutters overflowing on the back side; worried about the chimney flashing." },
    { key: "park-boot", customer: "park", serviceType: "Pipe boot replacement", source: "phone", urgency: "normal", status: "completed", valueCents: 42500,
      summary: "TEST: Small leak at the bathroom vent pipe. Replaced cracked pipe boot." },
    { key: "fowler-ref", customer: "fowler", serviceType: "Roof inspection (referral)", source: "referral", urgency: "low", status: "contact_attempted", valueCents: 0,
      summary: "TEST: Referred by Linda Harper. Wants a roof check before winter. Left a voicemail." },
  ],
  smartSiteLead: {
    customer: "haddad",
    summary: "TEST: Several shingles missing on the north side after last night's wind. No leak inside yet.",
    timing: "soon",
  },
  estimates: [
    { key: "leak-repair", lead: "leak", title: "TEST - Leak repair: step flashing at kitchen wall", status: "draft", notes: "TEST: Interior drywall repair not included.",
      lines: [["Remove shingles, replace step flashing (12 ft)", 1, 52000], ["Ice and water underlayment patch", 1, 9500], ["Labor - 2-person crew, half day", 1, 24000]] },
    { key: "replacement-est", lead: "replacement", title: "TEST - Full roof replacement: architectural shingles (28 squares)", status: "draft", notes: "TEST: Lifetime limited shingle warranty plus 10-year workmanship. Price valid 30 days.",
      lines: [["Tear-off and disposal, 1 layer (per square)", 28, 9500], ["Architectural shingles installed (per square)", 28, 38500], ["Ice and water shield - eaves and valleys", 1, 145000], ["Synthetic underlayment", 1, 98000], ["Ridge vent (40 ft)", 1, 52000], ["New drip edge and pipe boots", 1, 61000], ["Permit and final cleanup with magnet sweep", 1, 45000]] },
  ],
  appointments: [
    { key: "a-storm", customer: "castellano", lead: "storm", staff: "inspector", type: "inspection", day: 0, start: "09:00", minutes: 90,
      notes: "TEST: Hail damage inspection - photos of every slope, soft metals and gutters for the insurance file." },
    { key: "a-leak", customer: "grant", lead: "leak", staff: "inspector", type: "inspection", day: 0, start: "13:30", minutes: 60,
      notes: "TEST: Active leak over kitchen. Tarp on the truck in case it rains." },
    { key: "a-replacement", customer: "oduya", lead: "replacement", staff: "owner", type: "estimate_review", day: 1, start: "16:00", minutes: 60,
      notes: "TEST: Go over the replacement estimate and shingle color samples with Frank and Diane." },
    { key: "a-gutters", customer: "jimenez", lead: "gutters", staff: "inspector", type: "inspection", day: 2, start: "10:00", minutes: 60,
      notes: "TEST: Flashing and gutter inspection." },
    { key: "a-harper", customer: "harper", staff: "inspector", type: "inspection", day: 3, start: "11:00", minutes: 60,
      notes: "TEST: Returning customer - check small leak near skylight on the 2019 roof (workmanship warranty)." },
  ],
  tasks: [
    { key: "t-grant", customer: "grant", lead: "leak", staff: "owner", day: 0, due: "08:30", priority: "high", title: "TEST: Confirm Melissa Grant's leak visit window" },
    { key: "t-fowler", customer: "fowler", lead: "fowler-ref", staff: "owner", day: 0, due: "14:00", priority: "normal", title: "TEST: Call Janet Fowler back (referral from Linda Harper)" },
  ],
  assets: [
    { key: "harper-roof", customer: "harper", category: "roof_system", label: "TEST main roof - architectural shingle (2019)", manufacturer: "TEST Shieldline", model: "Architectural 30", serial: "TEST-PR-0001",
      installedOn: "2019-06-12", warrantyStartsOn: "2019-06-12", warrantyEndsOn: "2029-06-12", warrantySource: "TEST: Painless 10-year workmanship warranty (fictional)" },
  ],
  invoices: [
    { key: "inv-park", customer: "park", title: "TEST - Pipe boot replacement", issue: true, paidInFull: false,
      lines: [["Pipe boot replacement", 2, 9500], ["Labor and seal", 1, 23500]] },
    { key: "inv-harper-prior", customer: "harper", title: "TEST - 2019 roof replacement (prior job, for history)", issue: true, paidInFull: true, payRef: "TEST check #2210",
      lines: [["Roof replacement, 24 squares (prior job)", 1, 1420000]] },
  ],
  serviceAgreements: [
    { key: "sa-harper", customer: "harper", kind: "warranty_check", equipmentLabel: "TEST main roof - architectural shingle (2019)", dueInDays: 3, noticeDays: 3, intervalMonths: 12, staff: "inspector",
      note: "TEST: Annual workmanship-warranty roof check (fictional)" },
  ],
  returningWork: [
    { key: "rw-harper", customer: "harper", title: "TEST - Skylight flashing reseal (returning customer)", notes: "TEST: Covered labor under workmanship warranty; materials only.",
      lines: [["Skylight flashing reseal - materials", 1, 18500]] },
  ],
};

export const DEMO_COMPANIES = { css, painless };
