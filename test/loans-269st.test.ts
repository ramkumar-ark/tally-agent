import { describe, expect, it } from "vitest";
import {
  EMPTY_LOANS_OPERATOR,
  buildLoansCtx,
  scan269St,
  type LoanEvent,
  type LoansSheetRow,
  type V,
} from "../src/loans.js";
import { S269ST_LIMIT } from "../src/loans-law.js";

const GROUPS = [
  { name: "Loans (Liability)", parent: " Primary" },
  { name: "Unsecured Loans", parent: "Loans (Liability)" },
  { name: "Current Assets", parent: " Primary" },
  { name: "Cash-in-Hand", parent: "Current Assets" },
  { name: "Bank Accounts", parent: "Current Assets" },
];

const MASTERS = [
  { name: "Cash", parent: "Cash-in-Hand" },
  { name: "Petty Cash", parent: "Cash-in-Hand" },
  { name: "HDFC Bank", parent: "Bank Accounts" },
  { name: "Acme Traders", parent: "Sundry Creditors" },
  { name: "Bravo Traders", parent: "Sundry Creditors" },
  { name: "Party Loan", parent: "Loans (Liability)" },
];

const ctx = buildLoansCtx(MASTERS, GROUPS);

const mk = (
  date: string | number,
  entries: V["entries"],
  narration = "",
): V => ({
  date,
  voucherNumber: 101,
  voucherType: "Journal",
  narration,
  entries,
});

const ev = (
  date: string,
  party: string,
  direction: LoanEvent["direction"],
  amount: number,
  mode: LoanEvent["mode"],
): LoanEvent => ({ date, party, direction, amount, mode, narration: "" });

