// src/gst44.ts
import type { VoucherRow } from "./downstream.js";
import { money } from "./format.js";
import { canonicalKey } from "./key.js";
import { gstHeadOf, type GstCtx } from "./gst.js";
import {
  CLAUSE_44_ROWS,
  GST44_BUCKETS,
  type Gst44Bucket,
  type Gst44RowKey,
} from "./gst44-law.js";
import { findingId, type CheckId, type Severity } from "./types.js";

/** Pure clause-44 computation (R-E-1): no I/O, no MCP, no masking. Runs on
 * real names and real GSTINs; the session masks everything on the way out. */

export interface Gst44StatusRow {
  ledger: string;
  status: Gst44Bucket;
}
export interface OperatorGst44 {
  statuses: Gst44StatusRow[];
}
export const EMPTY_GST44: OperatorGst44 = { statuses: [] };

export interface Gst44RawFinding {
  id: string;
  check: CheckId;
  severity: Severity;
  ledger: string;
  group: string;
  amount: number | null;
  detail: string;
}

export interface Gst44Party {
  party: string;
  group: string;
  /** The master carried a GSTIN (never the value itself — that stays in the ctx). */
  gstinKnown: boolean;
  override: boolean;
  /** Registered GSTIN, no tax charged, no operator status: exempt vs composition is unknowable from books (C6). */
  ambiguous: boolean;
  capital: Record<Gst44Bucket, number>;
  revenue: Record<Gst44Bucket, number>;
}

export const partySpend = (p: Gst44Party): number =>
  GST44_BUCKETS.reduce((s, b) => s + p.capital[b] + p.revenue[b], 0);

export interface Gst44Row {
  key: Gst44RowKey;
  label: string;
  /** The BOOKS total for the row (Winman's column B): attributed spend plus any unattributed spend (C5). */
  total: number;
  exempt: number;
  composition: number;
  others: number;
  unregistered: number;
}

export interface Gst44Books {
  vouchersScanned: number;
  cancelledSkipped: number;
  rows: [Gst44Row, Gst44Row];
  parties: Gst44Party[];
  unattributed: { capital: number; revenue: number; events: number };
  findings: Gst44RawFinding[];
}

/** C3/C4 root sets: revenue = P&L expenditure roots, capital = Fixed Assets only. */
export const REVENUE_ROOTS = new Set(["Purchase Accounts", "Direct Expenses", "Indirect Expenses", "Misc. Expenses (ASSET)"]);
export const CAPITAL_ROOTS = new Set(["Fixed Assets"]);

const round2 = (n: number): number => Math.round(n * 100) / 100;
const zeroBuckets = (): Record<Gst44Bucket, number> => ({ exempt: 0, composition: 0, others: 0, unregistered: 0 });

export function statusOf(
  party: string,
  taxCharged: boolean,
  ctx: GstCtx,
  overrides: Map<string, Gst44Bucket>,
): { status: Gst44Bucket; ambiguous: boolean; override: boolean } {
  const o = overrides.get(canonicalKey(party));
  if (o) return { status: o, ambiguous: false, override: true };
  if (!ctx.gstinOf(party)) return { status: "unregistered", ambiguous: false, override: false };
  return taxCharged
    ? { status: "others", ambiguous: false, override: false }
    : { status: "exempt", ambiguous: true, override: false };
}

