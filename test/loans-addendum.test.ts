import { describe, expect, it } from "vitest";
import { canonicalKey } from "../src/key.js";
import { CHECK_ORDINAL } from "../src/types.js";
import {
  EMPTY_LOANS_OPERATOR,
  bankLenderNameMatch,
  buildLoansCtx,
  buildLoansRows,
  loanAutoExemptNames,
  loanLedgerEvents,
  scan269St,
  type LoanEvent,
  type LoansOperator,
  type V,
} from "../src/loans.js";
import { readDayBook, readDayBookMasterPairs } from "../src/tds-daybook.js";
import {
  buildLoansTemplateWorkbook,
  parseLoansTemplate,
} from "../src/loans-file.js";
import { buildWorkbook, type Sheet } from "../src/xlsx.js";

const GROUPS = [
  { name: "Loans (Liability)", parent: "\u0004 Primary" },
  { name: "Bank OD A/c", parent: "Loans (Liability)" },
  { name: "Bank OCC A/c", parent: "Loans (Liability)" },
  { name: "Unsecured Loans", parent: "Loans (Liability)" },
  { name: "Current Assets", parent: "\u0004 Primary" },
  { name: "Cash-in-Hand", parent: "Current Assets" },
  { name: "Bank Accounts", parent: "Current Assets" },
];

const MASTERS = [
  { name: "Cash", parent: "Cash-in-Hand" },
  { name: "HDFC Bank", parent: "Bank Accounts" },
  { name: "CC Limit A/c", parent: "Bank OD A/c" },
  { name: "OCC Union A/c", parent: "Bank OCC A/c" },
  { name: "Nirosha - Loan A/c", parent: "Unsecured Loans" },
  { name: "Term Loan A/c", parent: "Unsecured Loans" },
];

const ctx = buildLoansCtx(MASTERS, GROUPS);

const mk = (
  date: string | number,
  entries: V["entries"],
  voucherType = "Payment",
  narration = "",
): V => ({ date, voucherNumber: 101, voucherType, narration, entries });

const ev = (
  date: string,
  party: string,
  direction: LoanEvent["direction"],
  amount: number,
  mode: LoanEvent["mode"],
): LoanEvent => ({ date, party, direction, amount, mode, narration: "" });

describe("OD/OCC ancestry is bank (addendum 1)", () => {
  it("ctx predicates: OD/OCC-ancestry ledger is a bank ledger and a bank-OD loan; true loans untouched", () => {
    expect(ctx.isBankOdLedger("CC Limit A/c")).toBe(true);
    expect(ctx.isBankOdLedger("OCC Union A/c")).toBe(true);
    expect(ctx.isBankOdLoan("CC Limit A/c")).toBe(true);
    expect(ctx.isBankLedger("CC Limit A/c")).toBe(true);
    expect(ctx.isLoanLedger("CC Limit A/c")).toBe(true);
    expect(ctx.isBankLedger("HDFC Bank")).toBe(true);
    expect(ctx.isBankOdLoan("Nirosha - Loan A/c")).toBe(false);
    expect(ctx.isLoanLedger("Nirosha - Loan A/c")).toBe(true);
    expect(ctx.isBankOdLedger("Term Loan A/c")).toBe(false);
  });

  it("loanLedgerEvents drops the OD ledger entirely and keeps true-loan events", () => {
    const vouchers: V[] = [
      mk("20250415", [
        { ledger: "Cash", amount: 700000 },
        { ledger: "CC Limit A/c", amount: -700000 },
      ], "Receipt"),
      mk("20250416", [
        { ledger: "Imprest", amount: 50000 },
        { ledger: "OCC Union A/c", amount: -50000 },
      ], "Contra"),
      mk("20250610", [
        { ledger: "Nirosha - Loan A/c", amount: 100000 },
        { ledger: "CC Limit A/c", amount: -100000 },
      ]),
    ];
    const events = loanLedgerEvents(vouchers, ctx);
    expect(events).toEqual([
      {
        date: "20250610",
        party: "Nirosha - Loan A/c",
        direction: "repaid",
        amount: 100000,
        mode: "bank",
        narration: "",
        voucherNumber: "101",
      },
    ]);
  });

  it("269ST scan: cash withdrawal contra payments on the OD ledger yield no sheet6 row or finding", () => {
    const res = scan269St(
      [
        mk("20250415", [
          { ledger: "Cash", amount: 700000 },
          { ledger: "CC Limit A/c", amount: -700000 },
        ], "Receipt"),
        mk("20250416", [
          { ledger: "Imprest", amount: 50000 },
          { ledger: "OCC Union A/c", amount: -50000 },
        ], "Contra"),
      ],
      ctx,
      EMPTY_LOANS_OPERATOR,
    );
    expect(res.sheet6).toEqual([]);
    expect(res.sheet7).toEqual([]);
    expect(res.findings.filter((f) => f.check.startsWith("loans_269st"))).toEqual([]);
  });
});

