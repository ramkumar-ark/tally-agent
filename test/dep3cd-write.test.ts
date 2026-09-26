import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { makeDepWinmanFixture } from "./fixtures/winman-fixture.js";
import { readXlsm, partText } from "../src/xlsm.js";
import { readSchema } from "../src/winman3cd.js";
import { serial } from "../src/xlsx.js";
import { writeD3Bundle } from "./fixtures/dep3cd-fixture.js";

async function reviewed(dir: string) {
  const session = createSession(fakeDownstream({}), EMPTY_OVERRIDES);
  await session.dep3cdReview({ fromDate: "20250401", toDate: "20260331", dayBookPath: writeD3Bundle(dir) });
  return session;
}

describe("write3cdDepreciation", () => {
  it("writes additions and deletions into a copy; source untouched; names never written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d3w-"));
    const src = join(dir, "Demo_Depreciation as per IT Act.xlsm");
    writeFileSync(src, makeDepWinmanFixture());
    const before = readFileSync(src);
    const s = await reviewed(dir);
    const out = await s.write3cdDepreciation({ sourcePath: src, outPath: join(dir, "out") });
    expect(readFileSync(src).equals(before)).toBe(true);
    expect(out).toMatchObject({ additions: 4, deletions: 3, skipped: 2 });
    const pkg = readXlsm(readFileSync(out.written));
    const add = partText(pkg, readSchema(pkg, "Depreciation additions").partName);
    expect(add).toContain("5. Plant/ Machinery 15%:");
    expect(add).toContain("N/A");
    expect(add).toContain(`<c r="C7" s="81"><v>${serial("20250408")}</v></c>`);
    for (const real of ["Mixer Unit", "Site Van", "Store Box"]) expect(add).not.toContain(real);
    const del = partText(pkg, readSchema(pkg, "Depreciation deletions").partName);
    expect(del).toContain("<v>300000</v>");
    expect(del).not.toContain("<v>250000</v>");
  });
  it("block text outside the workbook list refuses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d3w-"));
    const src = join(dir, "wb.xlsm");
    writeFileSync(src, makeDepWinmanFixture({ additionsList: ["5. Plant & Machinery 15%"] }));
    const s = await reviewed(dir);
    await expect(s.write3cdDepreciation({ sourcePath: src, outPath: dir })).rejects.toThrow(/not in this workbook's list/);
  });
  it("wrong form id refuses; outPath onto the source refuses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d3w-"));
    const src = join(dir, "wb.xlsm");
    writeFileSync(src, makeDepWinmanFixture({ formId: "EmployeePFESIfunds" }));
    const s = await reviewed(dir);
    await expect(s.write3cdDepreciation({ sourcePath: src, outPath: dir })).rejects.toThrow(/DepreciationNew|belongs to form/);
    writeFileSync(src, makeDepWinmanFixture());
    await expect(s.write3cdDepreciation({ sourcePath: src, outPath: src })).rejects.toThrow(/source workbook itself/);
  });
  it("lock file yields a note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d3w-"));
    const src = join(dir, "wb.xlsm");
    writeFileSync(src, makeDepWinmanFixture());
    writeFileSync(join(dir, "~$wb.xlsm"), "lock");
    const s = await reviewed(dir);
    const out = await s.write3cdDepreciation({ sourcePath: src, outPath: join(dir, "o") });
    expect(out.notes.join(" ")).toMatch(/open in Excel/);
    expect(existsSync(out.written)).toBe(true);
  });
  it("re-running overwrites rather than appends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d3w-"));
    const src = join(dir, "wb.xlsm");
    writeFileSync(src, makeDepWinmanFixture());
    const s = await reviewed(dir);
    const first = await s.write3cdDepreciation({ sourcePath: src, outPath: join(dir, "a") });
    const second = await s.write3cdDepreciation({ sourcePath: first.written, outPath: join(dir, "b") });
    const pkg = readXlsm(readFileSync(second.written));
    const add = partText(pkg, readSchema(pkg, "Depreciation additions").partName);
    expect(add.match(/<row r="\d+"/g)!.length).toBe(5 + 4);
  });
});