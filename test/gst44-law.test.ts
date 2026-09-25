// test/gst44-law.test.ts
import { describe, expect, it } from "vitest";
import {
  CLAUSE_44_ROWS,
  GST44_BUCKETS,
  GST44_CONFIRMS,
  GST44_FORM_ID,
  GST44_SHEET,
  GST44_TEMPLATE_STATUSES,
} from "../src/gst44-law.js";

describe("gst44 law", () => {
  it("pins the Winman sheet identity", () => {
    expect(GST44_SHEET).toBe("Break-up of GST expenditure");
    expect(GST44_FORM_ID).toBe("3CDGSTbreakup44");
  });
  it("ships exactly the two pre-filled rows, labels verbatim", () => {
    expect(CLAUSE_44_ROWS.map((r) => r.label)).toEqual(["Capital Expenditure", "Revenue Expenditure"]);
  });
  it("has one template status per bucket and no more", () => {
    expect(GST44_TEMPLATE_STATUSES.map((s) => s.key).sort()).toEqual([...GST44_BUCKETS].sort());
  });
  it("carries six confirm points", () => {
    expect(GST44_CONFIRMS.length).toBe(6);
    expect(GST44_CONFIRMS.every((c) => /^C[1-6]:/.test(c))).toBe(true);
  });
});
