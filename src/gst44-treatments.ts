// src/gst44-treatments.ts
import { readFile } from "node:fs/promises";

/**
 * The operator-extensible treatment vocabulary for the GST nature-wise
 * break-up working sheet (captain's Q-B answer, 2026-09-26c): a ledger's
 * treatment is seeded by GENERIC keyword/pattern rules over its name — never
 * by an enumerated list of exact ledger names — combined with prior-year,
 * party-GSTIN and ledger-group evidence upstream of this module. Every
 * seeded row records WHICH rule seeded it; a ledger matching no rule stays
 * blank and raises a review finding instead of a guess.
 *
 * `policy` rules carve whole outflows out of the GST break-up (the J column:
 * not supply on revenue, paid to govt on capital). `evidence` rules read
 * registration off the name itself (URD markers, GST rate suffixes).
 */

export type WorksheetTreatment = "not_supply" | "exempt" | "composition" | "others" | "unregistered";

export interface TreatmentRule {
  /** Stable id quoted in the seed reason and the Vocabulary sheet. */
  id: string;
  kind: "policy" | "evidence";
  treatment: WorksheetTreatment;
  /** Word-boundary keyword alternatives over the ledger name, case-insensitive. */
  keywords?: string[];
  /** A raw regex source tested against the ledger name (case-insensitive). */
  pattern?: string;
  /**
   * Restrict the rule to one sheet: a fixed-asset acquisition whose NAME
   * carries a fuel/electricity word ("Petrol Vibrator", "Diesel Generator")
   * is equipment bought from a registered dealer, not an exempt supply — the
   * fuel/electricity exempt rules therefore scope to the revenue sheet.
   */
  scope?: "revenue" | "capital";
  note: string;
}

/**
 * The built-in vocabulary. A GST rate suffix rule fires per its own pattern:
 * 0% seeds exempt (named zero-rate supplies), any other rate seeds others.
 * The zero-rate rule is listed first so it wins within the pattern chain.
 */
