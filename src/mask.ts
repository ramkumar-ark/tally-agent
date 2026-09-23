import type { Classifier } from "./classify.js";
import { canonicalKey } from "./key.js";
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
    maskKnownNames(replaceWholeToken(f.detail, f.ledger, ledger), v),
  );
  return { ...f, ledger, detail };
}

/**
 * Substitutes a real value only where it is a whole token. A real value can
 * be a bare short string such as "1" (a 26AS schedule row label or sale
 * voucher reference vaulted under the doc role), and a plain substring
 * replace then mangles every digit 1 inside money figures and dates:
 * "1,40,011.00" becomes the pseudonym in three places and "01-Apr-2025"
 * loses its "1". See {@link wholeTokenPattern}'s boundary guards.
 */
function replaceWholeToken(haystack: string, needle: string, replacement: string): string {
  if (!needle.trim()) return haystack;
  const re = new RegExp(
    wholeTokenPattern(escapeRegExp(needle), isNumericValue(needle)),
    "gi",
  );
  return haystack.replace(re, () => replacement);
}

export function demaskText(text: string, v: Vault): string {
  // Longest alias first, so "Creditor 12" is not matched by "Creditor 1".
  const entries = v
    .entries()
    .sort((a, b) => b.alias.length - a.alias.length);
  let out = text;
  for (const { alias, real } of entries) {
    if (!alias.trim()) continue;
    const re = new RegExp(wholeTokenPattern(escapeRegExp(alias), false), "g");
    out = out.replace(re, () => real);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A match is a whole token when it is not flanked by a word character. A
 * purely numeric value gets a stricter guard: it must also not be flanked by
 * a numeric connector (".", ",", "/", ":", "-") that is itself attached to a
 * word character. That keeps a short numeric value ("1") from matching inside
 * "1,40,011.00", "1.5" or a date's year ("01-Apr-2025"), while an alphabetic
 * name still matches inside a hyphenated reference ("Inv-Acme Traders-2201")
 * and a token that merely ends a sentence ("ref 1.") or sits in brackets
 * ("(1)") is still a whole token.
 */
const WORD_LEFT = "(?<!\\w)";
const WORD_RIGHT = "(?!\\w)";
const NUMERIC_LEFT = "(?<!\\w)(?<!\\w[.,/:\\-])";
const NUMERIC_RIGHT = "(?!\\w)(?![.,/:\\-]\\w)";

function wholeTokenPattern(core: string, numeric: boolean): string {
  return numeric
    ? `${NUMERIC_LEFT}(?:${core})${NUMERIC_RIGHT}`
    : `${WORD_LEFT}(?:${core})${WORD_RIGHT}`;
}

const isNumericValue = (s: string): boolean => /^\d+$/.test(s.trim());

/**
 * Case-insensitive, whitespace-variant-tolerant matcher source for one real
 * name: any run of whitespace in the name matches any run of whitespace in
 * the target text, so "Acme Traders" also matches "Acme\r\nTraders" or
 * "Acme  Traders".
 */
function namePatternSource(real: string): string {
  const collapsed = real.trim().replace(/\s+/g, " ");
  return escapeRegExp(collapsed).replace(/ /g, "\\s+");
}

/**
 * Replaces any occurrence of an already-vaulted real name inside free text
 * (narration, reference, and similar fields the gateway does not otherwise
 * inspect field-by-field) with its pseudonym. Longest real name first, so a
 * shorter party's name is not matched as a substring of a longer one.
 *
 * Vault aliases are matched first and left untouched: an alias can itself
 * contain a vaulted real value as a token (real "1" is aliased "Doc 1", so
 * "Doc 1" contains the token "1"), and substituting inside an alias would
 * corrupt it to "Doc Doc 1". Only catches names the vault already knows — see
 * the design doc's stated limitation on detecting a name never otherwise
 * masked.
 */
export function maskKnownNames(text: string, v: Vault): string {
  const entries = v.entries().filter((e) => e.real.trim() !== "");
  if (entries.length === 0) return text;

  const aliasKeys = new Set(entries.map((e) => canonicalKey(e.alias)));
  const aliasByRealKey = new Map<string, string>();
  for (const { real, alias } of entries) aliasByRealKey.set(canonicalKey(real), alias);

  const aliases = entries
    .map((e) => e.alias)
    .sort((a, b) => b.length - a.length)
    .map((alias) => wholeTokenPattern(escapeRegExp(alias), false));
  const reals = entries
    .map((e) => e.real)
    .sort((a, b) => b.length - a.length)
    .map((real) => wholeTokenPattern(namePatternSource(real), isNumericValue(real)));

  const re = new RegExp([...aliases, ...reals].join("|"), "gi");
  return text.replace(re, (match) => {
    const key = canonicalKey(match);
    if (aliasKeys.has(key)) return match;
    return aliasByRealKey.get(key) ?? match;
  });
}
