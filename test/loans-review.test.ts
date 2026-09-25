import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { buildLoansTemplateWorkbook } from "../src/loans-file.js";
import { buildWorkbook } from "../src/xlsx.js";

// Synthetic ledgers and figures only: the real operator's loan ledgers, party
// names, PANs and addresses never appear in the repo (captain ruling).
// The ROOT_OF_PRIMARIES node: "\u0004 Primary" (see src/classify.ts).

const LEDGERS = [
  { name: "Metro Finance", parent: "Loans (Liability)" },
  { name: "Neighbour Trust", parent: "Loans (Liability)" },
  { name: "Colony Trust", parent: "Loans (Liability)" },
  { name: "Cash", parent: "Cash-in-Hand" },
  { name: "Axis Bank", parent: "Bank Accounts" },
  { name: "Wholesale Client", parent: "Sundry Debtors" },
  { name: "Site Advance Expense", parent: "Indirect Expenses" },
];
const GROUPS = [
  { name: "Loans (Liability)", parent: "\u0004 Primary" },
  { name: "Cash-in-Hand", parent: "Current Assets" },
  { name: "Bank Accounts", parent: "Current Assets" },
  { name: "Current Assets", parent: "\u0004 Primary" },
  { name: "Sundry Debtors", parent: "Current Assets" },
  { name: "Indirect Expenses", parent: "\u0004 Primary" },
];

// File amounts follow the day-book raw sign (negative = debit); the reader
// flips once at load, so the engine sees positive = debit. Entry ledgers use
// the LEDGERNAME key parseVoucherRows reads; the raw day-book format drops
// narrations, so the live-path stub cannot supply them either.
const VOUCHERS = [
  // Neighbour Trust cash acceptance 25,000 — 269SS breach
  {
    date: "2025-04-15", voucherType: "Journal", voucherNumber: "J-1",
    entries: [{ LEDGERNAME: "Cash", AMOUNT: -25000 }, { LEDGERNAME: "Neighbour Trust", AMOUNT: 25000 }],
  },
  // Metro Finance cash acceptance 25,000 — overridden to bank channel by template
  {
    date: "2025-04-20", voucherType: "Journal", voucherNumber: "J-2",
    entries: [{ LEDGERNAME: "Cash", AMOUNT: -25000 }, { LEDGERNAME: "Metro Finance", AMOUNT: 25000 }],
  },
  // Metro Finance bank repayment 30,000 (Dr loan / Cr bank) — no breach
  {
    date: "2026-02-15", voucherType: "Payment", voucherNumber: "P-1",
    entries: [{ LEDGERNAME: "Metro Finance", AMOUNT: -30000 }, { LEDGERNAME: "Axis Bank", AMOUNT: 30000 }],
  },
  // Colony Trust journal-mode acceptance 15,000 — mode unknown advisory
  {
    date: "2025-06-10", voucherType: "Journal", voucherNumber: "J-3",
    entries: [{ LEDGERNAME: "Site Advance Expense", AMOUNT: -15000 }, { LEDGERNAME: "Colony Trust", AMOUNT: 15000 }],
  },
  // Wholesale Client cash receipt 2,05,000 — 269ST receipt register
  {
    date: "2025-07-01", voucherType: "Receipt", voucherNumber: "R-1",
    entries: [{ LEDGERNAME: "Cash", AMOUNT: -205000 }, { LEDGERNAME: "Wholesale Client", AMOUNT: 205000 }],
  },
];

const REAL_PAN = "AAACM1234E";
const REAL_ADDRESS = "12, Subhash Road, Metropolis";

const BUNDLE = {
  tallyAgentExport: true,
  company: "Sample Co",
  groups: GROUPS,
  ledgers: LEDGERS,
  vouchers: VOUCHERS,
};

const rejectWith = (why: string) => async () => {
  throw new Error(why);
};

async function bundlePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "loans-review-"));
  const p = join(dir, "daybook-bundle.json");
  await writeFile(p, JSON.stringify(BUNDLE), "utf8");
  return p;
}

const PHASE = { fromDate: "20250401", toDate: "20260331" };

// The tests' loader writes a temporary day-book file; the session reads it
// through the path-only channel (no file contents ever ride the session).
async function templatePath(): Promise<string> {
  const { sheets } = buildLoansTemplateWorkbook(
    LEDGERS.map((l) => ({ name: l.name })).filter((p) =>
      ["Metro Finance", "Neighbour Trust", "Colony Trust"].includes(p.name),
    ),
    {},
  );
  sheets[0].rows = [["Metro Finance", REAL_PAN, REAL_ADDRESS, "", "A/c payee Cheque", ""]];
  const dir = await mkdtemp(join(tmpdir(), "loans-template-"));
  const p = join(dir, "loans-template.xlsx");
  await writeFile(p, buildWorkbook(sheets));
  return p;
}

