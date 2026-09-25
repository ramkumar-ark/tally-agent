import { canonicalKey } from "./key.js";
import { findingId, type CheckId, type Finding } from "./types.js";
import { displayDate, money } from "./format.js";
import {
  DEFAULT_BANK_MODE,
  LOANS_LIMIT,
  NARRATION_MODE_HINTS,
  S269ST_LIMIT,
  type NonAcMode,
  type ReceiptMode,
} from "./loans-law.js";
import { count as moneyCount } from "./format.js";

/**
 * The books side of the loan review (clause 31 / 269SS-T-ST tasks): discover
 * loan ledgers from the masters and extract acceptance / repayment events out
 * of the day book. Part 1 of Task 2: `buildLoansCtx` + `loanLedgerEvents`.
 *
 * Voucher amounts follow the project sign convention: positive = debit
 * (R-MCP-5). So a loan-ledger DEBIT is a repayment and a CREDIT is an
 * acceptance — mirrored from pf-esi.ts's credit-side logic, never re-flipped.
 */

/**
 * Minimal local voucher shape (pf-esi.ts holds its own; additive here).
 * `date`/`voucherNumber` can arrive as JSON numbers — coerced with String().
 */
export interface V {
  date?: string | number;
  voucherNumber?: string | number;
  voucherType?: string;
  narration?: string;
  entries: Array<string | null | undefined | { ledger: string; amount: number }>;
  isCancelled?: boolean;
}

export type ModeClass = "cash" | "bank" | "journal";

export interface LoanEvent {
  date: string;
  party: string;
  direction: "accepted" | "repaid";
  amount: number;
  mode: ModeClass;
  narration: string;
  voucherNumber?: string;
}

export interface LoansBooksCtx {
  parentOf: (ledger: string) => string | undefined;
  chainOf: (ledgerOrGroup: string) => string[];
  isLoanLedger: (ledger: string) => boolean;
  isBankLedger: (ledger: string) => boolean;
  isCashLedger: (ledger: string) => boolean;
}

/**
 * Tally's internal "root of primaries" node (see src/classify.ts): the parent
 * field of a real primary group is not empty — it is U+0004 followed by
 * " Primary". Treated as a root terminator exactly like an empty parent.
 */
const ROOT_OF_PRIMARIES = " Primary";

const LOANS_GROUP = "loans (liability)";
const BANK_GROUP = "bank accounts";
const CURRENT_ASSETS = "current assets";
const CASH_GROUP = /^cash/i;

const isRootEnd = (parent: string | undefined): boolean =>
  !parent || parent === ROOT_OF_PRIMARIES;

/**
 * Build the ancestry predicates from ledger-master pairs (`[{name,parent}]`,
 * ledger masters) and group rows (same shape). Cash-in-Hand and Bank Accounts
 * are GROUPS under Current Assets — mode inference is ancestry membership,
 * never root equality. All lookups are canonical (case-insensitive, whitespace
 * collapsed); the walk terminates on `\u0004 Primary`/empty parent.
 */
export function buildLoansCtx(
  masters: { name: string; parent: string }[],
  groups: { name: string; parent: string }[],
): LoansBooksCtx {
  const parentOf = new Map<string, string>();
  for (const g of groups) parentOf.set(canonicalKey(g.name), g.parent);
  for (const m of masters) parentOf.set(canonicalKey(m.name), m.parent);

  function rawParent(name: string): string | undefined {
    return parentOf.get(canonicalKey(name));
  }

  /** Ancestor names, self excluded; cycle-safe; terminates on root end. */
  function chainOf(ledgerOrGroup: string): string[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    let parent = rawParent(ledgerOrGroup);
    while (parent !== undefined && !isRootEnd(parent) && !seen.has(canonicalKey(parent))) {
      seen.add(canonicalKey(parent));
      chain.push(parent);
      parent = rawParent(parent);
    }
    return chain;
  }

  function isLoanLedger(ledger: string): boolean {
    return chainOf(ledger).some((n) => canonicalKey(n) === LOANS_GROUP);
  }

  function isBankLedger(ledger: string): boolean {
    return chainOf(ledger).some((n) => canonicalKey(n) === BANK_GROUP);
  }

  /** A cash group matches /^Cash/i AND sits in a Current Assets ancestry. */
  function isCashLedger(ledger: string): boolean {
    const chain = chainOf(ledger);
    return (
      chain.some((n) => CASH_GROUP.test(n)) &&
      chain.some((n) => canonicalKey(n) === CURRENT_ASSETS)
    );
  }

  return { parentOf: rawParent, chainOf, isLoanLedger, isBankLedger, isCashLedger };
}

