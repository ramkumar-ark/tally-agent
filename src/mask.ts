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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive, whitespace-variant-tolerant matcher for one real name:
 * any run of whitespace in the name matches any run of whitespace in the
 * target text, so "Acme Traders" also matches "Acme\r\nTraders" or
 * "Acme  Traders".
 */
function namePattern(real: string): RegExp {
  const collapsed = real.trim().replace(/\s+/g, " ");
  const escaped = escapeRegExp(collapsed).replace(/ /g, "\\s+");
  return new RegExp(escaped, "gi");
}

/**
 * Replaces any occurrence of an already-vaulted real name inside free text
 * (narration, reference, and similar fields the gateway does not otherwise
 * inspect field-by-field) with its pseudonym. Longest real name first, so a
 * shorter party's name is not matched as a substring of a longer one. Only
 * catches names the vault already knows — see the design doc's stated
 * limitation on detecting a name never otherwise masked.
 */
export function maskKnownNames(text: string, v: Vault): string {
  const entries = v.entries().sort((a, b) => b.real.length - a.real.length);
  let out = text;
  for (const { real, alias } of entries) {
    if (!real.trim()) continue;
    out = out.replace(namePattern(real), alias);
  }
  return out;
}
