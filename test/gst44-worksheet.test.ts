import { describe, expect, it } from "vitest";
import { GST44_TREATMENT_RULES } from "../src/gst44-treatments.js";
import { gst44Worksheet } from "../src/gst44-worksheet.js";
import type { PriorYearSheets } from "../src/gst44-prior.js";
import type { GstCtx } from "../src/gst.js";
import type { VoucherRow } from "../src/downstream.js";
import { canonicalKey } from "../src/key.js";

const groupOf: Record<string, string> = {
  "Site Materials": "Purchase Accounts",
  "Fuel Expenses - 18%": "Indirect Expenses",
  "Contract Labour - URD": "Indirect Expenses",
  "Rates & Taxes A/c": "Indirect Expenses",
  "Repair & Maintenance": "Indirect Expenses",
  "Penalty on GST - 18%": "Indirect Expenses",
  "Mystery Ledger": "Indirect Expenses",
  "JCB Purchased": "Fixed Assets",
  "Input IGST A/c": "Input GST",
  "Nova Traders": "Sundry Creditors",
  "Prime Haulage": "Sundry Creditors",
  "Ghost Supplier": "Sundry Creditors",
  "Cash A/c": "Cash-in-Hand",
};
const roots: Record<string, string> = {
  "Purchase Accounts": "Purchase Accounts",
  "Indirect Expenses": "Indirect Expenses",
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
    expect(row.seed!.reason).toContain("registered with tax");
    expect(r.findings).toHaveLength(0);
  });

  it("registered without tax -> exempt pot; mixed pots seed as mixed", () => {
    const r = gst44Worksheet(
      [
        v("Nova Traders", [["Site Materials", 20000], ["Nova Traders", -20000]]),
        taxedBuy("Site Materials", 40000),
      ],
      ctxOf({ "Nova Traders": GSTIN_REG }),
      base,
    );
    const row = r.revenue.find((x) => x.ledger === "Site Materials")!;
    expect(row.amount).toBe(60000);
    expect(row.seed).toMatchObject({ d: 20000, e: 0, h: 0, j: 0, treatment: "mixed", kind: "party evidence" });
    expect(row.seed!.reason).toContain("registered without tax");
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
      [v("Ghost Supplier", [["Fuel Expenses - 18%", 5000], ["Ghost Supplier", -5000]])],
      ctxOf({}),
      base,
    );
    const row = r.revenue.find((x) => x.ledger === "Fuel Expenses - 18%")!;
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

  it("a capital ledger with only depreciation credits rows with a zero debit total", () => {
    const r = gst44Worksheet(
      [
        v(null, [["JCB Purchased", -450000], ["Depreciation A/c", 450000]]),
      ],
      ctxOf({}),
      base,
    );
    const row = r.capital.find((x) => x.ledger === "JCB Purchased")!;
    expect(row.amount).toBe(0);
    expect(row.seed).toMatchObject({ kind: "zero balance" });
    expect(r.findings.filter((f) => f.check === "gst44_ws_unclassified")).toHaveLength(0);
  });
});