/** Filter a voucher's entries into the real, numeric, non-blank ones. */
function realEntries(v: V): Array<{ ledger: string; amount: number }> {
  const entries = v.entries;
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (e): e is { ledger: string; amount: number } =>
      !!e &&
      typeof e === "object" &&
      typeof (e as { ledger?: unknown }).ledger === "string" &&
      typeof (e as { amount?: unknown }).amount === "number",
  );
}

/**
 * Walk the day book for loan-ledger debits (repayments) and credits
 * (acceptances). Mode comes from the OTHER entries of the same voucher:
 * any cash-ancestry counter ⇒ "cash" (cash wins even when a bank counter is
 * also present — conservative for the breach side); else any bank-ancestry
 * counter ⇒ "bank"; else "journal". Non-loan ledgers and cash↔bank contra
 * vouchers (no loan ledger in the voucher) emit nothing.
 */
export function loanLedgerEvents(vouchers: V[], ctx: LoansBooksCtx): LoanEvent[] {
  const events: LoanEvent[] = [];

  for (const v of vouchers) {
    if (!v || v.isCancelled) continue;
    const entries = realEntries(v);
    if (entries.length === 0) continue;
    const date = String(v.date ?? "");
    const voucherNumber = String(v.voucherNumber ?? "");
    const narration = String(v.narration ?? "");

    for (const entry of entries) {
      if (!ctx.isLoanLedger(entry.ledger)) continue;
      const others = entries.filter((e) => e !== entry);
      let mode: ModeClass = "journal";
      if (others.some((e) => ctx.isCashLedger(e.ledger))) mode = "cash";
      else if (others.some((e) => ctx.isBankLedger(e.ledger))) mode = "bank";

      events.push({
        date,
        party: entry.ledger,
        direction: entry.amount > 0 ? "repaid" : "accepted",
        amount: Math.abs(entry.amount),
        mode,
        narration,
        voucherNumber,
      });
    }
  }

  return events;
}

/**
 * Part 2 of the loans engine (clause-31 worksheet rows + 269SS/T findings):
 * bucket the per-ledger events, compute movement-only running balances (C7)
 * from a 0 opening, and emit rows in the Winman clause-31 sheet families plus
 * the breach and honesty findings. Rules of record: task-3 brief, rules 1-9.
 */

export interface LoansOperatorParty {
  ledger: string;
  panOrAadhaar?: string;
  address?: string;
  /** C6: government / banking company / statutory corporation counterparty. */
  exempt?: boolean;
  modeOverrideAccepted?: ReceiptMode | "Cash-breach-declared";
  modeOverrideRepaid?: ReceiptMode | "Cash-breach-declared";
}

export interface LoansOperator {
  /** Keyed by canonical ledger name (case/whitespace insensitive). */
  parties: LoansOperatorParty[];
  /** C4: F-token for bank-mode movements whose narration carries no hint. */
  defaultBankMode?: ReceiptMode;
  /** C2/Task 5: sheet-2 rows are operator-only; the books never invent figures. */
  specifiedSums?: LoansSheetRow[];
  /**
   * Task 5: sheet-7 rows (bearer cheque/DD character) are operator-only too;
   * the books never invent one. Absent ⇒ no sheet-7 rows.
   */
  st26Declarations?: LoansSheetRow[];
}

/** Degrades a session wiring with no operator file (missing-file warn upstream). */
export const EMPTY_LOANS_OPERATOR: LoansOperator = { parties: [] };

