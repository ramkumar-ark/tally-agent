import { canonicalKey } from "./key.js";
import { displayDate } from "./format.js";
import type { VoucherEntry, VoucherRow } from "./downstream.js";
import type { GstAdjConfig } from "./gst-adj-config.js";
import type { ThreeBSummary } from "./gst-adj-3b.js";
import type { Itc2bEntry } from "./gst-adj-2b.js";

export type Role = string;
export type MonthMovements = Map<string, Map<Role, number>>;

export interface GadjEntry {
  kind: number; month: string; date: string; narration: string;
  legs: Array<{ dr: string; cr: string; amount: number }>;
}
export interface GadjFinding { id: string; severity: "warning" | "review"; detail: string; }
export interface GstAdjResult {
  entries: GadjEntry[];
  findings: GadjFinding[];
  tieout: Array<{ month: string; kind: number; head: string; entry: number; threeB: number | null; note?: string }>;
  residual: [];
}

export function booksMovements(
  vouchers: VoucherRow[],
  roleOf: (ledger: string) => Role | undefined,
  months?: string[],
): MonthMovements {
  const result: MonthMovements = new Map();
  if (months) {
    for (const m of months) result.set(m, new Map());
  }
  for (const v of vouchers) {
    const month = `${String(v.date).slice(0, 4)}-${String(v.date).slice(4, 6)}`;
    let monthMap = result.get(month);
    if (!monthMap) { monthMap = new Map(); result.set(month, monthMap); }
    for (const entry of v.entries) {
      const role = roleOf(entry.ledger);
      if (role !== undefined) {
        monthMap.set(role, (monthMap.get(role) ?? 0) + entry.amount);
      }
    }
  }
  return result;
}

export function roleResolver(config: GstAdjConfig): (ledger: string) => Role | undefined {
  const keyToRoles = new Map<string, string[]>();
  for (const [head, roles] of Object.entries(config.heads)) {
    for (const [role, ledgerName] of Object.entries(roles)) {
      const key = canonicalKey(ledgerName);
      if (!keyToRoles.has(key)) keyToRoles.set(key, []);
      keyToRoles.get(key)!.push(`${head}.${role}`);
    }
  }
  for (const [key, roles] of keyToRoles) {
    if (roles.length > 1) {
      throw new Error(`gst-adj roleResolver: ledger matches multiple roles — ${roles.join(", ")}`);
    }
  }
  const lookup = new Map<string, Role>();
  for (const [head, roles] of Object.entries(config.heads)) {
    for (const [role, ledgerName] of Object.entries(roles)) {
      lookup.set(canonicalKey(ledgerName), role);
    }
  }
  return (ledger: string): Role | undefined => lookup.get(canonicalKey(ledger));
}

const TOLERANCE = 1;
const HEAD_ORDER = ["igst", "cgst", "sgst", "cess"] as const;

function* monthIterator(months: string[]) {
  for (const m of months) {
    const year = Number(m.slice(0, 4));
    const monthIdx = Number(m.slice(5, 7)) - 1;
    const date = new Date(Date.UTC(year, monthIdx + 1, 0));
    const dateStr = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
    const monthName = date.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    const yearStr = String(year);
    yield { month: m, date: dateStr, monthName, yearStr };
  }
}

function pushEntry(
  result: GadjEntry[], kind: number, month: string, date: string, narration: string,
  legs: Array<{ dr: string; cr: string; amount: number }>,
) {
  const merged = new Map<string, { dr: string; cr: string; amount: number }>();
  for (const leg of legs) {
    const key = `${leg.dr}|${leg.cr}`;
    const existing = merged.get(key);
    if (existing) { existing.amount += leg.amount; }
    else { merged.set(key, { ...leg }); }
  }
  const finalLegs = Array.from(merged.values()).filter((l) => Math.abs(l.amount) > TOLERANCE);
  if (finalLegs.length === 0) return;
  result.push({ kind, month, date, narration, legs: finalLegs });
}

