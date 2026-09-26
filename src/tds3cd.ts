import type { SubsequentDeposit, TdsEvents, TdsTotals } from "./tds.js";
import { quarterOfDate } from "./tds.js";
import { calendarMonths, depositDue, interestOn, natureOf, statementDue, winmanSectionOf } from "./tds-law.js";
import { TCS_INTEREST, TCS_NATURES, tcsDepositDue } from "./tcs-law.js";
import type { TcsAnalysis } from "./tcs.js";
import type { OperatorFile } from "./tds-file.js";
import { round2 } from "./as26.js";
import { canonicalKey } from "./key.js";

export interface Tds3cdTdsRow { deductor: string; section: string; nature: string; totalPayments: number; sumLiable: number; atRateLiable: number; atRateTds: number; lowerRateLiable: number; lowerRateTds: number; notDeposited: number }
export interface Tds3cdTcsRow { collector: string; nature: string; totalReceipt: number; sumLiable: number; atRateLiable: number; atRateTcs: number; lowerRateLiable: number; lowerRateTcs: number; notDeposited: number }
export interface Tds3cdReturnRow { deductor: string; form: string; quarter: "Q1" | "Q2" | "Q3" | "Q4"; dueDate: string; filedOn: string; accurate: "Yes" | "No" }
export interface Tds3cdInterestRow { form: string; quarter: "Q1" | "Q2" | "Q3" | "Q4"; payable: number; paid?: number; paidOn?: string }

/**
 * A Winman Deduction-sheet allocation, verbatim (2026-09-26u, inbox 076): the
 * per-allocation basis for the 3CD Interest-on-TDS PAYABLE. `tax` is the row's
 * "Deducted and deposited - Tax"; `dedDate`/`depositDate` the deduction and the
 * joined challan's deposit date; `paidDate` the row's "Paid / Credited Date"
 * (s.201(1A)(i), used only when the operator's Late Deduction Interest toggle is
 * on); `interestPaid`/`challanId` feed the `paid` column.
 */
export interface Tds3cdChallanAllocation {
  section: string;
  tax: number;
  dedDate: string;
  paidDate?: string;
  depositDate: string;
  interestPaid: number;
  challanId: string;
}
export interface Tds3cdResult {
  company: string; tan: string | null;
  /** The deductor/collector name written on every 3CD TDS/TCS sheet — the
   * Winman export's Deductor name (2026-09-26r inbox 065), not the Tally
   * company name. */
  deductor: string;
  tds: Tds3cdTdsRow[]; tcs: Tds3cdTcsRow[];
  returns: Tds3cdReturnRow[];
  interestTds: Tds3cdInterestRow[]; interestTcs: Tds3cdInterestRow[];
  readonly skippedInterestQuarters: readonly string[];
}

type Quarter = "Q1" | "Q2" | "Q3" | "Q4";

const Q_ORDER: readonly Quarter[] = ["Q1", "Q2", "Q3", "Q4"];

const TDS_INTEREST_FORMS: readonly string[] = ["24Q", "26A", "26Q", "26QB", "27Q"];