export interface LoansSheetRow {
  /** Real ledger name (raw cache); masked copy for the model. */
  party: string;
  /** Vault alias, never the raw PAN. Two channels ride this field:
   * - books rows (buildLoansRows): the party's operator PAN/Aadhaar is
   *   vaulted (`vault.pseudonym(.., "tax_id")`) at buildLoansRows time and
   *   the value carried here from then on is the pseudonym;
   * - template rows (parseLoansTemplate -> LoansTemplateParsed.specifiedSums,
   *   Task 6 wiring): the field TEMPORARILY carries the raw OPERATOR value
   *   straight from the operator file — Session.loansReview MUST vault it
   *   (`vault.pseudonym(.., "tax_id")`) before any row reaches the model.
   *   The privacy contract is not waived by the transient raw value. */
  panAlias?: string;
  /** FY aggregate for the (party, direction, mode-class) bucket. */
  amount: number;
  /** Movement-only: closing balance ~0 means Yes (C7 caveat). */
  squaredUp?: "Yes" | "No";
  /** Movement-only running peak (C7 advisory). */
  maxAmount?: number;
  /** F column. */
  mode?: ReceiptMode;
  /** G column ("Cash" for the cash class). */
  nonAcMode?: NonAcMode;
  address?: string;
  /** 269ST sheets only. */
  type?: "Payments" | "Receipts";
  date?: string;
  nature?: string;
  /** 269ST sheet 7 only: operator-declared bearer cheque/DD character. */
  bearer?: "Y" | "";
}

export interface LoansBooksResult {
  sheet1: LoansSheetRow[];
  sheet2: LoansSheetRow[];
  sheet3: LoansSheetRow[];
  sheet4: LoansSheetRow[];
  sheet5: LoansSheetRow[];
  sheet6: LoansSheetRow[];
  sheet7: LoansSheetRow[];
  findings: Finding[];
}

const ZERO = 0.005;

/**
 * s.269SS/T apply when the amount EXCEEDS twenty thousand rupees — strictly
 * greater (captain ruling 2026-09-25; exactly 20,000 is not a breach; two
 * 19,999s are still caught by the running balance > 20,000 test). Strictly
 * greater stays correct even if a shared helper ever meets 269ST, whose
 * statute ("Rs 2,00,000 or more") is >= and stays ≥ in its owner task.
 */
const crossedTest = (orderedByDate: LoanEvent[]): boolean => {
  let balance = 0;
  for (const x of orderedByDate) {
    if (x.amount > LOANS_LIMIT) return true;
    balance += x.direction === "accepted" ? x.amount : -x.amount;
    if (balance > LOANS_LIMIT + ZERO) return true;
  }
  return false;
};

type LoansDirection = LoanEvent["direction"];

interface Bucket {
  party: string;
  direction: LoansDirection;
  modeClass: ModeClass;
  amount: number;
  /** Largest single event in this bucket — a bucket can breach on its own
   * single event even when its aggregate stays below LOANS_LIMIT (two
   * crossings of the same counterparty annul nothing; s.271D/E attach to the
   * event). */
  maxEvent: number;
  earliest: string;
  narrations: string[];
}

const NARRATION_HINT = (narrations: string[]): ReceiptMode | undefined => {
  for (const hint of NARRATION_MODE_HINTS) {
    if (narrations.some((n) => hint.re.test(n))) return hint.mode;
  }
  return undefined;
};

const overrideFor = (
  op: LoansOperatorParty | undefined,
  d: LoansDirection,
): ReceiptMode | "Cash-breach-declared" | undefined =>
  d === "accepted" ? op?.modeOverrideAccepted : op?.modeOverrideRepaid;

/**
 * Build the clause-31 sheet rows and 269SS/269T findings. Movement stats
 * (maxAmount / squaredUp) are per party over both directions from a 0
 * opening; `opts.mastersPresent === false` means the opening balance is
 * unknowable offline (C7) — the run is still computed, but a
 * `loans_max_amount_estimated` advisory fires once per party with movement.
 * Sheets 6/7 belong to Task 4's `scan269St` and come out empty here.
 */
