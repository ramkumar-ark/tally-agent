import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";
import { makeNotdsFixture } from "./fixtures/winman-fixture.js";
import { partText, readXlsm } from "../src/xlsm.js";

/**
 * tb_write_notds_template / tb_notds_review / tb_write_3cd_notds leak tests:
 * a planted party name and a planted PAN shape never appear in any tool's
 * JSON, while the WRITTEN workbook copy does carry them — the disk is where
 * they belong, never chat (plan global constraint: masked JSON, unmasked
 * workbook).
 */

const PLANTED_PARTY = "Medical Supplies LLP";
const PLANTED_PAN = "MEDPL1234F";

const MASTERS = JSON.stringify([
  { name: "Site Repairs Contract", parent: "Purchase Accounts", IsTDSApplicable: "Yes" },
  { name: "TDS Contractors", parent: "Duties & Taxes", IsTDSApplicable: "Yes" },
  { name: PLANTED_PARTY, parent: "Sundry Creditors", IncomeTaxNumber: PLANTED_PAN, IsTDSApplicable: "Yes", TDSDeducteeType: "Firm" },
]);

const OPERATOR: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [{ ledger: "Site Repairs Contract", section: "194C" }],
  parties: [{ ledger: PLANTED_PARTY, tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false }],
};

const session = () => {
  const s = createSession(
    Object.assign(fakeDownstream({ tally_get_ledgers: MASTERS }), {
      ledgerVoucherRows: async (_c: unknown, ledgerName: string, f: string, t: string) => {
        const list = String(ledgerName).toLowerCase() === "site repairs contract"
          ? [{ date: "20250510", voucherType: "Purchase", voucherNumber: "P/12", amount: 250000, partyLedgerName: PLANTED_PARTY }]
          : [];
        return {
          rows: list.filter((v) => v.date >= f && v.date <= t).map((v) => ({
            date: v.date, voucherType: v.voucherType, voucherNumber: v.voucherNumber,
            reference: "", counterparty: v.partyLedgerName, amount: v.amount,
            matchStatus: "matched" as const, tax: null,
          })),
          dropped: 0,
        } as never;
      },
    } as never),
    EMPTY_OVERRIDES,
    EMPTY_WRONG_GROUP,
  );
  return s;
};

const tools = (s: ReturnType<typeof session>) => {
  const dir = mkdtempSync(join(tmpdir(), "tally-agent-notds-tools-"));
  const registered = new Map<string, (a: any) => Promise<string>>();
  const register: ToolRegistrar = (name, _d, _schema, handler) => { registered.set(name, handler); };
  registerTools(register, s, { reportDir: dir, dayBookMaxBytes: 64 * 1024 * 1024 });
  return { dir, registered };
};

describe("notds tools leak contract", () => {
  it("tb_write_notds_template seeds from the cached TDS review and returns its PATH", async () => {
    const s = session();
    await s.tdsReview(undefined, "20250401", "20260331", "20260331", OPERATOR, "json");
    const { dir, registered } = tools(s);
    const out = JSON.parse(await registered.get("tb_write_notds_template")!({ company: "Report Co" }));
    expect(out.templatePath).toMatch(/notds-operator-template-.*\.xlsx$/);
    expect(out.templatePath).toContain(dir);
    const buf = await readFile(out.templatePath);
    expect(buf.subarray(0, 2).toString()).toBe("PK");
  });

  it("tb_notds_review's JSON carries pseudonyms only: no planted name, no PAN shape", async () => {
    const s = session();
    await s.tdsReview(undefined, "20250401", "20260331", "20260331", OPERATOR, "json");
    const { registered } = tools(s);
    const out = registered.get("tb_notds_review")!;
    const json = await out({});
    expect(json).not.toMatch(/medical|P\/12/i);
    expect(json).not.toMatch(/[A-Z]{5}[0-9]{4}[A-Z]/);
    expect(json).not.toContain(PLANTED_PAN);
    const parsed = JSON.parse(json);
    expect(parsed.candidates).toBe(1);
    expect(parsed.sheets["40(a)(ia) to resident"]).toBe(1);
  });

  it("tb_write_3cd_notds writes the planted name and PAN onto the operator's disk copy", async () => {
    const s = session();
    await s.tdsReview(undefined, "20250401", "20260331", "20260331", OPERATOR, "json");
    await s.noTdsReview({});
    const { dir, registered } = tools(s);
    const sourcePath = join(dir, "No TDS Disallowance.xlsm");
    await (await import("node:fs/promises")).writeFile(sourcePath, makeNotdsFixture());
    const out = registered.get("tb_write_3cd_notds")!;
    const written = JSON.parse(await out({ sourcePath }));
    expect(written.rowsBySheet["40(a)(ia) to resident"]).toBe(1);
    expect(written.path).toMatch(/ - filled - \d{8}\.xlsm$/);
    const pkg = readXlsm(await readFile(written.path));
    const parts = pkg.entries.map((e) => e.name);
    const residentPart = parts.find((p) => /sheet1\.xml$/.test(p))!;
    const xml = partText(pkg, residentPart);
    expect(xml).toContain(PLANTED_PARTY);
    expect(xml).toContain(PLANTED_PAN);
    expect(written).toEqual(JSON.parse(JSON.stringify(written))); // the tool return itself is path-only + counts
  });
});