describe("IDFC/Union Bank loans: 003 fix — repayments through the OD ledger reach 269T", () => {
  it("six Payment vouchers Dr Nirosha - Loan A/c / Cr CC Limit A/c classify bank-mode and row on sheet3", () => {
    const vouchers: V[] = [
      mk("20250410", [
        { ledger: "Nirosha - Loan A/c", amount: 216_333.34 },
        { ledger: "CC Limit A/c", amount: -216_333.34 },
      ]),
      mk("20250512", [
        { ledger: "Nirosha - Loan A/c", amount: 216_333.33 },
        { ledger: "CC Limit A/c", amount: -216_333.33 },
      ]),
      mk("20250614", [
        { ledger: "Nirosha - Loan A/c", amount: 216_333.33 },
        { ledger: "CC Limit A/c", amount: -216_333.33 },
      ]),
      mk("20250715", [
        { ledger: "Nirosha - Loan A/c", amount: 216_333.34 },
        { ledger: "CC Limit A/c", amount: -216_333.34 },
      ]),
      mk("20250816", [
        { ledger: "Nirosha - Loan A/c", amount: 216_333.33 },
        { ledger: "CC Limit A/c", amount: -216_333.33 },
      ]),
      mk("20250917", [
        { ledger: "Nirosha - Loan A/c", amount: 216_333.33 },
        { ledger: "CC Limit A/c", amount: -216_333.33 },
      ]),
    ];
    const events = loanLedgerEvents(vouchers, ctx);
    expect(events).toHaveLength(6);
    expect(events.every((e) => e.party === "Nirosha - Loan A/c" && e.mode === "bank")).toBe(true);
    expect(events.reduce((s, e) => s + e.amount, 0)).toBeCloseTo(1_298_000, 1);
    const books = buildLoansRows(events, EMPTY_LOANS_OPERATOR, { mastersPresent: true });
    // The bucket is per (party, direction, mode): all six aggregate to one
    // honest 269T row carrying the whole FY amount.
    expect(books.sheet3).toEqual([
      expect.objectContaining({
        party: "Nirosha - Loan A/c",
        amount: expect.closeTo(1_298_000, 1),
        mode: expect.anything(),
      }),
    ]);
    expect(books.findings.some((f) => f.check === "loans_mode_unknown")).toBe(false);
  });
});