export function tds3cdRows(args: {
  company: string; tan: string | null;
  /** The deductor name for the 3CD sheets (2026-09-26r, inbox 065): from the
   * Winman export's Deductor sheet, never the Tally company name. Defaults to
   * `company` for a review with no Winman file; `review.ts` requires it when
   * one is supplied. */
  deductorName?: string;
  tds: { events: TdsEvents; totals: TdsTotals };
  tcs: TcsAnalysis;
  operator: OperatorFile;
  asOnDate: string;
  /** The return's own challans (2026-09-26s, inbox 068): interest actually
   * paid per quarter is the sum of each challan's Interest cell, counted once
   * per (quarter, challan id) — independent of whether any deduction joined
   * it. Deductions alone drop challans whose allocations never landed. */
  challans?: SubsequentDeposit[];
  /** The Winman export's allocations, verbatim (2026-09-26s, inbox 068): the
   * full challan-interest source. `challans` above only holds allocations the
   * engine could tie to a party, so a challan whose deductee name is unmapped
   * would still be missing; this carries every allocation's challan id and
   * interest. When present (a Winman export is in hand) it is also the
   * per-allocation PAYABLE basis (2026-09-26u, inbox 076): late-deposit
   * 1.5% from each deduction date to its challan date past the Rule 30 due
   * date, plus the 1% late-deduction component when the operator toggle is on.
   * Values are `Tds3cdChallanAllocation`. */
  challanAllocations?: Tds3cdChallanAllocation[];
}): Tds3cdResult {
  const { company, tan, tds, tcs, operator, asOnDate } = args;
  const deductorName = args.deductorName ?? company;
  const skippedInterestQuarters: string[] = [];
  return {
    company,
    tan,
    deductor: deductorName,
    tds: tdsRows(tds.events, operator, deductorName),
    tcs: tcsRows(tcs, deductorName),
    returns: returnsRows(operator, deductorName),
    interestTds: interestTdsRows(tds.events, operator, skippedInterestQuarters, args.challans ?? [], args.challanAllocations ?? []),
    interestTcs: interestTcsRows(tcs, operator, asOnDate),
    skippedInterestQuarters,
  };
}

function tcsThresholdOf(nature: string): number {
  return TCS_NATURES.find((n) => n.key === nature)?.threshold ?? 0;
}

function tcsWinmanOf(nature: string): string {
  return TCS_NATURES.find((n) => n.key === nature)?.winman ?? (nature === "unknown" ? "unknown" : nature);
}

function tdsRows(events: TdsEvents, operator: OperatorFile, company: string): Tds3cdTdsRow[] {
  const bySection = new Map<string, { gross: number; liable: number; atL: number; atT: number; loL: number; loT: number; dedTax: number }>();
  for (const b of events.bookings) {
    if (b.section === null || winmanSectionOf(b.section) === null) continue;
    const agg = bySection.get(b.section) ?? { gross: 0, liable: 0, atL: 0, atT: 0, loL: 0, loT: 0, dedTax: 0 };
    agg.gross += b.gross;
    const liable = b.liable ?? 0;
    agg.liable += liable;
    if (b.viaCertificate) agg.loL += liable; else agg.atL += liable;
    bySection.set(b.section, agg);
  }

  const certHeld = (party: string, section: string, date: string): boolean =>
    operator.certificates.some(
      (c) => canonicalKey(c.ledger) === canonicalKey(party) && c.section === section && c.from <= date && date <= c.to,
    );

  for (const d of events.deductions) {
    if (winmanSectionOf(d.section) === null) continue;
    const agg = bySection.get(d.section);
    if (!agg) continue;
    const lower = d.joinedTo !== null && d.booking !== undefined && d.booking.voucherNumber === d.joinedTo && d.booking.section === d.section
      ? d.booking.viaCertificate === true
      : certHeld(d.party, d.section, d.date);
    if (lower) agg.loT += d.tax; else agg.atT += d.tax;
    // A month-level deposit-covered credit (2026-09-26e) is deposited for the
    // statement too — it must not swell the not-deposited column. Same for a
    // subsequent-year challan-covered credit (2026-09-26i): deposited, just
    // after the FY end — its lateness interest rides the interest rows.
    if (d.depositCovered || d.subsequentDeposit) continue;
    agg.dedTax += d.tax;
  }

  const depBySection = new Map<string, number>();
  for (const dep of events.deposits) {
    // A null section (an ambiguous duty ledger's row) belongs to no Winman
    // section — the statement never guesses either.
    if (dep.section === null || winmanSectionOf(dep.section) === null) continue;
    depBySection.set(dep.section, (depBySection.get(dep.section) ?? 0) + dep.tax);
  }

  return [...bySection.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([lawKey, agg]) => ({
      deductor: company,
      section: winmanSectionOf(lawKey) as string,
      nature: natureOf(lawKey),
      totalPayments: round2(agg.gross),
      sumLiable: round2(agg.liable),
      atRateLiable: round2(agg.atL),
      atRateTds: round2(agg.atT),
      lowerRateLiable: round2(agg.loL),
      lowerRateTds: round2(agg.loT),
      notDeposited: round2(Math.max(0, round2(agg.dedTax) - round2(depBySection.get(lawKey) ?? 0))),
    }));
}

