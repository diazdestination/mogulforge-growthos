import { describe, expect, it } from "vitest";
import { getWorkdayChecklistStarters, WORKDAY_CHECKLIST_STARTERS } from "./contractor-workday-baselines";
import { workdayStarterSchema } from "./contractor-workday-contract";

describe("original researched workday starters", () => {
  it("provides two closed editable suggestions with no answers or automatic authority", () => {
    expect(WORKDAY_CHECKLIST_STARTERS).toHaveLength(2);
    for (const starter of WORKDAY_CHECKLIST_STARTERS) {
      expect(workdayStarterSchema.parse(starter)).toEqual(starter);
      expect(starter.definition.items).toHaveLength(6);
      expect(new Set(starter.definition.items.map(item => item.key)).size).toBe(6);
      expect(starter.description).toMatch(/Suggested/);
      expect(starter.definition.description).toMatch(/Draft baseline/);
      expect(starter).not.toHaveProperty("reviewedAt");
      expect(starter).not.toHaveProperty("answers");
      expect(starter).not.toHaveProperty("recurrence");
      expect(starter).not.toHaveProperty("warrantyCoverage");
      for (const url of starter.sourceUrls) expect(new URL(url).protocol).toBe("https:");
      expect(starter.definition.items.find(item => item.kind === "photo")?.required).toBe(false);
    }
  });

  it("returns isolated copies so a company draft cannot change another baseline", () => {
    const first = getWorkdayChecklistStarters();
    (first[0].definition.items[0] as { label: string }).label = "Company-specific edited prompt";
    expect(getWorkdayChecklistStarters()[0].definition.items[0].label).toBe("Confirm the property, unit and agreed visit scope");
    expect(WORKDAY_CHECKLIST_STARTERS[0].definition.items[0].label).toBe("Confirm the property, unit and agreed visit scope");
  });
});
