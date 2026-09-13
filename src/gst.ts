import type { VoucherRow } from "./downstream.js";
import { money } from "./format.js";
import type { ReturnRow } from "./returns.js";
import {
  GST_HEADS,
  GST_TOLERANCE,
  gstFindingId,
  type GroupRole,
  type GstCheckId,
  type GstHead,
  type GstKind,
  type Severity,
} from "./types.js";

/**
 * GST computation, pure (R-E-1): no I/O, no MCP, no model, no masking. These
 * functions run on unmasked data — real ledger names and real GSTINs — and
 * return real values; the session layer is the single place that masks their
 * output on the way to the model (design doc §2.1, §5).
 */

/** Synthetic group label for identities that exist only in the returns file. */
export const RETURN_GROUP = "GST Return";

export interface GstCtx {
  /** Parent group of a ledger by (canonical) name; "" when unknown. */
  groupOf(ledger: string): string;
  /** Primary-group root of a group's ancestry, e.g. "Sales Accounts". */
  rootOf(group: string): string | null;
  /** True when the group's ancestry includes Duties & Taxes. */
  inDutiesAndTaxes(group: string): boolean;
  roleOf(group: string): GroupRole;
  /** Normalized GSTIN of a ledger by (canonical) name; null when the master carries none. */
  gstinOf(ledger: string): string | null;
}

/**
 * Tax head of a ledger by name keyword, or null when it is not a GST ledger
 * name. Specific heads are matched before the generic "gst" so "Input CGST"
 * is CGST, not GST-OTHER. SGST and UTGST merge, as GSTR-3B reports them.
 */