describe("bank lender name match (addendum 2)", () => {
  it("matches curated bank tokens case/whitespace-insensitively", () => {
    for (const name of [
      "IDFC First Bank Loan",
      "Union Bank OD Loan",
      "SBI Loan A/c",
      "State Bank of India Loan",
      "HDFC Bank Loan 2",
      "ICICI Bank Loan",
      "Axis Bank Car Loan",
      "Kotak Bank Term Loan",
      "Indian Bank Loan",
      "Canara Bank Loan",
      "Bank of Baroda Loan",
      "PNB Loan A/c",
      "IOB Loan",
      "Indian Overseas Bank Loan",
      "Karur Vysya Bank Loan",
      "KVB Term Loan",
      "City Union Bank Loan",
      "CUB Loan",
      "TMB Loan",
      "Federal Bank Loan",
      "IndusInd Bank Loan",
      "Yes Bank Loan",
      "Bank of India Loan",
    ]) {
      expect(bankLenderNameMatch(name)).toBe(true);
    }
  });

  it("addendum 4: the UB short form matches UB -X / UB-X / UB X", () => {
    expect(bankLenderNameMatch("UB - Standard Term Loan")).toBe(true);
    expect(bankLenderNameMatch("UB-Site Overdraft Loan")).toBe(true);
    expect(bankLenderNameMatch("UB Site Loan")).toBe(true);
    // "Capital" is an NBFC-guard word (Working-Capital names); the guard wins.
    expect(bankLenderNameMatch("UB Working Capital Loan")).toBe(false);
    expect(bankLenderNameMatch("UBX Loan")).toBe(false);
    expect(bankLenderNameMatch("SUB Loan")).toBe(false);
  });

  it("NBFC guard wins over bank tokens; HDFC alone is not an exempt token", () => {
    for (const name of [
      "Bajaj Finance Ltd Loan",
      "Sundaram Finance Loan",
      "Tata Capital Loan",
      "Shriram Finance Loan",
      "Mahindra Finance Loan",
      "Cholamandalam Investment Loan",
      "HDFC Loan A/c",
      "Ordinary Loan Creditor",
    ]) {
      expect(bankLenderNameMatch(name)).toBe(false);
    }
  });
});

describe("auto-exempt machinery", () => {
  it("loanAutoExemptNames maps OD-ancestry loans to the ancestry reason and bank names to the name reason; NBFC loans excluded", () => {
    const masters = [
      ...MASTERS,
      { name: "IDFC First Bank Loan", parent: "Unsecured Loans" },
      { name: "Bajaj Finance Loan", parent: "Unsecured Loans" },
    ];
    const map = loanAutoExemptNames(masters, GROUPS);
    expect(map.get(canonicalKey("CC Limit A/c"))).toBe("bank OD/OCC ancestry");
    expect(map.get(canonicalKey("OCC Union A/c"))).toBe("bank OD/OCC ancestry");
    expect(map.get(canonicalKey("IDFC First Bank Loan"))).toBe("bank name match");
    expect(map.has(canonicalKey("Nirosha - Loan A/c"))).toBe(false);
    expect(map.has(canonicalKey("Bajaj Finance Loan"))).toBe(false);
  });

  it("auto-exempt party is skipped with one advisory; others fire as normal", () => {
    const autoExempt = new Map([
      [canonicalKey("IDFC First Bank Loan"), "bank name match"],
    ]);
    const events = [ev("20250415", "IDFC First Bank Loan", "accepted", 2_50_000, "cash")];
    const books = buildLoansRows(events, EMPTY_LOANS_OPERATOR, {
      mastersPresent: true,
      autoExempt,
    });
    expect(books.sheet1).toEqual([]);
    expect(books.findings).toEqual([
      expect.objectContaining({
        check: "loans_auto_exempt",
        severity: "review",
        ledger: "IDFC First Bank Loan",
        detail: "auto-exempt: bank name match",
      }),
    ]);
  });

  it("NBFC loan keeps its rows and gets no auto-exempt advisory", () => {
    const events = [ev("20250415", "Bajaj Finance Loan", "accepted", 2_50_000, "cash")];
    const books = buildLoansRows(events, EMPTY_LOANS_OPERATOR, { mastersPresent: true });
    expect(books.sheet1).toHaveLength(1);
    expect(books.findings.some((f) => f.check === "loans_auto_exempt")).toBe(false);
  });

  it("operator N (exemptNot) overrides auto-exemption both in the skip and the advisory", () => {
    const autoExempt = new Map([[canonicalKey("IDFC First Bank Loan"), "bank name match"]]);
    const op: LoansOperator = {
      parties: [{ ledger: "IDFC First Bank Loan", exemptNot: true }],
    };
    const events = [ev("20250415", "IDFC First Bank Loan", "accepted", 2_50_000, "cash")];
    const books = buildLoansRows(events, op, { mastersPresent: true, autoExempt });
    expect(books.sheet1).toHaveLength(1);
    expect(books.findings.some((f) => f.check === "loans_auto_exempt")).toBe(false);
  });

  it("operator Y stays fully silent even with an auto reason", () => {
    const autoExempt = new Map([[canonicalKey("CC Limit A/c"), "bank OD/OCC ancestry"]]);
    const op: LoansOperator = { parties: [{ ledger: "CC Limit A/c", exempt: true }] };
    const books = buildLoansRows(
      [ev("20250415", "CC Limit A/c", "accepted", 2_50_000, "cash")],
      op,
      { mastersPresent: true, autoExempt },
    );
    expect(books.sheet1).toEqual([]);
    expect(books.findings.filter((f) => f.check === "loans_auto_exempt")).toEqual([]);
  });

  it("OD ancestry reason advisory and estimate/splitting loops skip auto-exempt parties", () => {
    const autoExempt = new Map([[canonicalKey("CC Limit A/c"), "bank OD/OCC ancestry"]]);
    const books = buildLoansRows(
      [
        ev("20250415", "CC Limit A/c", "accepted", 3_00_000, "journal"),
        ev("20250416", "CC Limit A/c", "accepted", 1_00_000, "journal"),
      ],
      EMPTY_LOANS_OPERATOR,
      { mastersPresent: true, autoExempt },
    );
    const checks = books.findings.map((f) => f.check);
    expect(checks).toContain("loans_auto_exempt");
    expect(checks).not.toContain("loans_max_amount_estimated");
    expect(checks).not.toContain("loans_mode_unknown");
    expect(checks).not.toContain("loans_splitting_suspect");
  });
});

