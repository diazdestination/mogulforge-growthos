import { describe, expect, it } from "vitest";
import { parseCsvPreview, suggestCustomerMapping } from "./csv-preview";

describe("parseCsvPreview", () => {
  it("keeps quoted commas, doubled quotes, CRLF and a BOM in the right columns", () => {
    const rows = parseCsvPreview('﻿First Name,Notes,Email\r\n"Smith, Jane","said ""hi""",jane@example.test\r\nBo,,bo@example.test\r\n');
    expect(rows).toEqual([
      ["First Name", "Notes", "Email"],
      ["Smith, Jane", 'said "hi"', "jane@example.test"],
      ["Bo", "", "bo@example.test"],
    ]);
  });
  it("stops after the requested rows", () => {
    expect(parseCsvPreview("a\n1\n2\n3\n4", 2)).toEqual([["a"], ["1"]]);
  });

  it("preserves multiline quoted fields", () => {
    expect(parseCsvPreview('First,Email\r\n"Ann\r\nAble",ann@example.invalid\r\n')).toEqual([
      ["First", "Email"], ["Ann\r\nAble", "ann@example.invalid"],
    ]);
  });

  it.each([
    'First,Email\n"Ann","ann@example.invalid\nBob,bob@example.invalid\n',
    'First,Email\nAn"n,ann@example.invalid\n',
    'First,Email\n"Ann"x,ann@example.invalid\n',
    'First,Email\nAnn,ann@example.invalid\nBob,bob@example.invalid\n"Unclosed,email@example.invalid',
    'First,Email\nAnn,ann@example.invalid\nBob,bob@example.invalid\nStray"quote,email@example.invalid',
  ])("rejects malformed quotes across the entire file even beyond the preview sample", (csv) => {
    expect(() => parseCsvPreview(csv, 2)).toThrow(/CSV.*quot/i);
  });
});

describe("suggestCustomerMapping", () => {
  it("suggests only clear generic header matches and never reuses a column", () => {
    expect(suggestCustomerMapping(["ID", "First Name", "Last Name", "Mobile Number", "Email", "Company", "Notes"])).toEqual({
      externalCustomerId: 0, firstName: 1, lastName: 2, phone: 3, email: 4,
    });
    expect(suggestCustomerMapping(["Customer", "Contact info"])).toEqual({});
  });
});
