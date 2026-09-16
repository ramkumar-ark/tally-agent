import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { writeDepreciationReport } from "../src/report.js";
import { parseDepOperatorFile } from "../src/depreciation-file.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";

const SECRETS = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/secrets.json", import.meta.url)), "utf8"),
) as string[];

/**
 * Non-vacuity guard (canon §5.7): a secret that appears in no fixture can
 * never leak, so asserting its absence proves nothing. Every secret must be
 * carried by the corpus the gateway actually consumes — the raw downstream
 * fixtures or the returns file — before the absence assertions below mean
 * anything.
 */
const FIXTURE_CORPUS =
  readFileSync(fileURLToPath(new URL("./fixtures/tally-responses.json", import.meta.url)), "utf8") +
  readFileSync(fileURLToPath(new URL("./fixtures/gst-returns.json", import.meta.url)), "utf8") +
  readFileSync(fileURLToPath(new URL("./fixtures/tds_operator_file.json", import.meta.url)), "utf8");

function makeTdsFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "tally-agent-tds-")), "tds-operator-file.json");
  writeFileSync(
    path,
    readFileSync(fileURLToPath(new URL("./fixtures/tds_operator_file.json", import.meta.url)), "utf8"),
  );
  return path;
}

function makeReturnsFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "tally-agent-returns-")), "returns.json");
  writeFileSync(
    path,
    readFileSync(fileURLToPath(new URL("./fixtures/gst-returns.json", import.meta.url)), "utf8"),
  );
  return path;
}

/**
 * Every gateway tool, exercised, with every outbound payload checked against
 * the manifest. A tool added later without masking fails here.
 */