describe("masterFacts PAN/address precedence (addendum 1 item 3)", () => {
  const facts = new Map([
    [canonicalKey("Nirosha - Loan A/c"), { pan: "MASTER12PAN", address: "Master Address 4" }],
    [canonicalKey("Term Loan A/c"), {}],
  ]);
  const eventsFor = (party: string) => [ev("20250415", party, "accepted", 2_50_000, "bank")];

  it("operator template PAN and address WIN over master facts", () => {
    const op: LoansOperator = {
      parties: [{ ledger: "Nirosha - Loan A/c", panOrAadhaar: "TEMPLATE9PAN", address: "Template Address" }],
    };
    const books = buildLoansRows(eventsFor("Nirosha - Loan A/c"), op, {
      mastersPresent: true,
      masterFacts: facts,
    });
    expect(books.sheet1[0]).toMatchObject({
      panAlias: "TEMPLATE9PAN",
      address: "Template Address",
    });
  });

  it("master PAN/address are used only when the operator row does not speak", () => {
    const books = buildLoansRows(
      eventsFor("Nirosha - Loan A/c"),
      { parties: [{ ledger: "Nirosha - Loan A/c", address: "Operator Address" }] },
      { mastersPresent: true, masterFacts: facts },
    );
    expect(books.sheet1[0]).toMatchObject({
      panAlias: "MASTER12PAN",
      address: "Operator Address",
    });
  });

  it("a party with no facts and no operator row carries neither field", () => {
    const books = buildLoansRows(eventsFor("Term Loan A/c"), EMPTY_LOANS_OPERATOR, {
      mastersPresent: true,
      masterFacts: facts,
    });
    expect(books.sheet1[0].panAlias).toBeUndefined();
    expect(books.sheet1[0].address).toBeUndefined();
  });
});