export const GST44_TREATMENT_RULES: readonly TreatmentRule[] = [
  { id: "taxes", kind: "policy", treatment: "not_supply", keywords: ["tax"], note: "taxes and statutory outflows (Rates & Taxes, Income Tax, Professional Tax)" },
  { id: "depreciation", kind: "policy", treatment: "not_supply", keywords: ["depreciation"], note: "book depreciation is not a supply" },
  { id: "payroll", kind: "policy", treatment: "not_supply", keywords: ["salary", "salaries", "wages", "bonus", "remuneration", "stipend"], note: "payroll: salary, wages, bonus, partner remuneration" },
  { id: "provident", kind: "policy", treatment: "not_supply", keywords: ["epf", "provident fund", "esi", "employees state insurance", "gratuity", "gratuities"], note: "statutory social-security contributions" },
  { id: "interest-capital", kind: "policy", treatment: "not_supply", keywords: ["interest on capital"], note: "interest on partners' capital" },
  { id: "donation", kind: "policy", treatment: "not_supply", keywords: ["donation"], note: "donations are not a supply" },
  { id: "penalty", kind: "policy", treatment: "not_supply", keywords: ["penalty", "penalties", "fine", "fines"], note: "penalties and fines are not a supply" },
  { id: "round-off", kind: "policy", treatment: "not_supply", keywords: ["round off", "rounded off"], note: "rounding differences" },
  { id: "loss-sale", kind: "policy", treatment: "not_supply", keywords: ["loss on sale"], note: "loss on sale of assets is not a supply" },
  { id: "bad-debts", kind: "policy", treatment: "not_supply", keywords: ["bad debt", "bad debts"], note: "bad debts written off are not expenditure on any supply" },
  // Interest/late fee ON taxes or duties is a statutory outflow, not a supply
  // (captain's addendum 2026-09-26d). It must precede the bank/NBFC
  // loan-interest rule, so "Interest on GST A/c" reads not_supply while
  // "Interest on Bank Loan A/c" reads exempt. Registered first in the chain.
  { id: "interest-tax", kind: "policy", treatment: "not_supply", keywords: ["interest on tax", "interest on duty", "late fee on tax", "late fee on duty", "interest on gst", "interest on tds", "interest on income tax", "interest on professional tax", "late fee on gst", "late fee on tds"], note: "interest or late fee on taxes/duties is not a supply" },
  { id: "urd", kind: "evidence", treatment: "unregistered", keywords: ["urd", "unregistered"], note: "the name itself declares an unregistered dealer" },
  // Banks and NBFCs are mandated to register, so their charges are always
  // registered purchases (others) — never exempt, never unregistered. As
  // evidence rules these override party-GSTIN pots that would park any part
  // in H (evidence beats party in the seed chain).
  { id: "bank-charges", kind: "evidence", treatment: "others", keywords: ["bank charge", "loan charge", "loan processing charge", "processing charge", "bank commission", "forex charge", "exchange charge", "cheque charge", "collection charge", "annual maintenance charge"], note: "bank/NBFC charges come from mandated registered dealers — others, never exempt or unregistered" },
  { id: "electricity", kind: "evidence", treatment: "exempt", scope: "revenue", keywords: ["electricity", "eb charge", "eb bill"], note: "electricity/EB charges are exempt supplies (expense ledgers only — a fixed-asset 'Petrol Vibrator'/'Diesel Generator' is equipment, not an exempt supply)" },
  { id: "fuel", kind: "evidence", treatment: "exempt", scope: "revenue", keywords: ["fuel", "diesel", "petrol", "hsd"], note: "fuel expenses are always exempt (registered dealers)" },
  { id: "insurance", kind: "evidence", treatment: "others", keywords: ["insurance"], note: "insurance ledgers are registered purchases — including Ineligible ITC ones, which are NOT exempt" },
  { id: "loan-interest", kind: "evidence", treatment: "exempt", keywords: ["interest on bank", "interest on loan", "interest on non bank", "interest on od", "interest on cc", "bank interest", "nbfc interest", "loan interest", "vehicle loan", "equipment loan", "finance charge", "finance cost"], note: "interest on bank/NBFC loans is an exempt financial service" },
  { id: "rate-zero", kind: "evidence", treatment: "exempt", pattern: String.raw`(?:^|[\s\-@])0+(?:\.0+)?\s*%`, note: "explicit 0% rate suffix: zero-rated supply" },
  { id: "rate-gst", kind: "evidence", treatment: "others", pattern: String.raw`(?:^|[\s\-@])\d+(?:\.\d+)?\s*%`, note: "explicit GST rate suffix: registered purchase with tax" },
];

