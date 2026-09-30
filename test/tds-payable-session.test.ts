import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSession, type Session } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { EMPTY_TDS_OPERATOR, type OperatorFile } from "../src/tds-file.js";
import {
  buildPayableDecisions,
  payableRunDigest,
  type PayableRunIdentity,
} from "../src/tds-payable-template.js";
import { readWorkbook } from "../src/xlsx-read.js";
import { buildWorkbook } from "../src/xlsx.js";
import { registerTools, type ToolRegistrar } from "../src/index.js";

/**
 * Session-level tests for the payable statement (design of record:
 * docs/design/2026-10-01-tds-payable-statement-design.md): a cached
 * tb_tds_review, the decisions workbook the tools write for it, the operator's
 * decisions stamped back into it, and the statement priced at a payment date.
 *
 * Every name and PAN here is invented. `orchid` is the repo's planted secret:
 * the masked result must never carry it, and never a PAN.
 */

const COMPANY_PAN = "MEDCA1234F"; // 4th character C — a company
const FIRM_GSTIN = "27ORCHT1234F1Z9"; // the PAN rides chars 3-12 of the GSTIN

const MASTERS = JSON.stringify([
  { name: "Site Repairs Contract", parent: "Purchase Accounts", IsTDSApplicable: "Yes" },
  { name: "Orchid Traders", parent: "Sundry Creditors", gstin: FIRM_GSTIN, IsTDSApplicable: "Yes" },
  { name: "Cedex Civil Works", parent: "Sundry Creditors", IncomeTaxNumber: COMPANY_PAN, IsTDSApplicable: "Yes" },
  { name: "Blank Vendor", parent: "Sundry Creditors", IsTDSApplicable: "Yes" },
]);

const OPERATOR: OperatorFile = {
  ...EMPTY_TDS_OPERATOR,
  sections: [{ ledger: "Site Repairs Contract", section: "194C" }],
  parties: [
    { ledger: "Orchid Traders", tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false },
    { ledger: "Cedex Civil Works", tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false },
    { ledger: "Blank Vendor", tdsApplicable: true, transporterDeclaration: false, deducteeFiledReturn: false },
  ],
};

const booking = (party: string, amount: number, date: string, voucher: string) => ({
  date,
  voucherType: "Purchase",
  voucherNumber: voucher,
  amount,
  partyLedgerName: party,
});

const VOUCHERS: Record<string, unknown> = {
  "site repairs contract": {
    source: "ledger-vouchers-report",
    vouchers: [
      booking("Orchid Traders", 250000, "2025-05-10", "P/12"),
      booking("Cedex Civil Works", 250000, "2025-06-10", "P/13"),
      booking("Blank Vendor", 250000, "2025-07-10", "P/14"),
    ],
  },
  "orchid traders": { source: "ledger-vouchers-report", vouchers: [] },
  "cedex civil works": { source: "ledger-vouchers-report", vouchers: [] },
  "blank vendor": { source: "ledger-vouchers-report", vouchers: [] },
};

const mkSession = (): Session =>
  createSession(
    Object.assign(fakeDownstream({ tally_get_ledgers: MASTERS }), {
      ledgerVoucherRows: async (_c: unknown, ledgerName: string, f: string, t: string) => {
        const body = VOUCHERS[String(ledgerName).toLowerCase()] ?? { vouchers: [] };
        const rows = (body.vouchers as Array<Record<string, unknown>>)
          .map((v) => ({
            date: String(v.date).replace(/[-/.\s]/g, ""),
            voucherType: String(v.voucherType ?? ""),
            voucherNumber: String(v.voucherNumber ?? ""),
            reference: "",
            counterparty: String(v.partyLedgerName ?? "").trim(),
            amount: Number(v.amount),
            matchStatus: "matched" as const,
            tax: null,
          }))
          .filter((r) => r.date >= f && r.date <= t);
        return { rows, dropped: 0 } as never;
      },
    } as never),
    EMPTY_OVERRIDES,
    EMPTY_WRONG_GROUP,
  );

const mainSession = async (): Promise<Session> => {
  const s = mkSession();
  await s.tdsReview(undefined, "20250401", "20260331", "20260331", OPERATOR, "json");
  return s;
};

const tmpDir = (): string => mkdtempSync(join(tmpdir(), "tally-agent-payable-"));

/**
 * The operator's half of the flow: stamp the Decision column of a generated
 * workbook the way Excel would, and save it. The header row and every books
 * fact are read back out of the generated file, so this test never restates
 * the writer's column order.
 */