describe("openings feed MAXAMOUNT (addendum 3)", () => {
  it("an opening restores the peak when movements dip negative; crossed stays movement-only", () => {
    const openings = new Map([[canonicalKey("Nirosha - Loan A/c"), 3_00_000]]);
    const events = [
      ev("20250601", "Nirosha - Loan A/c", "repaid", 2_50_000, "bank"),
      ev("20250701", "Nirosha - Loan A/c", "accepted", 1_00_000, "bank"),
    ];
    const books = buildLoansRows(events, EMPTY_LOANS_OPERATOR, {
      mastersPresent: true,
      openings,
    });
    // peak = max(3,00,000 opening; 50,000; 1,50,000): the opening owns it
    expect(books.sheet3[0].maxAmount).toBe(3_00_000);
    // movements alone never cross 20,000 by balance or single event… they do
    // (1,00,000 > 20,000)? No: crossedTest only crosses over LOANS_LIMIT = 20000.
    expect(books.findings.some((f) => f.check.startsWith("loans_cash"))).toBe(false);
  });

  it("a party with a known opening is silent; a party without one still gets the estimate advisory", () => {
    const openings = new Map([[canonicalKey("Nirosha - Loan A/c"), 1_00_000]]);
    const books = buildLoansRows(
      [
        ev("20250601", "Nirosha - Loan A/c", "accepted", 1_00_000, "bank"),
        ev("20250601", "Term Loan A/c", "accepted", 1_00_000, "bank"),
      ],
      EMPTY_LOANS_OPERATOR,
      { mastersPresent: true, openings },
    );
    const advisories = books.findings.filter((f) => f.check === "loans_max_amount_estimated");
    expect(advisories).toHaveLength(1);
    expect(advisories[0].ledger).toBe("Term Loan A/c");
  });
});

describe("parser Exempt accepts Y/N/blank and refuses junk", () => {
  const parseExempt = (cell: string | number | null) => {
    const sheets: Sheet[] = buildLoansTemplateWorkbook([{ name: "Loan Creditor A" }], {}).sheets;
    const parties = sheets.find((s) => s.name === "Parties")!;
    parties.rows = [["Loan Creditor A", "", "", cell, "", ""]];
    return parseLoansTemplate(buildWorkbook(sheets));
  };
  it("Y/y/Yes ⇒ exempt true; N/n/No ⇒ exemptNot; blank ⇒ neither", () => {
    expect(parseExempt("y").parties[0]).toMatchObject({ exempt: true });
    expect(parseExempt("Y").parties[0]).toMatchObject({ exempt: true });
    expect(parseExempt("yes").parties[0]).toMatchObject({ exempt: true });
    expect(parseExempt("n").parties[0]).toMatchObject({ exemptNot: true });
    expect(parseExempt("N").parties[0]).toMatchObject({ exemptNot: true });
    expect(parseExempt("no").parties[0]).toMatchObject({ exemptNot: true });
    const blank = parseExempt("");
    expect(blank.parties[0].exempt).toBeUndefined();
    expect(blank.parties[0].exemptNot).toBeUndefined();
  });
  it("junk is refused citing the address only", () => {
    const sheets: Sheet[] = buildLoansTemplateWorkbook([{ name: "Loan Creditor A" }], {}).sheets;
    const parties = sheets.find((s) => s.name === "Parties")!;
    parties.rows = [["Loan Creditor A", "", "", "maybe", "", ""]];
    let msg = "";
    try {
      parseLoansTemplate(buildWorkbook(sheets));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/^template Parties row 2, column D \(Exempt\): /);
    expect(msg).not.toContain("maybe");
  });
});

describe("template pre-fills the Exempt column", () => {
  it("writes Y only for parties flagged exempt", () => {
    const sheets = buildLoansTemplateWorkbook(
      [
        { name: "Bank OD Loan A/c", exempt: true },
        { name: "Loan Creditor A" },
      ],
      {},
    ).sheets;
    const parties = sheets.find((s) => s.name === "Parties")!;
    expect(parties.rows[0]).toEqual(["Bank OD Loan A/c", null, null, "Y"]);
    expect(parties.rows[1]).toEqual(["Loan Creditor A", null, null, null]);
    const parsed = parseLoansTemplate(buildWorkbook(sheets));
    expect(parsed.parties[0]).toMatchObject({ ledger: "Bank OD Loan A/c", exempt: true });
    expect(parsed.parties).toHaveLength(2);
  });
});

