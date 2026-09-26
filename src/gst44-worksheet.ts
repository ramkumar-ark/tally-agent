// src/gst44-worksheet.ts
import type { VoucherRow } from "./downstream.js";
import { money } from "./format.js";
import { canonicalKey } from "./key.js";
import { gstHeadOf, type GstCtx } from "./gst.js";
import { CAPITAL_ROOTS, REVENUE_ROOTS } from "./gst44.js";
import type { Gst44RawFinding } from "./gst44.js";
import { findingId, type CheckId, type Severity } from "./types.js";
import {
  policyMatch,
  evidenceMatch,
  patternMatch,
  type TreatmentRule,
  type WorksheetTreatment,
} from "./gst44-treatments.js";
import type { PriorYearSheets } from "./gst44-prior.js";

/**
 * The GST nature-wise break-up WORKING SHEET engine (captain's addendum
 * 2026-09-26, Phase B). Pure: walks the period's vouchers per EXPENSE LEDGER
 * — not per party like clause 44 itself — and seeds each ledger's break-up
 * columns from the captain-approved chain:
 *
 *   1. policy keyword rule   (taxes, payroll, depreciation, ... -> not supply)
 *   2. prior-year exact name (the FY 24-25 hand-prepared sheet, when given)
 *   3. evidence keyword rule (URD markers -> unregistered)
 *   4. party GSTIN evidence  (per-party registered/unregistered pots)
 *   5. rate-suffix pattern   (explicit "- 18%" -> others, "0%" -> exempt)
 *   6. nothing               -> the row stays blank + a review finding
 *
 * The sheet's own semantics (Q-C): the operator fills D/E/H/J only; I = B,
 * G = I - H - J and F = G - E - D derive. A seeded row therefore writes
 * literals ONLY into D/E/H/J and formulas into G/F/I — a wholly-others row
 * writes zeros there so F derives to the whole amount. An unseeded row gets
 * no formulas at all, so an unfilled amount can never silently land in F.
 */

export type WsRowKey = "revenue" | "capital";

export type SeedKind = "policy keyword" | "prior year" | "evidence keyword" | "party evidence" | "pattern rule" | "zero balance";

export interface WorksheetSeed {
  /** Literal fills for the operator-decided columns; F/G/I derive from them. */
  d: number;
  e: number;
  h: number;
  j: number;
  /** The seeded treatment label, or "mixed" when party evidence split the amount. */
  treatment: WorksheetTreatment | "mixed";
  /** Which chain step seeded the row — the seed-reason count's key. */
  kind: SeedKind;
  /** Why this seed: rule id, prior year, party evidence — shown in the sheet. */
  reason: string;
}

export interface WsLedgerRow {
  /** Display name (master case when the ledger is in the masters). */
  ledger: string;
  group: string;
  rowKey: WsRowKey;
  /** The ledger's FY debit total (column B). */
  amount: number;
  seed: WorksheetSeed | null;
}

export interface GstWorksheetResult {
  revenue: WsLedgerRow[];
  capital: WsLedgerRow[];
  vouchersScanned: number;
  cancelledSkipped: number;
  unattributed: { revenue: number; capital: number; events: number };
  findings: Gst44RawFinding[];
}

/** The K-column labels, mirroring the clause 44 template's vocabulary. */
export const WS_TREATMENT_LABELS: Record<WorksheetTreatment | "mixed" | "unclassified", string> = {
  not_supply: "Not supply / non-GST",
  exempt: "Exempt supplies",
  composition: "Composition supplier",
  others: "Registered - others",
  unregistered: "Unregistered",
  mixed: "Mixed (see reason)",
  unclassified: "UNCLASSIFIED",
};

const ZERO = 0.005;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Whole-amount seed for one treatment: the treated column carries the net
 * (others derives, so its literals stay zero) and the rest stay zero. */
function seedFor(treatment: WorksheetTreatment, net: number, kind: SeedKind, reason: string): WorksheetSeed {
  switch (treatment) {
    case "exempt":
      return { d: net, e: 0, h: 0, j: 0, treatment, kind, reason };
    case "composition":
      return { d: 0, e: net, h: 0, j: 0, treatment, kind, reason };
    case "unregistered":
      return { d: 0, e: 0, h: net, j: 0, treatment, kind, reason };
    case "not_supply":
      return { d: 0, e: 0, h: 0, j: net, treatment, kind, reason };
    case "others":
      return { d: 0, e: 0, h: 0, j: 0, treatment, kind, reason };
  }
}

interface Acc {
  ledger: string;
  group: string;
  rowKey: WsRowKey;
  debit: number;
  pots: { others: number; exempt: number; unregistered: number; unknown: number };
  noParty: number;
  seed: WorksheetSeed | null;
}