describe("scan269St", () => {
  it("rule 1-2: a single cash receipt of 2,05,000 rows into sheet6 with a critical finding", () => {
    const res = scan269St(
      [
        mk("20250415", [
          { ledger: "Cash", amount: 205_000 },
          { ledger: "Acme Traders", amount: -205_000 },
        ], "cash receipt"),
      ],
      ctx,
      EMPTY_LOANS_OPERATOR,
    );
    expect(res.sheet6).toHaveLength(1);
    expect(res.sheet6[0]).toMatchObject({
      party: "Acme Traders",
      amount: 205_000,
      type: "Receipts",
      date: "20250415",
      nature: "cash receipt",
    });
    expect(res.sheet7).toEqual([]);
    const f = res.findings.find((x) => x.check === "loans_269st_receipt");
    expect(f?.severity).toBe("critical");
    expect(f?.ledger).toBe("Acme Traders");
    expect(f?.amount).toBe(205_000);
    expect(f?.detail).toContain("2,05,000.00");
    expect(f?.detail).toContain("15-Apr-2025");
    expect(f?.detail).toContain("Acme Traders");
    expect(res.findings.find((x) => x.check === "loans_269st_payment")).toBeUndefined();
  });

  it("rule 1-2: a cash payment rows with type Payments and a warning (reporting-only) finding", () => {
    const res = scan269St(
      [
        mk("20250610", [
          { ledger: "Bravo Traders", amount: 250_000 },
          { ledger: "Cash", amount: -250_000 },
        ]),
      ],
      ctx,
      EMPTY_LOANS_OPERATOR,
    );
    expect(res.sheet6).toHaveLength(1);
    expect(res.sheet6[0]).toMatchObject({
      party: "Bravo Traders",
      amount: 250_000,
      type: "Payments",
    });
    const f = res.findings.find((x) => x.check === "loans_269st_payment");
    expect(f?.severity).toBe("warning");
    expect(f?.detail).toContain("2,50,000.00");
    expect(f?.detail).toContain("10-Jun-2025");
    expect(f?.detail).toContain("Bravo Traders");
    expect(res.findings.find((x) => x.check === "loans_269st_receipt")).toBeUndefined();
  });

  it("rule 1: cash↔bank contra and cash↔cash legs with no external counter are excluded", () => {
    const contra = [
      mk("20250416", [
        { ledger: "HDFC Bank", amount: 205_000 },
        { ledger: "Cash", amount: -205_000 },
      ]),
      mk("20250417", [
        { ledger: "Cash", amount: 205_000 },
        { ledger: "Petty Cash", amount: -205_000 },
      ]),
      mk("20250418", [
        { ledger: "Cash", amount: 250_000 },
        { ledger: "HDFC Bank", amount: -250_000 },
      ]),
    ];
    const res = scan269St(contra, ctx, EMPTY_LOANS_OPERATOR);
    expect(res.sheet6).toEqual([]);
    expect(res.findings).toEqual([]);
  });

  it("rule 3: same-day same-party receipts each below the limit aggregate into ONE row and ONE finding", () => {
    const res = scan269St(
      [
        mk("20250415", [
          { ledger: "Cash", amount: 105_000 },
          { ledger: "Acme Traders", amount: -105_000 },
        ]),
        mk("20250415", [
          { ledger: "Cash", amount: 105_000 },
          { ledger: "Acme Traders", amount: -105_000 },
        ]),
      ],
      ctx,
      EMPTY_LOANS_OPERATOR,
    );
    expect(res.sheet6).toHaveLength(1);
    expect(res.sheet6[0]).toMatchObject({
      party: "Acme Traders",
      amount: 210_000,
      type: "Receipts",
      date: "20250415",
    });
    const fis = res.findings.filter((x) => x.check === "loans_269st_receipt");
    expect(fis).toHaveLength(1);
    expect(fis[0].amount).toBe(210_000);
    expect(fis[0].detail).toContain("2,10,000.00");
    expect(res.findings.some((x) => x.check === "loans_269st_payment")).toBe(false);
  });

  it("rule 3: the same-day aggregate only fires when the sum reaches the limit", () => {
    const res = scan269St(
      [
        mk("20250415", [
          { ledger: "Cash", amount: 105_000 },
          { ledger: "Acme Traders", amount: -105_000 },
        ]),
        mk("20250416", [
          { ledger: "Cash", amount: 105_000 },
          { ledger: "Acme Traders", amount: -105_000 },
        ]),
      ],
      ctx,
      EMPTY_LOANS_OPERATOR,
    );
    expect(res.sheet6).toEqual([]);
    expect(res.findings).toEqual([]);
  });

  it("rule 1: the limit is >= — exactly S269ST_LIMIT is a candidate, one rupee below is not", () => {
    const at = scan269St(
      [mk("20250415", [
        { ledger: "Cash", amount: 200_000 },
        { ledger: "Acme Traders", amount: -200_000 },
      ])],
      ctx,
      EMPTY_LOANS_OPERATOR,
    );
    expect(at.sheet6).toHaveLength(1);

    const under = scan269St(
      [mk("20250415", [
        { ledger: "Cash", amount: 199_999 },
        { ledger: "Acme Traders", amount: -199_999 },
      ])],
      ctx,
      EMPTY_LOANS_OPERATOR,
    );
    expect(under.sheet6).toEqual([]);
    expect(under.findings).toEqual([]);
  });

  it("rule 2: numeric dates coerce through String() and an empty narration yields no nature", () => {
    const res = scan269St(
      [mk(20250415, [
        { ledger: "Cash", amount: 205_000 },
        { ledger: "Acme Traders", amount: -205_000 },
      ])],
      ctx,
      EMPTY_LOANS_OPERATOR,
    );
    expect(res.sheet6[0].date).toBe("20250415");
    expect(res.sheet6[0].nature).toBeUndefined();
  });

  it("rule 6: a loan-ledger cash receipt is scanned here and carries the 269SS/T dedupe note when the party+date matches a prior cash event", () => {
    const voucher: V = mk("20250415", [
      { ledger: "Cash", amount: 205_000 },
      { ledger: "Party Loan", amount: -205_000 },
    ], "loan taken in cash");

    const withPrior = scan269St(
      [voucher],
      ctx,
      EMPTY_LOANS_OPERATOR,
      [ev("20250415", "Party Loan", "accepted", 205_000, "cash")],
    );
    const withF = withPrior.findings.find((x) => x.check === "loans_269st_receipt");
    expect(withF).toBeDefined();
    expect(withF?.detail).toContain("269SS/T");

    const without = scan269St([voucher], ctx, EMPTY_LOANS_OPERATOR, []);
    const withoutF = without.findings.find((x) => x.check === "loans_269st_receipt");
    expect(withoutF?.detail).not.toContain("269SS/T");
  });

  it("rule 6: a bank-mode prior event does not trip the dedupe note", () => {
    const res = scan269St(
      [mk("20250415", [
        { ledger: "Cash", amount: 205_000 },
        { ledger: "Party Loan", amount: -205_000 },
      ])],
      ctx,
      EMPTY_LOANS_OPERATOR,
      [ev("20250415", "Party Loan", "accepted", 205_000, "bank")],
    );
    const f = res.findings.find((x) => x.check === "loans_269st_receipt");
    expect(f?.detail).not.toContain("269SS/T");
  });

  it("rule 5: sheet7 rows come only from operator.st26Declarations (default [])", () => {
    const decl: LoansSheetRow = {
      party: "Declared Party",
      amount: 300_000,
      type: "Receipts",
      date: "20250501",
      nature: "bearer cheque",
    };
    const declared = scan269St(
      [],
      ctx,
      { ...EMPTY_LOANS_OPERATOR, st26Declarations: [decl] },
    );
    expect(declared.sheet7).toEqual([decl]);

    const bare = scan269St([], ctx, EMPTY_LOANS_OPERATOR);
    expect(bare.sheet7).toEqual([]);
  });

  it("sheet6 is unmarked for cancelled vouchers and non-cash movements", () => {
    const res = scan269St(
      [
        mk("20250415", [
          { ledger: "Cash", amount: 205_000 },
          { ledger: "Acme Traders", amount: -205_000 },
        ], ""),
      ].map((v) => ({ ...v, isCancelled: true })),
      ctx,
      EMPTY_LOANS_OPERATOR,
    );
    expect(res.sheet6).toEqual([]);
    expect(res.findings).toEqual([]);
  });
});

describe("S269ST_LIMIT", () => {
  it("is the s.269ST Rs 2,00,000-or-more threshold", () => {
    expect(S269ST_LIMIT).toBe(2_00_000);
  });
});
