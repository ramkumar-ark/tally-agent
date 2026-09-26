import { describe, expect, it } from "vitest";
import { GST44_TREATMENT_RULES } from "../src/gst44-treatments.js";
import { gst44Worksheet } from "../src/gst44-worksheet.js";
import type { PriorYearSheets } from "../src/gst44-prior.js";
import type { GstCtx } from "../src/gst.js";
import type { VoucherRow } from "../src/downstream.js";
import { canonicalKey } from "../src/key.js";

const groupOf: Record<string, string> = {
  "Site Materials": "Purchase Accounts",
  "Site Jcb Hire": "Indirect Expenses",
  "Fuel Expenses - 18%": "Indirect Expenses",
  "Contract Labour - URD": "Indirect Expenses",
  "Rates & Taxes A/c": "Indirect Expenses",
  "Repair & Maintenance": "Indirect Expenses",
  "Penalty on GST - 18%": "Indirect Expenses",
  "Mystery Ledger": "Indirect Expenses",
  "Corporate Credit Card Charges A/c": "Indirect Expenses",
  "Fleet Insurence - URD A/c": "Indirect Expenses",
  "Printing Charges - 18%": "Indirect Expenses",
  "Bank Charges A/c": "Bank Charges",
  "Interest on GST A/c": "Interest Expenses",
  "Interest on Bank Loan A/c": "Interest Expenses",
  "Electricity Charges Paid": "Electricity Charges",
  "JCB Purchased": "Fixed Assets",
  "Petrol Vibrator - Greaves": "Fixed Assets",
  "Input IGST A/c": "Input GST",
  "Nova Traders": "Sundry Creditors",
  "Prime Haulage": "Sundry Creditors",
  "Ghost Supplier": "Sundry Creditors",
  "Cash A/c": "Cash-in-Hand",
};
const roots: Record<string, string> = {
  "Purchase Accounts": "Purchase Accounts",
  "Indirect Expenses": "Indirect Expenses",
  "Bank Charges": "Indirect Expenses",
  "Interest Expenses": "Indirect Expenses",
  "Electricity Charges": "Indirect Expenses",
  "Fixed Assets": "Fixed Assets",
  "Input GST": "Duties & Taxes",
  "Sundry Creditors": "Sundry Creditors",
};
const GSTIN_REG = "27AAAAA0000A1Z5";

const ctxOf = (gstins: Record<string, string>): GstCtx => ({
  groupOf: (l) => groupOf[l] ?? "",
  rootOf: (g) => roots[g] ?? null,
  roleOf: (g) => (g === "Sundry Creditors" ? "creditor" : "other"),
  inDutiesAndTaxes: (g) => g === "Duties & Taxes" || roots[g] === "Duties & Taxes",
  gstinOf: (l) => gstins[l] ?? null,
});

const v = (party: string | null, entries: Array<[string, number]>, cancelled = false): VoucherRow => ({
  date: "20250401",
  voucherType: "PURCHASE",
  voucherNumber: "P1",
  partyLedgerName: party ?? "",
  cancelled,
  entries: entries.map(([ledger, amount]) => ({ ledger, amount })),
});

const masters = (names: string[]) => new Map(names.map((n) => [canonicalKey(n), n] as const));
const base = {
  rules: GST44_TREATMENT_RULES,
  masterNames: masters(["Site Materials", "Nova Traders", "Prime Haulage", "Cash A/c"]),
};
const taxedBuy = (ledger: string, amount: number, party = "Nova Traders"): VoucherRow =>
  v(party, [
    [ledger, amount],
    ["Input IGST A/c", Math.round(amount * 0.18)],
    [party, -(amount + Math.round(amount * 0.18))],
  ]);