const decideInPlace = (
  generated: Buffer,
  identity: PayableRunIdentity,
  decide: (findingId: string) => "Accept" | "Reject" | null,
): string => {
  const grid = readWorkbook(generated).find((s) => s.name === "Findings");
  if (!grid) throw new Error("no Findings sheet");
  const header = grid.rows[0];
  const cols = [...header.cells.entries()].sort((a, b) => a[0] - b[0]);
  const colOf = (name: string): number => {
    const found = cols.find(([, c]) => String(c.value) === name);
    if (!found) throw new Error(`no ${name} column`);
    return found[0];
  };
  const idCol = colOf("Finding ID");
  const decCol = colOf("Decision");
  const rows = grid.rows.slice(1).map((r) =>
    cols.map(([idx]) =>
      idx === decCol ? decide(String(r.cells.get(idCol)?.value ?? "")) : r.cells.get(idx)?.value ?? null,
    ),
  );
  const out = join(tmpDir(), "decisions-filled.xlsx");
  writeFileSync(
    out,
    buildWorkbook([
      { name: "Findings", columns: cols.map(([, c]) => ({ header: String(c.value), format: "text" as const })), rows },
      {
        name: "Run",
        columns: [
          { header: "Field", format: "text" as const },
          { header: "Value", format: "text" as const },
        ],
        rows: [
          ["company", identity.company],
          ["fromDate", identity.fromDate],
          ["toDate", identity.toDate],
          ["asOnDate", identity.asOnDate],
          ["criticalCount", String(identity.criticalCount)],
          ["digest", payableRunDigest(identity)],
        ],
      },
    ]),
  );
  return out;
};

