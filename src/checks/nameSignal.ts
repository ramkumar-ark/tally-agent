import { canonicalKey } from "../key.js";
import type { GroupNature, NameSignal, WrongGroupConfig } from "../types.js";

/**
 * Single words that say what a ledger is. Matched against whole tokens of the
 * ledger name, never substrings, so "rent" never matches "current". The lists
 * are disjoint from each other and from NEUTRAL_WORDS; the tests hold them to it.
 */
export const SIGNAL_WORDS: Record<NameSignal, readonly string[]> = {
  expense: [
    "expense", "expenses", "exp", "expenditure", "salary", "salaries", "wages", "bonus",
    "remuneration", "rent", "electricity", "medical", "insurance", "travelling", "traveling",
    "travel", "conveyance", "repairs", "repair", "maintenance", "printing", "stationery",
    "postage", "courier", "telephone", "mobile", "internet", "fuel", "petrol", "diesel",
    "advertisement", "advertising", "entertainment", "welfare", "purchase", "purchases",
  ],
  income: ["sales", "sale", "income", "revenue", "turnover"],
  party: [
    "traders", "trader", "enterprises", "enterprise", "industries", "agencies", "agency",
    "associates", "corporation", "ltd", "limited", "pvt", "llp", "co", "sons", "brothers",
    "suppliers", "supplier", "distributors", "distributor",
  ],
  bank: ["bank", "od", "overdraft"],
  capital: ["capital", "drawings", "proprietor"],
  loan: ["loan", "loans", "borrowing", "borrowings"],
};

/**
 * Words that make a name mean something else: "salary payable" is a liability,
 * "bank charges" an expense, "capital gains" an income. Any one of them in a
 * name vetoes every signal, so the check stays silent rather than guess.
 */
export const NEUTRAL_WORDS: readonly string[] = [
  "payable", "payables", "receivable", "receivables", "advance", "advances", "prepaid",
  "deposit", "deposits", "provision", "provisions", "outstanding", "accrued", "due", "dues",
  "reserve", "reserves", "deferred", "refund", "recoverable", "security", "retention",
  "unbilled", "tax", "taxes", "gst", "cgst", "sgst", "igst", "utgst", "cess", "tds", "tcs",
  "vat", "duty", "duties", "interest", "charges", "commission", "discount", "fee", "fees",
  "received", "gain", "gains", "profit", "loss", "written", "goods", "return", "returns",
  "rounding",
];

export interface Vocabulary {
  words: ReadonlyMap<string, NameSignal>;
  neutral: ReadonlySet<string>;
}

/**
 * The built-in words plus the operator's (config/overrides.json "wrongGroup.keywords").
 * Operator words go in after every built-in word, so they win any clash: an operator
 * signal word stops being neutral, and an operator neutral word stops being a signal.
 */
export function vocabulary(extra: WrongGroupConfig["keywords"] = {}): Vocabulary {
  const signals = Object.keys(SIGNAL_WORDS) as NameSignal[];
  const words = new Map<string, NameSignal>();
  const neutral = new Set<string>(NEUTRAL_WORDS);
  for (const signal of signals) {
    for (const w of SIGNAL_WORDS[signal]) words.set(w, signal);
  }
  for (const signal of signals) {
    for (const w of extra[signal] ?? []) {
      words.set(canonicalKey(w), signal);
      neutral.delete(canonicalKey(w));
    }
  }
  for (const w of extra.neutral ?? []) {
    neutral.add(canonicalKey(w));
    words.delete(canonicalKey(w));
  }
  return { words, neutral };
}

/** "  Medical\r\nExp. A/c" -> ["medical", "exp", "a", "c"]. A name in a script other than Latin yields no tokens. */
export function tokens(text: string): string[] {
  return canonicalKey(text).split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

const PROFIT_AND_LOSS: ReadonlySet<NameSignal> = new Set(["expense", "income"]);

/** The more specific balance sheet reading wins: "zeta bank car loan" is a loan, "zeta bank ltd" a bank. */
const BALANCE_SHEET_PRECEDENCE: readonly NameSignal[] = ["loan", "bank", "capital", "party"];

/**
 * What a ledger's name says it is, or null when the name says nothing or says
 * two contradictory things ("rent - nimbus enterprises", "sales expenses").
 */
export function signalOf(name: string, vocab: Vocabulary): NameSignal | null {
  const found = new Set<NameSignal>();
  for (const t of tokens(name)) {
    if (vocab.neutral.has(t)) return null;
    const signal = vocab.words.get(t);
    if (signal) found.add(signal);
  }
  const profitAndLoss = [...found].filter((s) => PROFIT_AND_LOSS.has(s));
  const balanceSheet = BALANCE_SHEET_PRECEDENCE.filter((s) => found.has(s));
  if (profitAndLoss.length > 0 && balanceSheet.length > 0) return null;
  if (profitAndLoss.length > 1) return null;
  return profitAndLoss[0] ?? balanceSheet[0] ?? null;
}

/**
 * What each Tally primary group makes its ledgers. Suspense A/c and
 * Branch / Divisions are absent on purpose: they say nothing about a ledger's nature.
 */
const NATURE_BY_PRIMARY = new Map<string, GroupNature>(
  (
    [
      ["Capital Account", "capital"],
      ["Loans (Liability)", "liability"],
      ["Current Liabilities", "liability"],
      ["Fixed Assets", "asset"],
      ["Investments", "asset"],
      ["Current Assets", "asset"],
      ["Misc. Expenses (ASSET)", "asset"],
      ["Sales Accounts", "income"],
      ["Direct Incomes", "income"],
      ["Indirect Incomes", "income"],
      ["Purchase Accounts", "expense"],
      ["Direct Expenses", "expense"],
      ["Indirect Expenses", "expense"],
    ] as const
  ).map(([group, nature]) => [canonicalKey(group), nature]),
);

export function natureOfPrimary(group: string): GroupNature | null {
  return NATURE_BY_PRIMARY.get(canonicalKey(group)) ?? null;
}
