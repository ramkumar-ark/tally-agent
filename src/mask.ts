import type { Classifier } from "./classify.js";
import type { Finding } from "./types.js";
import type { Vault } from "./vault.js";

const DIGIT_RUN = /\d{6,}/g;

export function scrubDigits(text: string): string {
  return text.replace(DIGIT_RUN, "[number]");
}

export function maskLedgerName(
  ledger: string,
  group: string,
  c: Classifier,
  v: Vault,
): string {
  if (c.ledgerPolicy(ledger, group) === "mask") {
    return v.pseudonym(ledger, c.role(group));
  }
  return scrubDigits(ledger);
}

export function maskFinding(f: Finding, c: Classifier, v: Vault): Finding {
  // Fleet-wide findings such as out_of_balance carry no ledger; masking an
  // empty name would mint a pseudonym for nothing.
  if (!f.ledger) return { ...f, detail: scrubDigits(f.detail) };
  const ledger = maskLedgerName(f.ledger, f.group, c, v);
  const detail = scrubDigits(replaceAll(f.detail, f.ledger, ledger));
  return { ...f, ledger, detail };
}

function replaceAll(haystack: string, needle: string, replacement: string): string {
  if (!needle) return haystack;
  return haystack.split(needle).join(replacement);
}

export function demaskText(text: string, v: Vault): string {
  // Longest alias first, so "Creditor 12" is not matched by "Creditor 1".
  const entries = v
    .entries()
    .sort((a, b) => b.alias.length - a.alias.length);
  let out = text;
  for (const { alias, real } of entries) {
    out = replaceAll(out, alias, real);
  }
  return out;
}