export function analyzeGstAdj(input: {
  threeB: ThreeBSummary; movements: MonthMovements; config: GstAdjConfig;
  listDiffs?: Record<string, { newly: Itc2bEntry[]; dropped: Itc2bEntry[] }>;
  knownLedgers?: Set<string>;
}): GstAdjResult {
  const { threeB, movements, config } = input;
  const knownLedgers = input.knownLedgers ?? new Set<string>();
  const result: GstAdjResult = { entries: [], findings: [], tieout: [], residual: [] };

  for (const { month, date, monthName, yearStr } of monthIterator(threeB.months)) {
    const kind1Legs: Array<{ dr: string; cr: string; amount: number }> = [];
    for (const h of HEAD_ORDER) {
      const amount = threeB.outwardTax[month]?.[h] ?? 0;
      if (amount > TOLERANCE) {
        const outputLedger = config.heads[h]?.output;
        const payableLedger = config.heads[h]?.payable;
        if (outputLedger && payableLedger) {
          kind1Legs.push({ dr: outputLedger, cr: payableLedger, amount });
          const mv = movements.get(month);
          const booksOut = mv ? -(mv.get(outputLedger) ?? 0) : 0;
          if (Math.abs(booksOut - amount) > TOLERANCE) {
            result.findings.push({
              id: "gadj_3b_ledger_mismatch", severity: "warning",
              detail: `${outputLedger}: books ${booksOut} vs 3B ${amount}`,
            });
          }
          if (booksOut > TOLERANCE) {
            result.findings.push({
              id: "gadj_3b_ledger_mismatch", severity: "review",
              detail: `${outputLedger}: books ${booksOut}`,
            });
          }
        }
      }
    }
    if (kind1Legs.length > 0) {
      pushEntry(result.entries, 1, month, date, `being output gst for the month ${monthName} ${yearStr}`, kind1Legs);
    }

    const kind2Legs: Array<{ dr: string; cr: string; amount: number }> = [];
    for (const h of HEAD_ORDER) {
      const amount = threeB.netItc[month]?.[h] ?? 0;
      if (amount > TOLERANCE) {
        const payableLedger = config.heads[h]?.payable;
        const inputLedger = config.heads[h]?.input;
        if (payableLedger && inputLedger) {
          kind2Legs.push({ dr: payableLedger, cr: inputLedger, amount });
        }
      }
    }
    if (kind2Legs.length > 0) {
      pushEntry(result.entries, 2, month, date, `being input gst for the month ${monthName} ${yearStr}`, kind2Legs);
    }

    // Kind 3: RCM attribution (no voucher, tieout only)
    for (const h of HEAD_ORDER) {
      const rcmAmount = threeB.itcRcm[month]?.[h] ?? 0;
      if (rcmAmount > TOLERANCE) {
        const kind2Amount = threeB.netItc[month]?.[h] ?? 0;
        result.tieout.push({ month, kind: 3, head: h, entry: kind2Amount, threeB: rcmAmount, note: "included in the 4C claim (kind 2)" });
        if (rcmAmount > (threeB.rcmTax[month]?.[h] ?? 0) + TOLERANCE) {
          result.findings.push({
            id: "gadj_3b_ledger_mismatch", severity: "review",
            detail: `RCM ITC without matching RCM liability for ${h}`,
          });
        }
      }
    }

    // Kind 4: 4(B)(1) reversal (ledger reclassification)
    for (const h of HEAD_ORDER) {
      const reversedAmount = threeB.itcReversed[month]?.[h] ?? 0;
      if (reversedAmount > TOLERANCE) {
        const toBeReversed = config.heads[h]?.toBeReversed;
        const inputLedger = config.heads[h]?.input;
        if (toBeReversed && inputLedger) {
          pushEntry(result.entries, 4, month, date, `being itc reversal 4(b)(1) for the month ${monthName} ${yearStr}`, [
            { dr: toBeReversed, cr: inputLedger, amount: reversedAmount },
          ]);
        }
        const kind2Amount = threeB.netItc[month]?.[h] ?? 0;
        result.tieout.push({ month, kind: 4, head: h, entry: kind2Amount, threeB: reversedAmount, note: "reversal already inside 4C (kind 2); ledger reclassification only" });
      }
    }

    // Kind 7: TDS credit from config
    const anyGstTdsCredit = Object.values(config.gstTdsCredit).some((monthMap) =>
      Object.values(monthMap).some((v) => v > 0),
    );
    const tdsSectionNote = !threeB.tdsSectionPresent && anyGstTdsCredit
      ? "; the 3B workbook carries no TDS section; figure taken from config"
      : "";
    const suppressedRoles = new Set<string>();
    for (const h of HEAD_ORDER) {
      const tdsLedger = config.heads[h]?.tds;
      if (!tdsLedger) {
        suppressedRoles.add(h);
        result.findings.push({
          id: "gadj_config_ledger_missing", severity: "warning",
          detail: `no tds ledger configured for ${h}`,
        });
      }
    }
    for (const h of HEAD_ORDER) {
      const configFigure = config.gstTdsCredit[month]?.[h];
      if (!configFigure || configFigure <= TOLERANCE) continue;
      if (suppressedRoles.has(h)) continue;
      const tdsLedger = config.heads[h]!.tds;
      const payable = config.heads[h]?.payable;
      if (payable) {
        pushEntry(result.entries, 7, month, date, `being tds credit for the month ${monthName} ${yearStr}`, [
          { dr: tdsLedger, cr: payable, amount: configFigure },
        ]);
      }
      const mv = movements.get(month);
      if (mv && mv.has(tdsLedger)) {
        const booksMovement = mv.get(tdsLedger) ?? 0;
        if (Math.abs(booksMovement) > TOLERANCE && Math.abs(booksMovement) !== Math.abs(configFigure)) {
          result.findings.push({
            id: "gadj_tds_credit_unsupported", severity: "warning",
            detail: `tds credit ${configFigure} differs from books ${Math.abs(booksMovement)}${tdsSectionNote}`,
          });
        }
      } else if (knownLedgers.has(tdsLedger)) {
        result.findings.push({
          id: "gadj_tds_credit_unsupported", severity: "review",
          detail: `tds ledger has no books movement${tdsSectionNote}`,
        });
      }
    }

    // Kinds 5/6/R: list-driven entries and residual routing
    const listDiffs = input.listDiffs;
    if (listDiffs) {
      for (const h of HEAD_ORDER) {
        const inputLedger = config.heads[h]?.input;
        const unclaimedLedger = config.heads[h]?.unclaimed;
        const toBeBooked = config.heads[h]?.toBeBooked;
        const toBeReversed = config.heads[h]?.toBeReversed;
        if (!inputLedger) continue;

        const mv = movements.get(month);
        const booksCredit = inputLedger ? -(mv?.get(inputLedger) ?? 0) : 0;

        const newlyEntries = listDiffs[month]?.newly ?? [];
        const droppedEntries = listDiffs[month]?.dropped ?? [];

        let newlySum = 0;
        for (const e of newlyEntries) newlySum += e.tax[h] ?? 0;
        let droppedSum = 0;
        for (const e of droppedEntries) droppedSum += e.tax[h] ?? 0;

        const claimed = threeB.netItc[month]?.[h] ?? 0;
        const reversed = threeB.itcReversed[month]?.[h] ?? 0;
        const residual = booksCredit - claimed - reversed - newlySum + droppedSum;

        if (newlySum > TOLERANCE) {
          if (unclaimedLedger) {
            pushEntry(result.entries, 5, month, date, `being input gst for the month ${monthName} ${yearStr}`, [
              { dr: unclaimedLedger, cr: inputLedger, amount: newlySum },
            ]);
          }
          result.tieout.push({ month, kind: 5, head: h, entry: newlySum, threeB: null, note: "newly listed in 2B" });
        }

        if (droppedSum > TOLERANCE) {
          if (inputLedger && unclaimedLedger) {
            pushEntry(result.entries, 6, month, date, `being input gst for the month ${monthName} ${yearStr}`, [
              { dr: inputLedger, cr: unclaimedLedger, amount: droppedSum },
            ]);
          }
          result.tieout.push({ month, kind: 6, head: h, entry: droppedSum, threeB: null, note: "reflected+claimed" });
        }

        if (residual > 1) {
          const routeName = config.residualMarks[month]?.[h] === "reversed" ? "toBeReversed" : "toBeBooked";
          const routeLedger = routeName === "toBeReversed" ? toBeReversed : toBeBooked;
          if (routeLedger && inputLedger) {
            pushEntry(result.entries, 8, month, date, `being input gst for the month ${monthName} ${yearStr}`, [
              { dr: routeLedger, cr: inputLedger, amount: residual },
            ]);
          }
          result.tieout.push({ month, kind: 8, head: h, entry: residual, threeB: null, note: `residual routed to ${routeName}` });
        } else if (residual < -1) {
          result.findings.push({
            id: "gadj_claim_exceeds_books", severity: "warning",
            detail: `claim exceeds books for ${h} at ${displayDate(date)}`,
          });
        }
      }
    }
  }

  // Reappearance check: dropped keys that appear in later months
  const listDiffs = input.listDiffs;
  if (listDiffs) {
    const droppedByMonth: Record<string, Set<string>> = {};
    for (const [month, diff] of Object.entries(listDiffs)) {
      const keys = new Set<string>();
      for (const e of diff.dropped) keys.add(e.key);
      droppedByMonth[month] = keys;
    }
    const months = Object.keys(droppedByMonth).sort();
    const reappeared = new Set<string>();
    for (let i = 0; i < months.length; i++) {
      for (const k of droppedByMonth[months[i]]) {
        for (let j = i + 1; j < months.length; j++) {
          if (droppedByMonth[months[j]].has(k)) {
            reappeared.add(k);
            break;
          }
        }
      }
    }
    if (reappeared.size > 0) {
      result.findings.push({
        id: "gadj_list_reappearance", severity: "review",
        detail: `reappearance: ${Array.from(reappeared).join(", ")}`,
      });
    }
  }

  return result;
}