const emptyPots = () => ({ others: 0, exempt: 0, unregistered: 0, unknown: 0 });

export function gst44Worksheet(
  vouchers: VoucherRow[],
  ctx: GstCtx,
  opts: {
    rules: readonly TreatmentRule[];
    prior?: PriorYearSheets;
    /** canonical ledger key -> master-case display name. */
    masterNames?: Map<string, string>;
  },
): GstWorksheetResult {
  const masterNames = opts.masterNames ?? new Map<string, string>();
  const accs = new Map<string, Acc>();
  const ensure = (ledger: string, rowKey: WsRowKey): Acc => {
    const key = canonicalKey(ledger);
    let acc = accs.get(key);
    if (!acc) {
      acc = {
        ledger: masterNames.get(key) ?? ledger,
        group: ctx.groupOf(ledger),
        rowKey,
        debit: 0,
        pots: emptyPots(),
        noParty: 0,
        seed: null,
      };
      accs.set(key, acc);
    }
    return acc;
  };

  const masters = new Set(masterNames.keys());
  let vouchersScanned = 0;
  let cancelledSkipped = 0;
  const unattributed = { revenue: 0, capital: 0, events: 0 };

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
      if (!taxCharged && e.amount !== 0 && ctx.inDutiesAndTaxes(ctx.groupOf(e.ledger)) && gstHeadOf(e.ledger)) {
        taxCharged = true;
      }
    }
    const partyGstin = party ? ctx.gstinOf(party) : null;
    const partyKnown = party ? masters.has(canonicalKey(party)) : false;
    for (const e of v.entries) {
      const root = ctx.rootOf(ctx.groupOf(e.ledger)) ?? "";
      const rowKey: WsRowKey | null = CAPITAL_ROOTS.has(root) ? "capital" : REVENUE_ROOTS.has(root) ? "revenue" : null;
      if (!rowKey) continue;
      const acc = ensure(e.ledger, rowKey);
      // Column B is the FY debit total (design §4.1-B): credits on the ledger
      // are returns/reversals/closing entries, not expenditure, so they are
      // excluded from the amount and from every treatment pot.
      if (e.amount <= 0) continue;
      acc.debit += e.amount;
      if (!party) {
        acc.noParty += e.amount;
        unattributed[rowKey] += e.amount;
        unattributed.events += 1;
        continue;
      }
      if (partyGstin) {
        acc.pots[taxCharged ? "others" : "exempt"] += e.amount;
      } else if (partyKnown) {
        acc.pots.unregistered += e.amount;
      } else {
        acc.pots.unknown += e.amount;
      }
    }
  }

  const findings: Gst44RawFinding[] = [];
  const counters: Partial<Record<CheckId, number>> = {};
  const push = (check: CheckId, severity: Severity, ledger: string, group: string, amount: number, detail: string) => {
    counters[check] = (counters[check] ?? 0) + 1;
    findings.push({
      id: findingId(check, counters[check]!),
      check,
      severity,
      ledger,
      group,
      amount: round2(Math.abs(amount)),
      detail,
    });
  };

  const sorted = [...accs.values()].sort((a, b) => a.ledger.localeCompare(b.ledger));
  for (const acc of sorted) {
    const prior = opts.prior?.[acc.rowKey]?.get(canonicalKey(acc.ledger));
    const policy = policyMatch(acc.ledger, opts.rules);
    const evidence = evidenceMatch(acc.ledger, opts.rules.filter((r) => r.scope !== (acc.rowKey === "capital" ? "revenue" : "capital")));
    const pattern = patternMatch(acc.ledger, opts.rules);

    if (policy) {
      // Captain policy keyword rules take precedence over prior-year exact
      // matches (addendum 2026-09-26e: the seed reason must name the rule,
      // not the prior year). A prior-year agreement is noted as secondary.
      const priorNote =
        prior && !prior.split && prior.treatment === policy.treatment
          ? `rule '${policy.rule.id}': ${policy.rule.note} (FY 24-25 agreed: ${WS_TREATMENT_LABELS[prior.treatment]})`
          : `rule '${policy.rule.id}': ${policy.rule.note}`;
      acc.seed = seedFor(policy.treatment, acc.debit, "policy keyword", priorNote);
      if (prior && (prior.split || prior.treatment !== policy.treatment)) {
        push(
          "gst44_ws_prior_year_changed",
          "warning",
          acc.ledger,
          acc.group,
          acc.debit,
          `the policy rule '${policy.rule.id}' seeds this ledger as ${WS_TREATMENT_LABELS[policy.treatment]}, ` +
            `but FY 24-25 showed ${prior.split ? `a split (${prior.profile})` : WS_TREATMENT_LABELS[prior.treatment]} — adjust the break-up if the old treatment still applies`,
        );
      }
      const disagree = [evidence, pattern].find((h) => h && h.treatment !== policy.treatment);
      if (disagree) {
        push(
          "gst44_ws_rule_conflict",
          "warning",
          acc.ledger,
          acc.group,
          acc.debit,
          `policy rule '${policy.rule.id}' seeds ${WS_TREATMENT_LABELS[policy.treatment]} but rule '${disagree.rule.id}' reads the name as ${WS_TREATMENT_LABELS[disagree.treatment]}; the policy rule wins — check the ledger`,
        );
      }
      continue;
    }

    if (prior) {
      acc.seed = seedFor(
        prior.treatment,
        acc.debit,
        "prior year",
        prior.split
          ? `prior year FY 24-25 (${prior.label}): last year was split (${prior.profile}); seeded wholly as ${WS_TREATMENT_LABELS[prior.treatment]} — adjust the columns`
          : `prior year FY 24-25 (${prior.label}): treated as ${WS_TREATMENT_LABELS[prior.treatment]}`,
      );
      if (prior.split) {
        push(
          "gst44_ws_prior_year_changed",
          "warning",
          acc.ledger,
          acc.group,
          acc.debit,
          `FY 24-25 split this ledger's spend across columns (${prior.profile}); the seed keeps only the largest column (${WS_TREATMENT_LABELS[prior.treatment]}) — restore the split`,
        );
      }
      continue;
    }

    if (evidence) {
      acc.seed = seedFor(evidence.treatment, acc.debit, "evidence keyword", `rule '${evidence.rule.id}': ${evidence.rule.note}`);
      continue;
    }

    const unknownAmount = acc.pots.unknown + acc.noParty;
    if (Math.abs(unknownAmount) <= ZERO) {
      const { others, exempt, unregistered } = acc.pots;
      if (Math.abs(acc.debit) <= ZERO) {
        acc.seed = { d: 0, e: 0, h: 0, j: 0, treatment: "others", kind: "zero balance", reason: "no expenditure in the period (zero balance)" };
        continue;
      }
      const parts: string[] = [];
      if (Math.abs(others) > ZERO) parts.push(`registered with tax ${money(others)}`);
      if (Math.abs(exempt) > ZERO) parts.push(`registered without tax ${money(exempt)}`);
      if (Math.abs(unregistered) > ZERO) parts.push(`unregistered ${money(unregistered)}`);
      const nonzeroPots = parts.length;
      acc.seed = {
        d: exempt,
        e: 0,
        h: unregistered,
        j: 0,
        treatment: nonzeroPots > 1 ? "mixed" : others ? "others" : exempt ? "exempt" : "unregistered",
        kind: "party evidence",
        reason: `party GSTIN evidence: ${parts.join(", ")}`,
      };
      continue;
    }

    if (pattern) {
      acc.seed = {
        ...seedFor(pattern.treatment, acc.debit, "pattern rule", `rule '${pattern.rule.id}': ${pattern.rule.note}`),
        reason:
          `rule '${pattern.rule.id}': ${pattern.rule.note}` +
          (Math.abs(acc.pots.unknown) > ZERO ? `; party GSTIN unknown for ${money(Math.abs(acc.pots.unknown))} — verify` : "") +
          (Math.abs(acc.noParty) > ZERO ? `; ${money(Math.abs(acc.noParty))} had no party on its vouchers — verify` : ""),
      };
      continue;
    }

    acc.seed = null;
    if (Math.abs(acc.debit) > ZERO) {
      push(
        "gst44_ws_unclassified",
        "review",
        acc.ledger,
        acc.group,
        acc.debit,
        `matched no treatment rule and stays blank` +
          (Math.abs(acc.pots.unknown) > ZERO ? `; party GSTIN unknown for ${money(Math.abs(acc.pots.unknown))}` : "") +
          (Math.abs(acc.noParty) > ZERO ? `; ${money(Math.abs(acc.noParty))} had no party on its vouchers` : "") +
          ` — fill its break-up columns before approval`,
      );
    }
  }

  const byKey = (rowKey: WsRowKey) => sorted
    .filter((acc) => acc.rowKey === rowKey)
    .map((acc): WsLedgerRow => ({
      ledger: acc.ledger,
      group: acc.group,
      rowKey: acc.rowKey,
      amount: acc.debit,
      seed: acc.seed,
    }));
  return {
    revenue: byKey("revenue"),
    capital: byKey("capital"),
    vouchersScanned,
    cancelledSkipped,
    unattributed: {
      revenue: round2(unattributed.revenue),
      capital: round2(unattributed.capital),
      events: unattributed.events,
    },
    findings,
  };
}