describe("Session.loansReview — day-book offline run", () => {
  it("degrades with rejecting live stubs and still reviews the bundle", async () => {
    const stub = Object.assign(fakeDownstream(), {
      groups: rejectWith("no live tally"),
      ledgers: rejectWith("no live tally"),
    } as never);
    const session = createSession(stub, EMPTY_OVERRIDES);
    const result = await session.loansReview({
      ...PHASE,
      dayBookPath: await bundlePath(),
      templatePath: await templatePath(),
    });
    expect(result.mastersSource).toBe("bundle");

    // Masked parties: vault pseudonyms ("Ledger N") and role masks, never raw names.
    const text = JSON.stringify(result);
    expect(text).not.toContain("Metro Finance");
    expect(text).not.toContain("Neighbour Trust");
    expect(text).not.toContain("Wholesale Client");
    expect(text).not.toContain(REAL_PAN);
    expect(text).not.toContain(REAL_ADDRESS);
    // PAN rides a tax_id alias on the bank-override sheet-1 row.
    expect(result.rows.some((r) => (r.panAlias ?? "").startsWith("TaxId "))).toBe(true);

    // Sheet counts
    expect(result.sheets.sheet1).toBe(2); // Metro (override row) + Neighbour cash
    expect(result.sheets.sheet3).toBe(1); // Metro bank repayment
    expect(result.sheets.sheet6).toBe(1); // 2,05,000 receipt
    expect(result.sheets.sheet2).toBe(0);
    expect(result.sheets.sheet4).toBe(0);
    expect(result.sheets.sheet5).toBe(0);
    expect(result.sheets.sheet7).toBe(0);

    const checks = result.findings.map((f) => f.check);
    // Template override honoured: Metro's cash acceptance became an a/c payee row...
    // Neighbour's cash acceptance still breaches 269SS.
    expect(checks).toContain("loans_cash_acceptance");
    // Journal-mode acceptance is an advisory, never a breach (C3).
    expect(checks).toContain("loans_mode_unknown");
    expect(checks).toContain("loans_269st_receipt");
    expect(checks).not.toContain("loans_cash_repayment");

    for (const f of result.findings) {
      // money() groups figures, so a bare 6+-digit run with decimals cannot appear
      expect(/[0-9]{6,}\.\d{2}/.test(f.detail)).toBe(false);
    }
    const breach = result.findings.find((f) => f.check === "loans_cash_acceptance")!;
    expect(breach.detail).toContain("25,000.00");
    expect(breach.detail).toContain("15-Apr-2025");
    expect(breach.detail).toContain("Ledger ");
    const receipt = result.findings.find((f) => f.check === "loans_269st_receipt")!;
    expect(receipt.detail).toContain("2,05,000.00");
    const unknown = result.findings.find((f) => f.check === "loans_mode_unknown")!;
    expect(unknown.detail).toContain("15,000.00");
    expect(result.sectionSummary).toEqual(expect.any(Array));

    // Drill-down parity: every masked finding id resolves to the real ledger name.
    expect(session.vault.resolve(breach.ledger)).toBeTruthy();
  });
});

describe("Session.loansReview — degraded masters", () => {
  it("proceeds over a bundle without ledgers, raising loans_party_unmastered", async () => {
    const stub = fakeDownstream();
    const session = createSession(stub, EMPTY_OVERRIDES);
    const dir = await mkdtemp(join(tmpdir(), "loans-absent-"));
    const p = join(dir, "daybook.json");
    await writeFile(p, JSON.stringify({
      tallyAgentExport: true,
      company: "Sample Co",
      vouchers: VOUCHERS,
    }), "utf8");
    const result = await session.loansReview({ ...PHASE, dayBookPath: p });
    expect(result.mastersSource).toBe("absent");
    // Without the bundle's masters even loan-ledger discovery is impossible —
    // the honest run emits the unmastered advisory and invents nothing.
    expect(result.findings.map((f) => f.check)).toEqual(
      expect.arrayContaining(["loans_party_unmastered"]),
    );
    expect(result.sheets.sheet1).toBe(0);
    expect(result.sheets.sheet6).toBe(0);
    const unmastered = result.findings.find((f) => f.check === "loans_party_unmastered")!;
    expect(unmastered.detail).toMatch(/5 vouchers/);
  });
});

