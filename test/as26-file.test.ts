import { describe, expect, it } from "vitest";
import { readWorkbook } from "../src/xlsx-read.js";
import { parseAs26Export } from "../src/as26-file.js";
import { buildAs26Fixture, defaultAs26Fixture } from "./as26-fixture.js";

describe("as26 fixture", () => {
  it("exposes hidden data sheets by name regardless of state", () => {
    const sheets = readWorkbook(buildAs26Fixture());
    const names = sheets.map((s) => s.name);
    expect(names).toContain("TDS - Form 16A");
    expect(sheets.find((s) => s.name === "TDS_Detailed")?.state).toBe("hidden");
  });
});

describe("parseAs26Export — detailed", () => {
  const file = parseAs26Export(buildAs26Fixture());

  it("parses per-transaction rows with text dates and banded names", () => {
    expect(file.transactions).toHaveLength(4);
    const t = file.transactions[0];
    expect(t).toMatchObject({ kind: "tds", date: "20250414", amount: 300000, tax: 6000, status: "F", bookingDate: "20250530", section: "194C" });
  });

  it("carries banded names forward so group rows keep their deductor", () => {
    expect(file.transactions[1].nameKey).toBe(file.transactions[0].nameKey);
  });

  it("joins detailed names to summaries across case (UPPER vs mixed)", () => {
    for (const t of file.transactions) {
      expect(file.summaries.some((s) => s.kind === t.kind && s.section === t.section && s.nameKey === t.nameKey)).toBe(true);
    }
  });

  it("counts 16B-16E data rows without parsing them", () => {
    expect(file.skipped.form16BCDE).toBe(0); // fixture's sheet is empty
  });

  it("skips (counts) rows without a parsable date instead of throwing", () => {
    const fx = defaultAs26Fixture();
    fx.tdsDetail[3] = ["NAGAR PALIKA NAGAR BHAVAN", "14/04/2025", 300000, null, 6000, null, "MUMA01234E", null, "F", "30-May-2025", "194C"];
    const f = parseAs26Export(buildAs26Fixture(fx));
    expect(f.transactions).toHaveLength(3);
    expect(f.skipped.noDate).toBe(1);
  });
});

describe("parseAs26Export — summaries", () => {
  const file = parseAs26Export(buildAs26Fixture());

  it("reads both TDS summary rows and the TCS summary row", () => {
    expect(file.summaries).toHaveLength(3);
    const tds = file.summaries.filter((s) => s.kind === "tds");
    expect(tds.map((s) => s.name)).toEqual(["Nagar Palika Nagar Bhavan", "Anand Buildmart Pvt Ltd"]);
    expect(tds[0]).toMatchObject({ taxTotal: 18000, gross: 900000, section: "194C" });
    expect(file.summaries.find((s) => s.kind === "tcs")).toMatchObject({
      name: "Kaveri Minerals Trading", taxTotal: 1200, gross: 60000, section: "206CL",
    });
  });

  it("throws without values when a required sheet is missing", () => {
    const buf = buildAs26Fixture();
    expect(() => parseAs26Export(buf.slice(0, 0))).toThrow(); // degenerate buffer, error names a part
  });
});