describe("the session surface", () => {
  it("has no candidates and no identity before a TDS review has run", async () => {
    const s = mkSession();
    expect(s.tdsPayableCandidates()).toBeUndefined();
    expect(s.tdsPayableIdentity()).toBeUndefined();
    expect(s.tdsPayableRows()).toBeUndefined();
    await expect(s.tdsPayableStatement({ paymentDate: "20261031" })).rejects.toThrow(
      /run tb_tds_review first/,
    );
  });

  it("projects every critical finding of the cached run, with no PAN of its own", async () => {
    const s = await mainSession();
    const cands = s.tdsPayableCandidates()!;
    expect(cands).toHaveLength(3);
    expect(cands.every((c) => c.check === "tds_not_deducted")).toBe(true);
    expect(cands.map((c) => c.date).sort()).toEqual(["20250510", "20250610", "20250710"]);
    // The rate came from the engine's own stamped liabilities (206AA's 20% for
    // the PAN-less party), never guessed here.
    expect(cands.find((c) => c.party === "Blank Vendor")!.rate).toBe(0.2);
    expect(cands.find((c) => c.party === "Cedex Civil Works")!.rate).toBe(0.02);
    // The GSTIN-derived PAN ORCHT1234F carries H in its 4th position, so
    // 194C's HUF rate of 1% applies — the engine's own rate, read back here.
    expect(cands.find((c) => c.party === "Orchid Traders")!.rate).toBe(0.01);
    const identity = s.tdsPayableIdentity()!;
    expect(identity).toMatchObject({
      fromDate: "20250401",
      toDate: "20260331",
      asOnDate: "20260331",
      criticalCount: 3,
    });
    expect(identity.findingIds).toEqual(cands.map((c) => c.findingId));
  });

  it("prices the Accepted findings at a payment date and masks everything outbound", async () => {
    const s = await mainSession();
    const cands = s.tdsPayableCandidates()!;
    const identity = s.tdsPayableIdentity()!;
    const generated = buildPayableDecisionsForTest(s);
    const filled = decideInPlace(generated, identity, () => "Accept");
    const r = await s.tdsPayableStatement({ decisionsPath: filled, paymentDate: "20261031" });
    expect(r.critical).toBe(3);
    expect(r.accepted).toBe(3);
    expect(r.rejected).toBe(0);
    expect(r.paymentDate).toBe("20261031");
    expect(r.rows).toHaveLength(3);

    // The company flag: the master's PAN, the PAN derived from the GSTIN, and
    // the party whose PAN could not be found — never guessed.
    const kindOf = (id: string): string => r.rows.find((x) => x.findingId === id)!.partyKind;
    expect(kindOf(cands.find((c) => c.party === "Cedex Civil Works")!.findingId)).toBe("Company");
    expect(kindOf(cands.find((c) => c.party === "Orchid Traders")!.findingId)).toBe("Non-company");
    expect(kindOf(cands.find((c) => c.party === "Blank Vendor")!.findingId)).toBe("Not determinable (no PAN)");
    expect(r.panMissing).toBe(1);
    expect(r.byPartyKind.map((g) => g.kind).sort()).toEqual([
      "Company",
      "Non-company",
      "Not determinable (no PAN)",
    ]);

    // Totals are money() strings and the payable is the shortfall plus interest.
    expect(r.totals.payable).toMatch(/^[\d,]+\.\d\d$/);
    const n = (s2: string): number => Number(s2.replace(/,/g, ""));
    expect(n(r.totals.payable)).toBeCloseTo(n(r.totals.shortfall) + n(r.totals.interest), 2);
    // 2500 at 1% (the GSTIN-derived HUF PAN) + 5000 at 2% (a company) +
    // 50000 at the s.206AA 20% (no PAN found).
    expect(n(r.totals.shortfall)).toBeCloseTo(2500 + 5000 + 50000, 2);
    // Leg (i) is 1% per month-or-part-month from each booking to the payment
    // date (18 / 17 / 16 months), and leg (ii) is zero for a shortfall that
    // was never deducted: it is deemed deducted on the payment date.
    expect(n(r.totals.interestI)).toBeCloseTo(2500 * 0.01 * 18 + 5000 * 0.01 * 17 + 50000 * 0.01 * 16, 2);
    expect(n(r.totals.interestII)).toBe(0);
    for (const row of r.rows) {
      expect(row.depositDueDate).toBe("07-Nov-2026");
    }
    // The by-section and by-kind splits each reconcile to the headline total.
    expect(r.bySection.reduce((a, g) => a + n(g.payable), 0)).toBeCloseTo(n(r.totals.payable), 2);
    expect(r.byPartyKind.reduce((a, g) => a + n(g.payable), 0)).toBeCloseTo(n(r.totals.payable), 2);

    // Nothing outbound carries a real name or a PAN.
    const out = JSON.stringify(r);
    expect(out).not.toMatch(/orchid/i);
    expect(out).not.toMatch(/cedex|blank vendor/i);
    expect(out).not.toMatch(/[A-Z]{5}[0-9]{4}[A-Z]/);
    expect(out).not.toContain(COMPANY_PAN);
    // The envelope dates echo what the operator asked (the TDS lane's own
    // convention); every date a reader acts on is displayDate-formatted.
    expect(r.paymentDate).toBe("20261031");
    for (const row of r.rows) {
      expect(row.date).toMatch(/^\d{2}-[A-Z][a-z]{2}-\d{4}$/);
      expect(row.party).toMatch(/^Creditor \d+$/);
      expect(row.depositDueDate).toMatch(/^\d{2}-[A-Z][a-z]{2}-\d{4}$/);
    }

    // The unmasked rows for the workbook writer do carry the real facts.
    const rows = s.tdsPayableRows()!;
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.map((x) => x.party).sort()).toEqual([
      "Blank Vendor",
      "Cedex Civil Works",
      "Orchid Traders",
    ]);
    expect(rows.rows.find((x) => x.party === "Orchid Traders")!.panFromGstin).toBe(true);
    expect(rows.rows.find((x) => x.party === "Cedex Civil Works")!.panFromGstin).toBe(false);
    expect(rows.rows.find((x) => x.party === "Blank Vendor")!.pan).toBeNull();
  });

  it("refuses the statement while a critical finding is undecided, naming the open one", async () => {
    const s = await mainSession();
    const identity = s.tdsPayableIdentity()!;
    const generated = buildPayableDecisionsForTest(s);
    const ids = s.tdsPayableCandidates()!.map((c) => c.findingId);
    const filled = decideInPlace(generated, identity, (id) => (id === ids[0] ? "Accept" : null));
    await expect(
      s.tdsPayableStatement({ decisionsPath: filled, paymentDate: "20261031" }),
    ).rejects.toThrow(/2 of 3 critical findings are not decided yet/);
    try {
      await s.tdsPayableStatement({ decisionsPath: filled, paymentDate: "20261031" });
    } catch (e) {
      expect((e as Error).message).toContain(ids[1]);
      expect((e as Error).message).toContain(ids[2]);
    }
  });

  it("refuses a decisions workbook from a different review", async () => {
    const s = await mainSession();
    const identity = s.tdsPayableIdentity()!;
    const generated = buildPayableDecisionsForTest(s);
    const stale = decideInPlace(generated, identity, () => "Accept");
    // A second run of the same period but a different as-on date is a
    // different review, and its workbook must not read as decisions on this one.
    const other: Session = mkSession();
    await other.tdsReview(undefined, "20250401", "20260331", "20260930", OPERATOR, "json");
    await expect(
      other.tdsPayableStatement({ decisionsPath: stale, paymentDate: "20261031" }),
    ).rejects.toThrow(/generated from another review/);
  });

  it("prices only the Accepted findings and counts the Rejected ones", async () => {
    const s = await mainSession();
    const identity = s.tdsPayableIdentity()!;
    const cands = s.tdsPayableCandidates()!;
    const rejected = cands.find((c) => c.party === "Blank Vendor")!;
    const filled = decideInPlace(buildPayableDecisionsForTest(s), identity, (id) =>
      id === rejected.findingId ? "Reject" : "Accept",
    );
    const r = await s.tdsPayableStatement({ decisionsPath: filled, paymentDate: "20261031" });
    expect(r.accepted).toBe(2);
    expect(r.rejected).toBe(1);
    const n = (v: string): number => Number(v.replace(/,/g, ""));
    expect(n(r.totals.shortfall)).toBeCloseTo(2500 + 5000, 2);
    expect(r.rows.map((x) => x.findingId)).not.toContain(rejected.findingId);
  });
});