function tcsRows(analysis: TcsAnalysis, company: string): Tds3cdTcsRow[] {
  const emit = new Map<string, { gross: number; tax: number }>();
  for (const bn of analysis.totals.byNature) {
    if (bn.tax > 0 || bn.gross > 0) emit.set(bn.nature, { gross: bn.gross, tax: bn.tax });
  }
  for (const c of analysis.collections) {
    if (!emit.has(c.nature)) emit.set(c.nature, { gross: 0, tax: 0 });
  }

  const liableByNature = new Map<string, number>();
  for (const c of analysis.collections) {
    const threshold = tcsThresholdOf(c.nature);
    const base = threshold === 0 ? c.gross : Math.max(0, c.gross - threshold);
    liableByNature.set(c.nature, (liableByNature.get(c.nature) ?? 0) + base);
  }

  const depByNature = new Map<string, number>();
  const naturesByParty = new Map<string, string[]>();
  for (const c of analysis.collections) {
    const key = canonicalKey(c.party);
    const natures = naturesByParty.get(key) ?? [];
    if (!natures.includes(c.nature)) natures.push(c.nature);
    naturesByParty.set(key, natures);
  }
  for (const d of analysis.deposits) {
    const natures = naturesByParty.get(canonicalKey(d.party)) ?? [];
    let left = d.tax;
    const share = natures.length === 0 ? 0 : round2(left / natures.length);
    for (let i = 0; i < natures.length && left > 0; i += 1) {
      const take = i === natures.length - 1 ? left : share;
      depByNature.set(natures[i], (depByNature.get(natures[i]) ?? 0) + take);
      left = round2(left - take);
    }
  }

  return [...emit.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([nature, bn]) => {
      const sumLiable = round2(liableByNature.get(nature) ?? 0);
      return {
        collector: company,
        nature: tcsWinmanOf(nature),
        totalReceipt: round2(bn.gross),
        sumLiable,
        atRateLiable: sumLiable,
        atRateTcs: round2(bn.tax),
        lowerRateLiable: 0,
        lowerRateTcs: 0,
        notDeposited: round2(Math.max(0, round2(bn.tax) - round2(depByNature.get(nature) ?? 0))),
      };
    });
}

function returnsRows(operator: OperatorFile, company: string): Tds3cdReturnRow[] {
  return (operator.statements ?? []).map((st) => ({
    deductor: company,
    form: st.form,
    quarter: st.quarter,
    dueDate: statementDue(st.quarter, "FY 25-26"),
    filedOn: st.filedDate,
    accurate: st.returnAccurate ?? "Yes",
  }));
}

/** Per-entry interest stays exact (rate x months x tax, 2 dp); only the
 * per-quarter totals on the 3CD Interest sheets are rounded to the rupee
 * (captain, 2026-09-26r, inbox 064). */
function roundToRupee(n: number): number {
  return Math.round(n);
}

function paidOf(operator: OperatorFile, form: string, quarter: Quarter): { paid?: number; paidOn?: string } {
  const rec = (operator.interestPaid ?? []).find((r) => r.form === form && r.quarter === quarter);
  if (!rec) return {};
  return { paid: rec.amount, paidOn: rec.paidOn };
}

