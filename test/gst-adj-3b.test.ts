import { describe, expect, it } from "vitest";
import { make3bWorkbook } from "./helpers/gst-adj-3b.js";
import { parseThreeB } from "../src/gst-adj-3b.js";

describe("parseThreeB month binding", () => {
  it("binds 12 fuzzy month headers positionally and reads the header block", () => {
    const s = parseThreeB(make3bWorkbook());
    expect(s.months).toEqual(["2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"]);
    expect(s.companyName).toBe("Test Constructions");
    expect(s.gstin).toBe("33AAAAA0000A0Z0");
    expect(s.state).toBe("Tamil Nadu");
  });
  it("accepts a part-year file", () => {
    const s = parseThreeB(make3bWorkbook({ months: ["October", "November", "December"] }));
    expect(s.months).toEqual(["2025-10", "2025-11", "2025-12"]);
  });
  it("throws citing the row when a header is not a month", () => {
    expect(() => parseThreeB(make3bWorkbook({ months: ["Foo", "May"] }))).toThrow(/row 4/i);
  });
});