describe("gst44Worksheet party evidence", () => {
  it("registered + tax -> all-others seed derived through F (zero literals)", () => {
    const r = gst44Worksheet([taxedBuy("Site Materials", 100000)], ctxOf({ "Nova Traders": GSTIN_REG }), base);
    const row = r.revenue.find((x) => x.ledger === "Site Materials")!;
    expect(row.amount).toBe(100000);
    expect(row.seed).toMatchObject({
      d: 0,
      e: 0,
      h: 0,
      j: 0,
      treatment: "others",
      kind: "party evidence",
    });
    expect(row.seed!.reason).toContain("registered purchase");
    expect(r.findings).toHaveLength(0);
  });

  it("registered without tax -> still others; mixed registered+unregistered pots seed as mixed", () => {
    const r = gst44Worksheet(
      [
        v("Nova Traders", [["Site Materials", 20000], ["Nova Traders", -20000]]),
        taxedBuy("Site Materials", 40000),
        v("Prime Haulage", [["Site Materials", 10000], ["Prime Haulage", -10000]]),
      ],
      ctxOf({ "Nova Traders": GSTIN_REG }),
      base,
    );
    const row = r.revenue.find((x) => x.ledger === "Site Materials")!;
    expect(row.amount).toBe(70000);
    expect(row.seed).toMatchObject({ d: 0, e: 0, h: 10000, j: 0, treatment: "mixed", kind: "party evidence" });
    expect(row.seed!.reason).toContain("registered purchase");
    expect(row.seed!.reason).toContain("unregistered");
    expect(row.seed!.reason).toContain("no tax lines");
  });

  it("known party without GSTIN -> unregistered pot", () => {
    const r = gst44Worksheet(
      [v("Prime Haulage", [["Site Materials", 30000], ["Prime Haulage", -30000]])],
      ctxOf({}),
      base,
    );
    expect(r.revenue.find((x) => x.ledger === "Site Materials")!.seed).toMatchObject({
      h: 30000,
      treatment: "unregistered",
      kind: "party evidence",
    });
  });

  it("cancelled vouchers are skipped wholesale", () => {
    const r = gst44Worksheet(
      [
        v("Nova Traders", [["Site Materials", 100], ["Nova Traders", -100]], true),
        taxedBuy("Site Materials", 50),
      ],
      ctxOf({ "Nova Traders": GSTIN_REG }),
      base,
    );
    expect(r.cancelledSkipped).toBe(1);
    expect(r.vouchersScanned).toBe(1);
    expect(r.revenue.find((x) => x.ledger === "Site Materials")!.amount).toBe(50);
  });

  it("capital entries land on the capital sheet, ignoring the party", () => {
    const r = gst44Worksheet([taxedBuy("JCB Purchased", 500000)], ctxOf({ "Nova Traders": GSTIN_REG }), base);
    expect(r.revenue).toHaveLength(0);
    expect(r.capital).toHaveLength(1);
    expect(r.capital[0]).toMatchObject({ ledger: "JCB Purchased", amount: 500000, rowKey: "capital" });
    expect(r.capital[0].seed!.treatment).toBe("others");
  });
});

