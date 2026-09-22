import { mkdtempSync, readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendAudit, findingsCsv, findingsSheet, depreciationSheets, writeLedgerReport, writeReport, writeTdsReport, writeVaultDump, writeWorkbook, writeDepreciationReport, fixedAssetSheets, writeFaRegisterReport } from "../src/report.js";
import type { MaskedDepResult, MaskedFaResult } from "../src/report.js";
import type { TdsMaskedFinding } from "../src/review.js";
import { createVault } from "../src/vault.js";
import type { Finding } from "../src/types.js";
import { entry } from "./xlsx.test.js";

function fixture() {
  const vault = createVault();
  const alias = vault.pseudonym("Acme Traders", "creditor");
  const findings: Finding[] = [
    {
      id: "TB-004-1",
      check: "wrong_side_balance",
      severity: "warning",
      ledger: alias,
      group: "Sundry Creditors",
      amount: 41250,
      side: "Dr",
      expected: "Cr",
      detail: `${alias} carries a debit balance`,
    },
  ];
  return { vault, findings, alias };
}

describe("findingsCsv", () => {
  it("writes real names, not aliases", () => {
    const { vault, findings } = fixture();
    const csv = findingsCsv(findings, vault);
    expect(csv).toContain("Acme Traders");
    expect(csv).not.toContain("Creditor 1");
  });

  it("quotes fields containing commas", () => {
    const { vault, findings } = fixture();
    findings[0].detail = "one, two";
    expect(findingsCsv(findings, vault)).toContain('"one, two"');
  });

  it("starts with a header row", () => {
    const { vault, findings } = fixture();
    expect(findingsCsv(findings, vault).split("\n")[0]).toBe(
      "id,check,severity,ledger,group,amount,side,expected,detail",
    );
  });

  it("carries a group nature in the expected column for a wrong-group finding", () => {
    const vault = createVault();
    const alias = vault.pseudonym("Orchid Medical Expenses", "capital");
    const csv = findingsCsv(
      [
        {
          id: "TB-008-1",
          check: "ledger_in_wrong_group",
          severity: "warning",
          ledger: alias,
          group: "Capital Account",
          amount: 18000,
          side: "Dr",
          expected: "expense",
          detail: `${alias} reads as an expense ledger`,
        },
      ],
      vault,
    );
    expect(csv.split("\n")[1]).toBe(
      "TB-008-1,ledger_in_wrong_group,warning,Orchid Medical Expenses,Capital Account,18000.00,Dr,expense," +
        "Orchid Medical Expenses reads as an expense ledger",
    );
  });
});

describe("writeReport", () => {
  it("de-masks the narrative on the way to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-"));
    const { vault, findings, alias } = fixture();
    const { markdownPath } = await writeReport({
      reportDir: dir,
      company: "Demo Traders Pvt Ltd",
      asOnDate: "20260331",
      markdown: `# Review\n\n${alias} needs attention.`,
      findings,
      vault,
    });
    const body = readFileSync(markdownPath, "utf8");
    expect(body).toContain("Acme Traders needs attention.");
    expect(body).not.toContain("Creditor 1");
  });

  it("returns both artifact paths and names them by company and date", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-"));
    const { vault, findings } = fixture();
    const paths = await writeReport({
      reportDir: dir,
      company: "Demo Traders Pvt Ltd",
      asOnDate: "20260331",
      markdown: "# Review",
      findings,
      vault,
    });
    expect(paths.markdownPath).toMatch(/trial-balance-review-demo-traders-pvt-ltd-20260331\.md$/);
    expect(paths.csvPath).toMatch(/findings-demo-traders-pvt-ltd-20260331\.csv$/);
  });
});

describe("appendAudit", () => {
  it("appends one JSON line per call, into this session's own file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-"));
    await appendAudit(dir, "20260331T100000Z", { at: "2026-03-31T10:00:00Z", tool: "tb_review", args: {}, rows: 5, masked: 2 });
    await appendAudit(dir, "20260331T100000Z", { at: "2026-03-31T10:00:05Z", tool: "tb_write_report", args: {}, rows: 0, masked: 0 });
    const lines = readFileSync(join(dir, "session-20260331T100000Z.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).tool).toBe("tb_review");
  });
});

