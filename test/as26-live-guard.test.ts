import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import { parseAs26Export } from "../src/as26-file.js";
import { AS26_LIVE_READ_REFUSED } from "../src/as26.js";
import { buildAs26Fixture } from "./as26-fixture.js";
import type { DayBookInput } from "../src/tds-daybook.js";
import type { Downstream } from "../src/downstream.js";

const dirs: string[] = [];
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d;
};
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A downstream double whose live reads all fail: anything that reaches live
 *  Tally here is a bug, so a green run proves the books came from the file. */
const liveMustNotRun = (): Downstream =>
  ({
    groups: async () => { throw new Error("live read attempted"); },
    ledgersTax: async () => { throw new Error("live read attempted"); },
    ledgerVoucherRows: async () => { throw new Error("live read attempted"); },
    vouchers: async () => { throw new Error("live read attempted"); },
    callRaw: async () => { throw new Error("live read attempted"); },
    listCompanies: async () => ["Demo Traders Pvt Ltd"],
    trialBalance: async () => { throw new Error("live read attempted"); },
    ledgers: async () => { throw new Error("live read attempted"); },
    ledgerVouchers: async () => { throw new Error("live read attempted"); },
    close: async () => {},
  }) as never;

const dayBook: DayBookInput = {
  shape: "bundle",
  company: "Demo Traders Pvt Ltd",
  groups: [
    { name: "Current Assets", parent: "" },
    { name: "Sundry Debtors", parent: "Current Assets" },
    { name: "Sales Accounts", parent: "" },
    { name: "Works Contract Service", parent: "Sales Accounts" },
  ],
  ledgers: [
    { name: "TDS Receivable", parent: "Current Assets" },
    { name: "Anand Buildmart Pvt Ltd", parent: "Sundry Debtors" },
    { name: "Works Contract Service", parent: "Sales Accounts" },
  ],
  vouchers: [
    {
      date: "20250605", voucherType: "Sales", voucherNumber: "CS/9",
      partyLedgerName: "Anand Buildmart Pvt Ltd", cancelled: false,
      entries: [
        { ledger: "Anand Buildmart Pvt Ltd", amount: 230000 },
        { ledger: "Works Contract Service", amount: -230000 },
      ],
    },
    {
      date: "20250612", voucherType: "Journal", voucherNumber: "JV/1",
      partyLedgerName: "Anand Buildmart Pvt Ltd", cancelled: false,
      entries: [
        { ledger: "TDS Receivable", amount: 115000 },
        { ledger: "Anand Buildmart Pvt Ltd", amount: -115000 },
      ],
    },
  ],
  observedFrom: "20250605",
  observedTo: "20250612",
  rejected: 0,
  emptyMonths: [],
};

function harness() {
  const file = parseAs26Export(buildAs26Fixture());
  const mapPath = join(tempDir("as26-guard-map-"), "as26-map.json");
  writeFileSync(mapPath, JSON.stringify({ mappings: [
    { ledger: "Anand Buildmart Pvt Ltd", as26Name: "Anand Buildmart Pvt Ltd" },
  ]}));
  const session = createSession(liveMustNotRun(), EMPTY_OVERRIDES, EMPTY_WRONG_GROUP);
  return { file, mapPath, session };
}

describe("the 26AS review refuses the live read", () => {
  it("throws one named refusal when no day-book bundle is supplied", async () => {
    const { file, mapPath, session } = harness();
    let msg = "";
    try {
      await session.as26Review("Demo Traders Pvt Ltd", "20250401", "20260331", file, mapPath);
    } catch (e) { msg = String((e as Error).message); }
    expect(msg).toBe(AS26_LIVE_READ_REFUSED);
    // the message tells the operator what to do, without any company data
    expect(msg).toContain("dayBookPath");
    expect(msg).toContain("export-daybook.mjs");
    expect(msg).not.toContain("Demo Traders");
  });

  it("validates the period before refusing, so a bad date still says YYYYMMDD", async () => {
    const { file, mapPath, session } = harness();
    await expect(
      session.as26Review("Demo Traders Pvt Ltd", "2026-04-01", "20260331", file, mapPath),
    ).rejects.toThrow(/YYYYMMDD/);
    await expect(
      session.as26Review("Demo Traders Pvt Ltd", "20260401", "20250331", file, mapPath),
    ).rejects.toThrow(/YYYYMMDD/);
  });

  it("runs the review from a day-book bundle, never reaching live Tally", async () => {
    const { file, mapPath, session } = harness();
    const res = await session.as26Review(
      "Demo Traders Pvt Ltd", "20250401", "20260331", file, mapPath, dayBook,
    );
    expect(res.totals.partiesMatched).toBe(1);
    expect(res.counts.receivableLedgers).toHaveLength(1);
    expect(res.findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(res)).not.toContain("Anand Buildmart");
  });

  it("leaves every other live lane alone", async () => {
    const { session } = harness();
    const tools = new Map<string, (args: any) => Promise<string>>();
    const registrar: ToolRegistrar = (name, _d, _s, handler) => { tools.set(name, handler); };
    registerTools(registrar, session, { reportDir: tempDir("as26-guard-report-") }, "20260331T100000Z");
    // tb_list_companies reads Tally live and takes no day book at all
    const out = await tools.get("tb_list_companies")!({});
    expect(JSON.parse(out).companies).toEqual(["Demo Traders Pvt Ltd"]);
  });
});