describe("day-book reader carries pan/gstin/address/openingBalance additively", () => {
  const bundle = (ledgers: object[]): string =>
    JSON.stringify({
      company: "Acme Builders",
      from: "20250401",
      to: "20260331",
      groups: [{ name: "Unsecured Loans", parent: "Loans (Liability)" }],
      ledgers,
      vouchers: [],
    });

  it("reads the new fields, normalising pan/gstin and keeping address case", () => {
    const env = readDayBookMasterPairs(
      bundle([
        { name: "Nirosha - Loan A/c", parent: "Unsecured Loans", pan: "aaapl1234a", gstin: "33aaapl1234a1z5", address: "4 Nanda St", openingBalance: -300 },
        { name: "Plain A/c", parent: "Unsecured Loans" },
      ]),
      "Acme Builders",
    );
    expect(env.ledgers).toEqual([
      { name: "Nirosha - Loan A/c", parent: "Unsecured Loans", pan: "AAAPL1234A", gstin: "33AAAPL1234A1Z5", address: "4 Nanda St", openingBalance: -300 },
      { name: "Plain A/c", parent: "Unsecured Loans", pan: null, gstin: null, address: null, openingBalance: null },
    ]);
  });

  it("strips un-decoded XML escapes from pan/gstin (4d)", () => {
    const env = readDayBookMasterPairs(
      bundle([
        { name: "Khicha Lender", parent: "Loans (Liability)", pan: "ABCDE1234F&#13;&#10;", gstin: "33ABCDE1234F1Z5&#10;" },
      ]),
      "Acme Builders",
    );
    expect(env.ledgers).toEqual([
      { name: "Khicha Lender", parent: "Loans (Liability)", pan: "ABCDE1234F", gstin: "33ABCDE1234F1Z5", address: null, openingBalance: null },
    ]);
  });

  it("an old bundle without the fields still loads", () => {
    const env = readDayBookMasterPairs(
      bundle([{ name: "Nirosha - Loan A/c", parent: "Unsecured Loans" }]),
      "Acme Builders",
    );
    expect(env.ledgers).toEqual([
      { name: "Nirosha - Loan A/c", parent: "Unsecured Loans", pan: null, gstin: null, address: null, openingBalance: null },
    ]);
  });

  it("a non-zero openingBalance round-trips through readDayBook (addendum 4a)", () => {
    const bundleText = JSON.stringify({
      tallyAgentExport: 1,
      company: "Acme Builders",
      fromDate: "20250401",
      toDate: "20260331",
      groups: [{ name: "Unsecured Loans", parent: "Loans (Liability)" }],
      ledgers: [
        { name: "Nirosha - Loan A/c", parent: "Unsecured Loans", openingBalance: -3_50_000 },
        { name: "Cash", parent: "Cash-in-Hand", openingBalance: 1200 },
      ],
      vouchers: [
        { date: "20250415", voucherNumber: "RV-1", voucherType: "Payment", isCancelled: false, entries: [] },
      ],
    });
    const out = readDayBook(bundleText, {
      company: "acme builders",
      fromDate: "20250401",
      toDate: "20260331",
    });
    expect(out.ledgers).toEqual([
      { name: "Nirosha - Loan A/c", parent: "Unsecured Loans", pan: null, gstin: null, address: null, openingBalance: -3_50_000 },
      { name: "Cash", parent: "Cash-in-Hand", pan: null, gstin: null, address: null, openingBalance: 1200 },
    ]);
  });
});