describe("Session.loansReview — live path", () => {
  it("reads groups, ledgers and vouchers from the live stub", async () => {
    const stub = fakeDownstream({
      tally_get_groups: JSON.stringify(GROUPS),
      tally_get_ledgers: JSON.stringify(LEDGERS),
      tally_get_vouchers: JSON.stringify(
        VOUCHERS.map((v) => ({
          date: String(v.date).replace(/-/g, ""),
          voucherType: v.voucherType,
          voucherNumber: v.voucherNumber,
          entries: v.entries,
        })),
      ),
    });
    const session = createSession(stub, EMPTY_OVERRIDES);
    const result = await session.loansReview(PHASE);
    expect(result.mastersSource).toBe("live");
    expect(result.sheets.sheet1).toBe(2);
    expect(result.sheets.sheet6).toBe(1);
    const text = JSON.stringify(result);
    expect(text).not.toContain("Neighbour Trust");
  });
});

describe("Session.loansRows — raw cache for the Winman writer", () => {
  it("returns raw per-sheet rows and the vault map, unmasked, dates raw", async () => {
    const stub = Object.assign(fakeDownstream(), {
      groups: rejectWith("no live tally"),
      ledgers: rejectWith("no live tally"),
    } as never);
    const session = createSession(stub, EMPTY_OVERRIDES);
    await session.loansReview({
      ...PHASE,
      dayBookPath: await bundlePath(),
      templatePath: await templatePath(),
    });
    const cached = session.loansRows()!;
    expect(cached.sheets.sheet1).toHaveLength(2);
    expect(cached.sheets.sheet6).toHaveLength(1);
    // Raw cache carries the real names and the raw PAN; dates stay YYYYMMDD.
    const text = JSON.stringify(cached);
    expect(text).toContain("Metro Finance");
    expect(text).toContain(REAL_PAN);
    // Vault snapshot resolves the alias to its real value.
    const entry = cached.vault.find((e) => e.real === REAL_PAN);
    expect(entry?.alias.startsWith("TaxId ")).toBe(true);
  });

  it("returns undefined before any run", () => {
    const session = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    expect(session.loansRows()).toBeUndefined();
  });
});

describe("Session.loansReview — narrations on the day-book path", () => {
  // Narrations survive readDayBook -> VoucherRow (fix round): C4 mode hints
  // and sheet-6 nature text ride the file channel, not just live runs.
  async function narratedBundlePath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "loans-narration-"));
    const p = join(dir, "daybook-bundle.json");
    await writeFile(p, JSON.stringify({
      tallyAgentExport: true,
      company: "Sample Co",
      groups: GROUPS,
      ledgers: LEDGERS,
      vouchers: [
        // Object narration reads empty (never "[object Object]") → default ECS.
        {
          date: "2025-08-15", voucherType: "Payment", voucherNumber: "P-2",
          narration: { rich: "object narration" },
          entries: [{ LEDGERNAME: "Neighbour Trust", AMOUNT: -30000 }, { LEDGERNAME: "Axis Bank", AMOUNT: 30000 }],
        },
        // RTGS hint overrides the ECS default (C4).
        {
          date: "2025-09-15", voucherType: "Payment", voucherNumber: "P-3",
          narration: "settled through RTGS transfer",
          entries: [{ LEDGERNAME: "Colony Trust", AMOUNT: -40000 }, { LEDGERNAME: "Axis Bank", AMOUNT: 40000 }],
        },
        // Plain narration on a bank repayment — ECS default.
        {
          date: "2025-10-15", voucherType: "Payment", voucherNumber: "P-4",
          narration: "loan repayment",
          entries: [{ LEDGERNAME: "Metro Finance", AMOUNT: -50000 }, { LEDGERNAME: "Axis Bank", AMOUNT: 50000 }],
        },
        // Cash receipt candidate whose narration carries the sheet-6 nature.
        {
          date: "2025-11-01", voucherType: "Receipt", voucherNumber: "R-2",
          narration: "cash against truck hire deposit",
          entries: [{ LEDGERNAME: "Cash", AMOUNT: -205000 }, { LEDGERNAME: "Wholesale Client", AMOUNT: 205000 }],
        },
      ],
    }), "utf8");
    return p;
  }

  it("carries narration hints into modes and the 269ST nature", async () => {
    const session = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const result = await session.loansReview({
      fromDate: "20250401", toDate: "20260331",
      dayBookPath: await narratedBundlePath(),
    });
    // One bank-class repayment row per party, all crossed > 20,000.
    const repaid = result.rows.filter((r) => r.mode !== undefined);
    expect(repaid).toHaveLength(3);
    const modes = repaid.map((r) => r.mode).sort();
    expect(modes).toEqual(["ECS", "ECS", "RTGS"]);
    expect(JSON.stringify(result)).not.toContain("[object Object]");

    // Sheet-6 nature carries the narration text.
    const sheet6 = result.rows.filter((r) => r.type === "Receipts");
    expect(sheet6).toHaveLength(1);
    expect(sheet6[0].nature).toContain("cash against truck hire deposit");
  });
});