function interestTdsRows(
  events: TdsEvents,
  operator: OperatorFile,
  skipped: string[],
  challans: SubsequentDeposit[],
  challanAllocations: Tds3cdChallanAllocation[],
): Tds3cdInterestRow[] {
  const winmanPresent = challanAllocations.length > 0;
  const byQuarter = new Map<Quarter, number>();
  // Interest actually paid per quarter = the sum of every challan's own
  // Interest cell, counted exactly once per (quarter, challan id). This reads
  // the return's challans DIRECTLY (2026-09-26s, inbox 068): building it from
  // `events.deductions` dropped any challan whose allocations never joined a
  // deduction (or joined one with no computed interest), so paid ran short of
  // the Challan sheet. The Winman `ID No.` restarts each quarter, so the key
  // is quarter-scoped; a challan with no id falls back to its deposit date.
  const paidByQuarter = new Map<Quarter, { amount: number; paidOn: string }>();
  const seenChallans = new Set<string>();
  const addChallan = (dedDate: string, depositDate: string, interestPaid: number, challanId: string): void => {
    if (!interestPaid || interestPaid <= 0) return;
    // The interest belongs to the quarter of the DEDUCTION it covers, not the
    // deposit date (a Q4 deduction paid in Sep-next-quarter keeps Q4).
    const q = quarterOfDate(dedDate);
    const key = `${q}|${challanId || depositDate}`;
    if (seenChallans.has(key)) return;
    seenChallans.add(key);
    const prev = paidByQuarter.get(q);
    paidByQuarter.set(q, {
      amount: round2((prev?.amount ?? 0) + interestPaid),
      paidOn: prev?.paidOn && prev.paidOn > depositDate ? prev.paidOn : depositDate,
    });
  };
  // Allocations first: every Winman allocation carries its challan's id and
  // interest, so the full Challan-sheet total is reachable even when a
  // deductee name is unmapped. `challans` (party-tied) is the fallback for a
  // review with no Winman file.
  for (const a of challanAllocations) addChallan(a.dedDate, a.depositDate, a.interestPaid, a.challanId);
  for (const c of challans) addChallan(c.dedDate, c.depositDate, c.interestPaid ?? 0, c.challanId ?? "");
  if (winmanPresent) {
    // Payable basis with a Winman export in hand (2026-09-26u, inbox 076): the
    // department's own per-allocation statutory computation, NOT the books'
    // book-remittance join — the return shows the tax reached the government at
    // the quarter's challan even when a book remittance fell inside the Rule 30
    // window. Late deposit: 1.5% x calendar months from the deduction date to
    // the challan deposit date, only when the challan date is past the Rule 30
    // due date. Late deduction: 1% x months from the Paid/Credited date to the
    // deduction date, only when the operator's toggle is on. Exact per
    // allocation; the quarter total is rupee-rounded at emission.
    for (const a of challanAllocations) {
      if (!/^\d{8}$/.test(a.dedDate) || !/^\d{8}$/.test(a.depositDate)) continue;
      const q = quarterOfDate(a.dedDate);
      let amt = 0;
      if (a.depositDate > depositDue(a.dedDate)) {
        amt += interestOn(0.015, calendarMonths(a.dedDate, a.depositDate), a.tax);
      }
      if (
        operator.lateDeductionInterest &&
        typeof a.paidDate === "string" &&
        /^\d{8}$/.test(a.paidDate) &&
        a.paidDate < a.dedDate
      ) {
        amt += interestOn(0.01, calendarMonths(a.paidDate, a.dedDate), a.tax);
      }
      if (amt !== 0) byQuarter.set(q, round2((byQuarter.get(q) ?? 0) + amt));
    }
  } else {
    for (const d of events.deductions) {
      const amt = round2((d.interestI ?? 0) + (d.interestII ?? 0));
      if (amt <= 0) continue;
      const q = quarterOfDate(d.date);
      byQuarter.set(q, round2((byQuarter.get(q) ?? 0) + amt));
    }
  }
  const rows: Tds3cdInterestRow[] = [];
  for (const q of Q_ORDER) {
    const payable = byQuarter.get(q);
    const challanPaid = paidByQuarter.get(q);
    // Without a Winman file the row exists only where a book finding stamped
    // interest; with one, a quarter the return covered also gets a row (its
    // payable may be zero).
    if (winmanPresent ? payable === undefined && challanPaid === undefined : payable === undefined) continue;
    const form = operator.statements.find((s) => s.quarter === q)?.form;
    if (!form || !(TDS_INTEREST_FORMS as readonly string[]).includes(form)) {
      skipped.push(`${q}:${form ?? ""}`);
      continue;
    }
    const paidRec = challanPaid ? { paid: roundToRupee(challanPaid.amount), paidOn: challanPaid.paidOn } : paidOf(operator, form, q);
    rows.push({
      form,
      quarter: q,
      payable: roundToRupee(payable ?? 0),
      ...(paidRec.paid !== undefined ? { paid: roundToRupee(paidRec.paid) } : {}),
      ...(paidRec.paidOn ? { paidOn: paidRec.paidOn } : {}),
    });
  }
  return rows;
}