export function buildLoansRows(
  events: LoanEvent[],
  operator: LoansOperator,
  opts: { mastersPresent: boolean },
): LoansBooksResult {
  const opByCanonical = new Map<string, LoansOperatorParty>();
  for (const p of operator.parties) opByCanonical.set(canonicalKey(p.ledger), p);

  const byParty = new Map<string, LoanEvent[]>();
  for (const e of events) {
    const key = canonicalKey(e.party);
    const list = byParty.get(key) ?? [];
    list.push(e);
    byParty.set(key, list);
  }

  interface PartyStat {
    party: string;
    maxAmount: number;
    squaredUp: boolean;
    crossed: boolean;
    journalAmount: number;
  }
  const stats = new Map<string, PartyStat>();
  for (const [key, list] of byParty) {
    const ordered = [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let balance = 0;
    let peak = 0;
    let journalAmount = 0;
    for (const x of ordered) {
      balance += x.direction === "accepted" ? x.amount : -x.amount;
      peak = Math.max(peak, balance, 0);
      if (x.mode === "journal") journalAmount += x.amount;
    }
    stats.set(key, {
      party: list[0]?.party ?? key,
      maxAmount: peak,
      squaredUp: Math.abs(balance) < ZERO,
      crossed: crossedTest(ordered),
      journalAmount,
    });
  }

  // Buckets per (canonical party, direction, modeClass).
  const buckets = new Map<string, Bucket>();
  const splitBy = new Map<string, { party: string; date: string; direction: LoansDirection; count: number; total: number }>();
  for (const e of events) {
    const key = canonicalKey(e.party);
    const bKey = `${key}|${e.direction}|${e.mode}`;
    const bucket = buckets.get(bKey) ?? {
      party: e.party,
      direction: e.direction,
      modeClass: e.mode,
      amount: 0,
      maxEvent: 0,
      earliest: e.date,
      narrations: [],
    };
    bucket.amount += e.amount;
    bucket.maxEvent = Math.max(bucket.maxEvent, e.amount);
    if (e.date < bucket.earliest) bucket.earliest = e.date;
    if (e.narration) bucket.narrations.push(e.narration);
    buckets.set(bKey, bucket);

    const sKey = `${key}|${e.date}|${e.direction}`;
    const s = splitBy.get(sKey) ?? { party: e.party, date: e.date, direction: e.direction, count: 0, total: 0 };
    s.count += 1;
    s.total += e.amount;
    splitBy.set(sKey, s);
  }

  const findings: Finding[] = [];
  const ordinal = new Map<string, number>();
  const nextId = (check: CheckId) => {
    ordinal.set(check, (ordinal.get(check) ?? 0) + 1);
    return findingId(check, ordinal.get(check)!);
  };
  const finding = (
    check: CheckId,
    severity: Finding["severity"],
    party: string,
    amount: number,
    detail: string,
  ): Finding => ({
    id: nextId(check),
    check,
    severity,
    ledger: party,
    group: "",
    amount,
    side: null,
    expected: null,
    detail,
  });

  const res: LoansBooksResult = {
    sheet1: [],
    sheet2: [...(operator.specifiedSums ?? [])],
    sheet3: [],
    sheet4: [],
    sheet5: [],
    sheet6: [],
    sheet7: [],
    findings,
  };

  for (const [, bucket] of buckets) {
    const key = canonicalKey(bucket.party);
    const stat = stats.get(key)!;
    const op = opByCanonical.get(key);
    if (op?.exempt && !overrideFor(op, bucket.direction)) continue;

    const ov = overrideFor(op, bucket.direction);
    const declared = ov === "Cash-breach-declared";
    let mode: ReceiptMode | undefined;
    if (ov && ov !== "Cash-breach-declared") mode = ov;
    else mode = undefined as ReceiptMode | undefined;
    if (!mode) {
      const cashTreatment = bucket.modeClass === "cash" || declared;
      if (!cashTreatment) {
        if (bucket.modeClass === "bank") {
          mode = NARRATION_HINT(bucket.narrations) ?? operator.defaultBankMode ?? DEFAULT_BANK_MODE;
        }
        // else: journal-class, no override — advisory per party, no row (below).
      } else {
        mode = "Non-A/c payee modes";
      }
    }
    if (!mode && !declared) {
      // C3: journal-class, no operator override — advisory per party, no row.
      if (!res.findings.some(
        (f) => f.check === "loans_mode_unknown" && canonicalKey(f.ledger) === key,
      )) {
        res.findings.push(finding(
          "loans_mode_unknown",
          "review",
          bucket.party,
          stat.journalAmount,
          `Loan movement of ${money(stat.journalAmount)} for ${bucket.party} has no cash or bank ` +
            `counter; the receipt/repayment mode is not determinable from the books and waits on ` +
            `the operator mapping (journal entry assumed, never auto-breach).`,
        ));
      }
      continue;
    }
    if (!stat.crossed) continue;

    const cashTreatmentFinal = mode === "Non-A/c payee modes";
    const row: LoansSheetRow = {
      party: bucket.party,
      amount: bucket.amount,
      squaredUp: stat.squaredUp ? "Yes" : "No",
      maxAmount: stat.maxAmount,
      mode,
      ...(cashTreatmentFinal ? { nonAcMode: "Cash" as NonAcMode } : {}),
      ...(op?.panOrAadhaar ? { panAlias: op.panOrAadhaar } : {}),
      ...(op?.address ? { address: op.address } : {}),
    };
    const sheet = bucket.direction === "accepted" ? res.sheet1 : res.sheet3;
    sheet.push(row);

    if (!cashTreatmentFinal || op?.exempt) continue;

    // Reviewer fix: a critical s.269SS/T breach is claimed only when THIS
    // bucket crossed the limit on its own (aggregate > LOANS_LIMIT, or a
    // single event > LOANS_LIMIT such as a side-country aggregate's
    // participation). A sub-limit cash bucket that crosses only through the
    // party's overall running balance keeps its non-a/c-payee SHEET row (the
    // row speaks) but does not claim a breach it did not make — the simpler
    // honest rule, stated in the fix report.
    const breachCheck: CheckId =
      bucket.direction === "accepted" ? "loans_cash_acceptance" : "loans_cash_repayment";
    // C5: sheet 4 receives rows ONLY from a Cash-breach-declared repayment
    // (declaration rows are reporting, independent of the 20k threshold).
    if (bucket.direction === "repaid" && ov === "Cash-breach-declared") res.sheet4.push(row);

    // Reviewer fix: a critical s.269SS/T breach is claimed only when THIS
    // bucket crossed the limit on its own (aggregate > LOANS_LIMIT, or a
    // single event > LOANS_LIMIT). A sub-limit cash bucket that crosses only
    // through the party's overall running balance keeps its non-a/c-payee
    // SHEET row (the row speaks) but does not claim a breach it did not make
    // — the simpler honest rule, stated in the fix report.
    const bucketOwnCross = bucket.amount > LOANS_LIMIT || bucket.maxEvent > LOANS_LIMIT;
    if (!bucketOwnCross) continue;

    const breachDetail =
      bucket.direction === "accepted"
        ? `Cash acceptance from ${bucket.party} of ${money(bucket.amount)} on ` +
          `${displayDate(bucket.earliest)} breaches s.269SS (account-payee cheque/DD/ECS or bank ` +
          `credit required; penalty exposure s.271D).`
        : `Cash repayment to ${bucket.party} of ${money(bucket.amount)} on ` +
          `${displayDate(bucket.earliest)} breaches s.269T (account-payee cheque/DD/ECS required; ` +
          `penalty exposure s.271E).`;
    res.findings.push(finding(breachCheck, "critical", bucket.party, bucket.amount, breachDetail));
  }

  // C5-sheet4 declarations sorted with their sheets; finders all sort below.
  const byAmount = (a: LoansSheetRow, b: LoansSheetRow) =>
    b.amount - a.amount || (a.party < b.party ? -1 : a.party > b.party ? 1 : 0);
  for (const sheet of [res.sheet1, res.sheet3, res.sheet4]) sheet.sort(byAmount);

  if (!opts.mastersPresent) {
    for (const [key, stat] of stats) {
      const op = opByCanonical.get(key);
      if (op?.exempt) continue;
      res.findings.push(finding(
        "loans_max_amount_estimated",
        "review",
        stat.party,
        stat.maxAmount,
        `Opening balance unavailable, so the peak running amount of ${money(stat.maxAmount)} for ` +
          `${stat.party} is computed from movements only (0 opening assumed); MAXAMOUNT is an ` +
          `estimate and SQUAREDUP ("Yes" = closing movement zero) may be imprecise.`,
      ));
    }
  }

  const splitByPartyDate = new Set<string>();
  for (const [, s] of [...splitBy].sort()) {
    if (s.count < 2) continue;
    const key = canonicalKey(s.party);
    const op = opByCanonical.get(key);
    if (op?.exempt) continue;
    if (splitByPartyDate.has(`${key}|${s.date}|${s.direction}`)) continue;
    splitByPartyDate.add(`${key}|${s.date}|${s.direction}`);
    res.findings.push(finding(
      "loans_splitting_suspect",
      "review",
      s.party,
      s.total,
      `${moneyCount(s.count)} same-direction loan events for ${s.party} on ${displayDate(s.date)} ` +
        `aggregate ${money(s.total)} — possible splitting under the 269SS/T/ST thresholds; the ` +
        `sheet amounts are the honest bucket aggregates and were not changed.`,
    ));
  }

  return res;
}

/**
 * Part 3 of the loans engine — the s.269ST register (sheets 6/7) and the
 * `loans_269st_receipt` / `loans_269st_payment` findings.
 *
 * Candidate rule (voucher-level): a voucher carrying a cash-ancestry leg whose
 * external counter amount (the magnitudes of non-cash non-bank entries on the
 * OPPOSITE side — cash↔bank contra and cash↔cash transfers cancel to zero and
 * are excluded) reaches the limit is a candidate. WHICH cash side is a receipt
 * follows money flow, not the brief's rule-1 parenthetical, which contradicts
 * the same brief's rule 6 (a cash loan ACCEPTANCE — the day-book voucher
 * Dr Cash / Cr LoanLedger — "is also a 269ST receipt"): money coming in is a
 * cash-ancestry DEBIT under positive = debit (R-MCP-5), so
 *
 *   cash-ancestry DEBIT (amount > 0) + external counter credited => Receipts
 *   cash-ancestry CREDIT (amount < 0) + external counter debited => Payments
 *
 * Receipts => `loans_269st_receipt` CRITICAL (s.271DA exposure); payments =>
 * `loans_269st_payment` WARNING (269ST penalises receipts only — reporting).
 * The limit is "Rs 2,00,000 or more": >= S269ST_LIMIT, never the clause-31
 * strict-> helper.
 *
 * Same-day same-party same-TYPE aggregation (rule 3): ALL voucher-level
 * externals are summed per (canonical party, day, type) — including vouchers
 * individually below the limit — and one row/finding fires for a group whose
 * sum reaches the limit. A same-day pair of sub-limit vouchers therefore still
 * reports, as one aggregated row citing the aggregate.
 *
 * Sheet 7 (bearer cheque/DD, C5) carries rows ONLY from operator declarations
 * (`st26Declarations`, Task 5).
 *
 * `priorCashEvents` (optional 4th param; Task 6 wires it): the Task-3
 * loanLedgerEvents output (or its cash subset). When a group's party+date
 * matches a prior CASH-mode event of the matching direction (accepted =>
 * Receipts / repaid => Payments), the finding detail carries a dedupe note —
 * the event is also a 269ST receipt/payment and both scans run independently.
 */
export function scan269St(
  vouchers: V[],
  ctx: LoansBooksCtx,
  operator: LoansOperator,
  priorCashEvents?: LoanEvent[],
): { sheet6: LoansSheetRow[]; sheet7: LoansSheetRow[]; findings: Finding[] } {
  const findings: Finding[] = [];
  let ordinal = 0;
  const nextId = (check: CheckId): string => {
    ordinal += 1;
    return findingId(check, ordinal);
  };
  const finding = (
    check: CheckId,
    severity: Finding["severity"],
    party: string,
    amount: number,
    detail: string,
  ): Finding => ({
    id: nextId(check),
    check,
    severity,
    ledger: party,
    group: "",
    amount,
    side: null,
    expected: null,
    detail,
  });

  interface Group {
    party: string;
    date: string;
    type: "Receipts" | "Payments";
    total: number;
    voucherCount: number;
    narration: string;
  }
  const groups = new Map<string, Group>();

  for (const v of vouchers) {
    if (!v || v.isCancelled) continue;
    const entries = realEntries(v);
    if (entries.length === 0) continue;
    const date = String(v.date ?? "");
    const narration = String(v.narration ?? "");

    for (const dir of [
      { cashSide: 1, type: "Receipts" as const },
      { cashSide: -1, type: "Payments" as const },
    ]) {
      // The cash-ancestry leg must itself be on the candidate side.
      const cashLegs = entries.filter(
        (e) =>
          ctx.isCashLedger(e.ledger) &&
          (dir.cashSide === 1 ? e.amount > 0 : e.amount < 0),
      );
      if (cashLegs.length === 0) continue;

      // External counter: real, non-cash, non-bank entries on the OPPOSITE
      // side. Contra legs (cash/bank on the opposite side) contribute nothing
      // and a voucher without any external counter yields 0 — excluded.
      const externals = entries.filter(
        (e) =>
          !ctx.isCashLedger(e.ledger) &&
          !ctx.isBankLedger(e.ledger) &&
          (dir.cashSide === 1 ? e.amount < 0 : e.amount > 0),
      );
      const external = externals.reduce((s, e) => s + Math.abs(e.amount), 0);
      if (externals.length === 0 || external <= 0) continue;

      // Party = the external counter ledger (original case); the largest leg
      // names the counter when a voucher has more than one.
      const party = externals.reduce((a, b) =>
        Math.abs(b.amount) > Math.abs(a.amount) ? b : a,
      ).ledger;

      const key = `${canonicalKey(party)}|${date}|${dir.type}`;
      const group = groups.get(key) ?? {
        party,
        date,
        type: dir.type,
        total: 0,
        voucherCount: 0,
        narration: "",
      };
      group.total += external;
      group.voucherCount += 1;
      if (!group.narration && narration) group.narration = narration;
      groups.set(key, group);
    }
  }

  const cashByPartyDate = (
    party: string,
    date: string,
    direction: "accepted" | "repaid",
  ): boolean =>
    (priorCashEvents ?? []).some(
      (p) =>
        p.mode === "cash" &&
        p.direction === direction &&
        canonicalKey(p.party) === canonicalKey(party) &&
        String(p.date) === date,
    );

  const sheet6: LoansSheetRow[] = [];
  for (const g of groups.values()) {
    if (g.total < S269ST_LIMIT - ZERO) continue;

    sheet6.push({
      party: g.party,
      amount: g.total,
      type: g.type,
      date: g.date,
      ...(g.narration ? { nature: g.narration } : {}),
    });

    const isReceipt = g.type === "Receipts";
    const dedupe = cashByPartyDate(g.party, g.date, isReceipt ? "accepted" : "repaid")
      ? ` The same party and date appear as a cash loan event already reported under s.269SS/T; the two scans run independently and are not duplicate findings.`
      : "";
    const detail = isReceipt
      ? `${g.voucherCount > 1 ? `Same-day aggregate of ${moneyCount(g.voucherCount)} cash receipts` : "Cash receipt"} of ${money(g.total)} from ${g.party} on ${displayDate(g.date)} reaches s.269ST ("Rs 2,00,000 or more" in respect of a loan); receiving it otherwise than through an account-payee cheque/DD/electronic channel is penalised s.271DA.${dedupe}`
      : `${g.voucherCount > 1 ? `Same-day aggregate of ${moneyCount(g.voucherCount)} cash payments` : "Cash payment"} of ${money(g.total)} to ${g.party} on ${displayDate(g.date)} crosses the s.269ST register threshold; s.269ST (penalty s.271DA) reaches receipts, so this row is reporting-only with no receipt-penalty exposure.${dedupe}`;

    findings.push(
      finding(
        isReceipt ? "loans_269st_receipt" : "loans_269st_payment",
        isReceipt ? "critical" : "warning",
        g.party,
        g.total,
        detail,
      ),
    );
  }

  const byAmount = (a: LoansSheetRow, b: LoansSheetRow) =>
    b.amount - a.amount || (a.party < b.party ? -1 : a.party > b.party ? 1 : 0);
  sheet6.sort(byAmount);

  return {
    sheet6,
    sheet7: [...(operator.st26Declarations ?? [])],
    findings,
  };
}