/** The workbook the writer tool produces, through the writer module itself. */
const buildPayableDecisionsForTest = (s: Session): Buffer => {
  const identity = s.tdsPayableIdentity()!;
  return buildPayableDecisions({
    company: identity.company,
    candidates: s.tdsPayableCandidates()!,
    identity,
    generatedOn: "20261001",
  });
};

describe("the tools", () => {
  const tools = (s: Session): Map<string, (a: unknown) => Promise<string>> => {
    const registered = new Map<string, (a: unknown) => Promise<string>>();
    const register: ToolRegistrar = (name, _d, _schema, handler) => {
      registered.set(name, handler as (a: unknown) => Promise<string>);
    };
    registerTools(register, s, { reportDir: tmpDir(), dayBookMaxBytes: 64 * 1024 * 1024 });
    return registered;
  };
  const call = async (
    t: Map<string, (a: unknown) => Promise<string>>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<any> => JSON.parse(await t.get(name)!(args));

  it("writes the decisions workbook and the statement through the tool surface", async () => {
    const s = await mainSession();
    const t = tools(s);
    const dir = tmpDir();
    const written = await call(t, "tb_write_tds_payable_decisions", { company: "Sample Builders", outDir: dir });
    expect(written.critical).toBe(3);
    expect(written.templatePath.startsWith(dir)).toBe(true);
    const generated = readFileSync(written.templatePath);
    expect(readWorkbook(generated).map((x) => x.name)).toEqual([
      "Instructions",
      "Findings",
      "Lists",
      "Run",
    ]);

    const identity = s.tdsPayableIdentity()!;
    const filled = decideInPlace(generated, identity, () => "Accept");
    const statementDir = tmpDir();
    const result = await call(t, "tb_tds_payable_statement", {
      decisionsPath: filled,
      paymentDate: "20261031",
      company: "Sample Builders",
      outDir: statementDir,
    });
    expect(result.accepted).toBe(3);
    expect(result.statementPath.startsWith(statementDir)).toBe(true);
    const statement = readWorkbook(readFileSync(result.statementPath));
    expect(statement.map((x) => x.name)).toEqual(["Payable statement", "Summary"]);
    // The PANs are on the operator's disk, in the workbook only.
    expect(JSON.stringify(result)).not.toContain(COMPANY_PAN);
    expect(JSON.stringify(result)).not.toMatch(/[A-Z]{5}[0-9]{4}[A-Z]/);
  });

  it("refuses the statement tool with nothing decided and says which rows are open", async () => {
    const s = await mainSession();
    const t = tools(s);
    const dir = tmpDir();
    const written = await call(t, "tb_write_tds_payable_decisions", { outDir: dir });
    await expect(
      t.get("tb_tds_payable_statement")!({ decisionsPath: written.templatePath, paymentDate: "20261031" }),
    ).rejects.toThrow(/3 of 3 critical findings are not decided yet/);
  });

  it("refuses both tools before a TDS review has run", async () => {
    const s = mkSession();
    const t = tools(s);
    await expect(t.get("tb_write_tds_payable_decisions")!({})).rejects.toThrow(/run tb_tds_review first/);
    await expect(t.get("tb_tds_payable_statement")!({ paymentDate: "20261031" })).rejects.toThrow(
      /run tb_tds_review first/,
    );
  });
});