describe("CHECK_ORDINAL pin (auto-exempt ordinal 27)", () => {
  it("loans ordinal block is 19..27 with auto-exempt last", () => {
    expect(CHECK_ORDINAL.loans_auto_exempt).toBe(27);
    expect(CHECK_ORDINAL.loans_party_unmastered).toBe(26);
    expect(Object.keys(CHECK_ORDINAL)).toHaveLength(23);
  });
});

describe("secured-loans auto-exempt (addendum 4)", () => {
  const SECURED_GROUPS = [
    ...GROUPS,
    { name: "Secured Loans", parent: "Loans (Liability)" },
  ];

  it("a secured-loan ledger with no bank name is exempt with the secured-loan reason", () => {
    const masters = [
      ...MASTERS,
      { name: "Loan -050616440000088 - Hamm Roller", parent: "Secured Loans" },
    ];
    const map = loanAutoExemptNames(masters, SECURED_GROUPS);
    expect(map.get(canonicalKey("Loan -050616440000088 - Hamm Roller"))).toBe("secured loan");
  });

  it("an OD-ancestry loan outranks the secured reason; bank name outranks secured", () => {
    const masters = [
      ...MASTERS,
      { name: "OD Secured Term Loan", parent: "Bank OD A/c" },
      { name: "Union Bank Loan Sec", parent: "Secured Loans" },
      { name: "SBI Secured Term Loan", parent: "Secured Loans" },
    ];
    const groups = [
      ...SECURED_GROUPS,
      { name: "Bank OD A/c", parent: "Secured Loans" },
    ];
    const map = loanAutoExemptNames(masters, groups);
    expect(map.get(canonicalKey("OD Secured Term Loan"))).toBe("bank OD/OCC ancestry");
    expect(map.get(canonicalKey("Union Bank Loan Sec"))).toBe("bank name match");
    expect(map.get(canonicalKey("SBI Secured Term Loan"))).toBe("bank name match");
  });

  it("a secured-loan ledger with an NBFC name is NOT exempt", () => {
    const masters = [
      ...MASTERS,
      { name: "Bajaj Finance Secured Loan", parent: "Secured Loans" },
    ];
    const map = loanAutoExemptNames(masters, SECURED_GROUPS);
    expect(map.has(canonicalKey("Bajaj Finance Secured Loan"))).toBe(false);
  });

  it("unsecured-loan ledgers are unaffected by the secured rule", () => {
    const map = loanAutoExemptNames(MASTERS, GROUPS);
    expect(map.has(canonicalKey("Nirosha - Loan A/c"))).toBe(false);
    expect(map.has(canonicalKey("Term Loan A/c"))).toBe(false);
  });

  it("an operator N override keeps a secured loan listed", () => {
    const autoExempt = new Map([
      [canonicalKey("Loan -050616440000088 - Hamm Roller"), "secured loan"],
    ]);
    const op: LoansOperator = {
      parties: [{ ledger: "Loan -050616440000088 - Hamm Roller", exemptNot: true }],
    };
    const books = buildLoansRows(
      [ev("20250415", "Loan -050616440000088 - Hamm Roller", "accepted", 2_50_000, "cash")],
      op,
      { mastersPresent: true, autoExempt },
    );
    expect(books.sheet1).toHaveLength(1);
    expect(books.findings.some((f) => f.check === "loans_auto_exempt")).toBe(false);
  });

  it("buildLoansRows emits the exact secured-loan advisory", () => {
    const autoExempt = new Map([
      [canonicalKey("Loan -050616440000088 - Hamm Roller"), "secured loan"],
    ]);
    const books = buildLoansRows(
      [ev("20250415", "Loan -050616440000088 - Hamm Roller", "accepted", 2_50_000, "cash")],
      EMPTY_LOANS_OPERATOR,
      { mastersPresent: true, autoExempt },
    );
    expect(books.sheet1).toEqual([]);
    expect(books.findings).toEqual([
      expect.objectContaining({
        check: "loans_auto_exempt",
        detail: "auto-exempt: secured loan",
      }),
    ]);
  });
});
