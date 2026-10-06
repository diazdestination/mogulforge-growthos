/**
 * Original, editable research suggestions, never adopted company procedures.
 * No answers, thresholds, recurrence, coverage or physical completion is seeded.
 * Copy to a company draft and review the exact revision before visit enrollment.
 */
export const WORKDAY_CHECKLIST_STARTERS = [
  {
    id: "hvac_routine_visit",
    version: 1,
    title: "HVAC routine visit",
    description: "Suggested recording prompts for qualified staff. Adapt to the actual system and company procedures; not a warranty or safety certification.",
    sourceUrls: [
      "https://www.energystar.gov/saveathome/heating-cooling/maintenance-checklist",
      "https://help.housecallpro.com/en/articles/3703307-property-profile",
      "https://help.getjobber.com/en/articles/checklists/",
    ],
    definition: {
      name: "HVAC routine visit",
      trade: "hvac",
      description: "Draft baseline: review and customize before use. Record observations without assuming safe operation or warranty eligibility.",
      items: [
        { key: "work_scope", label: "Confirm the property, unit and agreed visit scope", kind: "result", required: true, allowNotApplicable: false, unit: null },
        { key: "airflow_observation", label: "Record filter and airflow observations under the company procedure", kind: "result", required: false, allowNotApplicable: true, unit: null },
        { key: "drainage_observation", label: "Record accessible drainage or moisture observations", kind: "result", required: false, allowNotApplicable: true, unit: null },
        { key: "operation_observation", label: "Record relevant control or operating observations", kind: "text", required: false, allowNotApplicable: true, unit: null },
        { key: "visit_photos", label: "Attach current unit or finding photos when safely available", kind: "photo", required: false, allowNotApplicable: true, unit: null },
        { key: "work_summary", label: "Describe work performed, limitations and any office follow-up", kind: "text", required: true, allowNotApplicable: false, unit: null },
      ],
    },
  },
  {
    id: "roof_inspection_visit",
    version: 1,
    title: "Roof inspection or maintenance visit",
    description: "Suggested recording prompts for qualified staff. Review for the actual roof, access conditions, contract and manufacturer instructions.",
    sourceUrls: [
      "https://support.jobnimbus.com/how-do-i-use-the-forms-feature",
      "https://www.gaf.com/en-us/document-library/documents/brochures-&-literature/maximize_the_life_of_your_roof_proactive_maintenance_checklist__resgn777c.pdf",
    ],
    definition: {
      name: "Roof inspection or maintenance visit",
      trade: "roofing",
      description: "Draft baseline: review and customize before use. Recorded observations are not an insurance, code-compliance or warranty determination.",
      items: [
        { key: "work_scope", label: "Confirm the property, roof area and safely accessible visit scope", kind: "result", required: true, allowNotApplicable: false, unit: null },
        { key: "roof_observation", label: "Record visible covering, flashing or penetration observations", kind: "result", required: false, allowNotApplicable: true, unit: null },
        { key: "drainage_observation", label: "Record accessible drainage or gutter observations", kind: "result", required: false, allowNotApplicable: true, unit: null },
        { key: "finding_notes", label: "Describe findings or areas requiring further qualified review", kind: "text", required: false, allowNotApplicable: true, unit: null },
        { key: "visit_photos", label: "Attach overview or finding photos when safely available", kind: "photo", required: false, allowNotApplicable: true, unit: null },
        { key: "work_summary", label: "Describe work performed, limitations and the next office action", kind: "text", required: true, allowNotApplicable: false, unit: null },
      ],
    },
  },
] as const;

/** Each consumer receives a fresh draftable copy, not a mutable shared preset. */
export function getWorkdayChecklistStarters() {
  return structuredClone(WORKDAY_CHECKLIST_STARTERS);
}