describe("writeVaultDump", () => {
  it("writes the mapping only when asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-"));
    const { vault } = fixture();
    const path = await writeVaultDump(dir, "20260331T100000Z", vault);
    const dump = JSON.parse(readFileSync(path, "utf8")) as Array<{ real: string; alias: string }>;
    expect(dump).toEqual([{ real: "Acme Traders", alias: "Creditor 1" }]);
  });
});

describe("writeLedgerReport", () => {
  it("names both artifacts by the opaque scrutiny id and de-masks on disk", async () => {
    const vault = createVault();
    const alias = vault.pseudonym("Acme Traders", "creditor");
    const reportDir = mkdtempSync(join(tmpdir(), "tally-agent-ledger-"));
    const paths = await writeLedgerReport({
      reportDir,
      company: "Demo Traders Pvt Ltd",
      scrutinyId: "L1",
      fromDate: "20250401",
      toDate: "20260331",
      markdown: `# ${alias}`,
      findings: [
        {
          id: "LS-1-002-1",
          check: "ls_wrong_side_during_period",
          severity: "warning",
          ledger: alias,
          group: "Sundry Creditors",
          amount: 82500,
          side: "Dr",
          expected: "Cr",
          detail: `${alias} stood on the debit side`,
        },
      ],
      vault,
    });
    expect(paths.markdownPath).toBe(join(reportDir, "ledger-scrutiny-demo-traders-pvt-ltd-l1-20250401-20260331.md"));
    expect(paths.csvPath).toBe(join(reportDir, "ledger-findings-demo-traders-pvt-ltd-l1-20250401-20260331.csv"));
    expect(readFileSync(paths.markdownPath, "utf8")).toBe("# Acme Traders");
    expect(readFileSync(paths.csvPath, "utf8")).toContain(
      "LS-1-002-1,ls_wrong_side_during_period,warning,Acme Traders,Sundry Creditors,82500.00,Dr,Cr,Acme Traders stood on the debit side",
    );
  });
});

describe("writeTdsReport", () => {
  it("writes the report trio with de-masked names and the interest schedule", async () => {
    const vault = createVault();
    const alias = vault.pseudonym("Sample Builders LLP", "creditor");
    const findings: TdsMaskedFinding[] = [
      {
        id: "TDS-001-1",
        check: "tds_not_deducted",
        severity: "critical",
        deductee: alias,
        group: "Sundry Creditors",
        section: "194C",
        amount: 5000,
        detail: `${alias} booking 2,50,000.00 on 10-May-2025: no duty credit found`,
        schedule: [{ kind: "i", amount: 100, from: "20250510", to: "20250628", basis: "1% of 2 month(s)" }],
      },
    ];
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-tds-"));
    const paths = await writeTdsReport({
      reportDir: dir,
      company: "Demo Traders Pvt Ltd",
      fromDate: "20250401",
      toDate: "20260331",
      markdown: `# TDS review\n\n${alias} is a pseudonym.`,
      findings,
      vault,
    });
    const md = readFileSync(paths.markdownPath, "utf8");
    const csv = readFileSync(paths.csvPath, "utf8");
    const isched = readFileSync(paths.interestCsvPath, "utf8");
    expect(md).toContain("Sample Builders LLP");
    expect(csv).toContain("Sample Builders LLP");
    expect(csv.split("\n")[0]).toBe("id,check,severity,deductee,group,section,amount,detail,books_source");
    expect(isched.split("\n")[0]).toBe("id,check,deductee,section,kind,amount,from,to,basis,books_source");
    expect(isched).toContain("Sample Builders LLP");
    expect(isched).toContain("1% of 2 month(s)");
  });

  it("prepends the operator day-book provenance block ahead of the narrative", async () => {
    const vault = createVault();
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-tds-"));
    const paths = await writeTdsReport({
      reportDir: dir,
      company: "Demo Traders Pvt Ltd",
      fromDate: "20250401",
      toDate: "20260331",
      markdown: "# Narrative\n\nbody text",
      findings: [],
      vault,
      booksSource: "daybook-file",
      books: {
        vouchers: 14356,
        ledgersProjected: 612,
        fromObserved: "20250403",
        toObserved: "20260330",
        rejected: 0,
        mastersSource: "live",
        bytes: 27_400_000,
        digest: "a".repeat(64),
      },
    });
    const md = readFileSync(paths.markdownPath, "utf8");
    expect(md).toContain("Books source: operator day-book file");
    expect(md).toContain("14,356 vouchers");
    expect(md).toContain("03-Apr-2025 to 30-Mar-2026");
    expect(md).toContain("26.1 MB");
    expect(md).toMatch(/a{64}/);
    expect(md.indexOf("Books source")).toBeLessThan(md.indexOf("# Narrative"));
  });

  it("states the live books source when no day-book file was used", async () => {
    const vault = createVault();
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-tds-"));
    const paths = await writeTdsReport({
      reportDir: dir,
      company: "Demo Traders Pvt Ltd",
      fromDate: "20250401",
      toDate: "20260331",
      markdown: "# Narrative",
      findings: [],
      vault,
      booksSource: "live",
    });
    const md = readFileSync(paths.markdownPath, "utf8");
    expect(md).toContain("Books source: live Tally");
  });

  it("carries the books source as a trailing column in both CSVs", async () => {
    const vault = createVault();
    const alias = vault.pseudonym("Sample Builders LLP", "creditor");
    const findings: TdsMaskedFinding[] = [
      {
        id: "TDS-001-1",
        check: "tds_not_deducted",
        severity: "critical",
        deductee: alias,
        group: "Sundry Creditors",
        section: "194C",
        amount: 5000,
        detail: "detail text",
        schedule: [{ kind: "i", amount: 100, from: "20250510", to: "20250628", basis: "1% of 2 month(s)" }],
      },
    ];
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-tds-"));
    const paths = await writeTdsReport({
      reportDir: dir,
      company: "Demo Traders Pvt Ltd",
      fromDate: "20250401",
      toDate: "20260331",
      markdown: "# Narrative",
      findings,
      vault,
      booksSource: "daybook-file",
      books: {
        vouchers: 10,
        ledgersProjected: 2,
        fromObserved: "20250403",
        toObserved: "20250415",
        rejected: 0,
        mastersSource: "live",
        bytes: 1_000_000,
        digest: "b".repeat(64),
      },
    });
    const csv = readFileSync(paths.csvPath, "utf8");
    const isched = readFileSync(paths.interestCsvPath, "utf8");
    expect(csv.split("\n")[0]).toBe("id,check,severity,deductee,group,section,amount,detail,books_source");
    expect(csv.split("\n")[1]).toMatch(/,daybook-file$/);
    expect(isched.split("\n")[0]).toBe("id,check,deductee,section,kind,amount,from,to,basis,books_source");
    expect(isched.split("\n")[1]).toMatch(/,daybook-file$/);
  });
});

