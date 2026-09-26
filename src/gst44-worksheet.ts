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
  allEvidenceHits,
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
 *   3. evidence keyword rule (URD markers -> unregistered, insurance always
 *      others, credit-card spend always others)
 *   4. party GSTIN evidence  (per-party registered/unregistered pots; a
 *      registered supplier with no tax lines on its vouchers still seeds
 *      others — no-tax is not by itself evidence of exempt, 26f — EXCEPT a
 *      "0%"-suffixed ledger, whose name pattern keeps it exempt when its
 *      registered suppliers charged no tax, 26g)
 *   5. rate-suffix pattern   (explicit "- 18%" -> others, "0%" -> exempt)
 *   6. nothing               -> the row stays blank + a review finding
 *
 * Column B is the ledger's NET FY movement on the REVENUE sheet (debits minus
 * credits, captain 2026-09-26h) and its debit total on CAPITAL (additions
 * only). The treatment pots are the same signed measure, so a revenue row's
 * buckets always sum to B.
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
  /**
   * Column B: the ledger's net FY movement for REVENUE (debits minus credits)
   * or its FY debit total for CAPITAL (additions only).
   */
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
  /**
   * Column B accumulator: net FY movement (debits minus credits) on the
   * REVENUE sheet; FY debit total only on the CAPITAL sheet. Every treatment
   * pot below is the same signed measure, so the pots sum to `amount`.
   */
  amount: number;
  pots: { others: number; exempt: number; unregistered: number; unknown: number };
  noParty: number;
  /**
   * Spend routed to `others` by voucher tax lines while the supplier master
   * carries no GSTIN (26e: tax-charged vouchers are registered purchases even
   * without a party GSTIN). Quoted in the seed reason so the operator verifies
   * the supplier's registration.
   */
  taxNoGstin: number;
  /**
   * Spend routed to `others` from a GST-registered supplier (master carries a
   * GSTIN) whose vouchers carried no tax lines (26f: no tax lines on a
   * registered supplier is not by itself evidence of exempt — the tax may sit
   * in the asset cost, e.g. blocked credit booked gross). Quoted in the seed
   * reason so the operator moves it to exempt only with evidence.
   */
  noTaxGstin: number;
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
        amount: 0,
        pots: emptyPots(),
        noParty: 0,
        taxNoGstin: 0,
        noTaxGstin: 0,
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
      // REVENUE contributes its NET FY movement — debits minus credits
      // (captain 2026-09-26h, superseding design §4.1-B's debit-only column
      // B): purchase returns, discounts and credit notes legitimately net down
      // expenditure, so the "As per books" total ties Tally's P&L group total.
      // CAPITAL stays debit-only: a year-end depreciation credit is the annual
      // charge, not a reversal of the asset's addition, so it must not reduce
      // capital expenditure (this also keeps the 26e zero-row fix meaningful).
      if (rowKey === "capital" && e.amount <= 0) continue;
      acc.amount += e.amount;
      if (!party) {
        acc.noParty += e.amount;
        unattributed[rowKey] += e.amount;
        unattributed.events += 1;
        continue;
      }
      if (partyGstin) {
        // A GST-registered supplier is a registered purchase whether or not
        // its vouchers carried tax lines (addendum 2026-09-26f): GST on a
        // blocked-credit s.17(5) purchase can sit inside the asset cost with
        // no tax lines, so no-tax on a registered supplier is not by itself
        // evidence of exempt. Exempt needs positive evidence (a policy,
        // evidence-keyword or prior-year seed, or an explicit "0%" pattern);
        // unregistered needs a known party with no GSTIN and no tax.
        acc.pots.others += e.amount;
        if (!taxCharged) acc.noTaxGstin += e.amount;
      } else if (taxCharged) {
        // The voucher itself charged GST (Input CGST/SGST lines), so this is
        // a registered purchase even though the supplier master carries no
        // GSTIN (addendum 2026-09-26e) — never park tax-charged spend in H.
        // Exempt needs positive evidence (a supplier GSTIN with no tax on
        // the voucher); unregistered needs a known party with no tax.
        acc.pots.others += e.amount;
        acc.taxNoGstin += e.amount;
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
      acc.seed = seedFor(policy.treatment, acc.amount, "policy keyword", priorNote);
      if (prior && (prior.split || prior.treatment !== policy.treatment)) {
        push(
          "gst44_ws_prior_year_changed",
          "warning",
          acc.ledger,
          acc.group,
          acc.amount,
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
          acc.amount,
          `policy rule '${policy.rule.id}' seeds ${WS_TREATMENT_LABELS[policy.treatment]} but rule '${disagree.rule.id}' reads the name as ${WS_TREATMENT_LABELS[disagree.treatment]}; the policy rule wins — check the ledger`,
        );
      }
      continue;
    }

    if (prior) {
      acc.seed = seedFor(
        prior.treatment,
        acc.amount,
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
          acc.amount,
          `FY 24-25 split this ledger's spend across columns (${prior.profile}); the seed keeps only the largest column (${WS_TREATMENT_LABELS[prior.treatment]}) — restore the split`,
        );
      }
      continue;
    }

    if (evidence) {
      acc.seed = seedFor(evidence.treatment, acc.amount, "evidence keyword", `rule '${evidence.rule.id}': ${evidence.rule.note}`);
      const scoped = opts.rules.filter((r) => r.scope !== (acc.rowKey === "capital" ? "revenue" : "capital"));
      const later = allEvidenceHits(acc.ledger, scoped).filter(
        (h) => h.rule.id !== evidence.rule.id && h.treatment !== evidence.treatment,
      );
      for (const hit of later) {
        push(
          "gst44_ws_rule_conflict",
          "warning",
          acc.ledger,
          acc.group,
          acc.amount,
          `evidence rule '${evidence.rule.id}' seeds ${WS_TREATMENT_LABELS[evidence.treatment]} but rule '${hit.rule.id}' reads the name as ${WS_TREATMENT_LABELS[hit.treatment]}; the earlier rule wins — check the ledger`,
        );
      }
      continue;
    }

    const unknownAmount = acc.pots.unknown + acc.noParty;
    // A "0%"-suffixed ledger whose registered suppliers charged no tax keeps
    // that part Exempt (addendum 2026-09-26g): the 0% name pattern beats the
    // registered-purchase party evidence. Only the no-tax part moves — spend
    // from tax-charged vouchers stays a registered purchase (26e) and derives
    // through F, so a part-taxed ledger seeds split (mixed). Any
    // unregistered/unknown/no-party spend falls through to the routing below.
    if (
      pattern &&
      pattern.rule.id === "rate-zero" &&
      Math.abs(acc.amount) > ZERO &&
      Math.abs(acc.pots.unregistered) <= ZERO &&
      Math.abs(unknownAmount) <= ZERO &&
      Math.abs(acc.noTaxGstin) > ZERO
    ) {
      const exemptPart = round2(Math.min(acc.noTaxGstin, acc.amount));
      const whole = Math.abs(acc.amount - exemptPart) <= ZERO;
      acc.seed = {
        d: exemptPart,
        e: 0,
        h: 0,
        j: 0,
        treatment: whole ? "exempt" : "mixed",
        kind: "pattern rule",
        reason:
          `rule 'rate-zero': ${pattern.rule.note} — its registered suppliers charged no tax on ${money(exemptPart)}, so the 0% name keeps that part exempt` +
          (whole
            ? ""
            : `; ${money(round2(acc.amount - exemptPart))} came from tax-charged vouchers and stays Registered - others (derives through F)`),
      };
      continue;
    }
    if (Math.abs(unknownAmount) <= ZERO) {
      const { others, unregistered } = acc.pots;
      if (Math.abs(acc.amount) <= ZERO) {
        acc.seed = { d: 0, e: 0, h: 0, j: 0, treatment: "others", kind: "zero balance", reason: "no expenditure in the period (zero balance)" };
        continue;
      }
      const parts: string[] = [];
      if (Math.abs(others) > ZERO) parts.push(`registered purchase ${money(others)}`);
      if (Math.abs(unregistered) > ZERO) parts.push(`unregistered ${money(unregistered)}`);
      const nonzeroPots = parts.length;
      const taxNote =
        Math.abs(acc.taxNoGstin) > ZERO
          ? `; ${money(Math.abs(acc.taxNoGstin))} of it charged GST on its vouchers while the supplier carries no GSTIN in the masters — treated as a registered purchase, verify the supplier's registration`
          : "";
      const noTaxNote =
        Math.abs(acc.noTaxGstin) > ZERO
          ? `; ${money(Math.abs(acc.noTaxGstin))} of it came from a GST-registered supplier whose vouchers carried no tax lines — treated as a registered purchase, not exempt (move to exempt only with evidence)`
          : "";
      acc.seed = {
        d: 0,
        e: 0,
        h: unregistered,
        j: 0,
        treatment: nonzeroPots > 1 ? "mixed" : others ? "others" : "unregistered",
        kind: "party evidence",
        reason: `party GSTIN evidence: ${parts.join(", ")}${taxNote}${noTaxNote}`,
      };
      continue;
    }

    if (pattern) {
      acc.seed = {
        ...seedFor(pattern.treatment, acc.amount, "pattern rule", `rule '${pattern.rule.id}': ${pattern.rule.note}`),
        reason:
          `rule '${pattern.rule.id}': ${pattern.rule.note}` +
          (Math.abs(acc.pots.unknown) > ZERO ? `; party GSTIN unknown for ${money(Math.abs(acc.pots.unknown))} — verify` : "") +
          (Math.abs(acc.noParty) > ZERO ? `; ${money(Math.abs(acc.noParty))} had no party on its vouchers — verify` : ""),
      };
      continue;
    }

    acc.seed = null;
    if (Math.abs(acc.amount) > ZERO) {
      push(
        "gst44_ws_unclassified",
        "review",
        acc.ledger,
        acc.group,
        acc.amount,
        `matched no treatment rule and stays blank` +
          (Math.abs(acc.pots.unknown) > ZERO ? `; party GSTIN unknown for ${money(Math.abs(acc.pots.unknown))}` : "") +
          (Math.abs(acc.noParty) > ZERO ? `; ${money(Math.abs(acc.noParty))} had no party on its vouchers` : "") +
          ` — fill its break-up columns before approval`,
      );
    }
  }

  const byKey = (rowKey: WsRowKey) => sorted
    .filter((acc) => acc.rowKey === rowKey)
    // Year-end depreciation journals credit ~130 asset ledgers without ever
    // debiting them, which seeded a page of zero-balance capital rows (26e).
    // Capital's `amount` is still its debit total (additions), so a row with
    // no addition is dropped; revenue keeps every row, including a negative
    // net (a ledger whose credits exceeded its debits), to tie Tally.
    .filter((acc) => rowKey !== "capital" || Math.abs(acc.amount) > ZERO)
    .map((acc): WsLedgerRow => ({
      ledger: acc.ledger,
      group: acc.group,
      rowKey: acc.rowKey,
      amount: acc.amount,
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
