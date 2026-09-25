import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { makeLoansWinmanFixture } from "./fixtures/winman-fixture.js";
import { readXlsm, partText } from "../src/xlsm.js";
import { readSchema, readHandshake } from "../src/winman3cd.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("loans winman fixture", () => {
  it("carries the loans form id, schemas, and handshake", () => {
    const dir = mkdtempSync(join(tmpdir(), "loans-fx-"));
    const path = join(dir, "loans-fx.xlsm");
    writeFileSync(path, makeLoansWinmanFixture());
    const pkg = readXlsm(readFileSync(path));
    const hs = readHandshake(pkg);
    expect(hs.assessmentYear).toBe("2026-2027");
    expect(hs.validationOn).toBe(true);
    const s1 = readSchema(pkg, "Sec.269SS Loans & Deposits");
    expect(s1.formId).toBe("269SS/269T_LoansAc/RpinCash");
    expect(s1.firstDataRow).toBe(8);
    expect(s1.keys.get("NAME")).toBe(0);
    expect(s1.keys.get("RECIEPTNONAC")).toBe(6);
    const s4 = readSchema(pkg, "Sec.269T Repayments Others");
    expect(s4.keys.get("ADDRESS")).toBe(6);
    const s6 = readSchema(pkg, "Sec.269ST_others");
    expect(s6.firstDataRow).toBe(9);
    expect(s6.keys.get("DATE")).toBe(4);
    expect(() => readSchema(pkg, "nope")).toThrow();
  });
});