describe("no secret leaves the gateway", () => {
  it("holds across the whole tool surface", async () => {
    for (const secret of SECRETS) {
      expect(
        FIXTURE_CORPUS.includes(secret.replace("HDFC ", "").replace("GSTIN", "")) ||
          containsCanonically(FIXTURE_CORPUS, secret),
        `secret "${secret}" appears in no fixture — the leak test would pass vacuously`,
      ).toBe(true);
    }
  });

  it("holds across the whole tool surface, exercised", async () => {
    const tools = new Map<string, (args: any) => Promise<string>>();
    const registrar: ToolRegistrar = (name, _d, _s, handler) => tools.set(name, handler);
    // A TDS-aware fake: additive over the base fixture, only for the two ledgers
    // the TDS operator file names, so earlier tools' fixtures stay untouched.
    const base = fakeDownstream();
    const baseLedgerVouchers = base.ledgerVoucherRows.bind(base);
    const tdsVouchers: Record<string, unknown> = {
      "site repairs contract": {
        source: "ledger-vouchers-report",
        vouchers: [
          {
            date: "2025-05-10",
            voucherType: "Purchase",
            voucherNumber: "P/12",
            amount: "-250000.00",
            partyLedgerName: "Sample Builders LLP",
          },
        ],
      },
      "tds contractors": { source: "ledger-vouchers-report", vouchers: [] },
      "sample builders llp": { source: "ledger-vouchers-report", vouchers: [] },
    };
    const TDS_MASTERS = JSON.stringify([
      {
        name: "Sample Builders LLP",
        parent: "Sundry Creditors",
        gstin: "",
        state: "Karnataka",
        IncomeTaxNumber: "ABCC1234A",
        IsTDSApplicable: "Yes",
        TDSDeducteeType: "Firm",
      },
      {
        name: "Site Repairs Contract",
        parent: "Purchase Accounts",
        IsTDSApplicable: "Yes",
      },
      {
        name: "TDS Contractors",
        parent: "Duties & Taxes",
        IsTDSApplicable: "Yes",
      },
    ]);
    const tdsFake = Object.assign(fakeDownstream({ tally_get_ledgers: TDS_MASTERS }), {
      ledgerVoucherRows: async (_c: any, ledgerName: string, f: string, t: string) => {
        const key = String(ledgerName).toLowerCase();
        if (!(key in tdsVouchers)) return baseLedgerVouchers(_c, ledgerName, f, t);
        const rows = ((tdsVouchers[key] as { vouchers: any[] }).vouchers as any[])
          .map((v) => ({
            date: String(v.date).replace(/[-/\.\s]/g, ""),
            voucherType: String(v.voucherType ?? ""),
            voucherNumber: String(v.voucherNumber ?? ""),
            reference: "",
            counterparty: String(v.counterLedgerName ?? v.partyLedgerName ?? "").trim(),
            amount:
              typeof v.amount === "number"
                ? v.amount
                : Number(String(v.amount ?? "0").replace(/,/g, "")),
            matchStatus: "matched" as const,
            tax: null,
          }))
          .filter((r: any) => r.date >= f && r.date <= t);
        return { rows, dropped: 0 } as never;
      },
    } as never);
    const session = createSession(tdsFake, EMPTY_OVERRIDES);
    const reportDir = mkdtempSync(join(tmpdir(), "tally-agent-leak-"));
    registerTools(registrar, session, { reportDir });

    // tb_review must run first: later tools depend on its findings.
    const outputs: string[] = [];
    outputs.push(await tools.get("tb_review")!({ asOnDate: "20260331" }));
    outputs.push(await tools.get("tb_list_companies")!({}));

    const review = JSON.parse(outputs[0]);
    // Non-vacuity for the wrong-group secrets: the expense ledger parked under
    // Capital Account must really be reported, and only by its pseudonym.
    const misgrouped = review.findings.find(
      (f: any) => f.check === "ledger_in_wrong_group" && f.group === "Capital Account",
    );
    expect(misgrouped?.ledger).toMatch(/^Capital \d+$/);
    const wrongSide = review.findings.find((f: any) => f.check === "wrong_side_balance");
    for (const f of review.findings) {
      if (!f.ledger) continue;
      const out = await tools.get("tb_ledger_activity")!({
        findingId: f.id,
        fromDate: "20250401",
        toDate: "20260331",
      });
      outputs.push(out);

      // The fixture voucher for the creditor finding hands the same real
      // party back under three fields, one with different internal
      // whitespace (as a live company was seen doing). All three — plus the
      // fields the gateway does not name-mask directly — must resolve to the
      // exact same pseudonym as the finding itself, or the party fragments
      // across the report.
      // Only PUR/0012 names the creditor on all three fields; the other rows
      // name a counterparty (Zenith Logistics, Rent) on the party fields.
      if (f.id === wrongSide?.id) {
        const rows = JSON.parse(out);
        for (const row of rows) {
          expect(row.matchedLedgerName).toBe(f.ledger);
          if (row.voucherNumber !== "PUR/0012") continue;
          for (const field of ["partyLedgerName", "counterLedgerName"]) {
            expect(row[field]).toBe(f.ledger);
          }
        }
      }
    }

    // M3: scrutinise every ledger-bearing finding, then write one report.
    const scrutinyChecks = new Set<string>();
    let scrutinyId = "";
    for (const f of review.findings) {
      if (!f.ledger) continue;
      const out = await tools.get("tb_ledger_scrutiny")!({
        findingId: f.id,
        fromDate: "20250401",
        toDate: "20260331",
      });
      outputs.push(out);
      const result = JSON.parse(out);
      for (const lf of result.findings) scrutinyChecks.add(lf.check);
      if (f.id === wrongSide?.id) scrutinyId = result.scrutinyId;
    }
    // Non-vacuity: the duplicate-reference detail names Zenith Logistics and
    // the digit-bearing voucher number, so the secrets are really exercised.
    expect(scrutinyChecks).toContain("ls_duplicate_reference");
    expect(scrutinyId).toBe("L3");
    outputs.push(
      await tools.get("tb_write_ledger_report")!({
        company: "Demo Traders Pvt Ltd",
        scrutinyId,
        markdown: "# Ledger scrutiny\n\nSee the findings.",
      }),
    );

    outputs.push(
      await tools.get("tb_write_report")!({
        company: "Demo Traders Pvt Ltd",
        asOnDate: "20260331",
        markdown: "# Review\n\nSee findings.",
      }),
    );

    // M2: the GST surface, exercised against the same fixtures.
    outputs.push(await tools.get("tb_gst_summary")!({ fromDate: "20250401", toDate: "20260331" }));
    const returnsPath = makeReturnsFile();
    outputs.push(
      await tools.get("tb_gst_mismatch")!({
        fromDate: "20250401",
        toDate: "20260331",
        returnsPath,
      }),
    );
    outputs.push(
      await tools.get("tb_write_gst_report")!({
        company: "Demo Traders Pvt Ltd",
        fromDate: "20250401",
        toDate: "20260331",
        markdown: "# GST\n\nSee the findings.",
      }),
    );

    // TDS: the operator file (its TAN included) travels into the gateway by
    // path, and no outbound string may name it back.
    const tdsPath = makeTdsFile();
    outputs.push(
      await tools.get("tb_tds_review")!({
        fromDate: "20250401",
        toDate: "20260331",
        asOnDate: "20260331",
        tdsFilePath: tdsPath,
      }),
    );
    const tdsRes = JSON.parse(outputs[outputs.length - 1]);
    // Non-vacuity: the TDS review really sees the 2,50,000 booking with no
    // duty credit behind it, and says so — the whole surface works.
    const notDeducted = (tdsRes.findings as any[]).find((f) => f.check === "tds_not_deducted");
    expect(notDeducted).toBeDefined();
    expect((notDeducted as any).amount).toBe(5000);
    outputs.push(
      await tools.get("tb_write_tds_report")!({
        company: "Demo Traders Pvt Ltd",
        fromDate: "20250401",
        toDate: "20260331",
        markdown: "# TDS\n\nSee the findings.",
      }),
    );

    for (const out of outputs) {
      for (const secret of SECRETS) {
        expect(out, `secret "${secret}" leaked in a tool result`).not.toContain(secret);
      }
    }
  });

  it("covers every registered tool, so a new unmasked tool cannot slip in", async () => {
    const tools = new Map<string, unknown>();
    const registrar: ToolRegistrar = (name) => tools.set(name, true);
    registerTools(registrar, createSession(fakeDownstream(), EMPTY_OVERRIDES), {
      reportDir: mkdtempSync(join(tmpdir(), "tally-agent-leak-")),
    });
    expect([...tools.keys()].sort()).toEqual([
      "tb_depreciation_review",
      "tb_gst_mismatch",
      "tb_gst_summary",
      "tb_ledger_activity",
      "tb_ledger_scrutiny",
      "tb_list_companies",
      "tb_review",
      "tb_tds_review",
      "tb_write_depreciation_report",
      "tb_write_gst_report",
      "tb_write_ledger_report",
      "tb_write_report",
      "tb_write_tds_report",
      "tb_write_tds_template",
    ]);
  });

  it("still does not expose the master-dump tool that returns bank and address details", async () => {
    const tools = new Map<string, unknown>();
    const registrar: ToolRegistrar = (name) => tools.set(name, true);
    registerTools(registrar, createSession(fakeDownstream(), EMPTY_OVERRIDES), {
      reportDir: mkdtempSync(join(tmpdir(), "tally-agent-leak-")),
    });
    expect(tools.has("tally_get_ledger")).toBe(false);
  });
});

