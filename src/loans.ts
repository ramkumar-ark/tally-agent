import { canonicalKey } from "./key.js";
import { findingId, type CheckId, type Finding } from "./types.js";
import { displayDate, money } from "./format.js";
import {
  DEFAULT_BANK_MODE,
  LOANS_LIMIT,
  NARRATION_MODE_HINTS,
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
}

/** Degrades a session wiring with no operator file (missing-file warn upstream). */
export const EMPTY_LOANS_OPERATOR: LoansOperator = { parties: [] };

export interface LoansSheetRow {
  /** Real ledger name (raw cache); masked copy for the model. */
  party: string;
  /** Vault alias, never the raw PAN. */
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
 * s.269SS/T uses "of Rs. 20,000 or more", so the crossing test is >= 20,000
 * (single event) or a running balance strictly above 20,000 (mirrors the
 * 269SS outstanding test), never the brief's literal `>` typo.
 */
const crossedTest = (orderedByDate: LoanEvent[]): boolean => {
  let balance = 0;
  for (const x of orderedByDate) {
    if (x.amount >= LOANS_LIMIT) return true;
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
      earliest: e.date,
      narrations: [],
    };
    bucket.amount += e.amount;
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
          "warning",
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
    const breachCheck: CheckId =
      bucket.direction === "accepted" ? "loans_cash_acceptance" : "loans_cash_repayment";
    const breachDetail =
      bucket.direction === "accepted"
        ? `Cash acceptance from ${bucket.party} of ${money(bucket.amount)} on ` +
          `${displayDate(bucket.earliest)} breaches s.269SS (account-payee cheque/DD/ECS or bank ` +
          `credit required; penalty exposure s.271D).`
        : `Cash repayment to ${bucket.party} of ${money(bucket.amount)} on ` +
          `${displayDate(bucket.earliest)} breaches s.269T (account-payee cheque/DD/ECS required; ` +
          `penalty exposure s.271E).`;
    res.findings.push(finding(breachCheck, "critical", bucket.party, bucket.amount, breachDetail));

    // C5: sheet 4 receives rows ONLY from a Cash-breach-declared repayment.
    if (bucket.direction === "repaid" && ov === "Cash-breach-declared") res.sheet4.push(row);
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
        "warning",
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
      "warning",
      s.party,
      s.total,
      `${moneyCount(s.count)} same-direction loan events for ${s.party} on ${displayDate(s.date)} ` +
        `aggregate ${money(s.total)} — possible splitting under the 269SS/T/ST thresholds; the ` +
        `sheet amounts are the honest bucket aggregates and were not changed.`,
    ));
  }

  return res;
}