describe("writeWorkbook", () => {
  it("de-masks every string cell on the way to disk and leaves numbers alone", async () => {
    const vault = createVault();
    const alias = vault.pseudonym("Sundry Machinery Supplier", "creditor");
    const dir = await mkdtemp(join(tmpdir(), "dep-wb-"));

    const path = await writeWorkbook({
      reportDir: dir,
      fileName: "wb.xlsx",
      vault,
      sheets: [{
        name: "S",
        columns: [{ header: "Party", format: "text" }, { header: "Amount", format: "money" }],
        rows: [[alias, 1234.5]],
      }],
    });

    const xml = entry(await readFile(path), "xl/worksheets/sheet1.xml");
    expect(xml).toContain("Sundry Machinery Supplier");
    expect(xml).not.toContain(alias);
    expect(xml).toContain("<v>1234.5</v>");
    expect(path.startsWith(dir)).toBe(true);
  });

  it("builds a findings sheet whose columns match findingsCsv's header", () => {
    const sheet = findingsSheet([{
      id: "DEP-005-1", check: "dep_credit_unclassified", severity: "critical",
      ledger: "Ledger 7", group: "Block 15%", amount: 962000,
      side: null, expected: null, detail: "counter ledger not resolvable",
    }]);
    expect(sheet.columns.map((c) => c.header)).toEqual([
      "id", "check", "severity", "ledger", "group", "amount", "side", "expected", "detail",
    ]);
    expect(sheet.rows[0][0]).toBe("DEP-005-1");
    expect(sheet.rows[0][5]).toBe(962000);
  });
});