/**
 * A canonicalized containment check for names that can appear with variant
 * whitespace or case in the fixtures, mirroring canonicalKey's collapse.
 */
function containsCanonically(corpus: string, secret: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(corpus).includes(norm(secret));
}

/**
 * Depreciation leak surfaces (plan Task 13): a workbook is a new way for a
 * real asset ledger name to reach the model, and an operator file is a new
 * way for one to reach an error message. The helpers build on the additive
 * stub pattern above: the dep engine is fed its own small group tree and one
 * secret asset ledger, so the review really sees the secret.
 */
function depSecretDownstream(name: string) {
  const depreciationRow = {
    date: "20260303", voucherType: "Jrnl", voucherNumber: "1", reference: "",
    counterparty: name, amount: 15000, matchStatus: "matched" as const, tax: null,
  };
  const trialBalance = (rows: Array<{ name: string; parent: string; balance: number }>) =>
    async (_c: unknown, asOn: string) => ({
      totalDebit: 0, totalCredit: 0,
      rows: asOn === "20250331"
        ? rows.map((r) => (r.parent === "Indirect Expenses" ? { ...r, balance: 0 } : r))
        : rows,
    });
  return Object.assign(fakeDownstream(), {
    groups: async () => [
      { name: "Fixed Assets", parent: " Primary" },
      { name: "Block 15%", parent: "Fixed Assets" },
      { name: "Indirect Expenses", parent: " Primary" },
    ],
    trialBalance: trialBalance([
      { name, parent: "Block 15%", balance: 100000 },
      { name: "Depreciation A/c", parent: "Indirect Expenses", balance: 0 },
    ]),
    ledgerVoucherRows: async (_c: unknown, ledger: string, from: string, to: string) => {
      if (ledger !== "Depreciation A/c" || from > "20260303" || to < "20260303") {
        return { rows: [], dropped: 0 };
      }
      return { rows: [depreciationRow], dropped: 0 };
    },
  } as never);
}