function interestTcsRows(analysis: TcsAnalysis, operator: OperatorFile, asOnDate: string): Tds3cdInterestRow[] {
  if (analysis.collections.length === 0) return [];
  const poolByParty = new Map<string, { date: string; tax: number }[]>();
  for (const d of analysis.deposits) {
    const key = canonicalKey(d.party);
    poolByParty.set(key, [...(poolByParty.get(key) ?? []), { date: d.date, tax: d.tax }]);
  }
  for (const pool of poolByParty.values()) pool.sort((a, b) => a.date.localeCompare(b.date));

  const byQuarter = new Map<Quarter, number>();
  for (const c of [...analysis.collections].sort((a, b) => a.date.localeCompare(b.date))) {
    const q = quarterOfDate(c.date);
    const due = tcsDepositDue(c.date);
    const pool = poolByParty.get(canonicalKey(c.party)) ?? [];
    let left = c.tax;
    for (const dep of pool) {
      if (left <= 0) break;
      if (dep.tax <= 0) continue;
      const take = Math.min(dep.tax, left);
      dep.tax = round2(dep.tax - take);
      const months = calendarMonths(due, dep.date);
      if (months > 0) {
        const interest = interestOn(TCS_INTEREST.lateDeposit, months, take);
        byQuarter.set(q, round2((byQuarter.get(q) ?? 0) + interest));
      }
      left = round2(left - take);
    }
    if (left > 0) {
      const months = calendarMonths(due, asOnDate);
      if (months > 0) {
        const interest = interestOn(TCS_INTEREST.lateDeposit, months, left);
        byQuarter.set(q, round2((byQuarter.get(q) ?? 0) + interest));
      }
    }
  }

  const paidRows = (operator.interestPaid ?? []).filter((r) => r.form === "27EQ");
  const rows: Tds3cdInterestRow[] = [];
  for (const q of Q_ORDER) {
    const payable = byQuarter.get(q);
    const paidRow = paidRows.find((r) => r.quarter === q);
    if (payable === undefined && !paidRow) continue;
    if (payable === undefined && paidRow) {
      rows.push({ form: "27EQ", quarter: q, payable: 0, ...paidOf(operator, "27EQ", q) });
      continue;
    }
    if ((payable ?? 0) <= 0 && !paidRow) continue;
    const paidRec = paidOf(operator, "27EQ", q);
    rows.push({
      form: "27EQ",
      quarter: q,
      payable: roundToRupee(payable ?? 0),
      ...(paidRec.paid !== undefined ? { paid: roundToRupee(paidRec.paid) } : {}),
      ...(paidRec.paidOn ? { paidOn: paidRec.paidOn } : {}),
    });
  }
  return rows;
}
