import { displayDate, money } from "../format.js";
import { canonicalKey } from "../key.js";
import {
  findingId,
  sideOf,
  type Check,
  type Finding,
  type GroupNature,
  type NameSignal,
  type Side,
} from "../types.js";
import { natureOfPrimary, signalOf, tokens, vocabulary } from "./nameSignal.js";

/** The side a balance sheet group's ledgers normally carry. Capital has none: no P&L-named ledger belongs there on either side. */
const NORMAL_SIDE: Partial<Record<GroupNature, Side>> = { asset: "Dr", liability: "Cr" };

/** The side an expense or income ledger naturally carries. */
const NATURAL_SIDE: Partial<Record<NameSignal, Side>> = { expense: "Dr", income: "Cr" };

/** A sub-group named like this holds the proprietor's personal spending on purpose. */
const DRAWINGS_GROUP_WORDS: ReadonlySet<string> = new Set(["drawing", "drawings", "personal"]);

/**
 * Generic on purpose: the detail must never quote a word of the ledger's name,
 * because a masked ledger's name is replaced as a whole string and a quoted
 * fragment would survive the swap.
 */
const PHRASE: Record<NameSignal, string> = {
  expense: "an expense ledger",
  income: "an income ledger",
  party: "a party (debtor or creditor) ledger",
  bank: "a bank ledger",
  capital: "a capital or drawings ledger",
  loan: "a loan ledger",
};

function properPlace(signal: NameSignal, side: Side): { where: string; nature: GroupNature } {
  switch (signal) {
    case "expense":
      return { where: "Direct Expenses, Indirect Expenses or Purchase Accounts", nature: "expense" };
    case "income":
      return { where: "Sales Accounts, Direct Incomes or Indirect Incomes", nature: "income" };
    case "party":
      return side === "Dr"
        ? { where: "Sundry Debtors", nature: "asset" }
        : { where: "Sundry Creditors", nature: "liability" };
    case "bank":
      return side === "Dr"
        ? { where: "Bank Accounts", nature: "asset" }
        : { where: "Bank OD A/c", nature: "liability" };
    case "capital":
      return { where: "Capital Account", nature: "capital" };
    case "loan":
      return side === "Dr"
        ? { where: "Loans & Advances (Asset)", nature: "asset" }
        : { where: "Loans (Liability)", nature: "liability" };
  }
}

const isProfitAndLoss = (nature: GroupNature): boolean => nature === "income" || nature === "expense";

/**
 * True when the name and the group contradict each other across the two statements.
 *
 * - A balance sheet identity (party, bank, capital, loan) under an income or
 *   expense group: always.
 * - An expense or income name under a balance sheet group: only when the
 *   balance sits on the name's natural side AND on the side the group does not
 *   normally carry. So "Rent" Dr under Current Assets (reads as prepaid rent)
 *   and "Salary" Cr under Sundry Creditors (reads as salary payable) stay
 *   silent, while "Salary" Dr under Sundry Creditors fires. Capital Account has
 *   no normal side for this purpose, so its natural-side rows always fire —
 *   except inside a Drawings-style sub-group, where personal spending belongs.
 * - Income under expense or the reverse is presentation only, and not reported.
 */
function misplaced(signal: NameSignal, nature: GroupNature, side: Side, belowRoot: string[]): boolean {
  const natural = NATURAL_SIDE[signal];
  if (!natural) return isProfitAndLoss(nature);
  if (isProfitAndLoss(nature) || side !== natural || NORMAL_SIDE[nature] === side) return false;
  return !belowRoot.some((g) => tokens(g).some((t) => DRAWINGS_GROUP_WORDS.has(t)));
}

export const ledgerInWrongGroup: Check = (input) => {
  const vocab = vocabulary(input.wrongGroup.keywords);
  const ignored = new Set(input.wrongGroup.ignoreLedgers.map(canonicalKey));
  const out: Finding[] = [];
  let n = 0;
  for (const row of input.rows) {
    const side = sideOf(row.balance);
    if (!side || ignored.has(canonicalKey(row.name))) continue;
    const chain = input.ancestryOf(row.parent);
    const rootAt = chain.findIndex((g) => input.isPrimaryGroup(g));
    if (rootAt < 0) continue;
    const root = chain[rootAt];
    const nature = natureOfPrimary(root);
    const signal = signalOf(row.name, vocab);
    if (!nature || !signal || !misplaced(signal, nature, side, chain.slice(0, rootAt))) continue;

    n += 1;
    const amount = Math.abs(row.balance);
    const proper = properPlace(signal, side);
    const consequence = isProfitAndLoss(nature)
      ? "its balance runs through the profit and loss account"
      : "it is kept out of the profit and loss account";
    // Personal spending parked in Capital Account belongs in a Drawings sub-group, which this check exempts.
    const personal =
      nature === "capital" && signal === "expense"
        ? ", or under a Drawings sub-group of Capital Account if it is an owner's personal spending"
        : "";
    out.push({
      id: findingId("ledger_in_wrong_group", n),
      check: "ledger_in_wrong_group",
      severity: "warning",
      ledger: row.name,
      group: row.parent,
      amount,
      side,
      expected: proper.nature,
      detail:
        `${row.name} reads as ${PHRASE[signal]} but is grouped under ${root}, ` +
        `with a ${side} balance of ${money(amount)} as of ${displayDate(input.asOnDate)}; ` +
        `as placed, ${consequence}. Move it under ${proper.where}${personal}. ` +
        `If the placement is deliberate, list it in wrongGroup.ignoreLedgers in config/overrides.json`,
    });
  }
  return out;
};
