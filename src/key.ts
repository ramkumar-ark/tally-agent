/**
 * Canonical identity key for matching a real-world ledger/party name across
 * calls to different downstream tools. A live company was seen returning the
 * same ledger with different internal whitespace from different report
 * paths — one tool's canonical name carried an embedded CRLF that another
 * tool's response for the same ledger did not. `trim()` + `toLowerCase()`
 * alone leaves embedded control characters untouched, which fragments one
 * real party into two different pseudonyms and can make a group lookup miss
 * (falling to the default mask policy — safe, but fragmented).
 *
 * Collapses every run of whitespace — including embedded CR, LF and tab, not
 * only leading/trailing — to a single space, then lowercases.
 */
export function canonicalKey(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}