/** A masked result standing in for one block with one asset. Invented figures. */
const sampleMaskedResult: MaskedDepResult = {
  seedSource: "operator",
  bookCharge: 150000,
  blocks: [{
    block: "Block 15%", rate: 15, openingWdv: 0, additionsFull: 1000000, additionsHalf: 0,
    deductions: 0, wdvBeforeDep: 1000000, normalDepreciation: 150000,
    additionalDepreciation: 0, totalDepreciation: 150000, closingWdv: 850000,
    shortTermGain: 0, shortTermLoss: 0, status: "ok",
  }],
  assets: [{
    ledger: "Ledger 7", block: "Block 15%", rate: 15, opening: 0, additionsNet: 1000000,
    firstUse: "20250515", shortPeriod: false, actDepreciation: 150000,
    bookCharge: 150000, difference: 0, notes: "",
  }],
  movements: [],
  excluded: [{
    ledger: "Ledger 9", date: "20250901", amount: 90000,
    rule: "", missing: "no rule matched the counter ledger's group",
  }],
  findings: [],
};

describe("depreciationSheets", () => {
  it("builds the six sheets the design names, in order", () => {
    const sheets = depreciationSheets(sampleMaskedResult);
    expect(sheets.map((s) => s.name)).toEqual([
      "Summary", "Blocks", "Assets", "Movements", "Excluded", "Findings",
    ]);
  });

  it("puts the unverified-seed banner on the Summary sheet, not in a footnote", () => {
    const sheets = depreciationSheets({ ...sampleMaskedResult, seedSource: "book-seed" });
    expect(sheets[0].title?.join(" ")).toContain("UNVERIFIED BOOK SEED");
  });

  it("states on the Assets sheet that the split is an allocation", () => {
    const assets = depreciationSheets(sampleMaskedResult)[2];
    expect(assets.title?.join(" ")).toMatch(/block figure is (the )?statutory/i);
    expect(assets.title?.join(" ")).toMatch(/allocation/i);
  });

  it("shows no alternative figure on the Excluded sheet", () => {
    const excluded = depreciationSheets(sampleMaskedResult)[4];
    expect(excluded.columns.map((c) => c.header)).toEqual([
      "Asset", "Date", "Amount", "Closest rule", "What is missing", "Operator file stanza",
    ]);
  });
});

describe("writeDepreciationReport", () => {
  it("writes the trio with de-masked names, the seed banner and the allocation note", async () => {
    const vault = createVault();
    const alias = vault.pseudonym("Sample Machinery LLP", "creditor");
    const result: MaskedDepResult = {
      ...sampleMaskedResult,
      seedSource: "book-seed",
      assets: [{ ...sampleMaskedResult.assets[0], ledger: alias }],
      excluded: [...sampleMaskedResult.excluded],
      findings: [{
        id: "DEP-006-1", check: "dep_credit_unclassified", severity: "critical",
        ledger: alias, block: "Block 15%", amount: 90000,
        detail: `a credit is excluded: ${alias} is unclassified`,
      }],
    };
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-dep-"));
    const paths = await writeDepreciationReport({
      reportDir: dir,
      company: "Demo Traders Pvt Ltd",
      fromDate: "20250401",
      toDate: "20260331",
      result,
      vault,
    });
    expect(paths.workbookPath).toMatch(/depreciation-review-demo-traders-pvt-ltd-20250401-20260331\.xlsx$/);
    const md = readFileSync(paths.markdownPath, "utf8");
    expect(paths.markdownPath).toMatch(/depreciation-review-demo-traders-pvt-ltd-20250401-20260331\.md$/);
    expect(md).toContain("UNVERIFIED BOOK SEED");
    expect(md).toContain("Sample Machinery LLP");
    expect(md).not.toContain("Creditor 1");
    expect(md).toMatch(/block figure is (the )?statutory/i);
    const csv = readFileSync(paths.csvPath, "utf8");
    expect(csv.split("\n")[0]).toBe("id,check,severity,ledger,block,amount,detail");
    expect(csv).toContain("Sample Machinery LLP");
    const wb = await readFile(paths.workbookPath);
    const summaryXml = entry(wb, "xl/worksheets/sheet1.xml");
    expect(summaryXml).toContain("UNVERIFIED BOOK SEED");
    const excludedXml = entry(wb, "xl/worksheets/sheet5.xml");
    expect(excludedXml).toContain("Operator file stanza");
    expect(excludedXml).not.toContain("Creditor 1");
  });
});

