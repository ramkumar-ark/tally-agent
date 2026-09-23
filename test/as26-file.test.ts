import { describe, expect, it } from "vitest";
import { readWorkbook } from "../src/xlsx-read.js";
import { parseAs26Export } from "../src/as26-file.js";
import { buildAs26Fixture } from "./as26-fixture.js";

describe("as26 fixture", () => {
  it("exposes hidden data sheets by name regardless of state", () => {
    const sheets = readWorkbook(buildAs26Fixture());
    const names = sheets.map((s) => s.name);
    expect(names).toContain("TDS - Form 16A");
    expect(sheets.find((s) => s.name === "TDS_Detailed")?.state).toBe("hidden");
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
