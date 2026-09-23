import { describe, expect, it } from "vitest";
import { readWorkbook } from "../src/xlsx-read.js";
import { buildAs26Fixture } from "./as26-fixture.js";

describe("as26 fixture", () => {
  it("exposes hidden data sheets by name regardless of state", () => {
    const sheets = readWorkbook(buildAs26Fixture());
    const names = sheets.map((s) => s.name);
    expect(names).toContain("TDS - Form 16A");
    expect(sheets.find((s) => s.name === "TDS_Detailed")?.state).toBe("hidden");
  });
});
