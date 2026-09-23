# Tally-vs-Form-26AS reconciliation — design of record

Date: 2026-09-22. Plan of record: `/home/ram/firstmate/data/ta-26as-reconciliation/report.md`. This document condenses that plan's §0–§4 and §6 into what the implementation actually honours, plus the captain deviations that were applied (each noted inline).

## 1. Purpose and scope

Reconcile a TRACES Form 26AS export (.xlsm) against the books in Tally for FY 2025-26 (TDS and TCS). Output is a masked finding set (`AS26-*` ids), an optional workbook report (de-masked on disk only), and a mapping-aids sheet the operator uses to correct `config/as26-map.json`.

Out of scope (unchanged from the plan): two-FY netting, per-section rate comparison, a sibling Winman 26AS parser, and any change to the TDS path beyond sharing the day-book reader.

## 2. Staged pipeline

1. **Parse** (`src/as26-file.ts`) — zero-new-dep zip+XML reader over the TRACES workbook; sheets are matched by normalized sheet name *ignoring hidden state* (divergence from the Winman parser's visible-only filter — TRACES marks every data sheet hidden).
2. **Operator-map join** (`matchParties`, `src/as26.ts`) — a mapping joins books ledgers to 26AS deductor names **exactly** and only. Captain deviation: no canonical auto-match — the plan's structural/name auto-matching was deleted; anything unmapped or ambiguous becomes a `mapping_gap` finding.
3. **Reconcile** (`reconcileParty`) — totals first, unique 1:1 pairing within tolerance, then a bounded subset-combination explanation of leftovers.
4. **Findings** (`analyzeAs26`) — 8 checks, ids `AS26-<pad3(n)>-<n>` per check ordinal (ordinal table below).

## 3. Layout pins (TRACES export)

- Summary sheets: `TDS - Form 16A` (TDS) and TCS variant; machine headers on row 2 (`Name of Deductor | TAN of Deductor | TDS Deducted | TDS Claimed by the Assessee (Current Year) | Balance (TDS CF) | Gross Receipts as per 26AS | Head of Income | Gross Receipt | Section`), data from row 8. A data row has a non-blank name, is not all-dashes, and carries a numeric in at least one bound numeric column.
- Detailed sheets: `TDS_Detailed` / `TCS_Detailed`; the header row is located by scanning the first 12 rows for `Name of Deductor/Name of Collector`; banded names carry the last non-blank forward; transaction dates are **text** `dd-MMM-yyyy` (Excel serials also accepted); float tails like `230000.8900000001` are round-2'd.
- Never bound by the parser: TAN, deposited, subtotal columns, status/booking columns beyond the named ones — security contract: errors cite sheet/row/column, never a cell value.
- Header binding is two-pass (exact token, then prefix): real TRACES headers carry `(Rs.)` suffixes, so `Amount Paid / Credited(Rs.)` did not exact-match `amountpaidcredited`.
- Skipped rows are counted (`skipped.noDate`, `blankTax`, `form16BCDE`), never thrown; a row counted is data not silently dropped.

## 4. Books evidence

- Deduction side: month-chunked Ledger-Vouchers reads of the TDS/TCS receivable ledger(s) (`fetchLedgerRows`, `deductionEvents`). `LedgerVoucherRow.amount` is positive=debit at the gateway boundary (R-MCP-5) — a debit row on the receivable ledger is a TDS booking; never re-flipped.
- Sale side: `booksSales` walks the period's vouchers once; one `BooksSale` per outward voucher; taxable = the debit-magnitude of Sales-Accounts-root lines (outward contribution), gross adds Duties& Taxes/GST-head credits; ref = voucher number.
- `ctx.groupOf(ledger)` must come from ledger master pairs (`ledgersTax`), not the groups tree: `kindOf` roots each entry's group through that map; without a master row for a sales ledger the sale silently disappears. Inside the gateway this is populated for both review paths.
- Day-book file channel (captain deviation 3): `tb_26as_review` accepts `dayBookPath`, reusing `src/tds-daybook.ts` (`loadDayBookText` + `readDayBook` → `projectLedgerRows`) — no second reader, same 64 MB ceiling.
- `receivableLedgers` name heuristic: canonical name matches `(tds|tcs)` AND `receivable`, parent chain reaches an asset root (`current assets`, `fixed assets`, `misc. expenses (asset)`). None ⇒ hard error telling the operator the exact fix. When masters degraded, a heuristic fallback over the fetched vouchers' entry ledgers applies.
- The receivable-ledgers group-override key from the plan was NOT built (recorded follow-up).

## 5. Tolerances and constants

| Symbol | Value | Meaning |
|---|---|---|
| `AS26_TAX_TOLERANCE` | 1.00 | rupee tolerance on paired tax amounts |
| `AS26_VALUE_TOLERANCE` | 1,000.00 | check 003's value deltas, applied to both GST interpretations (captain-set) |
| `ZERO_TOLERANCE` | 0.005 | export self-consistency |
| `COMBINATION_MAX_SIZE` | 4 | max parts in a subset combination |
| `COMBINATION_MAX_ITEMS` | 40 | per-side unmatched cap beyond which the search is skipped |

## 6. Findings ordinal table (frozen)

| check | ord | severity |
|---|---|---|
| books_tax_not_in_26as | 1 | critical |
| as26_tax_not_in_books | 2 | critical |
| assessable_value_mismatch | 3 | warning |
| mapping_gap | 4 | review |
| late_booking | 5 | review |
| export_inconsistent | 6 | review |
| unresolved_combination | 7 | review |
| deduction_without_sale | 8 | review |

Ids are `AS26-<pad3 ordinal>-<n>` with n counting per check (e.g. `AS26-001-1`). Settled defaults (captain deviation 4): value tolerance 1000 on both interpretations; totals-first; late booking gets no grace (a deduction's `lateBookedTax` uses the calendar, not a grace window; cross-FY entries are labelled only); non-F booking statuses are counted, not interpreted.

## 7. Honesty rules for the combination search

A tax edge may be explained by a bounded subset of the other side's unmatched rows: unique 1:1 pairing only when unique in both directions; subsets of size 2..4 with exactly one fit become a `combinations` entry (target consumed, parts consumed); more than one fit ⇒ `ambiguous`, the item stays unmatched; more than 40 unmatched per side disables the search (`combinationSearchSkipped`). Totals are never mutated by the search.

## 8. Privacy contract

- Both input files (26AS export, party map) are read **inside the gateway by path**; only paths are audited. Optional `as26MapPath` argument on `tb_26as_review` overrides the default `config/as26-map.json`.
- Every outbound string passes `scrubSecrets`; parties are pseudonymed (Tally-ledger parties via `maskLedgerName`/`maskPolicy`, 26AS names via `vault.pseudonym(name, "debtor")`); finding/marked-up voucher refs mask via `Doc N` aliases; a whole-result `sweepStrings` is the floor.
- TAN columns are never bound → TANs never enter memory other than as unread cells; PAN shapes are scrubbed by `scrubSecrets` on any master-channel leak.
- The workbook's cells and titles are de-masked **on disk only** (`writeWorkbook` + vault) for the operator; the chat/tool envelope stays masked. `config/as26-map.json` holds real names and is the operator's artifact — `config/as26-map.sample.json` ships committed, the real map does not.

## 9. Masks vs the two formats

- `maskedCountAs26` counts masked parties under `/^(\w+) \d+$/`, the shared convention.
- Dates: `sweepStrings`' `scrubDigits` eats 8-digit `YYYYMMDD` runs, so every date the review result carries is already `displayDate`-formatted at the session boundary (finding schedule labels, recon items, book events).

## 10. Mapping-correction workflow (operator)

1. Run `tb_26as_review` with no or partial map; the `mapping_gap` findings name what is unjoined.
2. Run `tb_write_26as_report`; the workbook's **Mapping** sheet lists matches union gaps with the 26AS-side de-masked names and the exact books-ledger names to place against them.
3. Edit `config/as26-map.json` (`{ "mappings": [{ "ledger": "...", "as26Name": "..." }] }`; sample shipped) or pass a temporary file via `as26MapPath`; re-run.
4. `loadAs26Map` follows the overrides-file semantics: missing → empty map + warn; malformed JSON / duplicate ledger-or-as26Name key / blank field → throw citing the entry NUMBER only.