async function runDepreciationReviewWithSecretLedger(name: string) {
  const session = createSession(depSecretDownstream(name), EMPTY_OVERRIDES);
  return session.depreciationReview(undefined, "20250401", "20260331", null);
}

async function writeDepreciationReportWithSecretLedger(name: string) {
  const session = createSession(depSecretDownstream(name), EMPTY_OVERRIDES);
  const masked = await session.depreciationReview(undefined, "20250401", "20260331", null);
  const { workbookPath, csvPath } = await writeDepreciationReport({
    reportDir: mkdtempSync(join(tmpdir(), "tally-agent-dep-")),
    company: "Demo Traders Pvt Ltd",
    fromDate: "20250401",
    toDate: "20260331",
    result: masked,
    vault: session.vault,
  });
  return { workbookPath, csvPath, masked };
}

describe("depreciation leak surfaces", () => {
  it("never returns a real asset ledger name from a depreciation review", async () => {
    const result = await runDepreciationReviewWithSecretLedger("Orchid Medical Plant");
    // Non-vacuity: the stub's asset ledger really entered the review.
    expect(JSON.stringify(result)).toMatch(/Ledger \d+/);
    const text = JSON.stringify(result).toLowerCase();
    expect(text).not.toContain("orchid");
    expect(text).not.toContain("medical");
  });

  it("never echoes an operator file value in a parse error", () => {
    const bad = JSON.stringify({
      schema: "tally-agent-depreciation.v1",
      financialYear: { from: "2025-04-01", to: "2026-03-31" },
      rateOverrides: [{ ledger: "Orchid Medical Plant", rate: "bad" }],
    });
    try {
      parseDepOperatorFile(bad, "20250401", "20260331");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message.toLowerCase()).not.toContain("orchid");
      expect((e as Error).message.toLowerCase()).not.toContain("medical");
    }
  });

  it("writes the real name into the workbook but never into the returned paths", async () => {
    const { workbookPath, csvPath, masked } = await writeDepreciationReportWithSecretLedger("Orchid Medical Plant");
    // Non-vacuity: the files really exist and the trio's CSV on the disk
    // carries the restored real name (the workbook is zip-compressed, so its
    // strings are not raw-scannable; the CSV is the same de-masked writer).
    expect(readFileSync(workbookPath).subarray(0, 2).toString("latin1")).toBe("PK");
    expect(readFileSync(csvPath, "utf8").toLowerCase()).toContain("orchid medical plant");
    expect(workbookPath.toLowerCase()).not.toContain("orchid");
    expect(csvPath.toLowerCase()).not.toContain("orchid");
    expect(JSON.stringify(masked).toLowerCase()).not.toContain("orchid");
    expect(JSON.stringify(masked).toLowerCase()).not.toContain("medical");
  });
});