describe("gst44Worksheet seed precedence", () => {
  it("policy keyword beats a disagreeing prior year and raises the change finding", () => {
    const prior: PriorYearSheets = {
      revenue: new Map([
        [canonicalKey("Rates & Taxes A/c"), { label: "Rates & Taxes A/c", treatment: "unregistered", split: false, profile: "unregistered (H) 5,000.00" }],
      ]),
      capital: new Map(),
    };
    const r = gst44Worksheet(
      [v("Nova Traders", [["Rates & Taxes A/c", 5000], ["Nova Traders", -5000]])],
      ctxOf({}),
      { ...base, prior },
    );
    const row = r.revenue.find((x) => x.ledger === "Rates & Taxes A/c")!;
    expect(row.seed).toMatchObject({ j: 5000, treatment: "not_supply", kind: "policy keyword" });
    const changed = r.findings.filter((f) => f.check === "gst44_ws_prior_year_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].id).toBe("TB-029-1");
    expect(changed[0].ledger).toBe("Rates & Taxes A/c");
  });

  it("prior year seeds an unpoliced ledger; a split carries the restore note", () => {
    const prior: PriorYearSheets = {
      revenue: new Map([
        [
          canonicalKey("Repair & Maintenance"),
          { label: "Repair & Maintenance", treatment: "exempt", split: true, profile: "exempt (D) 1,000.00 + unregistered (H) 500.00" },
        ],
      ]),
      capital: new Map(),
    };
    const r = gst44Worksheet(
      [v("Prime Haulage", [["Repair & Maintenance", 1200], ["Prime Haulage", -1200]])],
      ctxOf({}),
      { ...base, prior },
    );
    const row = r.revenue.find((x) => x.ledger === "Repair & Maintenance")!;
    expect(row.seed).toMatchObject({ d: 1200, treatment: "exempt", kind: "prior year" });
    expect(row.seed!.reason).toContain("split");
    const changed = r.findings.filter((f) => f.check === "gst44_ws_prior_year_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].detail).toContain("restore the split");
  });

  it("evidence keyword beats party evidence", () => {
    const r = gst44Worksheet(
      [v("Prime Haulage", [["Contract Labour - URD", 8000], ["Prime Haulage", -8000]])],
      ctxOf({}),
      base,
    );
    expect(r.revenue.find((x) => x.ledger === "Contract Labour - URD")!.seed).toMatchObject({
      h: 8000,
      treatment: "unregistered",
      kind: "evidence keyword",
    });
  });

  it("a policy/pattern conflict is reported but the policy rule wins", () => {
    const r = gst44Worksheet(
      [v("Nova Traders", [["Penalty on GST - 18%", 2500], ["Nova Traders", -2500]])],
      ctxOf({ "Nova Traders": GSTIN_REG }),
      base,
    );
    const row = r.revenue.find((x) => x.ledger === "Penalty on GST - 18%")!;
    expect(row.seed).toMatchObject({ j: 2500, treatment: "not_supply", kind: "policy keyword" });
    const conflict = r.findings.filter((f) => f.check === "gst44_ws_rule_conflict");
    expect(conflict).toHaveLength(1);
    expect(conflict[0].id).toBe("TB-030-1");
  });
});

describe("gst44Worksheet gaps", () => {
  it("unknown GSTIN party falls back to the pattern rule with a verify note", () => {
    const r = gst44Worksheet(
      [v("Ghost Supplier", [["Printing Charges - 18%", 5000], ["Ghost Supplier", -5000]])],
      ctxOf({}),
      base,
    );
    const row = r.revenue.find((x) => x.ledger === "Printing Charges - 18%")!;
    expect(row.seed).toMatchObject({ treatment: "others", kind: "pattern rule" });
    expect(row.seed!.reason).toContain("party GSTIN unknown");
    expect(r.findings).toHaveLength(0);
  });

  it("no rule at all -> UNCLASSIFIED with no literals and a review finding", () => {
    const r = gst44Worksheet(
      [v("Ghost Supplier", [["Mystery Ledger", 700], ["Ghost Supplier", -700]])],
      ctxOf({}),
      base,
    );
    const row = r.revenue.find((x) => x.ledger === "Mystery Ledger")!;
    expect(row.seed).toBeNull();
    const un = r.findings.filter((f) => f.check === "gst44_ws_unclassified");
    expect(un).toHaveLength(1);
    expect(un[0].id).toBe("TB-028-1");
    expect(un[0].severity).toBe("review");
    expect(un[0].detail).toContain("party GSTIN unknown");
  });

  it("entries with no party at all are counted as unattributed and flagged", () => {
    const r = gst44Worksheet([v(null, [["Mystery Ledger", 700], ["Cash A/c", -700]])], ctxOf({}), base);
    expect(r.unattributed).toEqual({ revenue: 700, capital: 0, events: 1 });
    const un = r.findings.filter((f) => f.check === "gst44_ws_unclassified");
    expect(un[0].detail).toContain("no party");
  });

  it("a zero-balance ledger seeds as zero without any finding", () => {
    const r = gst44Worksheet(
      [v("Nova Traders", [["Mystery Ledger", 0], ["Nova Traders", 0]])],
      ctxOf({ "Nova Traders": GSTIN_REG }),
      base,
    );
    expect(r.revenue.find((x) => x.ledger === "Mystery Ledger")!.seed).toMatchObject({
      treatment: "others",
      kind: "zero balance",
    });
    expect(r.findings.filter((f) => f.check === "gst44_ws_unclassified")).toHaveLength(0);
  });
});

describe("gst44Worksheet debit-total semantics", () => {
  it("credits on a tracked ledger do not reduce column B or the treatment pots", () => {
    // A purchase (debit 1,00,000) later reversed by a credit note (credit
    // -40,000) still books 1,00,000 of expenditure per design §4.1-B.
    const r = gst44Worksheet(
      [
        taxedBuy("Site Materials", 100000),
        v("Nova Traders", [["Site Materials", -40000], ["Nova Traders", 40000]]),
      ],
      ctxOf({ "Nova Traders": GSTIN_REG }),
      base,
    );
    const row = r.revenue.find((x) => x.ledger === "Site Materials")!;
    expect(row.amount).toBe(100000);
    expect(row.seed!.treatment).toBe("others");
  });

  it("a capital ledger with only depreciation credits is dropped from the capital sheet", () => {
    const r = gst44Worksheet(
      [
        v(null, [["JCB Purchased", -450000], ["Depreciation A/c", 450000]]),
      ],
      ctxOf({}),
      base,
    );
    expect(r.capital.find((x) => x.ledger === "JCB Purchased")).toBeUndefined();
    expect(r.findings.filter((f) => f.check === "gst44_ws_unclassified")).toHaveLength(0);
  });
});

describe("gst44Worksheet addendum 2026-09-26d", () => {
  it("a bank-charges ledger seeds others wholly, overriding party unregistered pots", () => {
    const r = gst44Worksheet(
      [
        v("Prime Haulage", [["Bank Charges A/c", 30000], ["Prime Haulage", -30000]]),
        v("Nova Traders", [["Bank Charges A/c", 20000], ["Input IGST A/c", 3600], ["Nova Traders", -23600]]),
      ],
      ctxOf({ "Nova Traders": GSTIN_REG }),
      { ...base, masterNames: masters(["Bank Charges A/c", "Prime Haulage", "Nova Traders", "Cash A/c"]) },
    );
    const row = r.revenue.find((x) => x.ledger === "Bank Charges A/c")!;
    expect(row.amount).toBe(50000);
    expect(row.seed).toMatchObject({ treatment: "others", kind: "evidence keyword" });
    expect(row.seed!.reason).toContain("bank-charges");
    expect(r.findings).toHaveLength(0);
  });

  it("interest on gst reads not supply while interest on bank loan reads exempt", () => {
    const r = gst44Worksheet(
      [
        v("Nova Traders", [["Interest on GST A/c", 5104], ["Nova Traders", -5104]]),
        v("Prime Haulage", [["Interest on Bank Loan A/c", 100000], ["Prime Haulage", -100000]]),
      ],
      ctxOf({ "Nova Traders": GSTIN_REG }),
      { ...base, masterNames: masters(["Interest on GST A/c", "Interest on Bank Loan A/c", "Prime Haulage", "Nova Traders"]) },
    );
    expect(r.revenue.find((x) => x.ledger === "Interest on GST A/c")!.seed).toMatchObject({
      j: 5104,
      treatment: "not_supply",
      kind: "policy keyword",
    });
    expect(r.revenue.find((x) => x.ledger === "Interest on Bank Loan A/c")!.seed).toMatchObject({
      treatment: "exempt",
      kind: "evidence keyword",
    });
  });
});

describe("gst44Worksheet rule scope", () => {
  it("a capital asset whose name carries a fuel word is NOT exempt — party evidence applies", () => {
    const r = gst44Worksheet(
      [v("Prime Haulage", [["Petrol Vibrator - Greaves", 81750], ["Prime Haulage", -81750]])],
      ctxOf({}),
      { ...base, masterNames: masters(["Petrol Vibrator - Greaves", "Prime Haulage", "Cash A/c"]) },
    );
    const row = r.capital.find((x) => x.ledger === "Petrol Vibrator - Greaves")!;
    expect(row.seed).toMatchObject({ treatment: "unregistered", kind: "party evidence" });
    const re = gst44Worksheet(
      [v("Nova Traders", [["Petrol Vibrator - Greaves", 81750], ["Input IGST A/c", 14715], ["Nova Traders", -96465]])],
      ctxOf({ "Nova Traders": GSTIN_REG }),
      { ...base, masterNames: masters(["Petrol Vibrator - Greaves", "Nova Traders", "Cash A/c"]) },
    );
    expect(re.capital.find((x) => x.ledger === "Petrol Vibrator - Greaves")!.seed).toMatchObject({
      treatment: "others",
    });
  });
});

describe("gst44Worksheet policy beats prior year (addendum 2026-09-26e)", () => {
  it("an electricity ledger seeds by the policy rule even when the prior year named it first", () => {
    const prior = {
      revenue: new Map([["electricity charges paid", { label: "Electricity Charges Paid", treatment: "unregistered" as const, split: false, profile: "unregistered (H) 3,00,000.00" }]]),
      capital: new Map(),
    };
    const r = gst44Worksheet(
      [v("Prime Haulage", [["Electricity Charges Paid", 300000], ["Prime Haulage", -300000]])],
      ctxOf({}),
      { ...base, masterNames: masters(["Electricity Charges Paid", "Prime Haulage"]), prior },
    );
    const row = r.revenue.find((x) => x.ledger === "Electricity Charges Paid")!;
    expect(row.seed).toMatchObject({ treatment: "exempt", kind: "policy keyword" });
    expect(row.seed!.reason).toContain("electricity");
    expect(r.findings.some((f) => f.check === "gst44_ws_prior_year_changed")).toBe(true);
  });

  it("a prior-year agreement is noted as secondary in the reason", () => {
    const prior = {
      revenue: new Map([["electricity charges paid", { label: "Electricity Charges Paid", treatment: "exempt" as const, split: false, profile: "exempt (D) 3,00,000.00" }]]),
      capital: new Map(),
    };
    const r = gst44Worksheet(
      [v("Prime Haulage", [["Electricity Charges Paid", 300000], ["Prime Haulage", -300000]])],
      ctxOf({}),
      { ...base, masterNames: masters(["Electricity Charges Paid", "Prime Haulage"]), prior },
    );
    const row = r.revenue.find((x) => x.ledger === "Electricity Charges Paid")!;
    expect(row.seed!.kind).toBe("policy keyword");
    expect(row.seed!.reason).toContain("FY 24-25 agreed");
    expect(r.findings.some((f) => f.check === "gst44_ws_prior_year_changed")).toBe(false);
  });
});

describe("gst44Worksheet addendum 2026-09-26e", () => {
  it("a tax-charged voucher from a known party without a GSTIN seeds others, not unregistered", () => {
    const r = gst44Worksheet([taxedBuy("Site Materials", 100000, "Prime Haulage")], ctxOf({}), base);
    const row = r.revenue.find((x) => x.ledger === "Site Materials")!;
    expect(row.seed).toMatchObject({ d: 0, e: 0, h: 0, j: 0, treatment: "others", kind: "party evidence" });
    expect(row.seed!.reason).toContain("registered purchase");
    expect(row.seed!.reason).toContain("no GSTIN in the masters");
    expect(r.findings).toHaveLength(0);
  });

  it("a no-tax voucher from a known party without a GSTIN still seeds unregistered", () => {
    const r = gst44Worksheet(
      [v("Prime Haulage", [["Site Materials", 30000], ["Prime Haulage", -30000]])],
      ctxOf({}),
      base,
    );
    expect(r.revenue.find((x) => x.ledger === "Site Materials")!.seed).toMatchObject({
      h: 30000,
      treatment: "unregistered",
      kind: "party evidence",
    });
  });

  it("a credit-card charges ledger seeds others even with no party GSTIN and no tax", () => {
    const r = gst44Worksheet(
      [v("Prime Haulage", [["Corporate Credit Card Charges A/c", 12000], ["Prime Haulage", -12000]])],
      ctxOf({}),
      { ...base, masterNames: masters(["Corporate Credit Card Charges A/c", "Prime Haulage", "Nova Traders", "Cash A/c"]) },
    );
    const row = r.revenue.find((x) => x.ledger === "Corporate Credit Card Charges A/c")!;
    expect(row.seed).toMatchObject({ treatment: "others", kind: "evidence keyword" });
    expect(row.seed!.reason).toContain("credit-card");
    expect(r.findings).toHaveLength(0);
  });

  it("a URD-marked insurance ledger seeds others by the insurance rule and raises a rule-conflict warning", () => {
    const r = gst44Worksheet(
      [v("Prime Haulage", [["Fleet Insurence - URD A/c", 50000], ["Prime Haulage", -50000]])],
      ctxOf({}),
      { ...base, masterNames: masters(["Fleet Insurence - URD A/c", "Prime Haulage", "Nova Traders", "Cash A/c"]) },
    );
    const row = r.revenue.find((x) => x.ledger === "Fleet Insurence - URD A/c")!;
    expect(row.seed).toMatchObject({ treatment: "others", kind: "evidence keyword" });
    expect(row.seed!.reason).toContain("insurance");
    const conflicts = r.findings.filter((f) => f.check === "gst44_ws_rule_conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].detail).toContain("'urd'");
    expect(conflicts[0].severity).toBe("warning");
  });
});

describe("gst44Worksheet addendum 2026-09-26f", () => {
  it("a no-tax purchase from a GST-registered supplier seeds others, not exempt", () => {
    const r = gst44Worksheet(
      [v("Nova Traders", [["Site Jcb Hire", 50000], ["Nova Traders", -50000]])],
      ctxOf({ "Nova Traders": GSTIN_REG }),
      { ...base, masterNames: masters(["Site Jcb Hire", "Nova Traders", "Cash A/c"]) },
    );
    const row = r.revenue.find((x) => x.ledger === "Site Jcb Hire")!;
    expect(row.seed).toMatchObject({ d: 0, e: 0, h: 0, j: 0, treatment: "others", kind: "party evidence" });
    expect(row.seed!.reason).toContain("registered purchase");
    expect(row.seed!.reason).toContain("no tax lines");
    expect(r.findings).toHaveLength(0);
  });
});