describe("Session.loansReview — narration quoting a different loan party", () => {
  // maskRow pre-vaults EVERY loan party before any sweep (pfEsi pattern).
  // The leak surfaces on a sheet-6 row's `nature`, the only masked field that
  // carries narration text: each narrating voucher is a ≥ 2,00,000 cash
  // receipt (a loans_269st_receipt candidate whose row keeps the narration),
  // while the QUOTED party owns no movements at all — so without the
  // pre-vault loop the row's own party is vaulted but the quoted party's
  // real name rides straight into the masked result.
  const PARTIES = ["Trust A", "Trust B", "Trust C"];
  const quotedButSilent: { name: string; parent: string }[] = [
    ...PARTIES.map((n) => ({ name: n, parent: "Loans (Liability)" })),
    { name: "Axle Client", parent: "Sundry Debtors" },
    { name: "Cash", parent: "Cash-in-Hand" },
  ];

  async function crossNamingBundle(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "loans-crossname-"));
    const p = join(dir, "daybook-bundle.json");
    await writeFile(p, JSON.stringify({
      tallyAgentExport: true,
      company: "Sample Co",
      groups: GROUPS,
      ledgers: quotedButSilent,
      vouchers: [
        {
          date: "2025-08-15", voucherType: "Journal", voucherNumber: "J-1",
          narration: "loan visible to Trust A settled like Trust C",
          entries: [{ LEDGERNAME: "Cash", AMOUNT: -205000 }, { LEDGERNAME: "Axle Client", AMOUNT: 205000 }],
        },
        // Voucher 2: quote Trust A too but in the opposite order, and pull a
        // bank counter in, so the class differs from voucher 1.
        {
          date: "2025-09-15", voucherType: "Journal", voucherNumber: "J-2",
          narration: "loan visible to Trust B",
          entries: [{ LEDGERNAME: "Cash", AMOUNT: -205000 }, { LEDGERNAME: "Axle Client", AMOUNT: 205000 }],
        },
      ],
    }), "utf8");
    return p;
  }

  it("pre-vaults every party so no raw name survives the sweep", async () => {
    const session = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const result = await session.loansReview({
      fromDate: "20250401", toDate: "20260331",
      dayBookPath: await crossNamingBundle(),
    });
    // The narrations must actually surface: two sheet-6 rows carry the nature.
    const sheet6 = result.rows.filter((r) => r.type === "Receipts");
    expect(sheet6).toHaveLength(2);
    expect(sheet6[0].nature).toMatch(/loan visible to/);
    const text = JSON.stringify(result);
    for (const name of PARTIES) expect(text).not.toContain(name);
  });
});

describe("Session.loansReview — mastersSource tri-state and grouped counts", () => {
  it("treats a present-but-empty ledgers array as absent", async () => {
    const session = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const dir = await mkdtemp(join(tmpdir(), "loans-empty-ledgers-"));
    const p = join(dir, "daybook.json");
    await writeFile(p, JSON.stringify({
      tallyAgentExport: true,
      company: "Sample Co",
      groups: GROUPS,
      ledgers: [], // present but EMPTY — degrades to absent, not "bundle"
      vouchers: VOUCHERS,
    }), "utf8");
    const result = await session.loansReview({ fromDate: "20250401", toDate: "20260331", dayBookPath: p });
    expect(result.mastersSource).toBe("absent");
    expect(result.findings.map((f) => f.check)).toContain("loans_party_unmastered");
  });

  it("groups the voucher count in loans_party_unmastered (scrubDigits-safe)", async () => {
    const session = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    // A six-digit voucher count is cheap to synthesise: all 1,00,000 entries
    // are the SAME object — JSON.stringify repeats it (no reference dedupe
    // on dump), so write output stays ~10 MB, not smaller.
    const vouchers = Array.from({ length: 1_00_000 }, () => VOUCHERS[0]);
    const dir = await mkdtemp(join(tmpdir(), "loans-count-"));
    const p = join(dir, "daybook.json");
    await writeFile(p, JSON.stringify({
      tallyAgentExport: true, company: "Sample Co", vouchers,
    }), "utf8");
    const result = await session.loansReview({ fromDate: "20250401", toDate: "20260331", dayBookPath: p });
    const unmastered = result.findings.find((f) => f.check === "loans_party_unmastered")!;
    // count() groups the digit run; the bare "100000" run must be absent.
    expect(unmastered.detail).toContain("1,00,000");
    expect(unmastered.detail).not.toMatch(/1\d{5} vouchers/);
  });
});