export function gst44(vouchers: VoucherRow[], ctx: GstCtx, operator: OperatorGst44): Gst44Books {
  const overrides = new Map(operator.statuses.map((s) => [canonicalKey(s.ledger), s.status]));
  const parties = new Map<string, Gst44Party>();
  const ensureParty = (name: string): Gst44Party => {
    const k = canonicalKey(name);
    let p = parties.get(k);
    if (!p) {
      p = {
        party: name,
        group: ctx.groupOf(name),
        gstinKnown: ctx.gstinOf(name) !== null,
        override: overrides.has(k),
        ambiguous: false,
        capital: zeroBuckets(),
        revenue: zeroBuckets(),
      };
      parties.set(k, p);
    }
    return p;
  };

  let vouchersScanned = 0;
  let cancelledSkipped = 0;
  const unattributed = { capital: 0, revenue: 0, events: 0 };

  for (const v of vouchers) {
    if (v.cancelled) {
      cancelledSkipped += 1;
      continue;
    }
    vouchersScanned += 1;
    let party = v.partyLedgerName || null;
    if (!party) {
      for (const e of v.entries) {
        if (ctx.roleOf(ctx.groupOf(e.ledger)) === "creditor") {
          party = e.ledger;
          break;
        }
      }
    }
    let taxCharged = false;
    for (const e of v.entries) {
      const g = ctx.groupOf(e.ledger);
      if (!taxCharged && e.amount !== 0 && ctx.inDutiesAndTaxes(g) && gstHeadOf(e.ledger)) taxCharged = true;
    }
    for (const e of v.entries) {
      if (e.amount <= 0) continue;
      const root = ctx.rootOf(ctx.groupOf(e.ledger)) ?? "";
      const rowKey: Gst44RowKey | null = CAPITAL_ROOTS.has(root) ? "capital" : REVENUE_ROOTS.has(root) ? "revenue" : null;
      if (!rowKey) continue;
      if (!party) {
        unattributed[rowKey] += e.amount;
        unattributed.events += 1;
        continue;
      }
      const p = ensureParty(party);
      const { status, ambiguous } = statusOf(party, taxCharged, ctx, overrides);
      if (ambiguous) p.ambiguous = true;
      p[rowKey][status] += e.amount;
    }
  }

  const mkRow = (key: Gst44RowKey, label: string): Gst44Row => {
    const acc = zeroBuckets();
    for (const p of parties.values()) for (const b of GST44_BUCKETS) acc[b] += p[key][b];
    return {
      key,
      label,
      // The books total (v1 brief): every expenditure line under this row's
      // roots, attributed or not — so the split columns need not add across
      // and the unattributed gap lands in the total alone (C5).
      total: round2(acc.exempt + acc.composition + acc.others + acc.unregistered + unattributed[key]),
      exempt: round2(acc.exempt),
      composition: round2(acc.composition),
      others: round2(acc.others),
      unregistered: round2(acc.unregistered),
    };
  };
  const rows = CLAUSE_44_ROWS.map((r) => mkRow(r.key, r.label)) as [Gst44Row, Gst44Row];

  const findings: Gst44RawFinding[] = [];
  let n = 0;
  for (const p of [...parties.values()].sort((a, b) => partySpend(b) - partySpend(a))) {
    if (p.ambiguous) {
      n += 1;
      const amount = p.capital.exempt + p.revenue.exempt;
      findings.push({
        id: findingId("gst44_composition_unknown", n),
        check: "gst44_composition_unknown",
        severity: "review",
        ledger: p.party,
        group: p.group,
        amount: round2(amount),
        detail:
          `${p.party} is registered (GSTIN in the master) but some vouchers charge no GST: ${money(amount)} ` +
          `sits in the exempt column; if the supplier is a composition dealer, fill the GST Status sheet (C6)`,
      });
    }
  }
  if (unattributed.events > 0) {
    findings.push({
      id: findingId("gst44_unattributed_expenditure", 1),
      check: "gst44_unattributed_expenditure",
      severity: "review",
      ledger: "",
      group: "",
      amount: round2(unattributed.capital + unattributed.revenue),
      detail:
        `${unattributed.events} expenditure lines (${money(unattributed.capital)} capital, ` +
        `${money(unattributed.revenue)} revenue) have no party to attribute: they are in the ` +
        `row totals (books total) but in no split column (C5)`,
    });
  }
  n = 0;
  for (const p of parties.values()) {
    if (p.group === "" && partySpend(p) > 0) {
      n += 1;
      findings.push({
        id: findingId("gst44_party_not_in_masters", n),
        check: "gst44_party_not_in_masters",
        severity: "warning",
        ledger: p.party,
        group: "",
        amount: round2(partySpend(p)),
        detail: `${p.party} is not in the ledger masters; its GST status is books-guesswork`,
      });
    }
  }

  return {
    vouchersScanned,
    cancelledSkipped,
    rows,
    parties: [...parties.values()].sort((a, b) => partySpend(b) - partySpend(a)),
    unattributed: {
      capital: round2(unattributed.capital),
      revenue: round2(unattributed.revenue),
      events: unattributed.events,
    },
    findings,
  };
}