/** A masked FA register standing in for one vehicle acquisition. Invented names and figures. */
const sampleFaResult: MaskedFaResult = {
  fromDate: "20250401",
  toDate: "20260331",
  counts: { critical: 0, warning: 0, review: 2 },
  purchases: [{
    date: "20250710", asset: "Ledger 7", block: "Block 30%", rate: 30,
    counterparty: "Creditor 1", vendor: "Creditor 1", amount: 2000000,
    voucherType: "Purc", voucherNumber: "Doc 1", reference: "Doc 2",
    acquisitionDate: "20250710", instalment: 1, instalments: 1,
    acquisitionCost: 2000000, netted: 0, rule: "acquisition",
    isVehicle: true, incidentalSummary: "insurance: capitalised; rto: not found — FA-002-1; accessories: none (not flagged)",
  }],
  disposals: [{
    date: "20251005", asset: "", block: "", counterparty: "Ledger 11", amount: 96000,
    voucherType: "Sale", voucherNumber: "Doc 3", reference: "",
    kind: "disposal-signal", rule: "§9", note: "no matching credit in any asset ledger",
  }],
  vehicleCosts: [{
    vehicle: "Ledger 7", block: "Block 30%", firstUse: "20250710", costType: "rto",
    status: "not-found", amount: 0, date: null, where: "",
    voucherType: "", voucherNumber: "", reference: "",
    ambiguous: false, findingId: "FA-002-1",
  }],
  vendors: [{
    vendor: "Creditor 1", vehicles: ["Ledger 7"], acquisitionsTotal: 2000000,
    closingBalance: -150000, side: "Cr", squaredOff: false, findingId: "FA-003-1",
  }],
  findings: [
    {
      id: "FA-002-1", check: "fa_vehicle_incidental_missing", severity: "review",
      ledger: "Ledger 7", block: "Block 30%", amount: 0,
      detail: "no rto cost of first use appears ... within 30 days before to 90 days after the first use on 10-Jul-2025",
    },
    {
      id: "FA-003-1", check: "fa_vehicle_vendor_unsettled", severity: "review",
      ledger: "Creditor 1", block: "", amount: 150000,
      detail: "the supplier's ledger closes the period on 31-Mar-2026 with a Cr balance of 1,50,000.00",
    },
  ],
  assetLedgers: 3,
};

describe("fixedAssetSheets", () => {
  it("builds the six sheets the design names, in order", () => {
    const sheets = fixedAssetSheets(sampleFaResult);
    expect(sheets.map((s) => s.name)).toEqual([
      "Summary", "Purchases", "Disposals", "Vehicle costs", "Vendors", "Findings",
    ]);
    expect(sheets[0].title?.join(" ")).toContain("Asset ledgers: 3");
    expect(sheets[1].rows[0]).toContain("Doc 1");
  });
});

describe("writeFaRegisterReport", () => {
  it("writes the trio with de-masked names and voucher numbers, displayDate and grouped money", async () => {
    const vault = createVault();
    vault.pseudonym("Tipper Works Ltd", "other"); // warm the counter for determinism
    const assetAlias = vault.pseudonym("Tipper Lorry 3", "other");
    const vendorAlias = vault.pseudonym("Safe Motors", "creditor");
    const docAlias = vault.pseudonym("PUR/918020045566771", "doc");
    const refAlias = vault.pseudonym("INV-2201", "doc");
    const result: MaskedFaResult = {
      ...sampleFaResult,
      purchases: [{
        ...sampleFaResult.purchases[0],
        asset: assetAlias, counterparty: vendorAlias, vendor: vendorAlias,
        voucherNumber: docAlias, reference: refAlias,
      }],
      vendors: [{ ...sampleFaResult.vendors[0], vendor: vendorAlias, vehicles: [assetAlias] }],
    };
    const dir = await mkdtemp(join(tmpdir(), "fa-reg-"));
    const paths = await writeFaRegisterReport({
      reportDir: dir, company: "Sample Works", fromDate: "20250401", toDate: "20260331",
      result, vault,
    });
    expect(paths.markdownPath).toContain("fixed-asset-register-sample-works-20250401-20260331.md");
    const md = await readFile(paths.markdownPath, "utf8");
    expect(md).toContain("Safe Motors"); // de-masked from the finding's ledger pseudonym
    expect(md).toContain("1,50,000.00");
    expect(md).toContain("31-Mar-2026");
    expect(md).not.toMatch(/\d{6,}/);
    const csv = await readFile(paths.csvPath, "utf8");
    expect(csv).toContain("Safe Motors");
    const wb = await readFile(paths.workbookPath);
    const purchasesXml = entry(wb, "xl/worksheets/sheet2.xml");
    expect(purchasesXml).toContain("PUR/918020045566771");
    expect(purchasesXml).not.toContain(docAlias);
  });
});
