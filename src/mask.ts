import type { Classifier } from "./classify.js";
import type { Finding } from "./types.js";
import type { Vault } from "./vault.js";

const DIGIT_RUN = /\d{6,}/g;

/**
 * GSTIN shape: 2-digit state code, 10-char PAN, entity code, 'Z'-position
 * char, checksum — 15 alphanumeric chars. PAN shape: 5 letters, 4 digits,
 * 1 letter. Neither contains a 6-digit run, so scrubDigits provably misses
 * both (canon R-P-9 / §5.7). No word boundaries: a tax ID glued to other
 * text ("GSTIN27AAAAA0000A1Z5") must still be caught. Over-redaction of an
 * innocent PAN-shaped token is the accepted failure direction — the same
 * fail-safe philosophy as default-mask. GSTIN is redacted before PAN so a
 * GSTIN's embedded PAN cannot leave a half-eaten token.
 */
const GSTIN_SHAPE = /\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]{3}/gi;
const PAN_SHAPE = /[A-Z]{5}\d{4}[A-Z]/gi;

export function scrubDigits(text: string): string {
  return text.replace(DIGIT_RUN, "[number]");
}

export function redactTaxIds(text: string): string {
  return text.replace(GSTIN_SHAPE, "[tax-id]").replace(PAN_SHAPE, "[tax-id]");
}

/**
 * The single scrubbing composition for every outbound string, masked or
 * clear: tax-ID shapes first (their digits must not be mangled into a
 * different shape first), then digit runs.
 */
export function scrubSecrets(text: string): string {
  return scrubDigits(redactTaxIds(text));
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
  return scrubSecrets(ledger);
}

export function maskFinding(f: Finding, c: Classifier, v: Vault): Finding {
  // Fleet-wide findings such as out_of_balance carry no ledger; masking an
  // empty name would mint a pseudonym for nothing. The detail still gets the
  // known-name sweep — it is outbound free text like any other.
  if (!f.ledger) {
    return { ...f, detail: scrubSecrets(maskKnownNames(f.detail, v)) };
  }
  const ledger = maskLedgerName(f.ledger, f.group, c, v);
  const detail = scrubSecrets(
    maskKnownNames(replaceAll(f.detail, f.ledger, ledger), v),
  );
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
