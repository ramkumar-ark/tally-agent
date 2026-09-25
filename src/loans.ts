import { canonicalKey } from "./key.js";

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