/** \b-anchored, plural-tolerant keyword matcher, compiled once per rule. */
function keywordRegex(keyword: string): RegExp {
  const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}(?:s|es|ies)?\\b`, "i");
}

export interface TreatmentHit {
  rule: TreatmentRule;
  treatment: WorksheetTreatment;
}

const compiled = new WeakMap<TreatmentRule, { words: RegExp[]; pattern: RegExp | null }>();

function compiledOf(rule: TreatmentRule): { words: RegExp[]; pattern: RegExp | null } {
  let c = compiled.get(rule);
  if (!c) {
    c = {
      words: (rule.keywords ?? []).map(keywordRegex),
      pattern: rule.pattern ? new RegExp(rule.pattern, "i") : null,
    };
    compiled.set(rule, c);
  }
  return c;
}

function firstHit(rules: readonly TreatmentRule[], name: string): TreatmentHit | null {
  for (const rule of rules) {
    const c = compiledOf(rule);
    if (c.words.some((re) => re.test(name)) || (c.pattern && c.pattern.test(name))) {
      return { rule, treatment: rule.treatment };
    }
  }
  return null;
}

/** Chain step 1: the first POLICY rule that matches (operator rules first). */
export function policyMatch(name: string, rules: readonly TreatmentRule[]): TreatmentHit | null {
  return firstHit(rules.filter((r) => r.kind === "policy"), name);
}

/** Chain step 3: the first EVIDENCE keyword rule that matches. */
export function evidenceMatch(name: string, rules: readonly TreatmentRule[]): TreatmentHit | null {
  return firstHit(rules.filter((r) => r.kind === "evidence" && r.keywords), name);
}

/** Chain step 5: the first EVIDENCE pattern rule that matches. */
export function patternMatch(name: string, rules: readonly TreatmentRule[]): TreatmentHit | null {
  return firstHit(rules.filter((r) => r.kind === "evidence" && r.pattern), name);
}

/**
 * Operator rules from a JSON file: { "rules": [ {id, kind, treatment,
 * keywords?/pattern?, note} ] }. A missing file is normal (optional channel):
 * the built-ins stand alone. A malformed file throws citing the rule's index
 * in the array — never a value from the file.
 */
export async function loadGst44TreatmentRules(
  path: string | undefined,
  warn: (message: string) => void,
): Promise<TreatmentRule[]> {
  if (!path) return [...GST44_TREATMENT_RULES];
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    warn(`treatment rules file not readable at ${path}: the built-in vocabulary stands alone`);
    return [...GST44_TREATMENT_RULES];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the treatment rules file is not valid JSON; fix it and pass the path again");
  }
  const list = (parsed as { rules?: unknown })?.rules;
  if (!Array.isArray(list)) {
    throw new Error("the treatment rules file must be an object with a `rules` array");
  }
  const out: TreatmentRule[] = [];
  list.forEach((r, i) => {
    const at = `rule ${i + 1}`;
    if (!r || typeof r !== "object") throw new Error(`treatment rules file: ${at} is not an object`);
    const rec = r as Record<string, unknown>;
    const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : null;
    if (!id) throw new Error(`treatment rules file: ${at} has no id`);
    const kind = rec.kind === "policy" || rec.kind === "evidence" ? rec.kind : null;
    if (!kind) throw new Error(`treatment rules file: ${at} must carry kind "policy" or "evidence"`);
    const treatment = rec.treatment;
    if (treatment !== "not_supply" && treatment !== "exempt" && treatment !== "composition" && treatment !== "others" && treatment !== "unregistered") {
      throw new Error(
        `treatment rules file: ${at} carries treatment "${String(treatment)}"; expected not_supply, exempt, composition, others or unregistered`,
      );
    }
    const keywords = Array.isArray(rec.keywords) ? rec.keywords.map((k) => String(k)) : undefined;
    const pattern = typeof rec.pattern === "string" ? rec.pattern : undefined;
    if (!keywords?.length && !pattern) {
      throw new Error(`treatment rules file: ${at} must carry a non-empty keywords array or a pattern`);
    }
    if (keywords?.length && pattern) {
      throw new Error(`treatment rules file: ${at} carries both keywords and a pattern; give one`);
    }
    const scope = rec.scope === "revenue" || rec.scope === "capital" ? rec.scope : undefined;
    out.push({
      id,
      kind,
      treatment,
      ...(keywords?.length ? { keywords } : {}),
      ...(pattern ? { pattern } : {}),
      ...(scope ? { scope } : {}),
      note: typeof rec.note === "string" && rec.note.trim() ? rec.note.trim() : `operator rule ${id}`,
    });
  });
  // Operator rules precede their built-in siblings within each kind, so an
  // operator rule can special-case what a built-in would have caught.
  const operatorPolicy = out.filter((r) => r.kind === "policy");
  const operatorEvidence = out.filter((r) => r.kind === "evidence");
  return [
    ...operatorPolicy,
    ...GST44_TREATMENT_RULES.filter((r) => r.kind === "policy"),
    ...operatorEvidence,
    ...GST44_TREATMENT_RULES.filter((r) => r.kind === "evidence"),
  ];
}