export function gstHeadOf(ledgerName: string): GstHead | null {
  const n = ledgerName.toLowerCase();
  if (n.includes("cgst")) return "CGST";
  if (n.includes("igst")) return "IGST";
  if (n.includes("sgst") || n.includes("utgst")) return "SGST/UTGST";
  if (n.includes("cess")) return "CESS";
  if (n.includes("gst")) return "GST-OTHER";
  return null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const zeroHeads = (): Record<GstHead, number> => ({
  CGST: 0,
  "SGST/UTGST": 0,
  IGST: 0,
  CESS: 0,
  "GST-OTHER": 0,
});

export interface GstPartyTotals {
  /** Real ledger name (first seen, when several ledgers share one GSTIN). */
  party: string;
  /** Real group of that ledger. */
  group: string;
  gstin: string | null;
  taxableValue: number;
  /** Tax booked for this kind per head; sign follows the books, so credit/debit notes can make it negative. */
  heads: Record<GstHead, number>;
}

export interface GstTaxLedgerRow {
  ledger: string;
  group: string;
  output: number;
  input: number;
}

export interface GstBooks {
  vouchersScanned: number;
  cancelledSkipped: number;
  /** Every GST ledger entry in the period, by head and side. Credit = output booked, debit = input credit booked. */
  heads: Record<GstHead, { output: number; input: number }>;
  taxLedgers: GstTaxLedgerRow[];
  byKind: Record<
    GstKind,
    {
      withGstin: GstPartyTotals[];
      withoutGstin: GstPartyTotals[];
      taxableValue: number;
      heads: Record<GstHead, number>;
    }
  >;
  /** GST entries on vouchers with no kind or no party — aggregate-only, never invents a party row. */
  unattributed: Record<GstHead, { output: number; input: number }>;
}

interface Acc {
  taxableValue: number;
  heads: Record<GstHead, number>;
}

const kindOf = (v: VoucherRow, ctx: GstCtx): GstKind | null => {
  let hasSales = false;
  let hasPurchase = false;
  for (const e of v.entries) {
    const root = ctx.rootOf(ctx.groupOf(e.ledger));
    if (root === "Sales Accounts") hasSales = true;
    else if (root === "Purchase Accounts") hasPurchase = true;
  }
  // A voucher touching both roots is mixed; attribute nothing rather than guess.
  if (hasSales && !hasPurchase) return "outward";
  if (hasPurchase && !hasSales) return "inward";
  return null;
};

const partyOf = (v: VoucherRow, kind: GstKind | null, ctx: GstCtx): string | null => {
  if (v.partyLedgerName) return v.partyLedgerName;
  if (!kind) return null;
  const want: GroupRole = kind === "outward" ? "debtor" : "creditor";
  for (const e of v.entries) {
    if (ctx.roleOf(ctx.groupOf(e.ledger)) === want) return e.ledger;
  }
  return null;
};

/** Walk the period's vouchers once, bucketing every GST entry three ways: per head, per party+kind, unattributed. */
export function gstBooks(vouchers: VoucherRow[], ctx: GstCtx): GstBooks {
  const heads = {} as Record<GstHead, { output: number; input: number }>;
  const unattributed = {} as Record<GstHead, { output: number; input: number }>;
  for (const h of GST_HEADS) {
    heads[h] = { output: 0, input: 0 };
    unattributed[h] = { output: 0, input: 0 };
  }
  const ledgerRows = new Map<string, GstTaxLedgerRow>();
  // Party accumulation, keyed by GSTIN when known (so two ledgers of one
  // party merge) and by canonical party name otherwise.
  const parties = {
    outward: new Map<string, GstPartyTotals & { key: string }>(),
    inward: new Map<string, GstPartyTotals & { key: string }>(),
  };
  const kindTotals: Record<GstKind, Acc> = {
    outward: { taxableValue: 0, heads: zeroHeads() },
    inward: { taxableValue: 0, heads: zeroHeads() },
  };

  let vouchersScanned = 0;
  let cancelledSkipped = 0;

  /**
   * The party's bucket, created on demand from either a tax line or a
   * taxable line — whichever the voucher lists first. Creating it only on
   * tax lines made the taxable value always zero for vouchers whose party
   * line precedes the tax lines (the normal Tally layout).
   */
  const ensureParty = (
    kind: GstKind,
    party: string,
  ): GstPartyTotals & { key: string } => {
    const bucket = parties[kind];
    const gstin = ctx.gstinOf(party);
    const key = gstin ?? `name:${party.toLowerCase()}`;
    let acc = bucket.get(key);
    if (!acc) {
      acc = {
        key,
        party,
        group: ctx.groupOf(party),
        gstin: gstin ?? null,
        taxableValue: 0,
        heads: zeroHeads(),
      };
      bucket.set(key, acc);
    }
    return acc;
  };

  for (const v of vouchers) {
    if (v.cancelled) {
      cancelledSkipped += 1;
      continue;
    }
    vouchersScanned += 1;
    const kind = kindOf(v, ctx);
    const party = kind ? partyOf(v, kind, ctx) : null;

    for (const e of v.entries) {
      if (e.amount === 0) continue;
      const group = ctx.groupOf(e.ledger);
      const head = ctx.inDutiesAndTaxes(group) ? gstHeadOf(e.ledger) : null;

      if (head) {
        // Credit = output tax booked; debit = input tax credit booked.
        const side = e.amount < 0 ? "output" : "input";
        const mag = Math.abs(e.amount);
        heads[head][side] += mag;
        let row = ledgerRows.get(e.ledger.toLowerCase());
        if (!row) {
          row = { ledger: e.ledger, group, output: 0, input: 0 };
          ledgerRows.set(e.ledger.toLowerCase(), row);
        }
        row[side] += mag;

        if (kind && party) {
          // Outward tax normally sits as credits (positive contribution);
          // a debit note reverses that honestly because the signed amount
          // is what accumulates.
          const contribution = kind === "outward" ? -e.amount : e.amount;
          ensureParty(kind, party).heads[head] += contribution;
        } else {
          unattributed[head][side] += mag;
        }
      }

      // Taxable value: the sales/purchase-account lines of a kinded voucher.
      if (kind && party) {
        const root = ctx.rootOf(group);
        const wanted = kind === "outward" ? "Sales Accounts" : "Purchase Accounts";
        if (root === wanted) {
          const contribution = kind === "outward" ? -e.amount : e.amount;
          ensureParty(kind, party).taxableValue += contribution;
          kindTotals[kind].taxableValue += contribution;
        }
      }
    }
  }


  // Kind head aggregates come from the party buckets, so unattributed tax is
  // excluded by construction.
  for (const k of ["outward", "inward"] as GstKind[]) {
    for (const acc of parties[k].values()) {
      for (const h of GST_HEADS) kindTotals[k].heads[h] += acc.heads[h];
    }
  }

  const split = (k: GstKind) => {
    const rows = [...parties[k].values()];
    const withGstin = rows
      .filter((r) => r.gstin)
      .sort((a, b) => (a.gstin! < b.gstin! ? -1 : a.gstin! > b.gstin! ? 1 : 0));
    const withoutGstin = rows
      .filter((r) => !r.gstin)
      .sort((a, b) => a.party.localeCompare(b.party));
    return {
      withGstin: withGstin.map(({ key: _key, ...r }) => r),
      withoutGstin: withoutGstin.map(({ key: _key, ...r }) => r),
      taxableValue: round2(kindTotals[k].taxableValue),
      heads: Object.fromEntries(
        GST_HEADS.map((h) => [h, round2(kindTotals[k].heads[h])]),
      ) as Record<GstHead, number>,
    };
  };

  return {
    vouchersScanned,
    cancelledSkipped,
    heads: Object.fromEntries(
      GST_HEADS.map((h) => [h, { output: round2(heads[h].output), input: round2(heads[h].input) }]),
    ) as Record<GstHead, { output: number; input: number }>,
    taxLedgers: [...ledgerRows.values()]
      .map((r) => ({ ...r, output: round2(r.output), input: round2(r.input) }))
      .sort((a, b) => a.ledger.localeCompare(b.ledger)),
    byKind: { outward: split("outward"), inward: split("inward") },
    unattributed: Object.fromEntries(
      GST_HEADS.map((h) => [
        h,
        { output: round2(unattributed[h].output), input: round2(unattributed[h].input) },
      ]),
    ) as Record<GstHead, { output: number; input: number }>,
  };
}

export interface GstHeadTotals {
  head: GstHead;
  output: number;
  input: number;
  net: number;
}

export interface GstSummaryView {
  heads: GstHeadTotals[];
  totals: { output: number; input: number; netLiability: number };
  taxLedgers: GstTaxLedgerRow[];
  vouchersScanned: number;
  cancelledSkipped: number;
  /** Heads with GST entries that could not be attributed to a kinded party voucher. */
  unattributed: Array<{ head: GstHead; output: number; input: number }>;
}

/** The masked-summary tool's view over the books analysis. Aggregate by construction: no party data. */
export function gstSummary(books: GstBooks): GstSummaryView {
  let output = 0;
  let input = 0;
  const heads: GstHeadTotals[] = GST_HEADS.map((head) => {
    const { output: o, input: i } = books.heads[head];
    output += o;
    input += i;
    return { head, output: o, input: i, net: round2(o - i) };
  });
  return {
    heads,
    totals: {
      output: round2(output),
      input: round2(input),
      netLiability: round2(output - input),
    },
    taxLedgers: books.taxLedgers,
    vouchersScanned: books.vouchersScanned,
    cancelledSkipped: books.cancelledSkipped,
    unattributed: GST_HEADS.filter(
      (h) => books.unattributed[h].output !== 0 || books.unattributed[h].input !== 0,
    ).map((h) => ({ head: h, ...books.unattributed[h] })),
  };
}

const SEVERITY: Record<GstCheckId, Severity> = {
  gst_amount_mismatch: "warning",
  gst_return_not_in_books: "warning",
  gst_books_not_in_return: "warning",
  gst_party_without_gstin: "review",
};

/** Raw (unmasked) mismatch finding; the session masks it before it goes anywhere near the model. */
export interface GstMismatchFinding {
  id: string;
  check: GstCheckId;
  severity: Severity;
  kind: GstKind;
  /** Real ledger name, or the returns file's partyName, or "" when neither exists. */
  party: string;
  /** Real group for a book party; RETURN_GROUP for a returns-only identity. */
  group: string;
  /** Real GSTIN, or null for a book party whose master carries none. */
  gstin: string | null;
  amount: number;
  detail: string;
}

export interface GstSideTotals {
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  other: number;
}

export interface GstKindAggregate {
  books: GstSideTotals;
  returns: GstSideTotals;
  parties: { matched: number; booksOnly: number; returnsOnly: number; withoutGstin: number };
}

export interface GstAggregate {
  outward: GstKindAggregate;
  inward: GstKindAggregate;
  unattributed: Array<{ head: GstHead; output: number; input: number }>;
}

/**
 * Money in finding details is formatted with Indian digit grouping, not
 * bare: a bare 6+-digit money figure ("100000.00") triggers scrubDigits'
 * 6-digit-run scrub and reaches the model as "[number].00" — destroying the
 * very figure the report narrates. Indian grouping ("1,00,000.00") keeps
 * every digit run under three digits, so the account-number scrub never
 * collides with a money amount, and it reads correctly for the report's
 * audience. (The same latent collision exists in the M1 check details; it
 * is left alone — milestone boundary.)
 */
// money() now lives in src/format.ts, shared with the M3 ledger scrutiny details.

const nonZeroHeads = (heads: Record<GstHead, number>): string => {
  const parts = GST_HEADS.filter((h) => Math.abs(heads[h]) > 0.005).map(
    (h) => `${h} ${money(heads[h])}`,
  );
  return parts.length ? parts.join(", ") : "no tax";
};

const taxSum = (heads: Record<GstHead, number>): number =>
  GST_HEADS.reduce((s, h) => s + heads[h], 0);

const booksTotals = (rows: GstPartyTotals[]): GstSideTotals => {
  const t: GstSideTotals = {
    taxableValue: 0,
    cgst: 0,
    sgst: 0,
    igst: 0,
    cess: 0,
    other: 0,
  };
  for (const r of rows) {
    t.taxableValue += r.taxableValue;
    t.cgst += r.heads.CGST;
    t.sgst += r.heads["SGST/UTGST"];
    t.igst += r.heads.IGST;
    t.cess += r.heads.CESS;
    t.other += r.heads["GST-OTHER"];
  }
  return {
    taxableValue: round2(t.taxableValue),
    cgst: round2(t.cgst),
    sgst: round2(t.sgst),
    igst: round2(t.igst),
    cess: round2(t.cess),
    other: round2(t.other),
  };
};

const returnsTotals = (rows: ReturnRow[]): GstSideTotals => {
  const t: GstSideTotals = {
    taxableValue: 0,
    cgst: 0,
    sgst: 0,
    igst: 0,
    cess: 0,
    other: 0,
  };
  for (const r of rows) {
    t.taxableValue += r.taxableValue;
    t.cgst += r.cgst;
    t.sgst += r.sgst;
    t.igst += r.igst;
    t.cess += r.cess;
  }
  return {
    taxableValue: round2(t.taxableValue),
    cgst: round2(t.cgst),
    sgst: round2(t.sgst),
    igst: round2(t.igst),
    cess: round2(t.cess),
    other: round2(t.other),
  };
};

/**
 * Join books to filed returns on GSTIN, in code, on real values (design doc
 * §2.1). Generation order is deterministic: kinds outward→inward, and within
 * a kind joined pairs first, then books-only, returns-only and no-GSTIN
 * parties, each sorted — so finding ordinals are stable for a given input.
 */
export function gstMismatch(
  books: GstBooks,
  returns: ReturnRow[],
): { findings: GstMismatchFinding[]; aggregate: GstAggregate } {
  const findings: GstMismatchFinding[] = [];
  const counters: Record<GstCheckId, number> = {
    gst_amount_mismatch: 0,
    gst_return_not_in_books: 0,
    gst_books_not_in_return: 0,
    gst_party_without_gstin: 0,
  };
  const push = (f: Omit<GstMismatchFinding, "id" | "severity">) => {
    counters[f.check] += 1;
    findings.push({
      ...f,
      id: gstFindingId(f.check, counters[f.check]),
      severity: SEVERITY[f.check],
    });
  };

  const aggregate = {} as GstAggregate;

  for (const kind of ["outward", "inward"] as GstKind[]) {
    const bookRows = books.byKind[kind].withGstin;
    const bookByGstin = new Map(bookRows.map((r) => [r.gstin!, r]));
    const retRows = returns.filter((r) => r.kind === kind);
    const retByGstin = new Map(retRows.map((r) => [r.gstin, r]));

    let matched = 0;
    let booksOnly = 0;
    let returnsOnly = 0;

    // 1. Joined pairs: per-field comparison beyond tolerance.
    for (const gstin of [...bookByGstin.keys()].sort()) {
      const ret = retByGstin.get(gstin);
      const b = bookByGstin.get(gstin)!;
      if (!ret) continue;
      matched += 1;
      const fields: Array<{ label: string; books: number; ret: number }> = [
        { label: "taxable value", books: round2(b.taxableValue), ret: round2(ret.taxableValue) },
        { label: "CGST", books: round2(b.heads.CGST), ret: round2(ret.cgst) },
        { label: "SGST/UTGST", books: round2(b.heads["SGST/UTGST"]), ret: round2(ret.sgst) },
        { label: "IGST", books: round2(b.heads.IGST), ret: round2(ret.igst) },
        { label: "CESS", books: round2(b.heads.CESS), ret: round2(ret.cess) },
        { label: "GST-OTHER", books: round2(b.heads["GST-OTHER"]), ret: 0 },
      ];
      const breaches = fields.filter((f) => Math.abs(f.books - f.ret) > GST_TOLERANCE);
      if (!breaches.length) continue;
      push({
        check: "gst_amount_mismatch",
        kind,
        party: b.party,
        group: b.group,
        gstin,
        amount: round2(
          breaches.reduce((s, f) => s + Math.abs(f.books - f.ret), 0),
        ),
        detail:
          `${b.party} (${gstin}) ${kind}: books vs return differ beyond the ` +
          `${money(GST_TOLERANCE)} tolerance — ` +
          breaches
            .map((f) => `${f.label} books ${money(f.books)} vs return ${money(f.ret)}`)
            .join("; "),
      });
    }

    // 2. Books-only GSTINs: in the books, absent from the filed return.
    for (const gstin of [...bookByGstin.keys()].sort()) {
      if (retByGstin.has(gstin)) continue;
      const b = bookByGstin.get(gstin)!;
      const tax = round2(taxSum(b.heads));
      if (Math.abs(tax) <= GST_TOLERANCE) continue; // nothing to file
      booksOnly += 1;
      push({
        check: "gst_books_not_in_return",
        kind,
        party: b.party,
        group: b.group,
        gstin,
        amount: Math.abs(tax),
        detail:
          `${b.party} (${gstin}) has ${kind} GST in the books but no ${kind} row in the ` +
          `return: ${nonZeroHeads(b.heads)}; taxable value ${money(round2(b.taxableValue))}`,
      });
    }

    // 3. Returns-only GSTINs: filed, but no book activity to back them.
    for (const gstin of [...retByGstin.keys()].sort()) {
      if (bookByGstin.has(gstin)) continue;
      const r = retByGstin.get(gstin)!;
      const tax = round2(r.cgst + r.sgst + r.igst + r.cess);
      if (Math.abs(tax) <= GST_TOLERANCE) continue;
      returnsOnly += 1;
      push({
        check: "gst_return_not_in_books",
        kind,
        party: r.partyName,
        group: RETURN_GROUP,
        gstin,
        amount: Math.abs(tax),
        detail:
          `Return row for ${r.partyName || "an unnamed party"} (${gstin}), ${kind}: tax ` +
          `${money(tax)}; taxable value ${money(round2(r.taxableValue))} — no matching ` +
          `GST activity in the books`,
      });
    }

    // 4. Book parties whose master carries no GSTIN: unjoinable, fix the master.
    const noGstin = books.byKind[kind].withoutGstin;
    for (const b of noGstin) {
      const tax = round2(taxSum(b.heads));
      if (Math.abs(tax) <= GST_TOLERANCE) continue;
      push({
        check: "gst_party_without_gstin",
        kind,
        party: b.party,
        group: b.group,
        gstin: null,
        amount: Math.abs(tax),
        detail:
          `${b.party} has ${kind} GST in the books (${nonZeroHeads(b.heads)}; taxable value ` +
          `${money(round2(b.taxableValue))}) but no GSTIN in its ledger master, so it ` +
          `cannot be matched to any return row`,
      });
    }

    aggregate[kind] = {
      books: booksTotals([...bookRows, ...noGstin]),
      returns: returnsTotals(retRows),
      parties: {
        matched,
        booksOnly,
        returnsOnly,
        withoutGstin: noGstin.filter((b) => Math.abs(taxSum(b.heads)) > GST_TOLERANCE).length,
      },
    };
  }

  aggregate.unattributed = GST_HEADS.filter(
    (h) => books.unattributed[h].output !== 0 || books.unattributed[h].input !== 0,
  ).map((h) => ({ head: h, ...books.unattributed[h] }));

  return { findings, aggregate };
}
