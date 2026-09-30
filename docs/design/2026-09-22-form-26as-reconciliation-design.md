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
| `AS26_VALUE_TOLERANCE` | 1,000.00 | check 003's value deltas, taxable-only since D3 (captain-set) |
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
2. Generate the fillable mapping template with `tb_write_26as_template` (pass `as26Path`, and `as26MapPath` if a map is already partly in effect). The tool pre-fills one row per 26AS deductor/collector — name, kind and 26AS tax — with the "Tally ledger" column already carrying any in-effect mapping, and always writes a `Ledgers` sheet from which that column's dropdown is validated (`Ledgers!$A$2:$A$N`). The list comes from the day book's `ledgers` when `dayBookPath` is given, else live masters. The dropdown is a range reference, never an inline list, so it carries a real company's thousands of names.
3. Fill the "Tally ledger" column in Excel. `tb_write_26as_report`'s workbook **Mapping** sheet lists matches union gaps de-masked, as a second aid.
4. Pass the filled `.xlsx` back as `as26MapPath` (`tb_26as_review` dispatches on extension); re-run. Repeat as gaps close.
5. `config/as26-map.json` (`{ "mappings": [{ "ledger": "...", "as26Name": "..." }] }`; sample shipped) remains the default and the JSON channel still works unchanged.
6. Both loaders share the overrides-file semantics: missing → empty map + warn; malformed input / duplicate ledger-or-as26Name key / blank field → throw citing the NUMBER only (JSON entry index, template Excel ROW number), never a name.

Operator-facing walkthrough: `docs/operator/26as-mapping-template.md`.

## 11. Bill-level drill-down (A2/A5, shipped 2026-09-24)

Tax-level reconciliation stays as above; this layer adds per-invoice evidence
behind each finding. `src/as26-bill.ts` is pure and masking-free; the session
wiring and masking are in `src/review.ts`; the three sheets are written by
`src/report.ts`.

### 11.1 D2 — four-step invoice linkage

A 26AS transaction links to one books sale drawn from the party's whole mapped
ledger group (`match.ledgerKeys`). First hit wins, and every row carries its
`linkBasis`:

1. `reference` — the 26AS transaction's reference, or the books deduction's
   surfaced `reference`, canonical-matches a sale's invoice ref (any date).
2. `taxable-rate` — `round2(sale.taxable × rate)` is within
   `AS26_TAX_TOLERANCE` of the transaction tax, over sales on or before the
   item date.
3. `invoice-rate` — the same over `sale.gross` (the GST-inclusive invoice
   value).
4. `approximate` — otherwise the latest sale on or before the item date; no
   sale at all ⇒ `none` (and `linked` is null).

`rate` is `lawOf(section).rates.standard`, a decimal (e.g. 0.02) from
`src/tds-law.ts`. Real TRACES writes rent as `194I(a)`/`194I(b)` (no hyphen),
which `lawOf` does not know, so `linkInvoice` first applies a minimal pure
normalizer, `normalizeAs26Section` (`194I(a)` → `194-I(a)`, tolerant of case,
optional hyphen and surrounding spaces). Every other section string is
returned unchanged, so a section absent from the law table (`194R`, `206CL`)
honestly stays unmatched and the link falls through to `approximate` — no
key-hacking. The row's stored and displayed `section` is always the original
string; normalization is lookup-only.

### 11.2 D2 investigation — why step 1 rarely fires from the day book

Requested by the firstmate amendment, the reference channel was traced end to
end:

- The raw day-book export carries a `BILLALLOCATIONS.LIST` per voucher entry,
  but its `NAME` is empty in the reviewed company, and the gateway's
  `parseVoucherRows` (`src/downstream.ts`) does not project bill allocations
  at all — it reads only `LEDGERNAME`/`AMOUNT` per entry.
- The day-book channel hard-sets `reference: ""` in `projectLedgerRows`
  (`src/tds-daybook.ts`), so a `BooksDeduction.reference` built from a day
  book is always null.
- The live channel's `ledgerVoucherRows` does surface
  `LedgerVoucherRow.reference` (`src/downstream.ts`), and `deductionEvents`
  carries it additively into `BooksDeduction.reference`.

Net effect: linkage step 1 can only fire where a reference is already
surfaced (the live channel); on a `dayBookPath` run steps 2–4 carry every
link. This gap is a documented limitation, not a code defect (M-5).

### 11.3 D3 — check 003 compares taxable only

`assessable_value_mismatch` compares 26AS gross (`summary.gross`) against
books taxable (Sales-Accounts-root debit magnitudes) with
`AS26_VALUE_TOLERANCE` (1,000). The earlier GST-inclusive reading was dropped
from the check and re-homesteaded on the Deductors sheet (`gross incl GST` /
`delta value`). The finding detail now ends with the honest pointer
"Bill-level value rows, where present, carry the per-invoice detail." — value
rows are emitted only for non-approximate links, so the sentence never
promises a sheet that may be empty.

### 11.4 D4 — the three drill-down sheets

`writeAs26Report` writes three sheets alongside the existing four, one per
`billRows` `sheetId`. Ids are assigned over **all** rows of a kind — unmatched
plus combination-consumed — so a consumed row still reserves its ordinal and
the displayed sheet carries gaps where it was explained. That keeps the ids a
finding may have named in an earlier run stable and lets the traceability
sheet (`§11.7`) point at the same `B`/`D` ordinals.

- `Books not in 26AS` — ids `B1..Bn`; books deductions that no 26AS row
  explains. Combination-consumed entries reserve their `B` ordinal but are
  hidden. Columns include `link basis` and `window`.
- `26AS unmatched` — ids `D1..Dn`; 26AS transactions that no books entry
  explains (combination parts likewise reserve-and-hide). Columns include
  `link basis` and `window`.
- `Bill value mismatch` — ids `V1..Vn`; one row per non-approximate 26AS
  transaction of a matched party whose `delta` (26AS amount − linked invoice
  taxable) exceeds `AS26_VALUE_TOLERANCE` in magnitude.

`window` reads `pre-period`/`post-period` and is blank when in-period. Rows
arrive masked; `writeWorkbook` de-masks on disk only.

### 11.7 The Combination matches sheet

`writeAs26Report` also writes a **`Combination matches`** sheet listing every
entry of `recon[].combinations`, in both directions:

- `side` is `as26` when one 26AS row was matched to a set of books entries,
  and `books` when one books entry was matched to a set of 26AS rows (the
  one-to-many aggregate a deductor reports as many detail lines).
- Columns: `row` (`C1..Cn`), `side`, `party`, `target row`, `target date`,
  `target tax`, `matched rows` (count), `matched row ids` (the reserved
  `B`/`D` ordinals, comma-joined), `entries total`, `invoice ref`,
  `invoice date`, `invoice taxable`, `link basis`.
- `target row` / `matched row ids` are the drill-down ids from §11.4, so a
  reader can trace a consumed `B`/`D` row to the combination that explains it
  even though the row itself no longer appears on the mismatch sheets.
- `link basis` is the tier basis when the match was invoice-anchored, else
  `aggregate` for a books-target match, else blank. A books-target match with
  no invoice anchor is an aggregate by construction.

### 11.5 D5 — finding pointers

After every finding detail has passed `maskKnownNames`, the session appends a
pointer sentence naming that party's drill-down rows, e.g. `see Books not in
26AS rows B1, B2.` Mappings: 001/008 → B; 002/005 → D (005 restricted to
out-of-window D ids); 007 → B and D; 003 → V. When a party has no rows of the
named kind, no pointer is appended. A combination-consumed row reserves its
ordinal but is never a pointer target, so a pointer can only name a row that
still appears on the sheet. The appending happens after masking so
row ids can never be re-masked.

### 11.6 D6 — masking boundary unchanged

All masking of bill rows, pointers and refs happens in `src/review.ts` only;
`src/as26-bill.ts` and `src/report.ts` stay masking-free. The workbook is
de-masked on disk via `writeWorkbook` + vault, exactly as the rest of the 26AS
report, and party labels on the sheets equal the findings' masked labels
(R-P-5).

## 12. Totals-only reconciliation, bank interest and 20% TDS (addendum 2, 2026-09-26)

Captain: s.194R entries and bank-deducted s.194A interest are "reported in
many small amounts and are impossible to map to book entries" — bill-level
pairing is noise there. Compare totals instead; keep the ordinary drill-down
for every other section, including non-bank 194A.

### 12.1 Which parties go totals-only

Party-level decision (the books deduction events carry no section, so a
per-section split is impossible): a matched party is **totals-only** when every
summary row of the party carries a section token of `194R`, or of `194A` **and
the operator marked that name a bank** on the Bank Interest mapping sheet.
Section tokens are normalized like everywhere else (case/punctuation strip):
`194R`/`194 R`/`194-R` all collapse to `194r`. A mixed party (some sections
bill-level, some totals-only) keeps the bill-level behaviour — the totals-only
reading requires the party's whole books side to be unattributable; when the
captain's company hits that mix, the drill-down still shows everything and no
figure is lost.

### 12.2 The books side

- **194R**: the ordinary `facts.deductions` of the party's ledgers — compared
  on TAX only (`booksTax` vs the 26AS tax total). No books amount is claimed:
  the expense ledger mapping does not exist, and the finding must not pretend
  otherwise.
- **Bank 194A**: wholly operator-mapped. The Bank Interest sheet gives, per
  26AS bank name, the interest income ledger(s) and the FD ledger(s). A books
  event is one books voucher touching any of the bank's interest/FD ledgers;
  `interest` = the credit magnitude on interest ledgers, `tax` = the credit
  magnitude on a TDS receivable ledger inside the same voucher, `fdDebit` =
  the debit on FD ledgers (carried, not compared — it is principal). Non-bank
  194A parties are untouched.

### 12.3 The comparison and findings

Per totals-only party: compares the books tax total against
the 26AS transactions' tax total with `AS26_TAX_TOLERANCE`; for banks the
books interest total is additionally compared against the 26AS gross with
`AS26_VALUE_TOLERANCE`. Any distance beyond the tolerance raises **check
`as26_totals_mismatch` (ordinal 009)** — critical when the tax total misses,
warning when only the interest/gross misses. A marked bank whose Bank Interest
rows carry no ledgers at all yields no books side; it surfaces as
**review** (never a zero-books critical) asking the operator to fill the
ledger names. Checks 001/002/007/008 and the
three drill-down sheets are skipped for a totals-only party (its rows must not
appear in "Books not in 26AS"/"26AS unmatched"); 005 (late booking) is kept —
it explains a totals gap across the window. When the totals tie there is
**no finding at all** — silence is the success state.

### 12.4 20% TDS on FD interest

Some banks deduct 20% TDS on FD interest (no PAN on file); such books entries
will never appear in 26AS. Per books event of a mapped bank:
`is20 = tax>0 and interest>0 and |tax − 0.20×interest| ≤ max(1, 0.01×interest)`
(`FD20_TAX_RATE`, relative tolerance 1%). A 20% event is **excluded** from the
bank's totals comparison and reported instead as individual rows on the new
**`FD interest 20% TDS`** workbook sheet (count, interest, TDS per entry) plus
one finding per bank, **check `fd_20pct_tds` (ordinal 010, review)**, whose
detail states the entries are not expected to reflect in 26AS. Masking is the
ordinary channel: party pseudonym, `displayDate` dates.

### 12.5 The Bank Interest mapping sheet

The fillable template gains a **`Bank Interest`** sheet — columns `26AS name
(bank)`, `Interest income ledger`, `FD ledger` (both dropdowns backed by the
same `Ledgers` range). One row per ledger; a bank repeats across rows and the
parser groups by canonical name. Presence on the sheet **is** the bank mark
(no name guessing, no extra flag column). The parser refuses a ledger named
twice on this sheet (row number only, never a value); a ledger shared with the
Mapping sheet is *not* cross-refused — the two sheets serve different
questions. Older filled templates (no such sheet) load unchanged with empty
bank rows; the JSON map channel never carries banks.

## 13. Same-voucher other income in the party gross basis (addendum 10, 2026-09-26)

A party's books gross basis was the Sales-Accounts-root taxable credits alone.
That omits income that is *not* contract turnover but is still reported to the
department against the party's TAN — e.g. an exempt contract bonus credited by
a gross-up journal (`Dr party` + `Dr TDS receivable`, `Cr income`), which the
department reports as a 194C receipt. Check 003 then showed the 26AS gross
exceeding the books taxable by exactly that income.

Rule: when a voucher debits a mapped party's TDS receivable (a `tds`
`BooksDeduction`, after the addendum-9 re-key) **and** credits a ledger under an
income root (`Direct Incomes`, `Indirect Incomes`), that credit joins the
party's gross basis. Other income carries no GST, so the amount is added to
**both** `booksTaxableValue` and `booksGrossValue`. Attribution is by voucher
identity `` `${date}|${voucherType}|${voucherNumber}` `` (`voucherIdentity`),
never by name; the credits come from the same day-book voucher walk as the
deductions.

Guard (inbox 030): an income ledger already inside the party's measured basis —
a mapped bank's interest/FD ledgers (`map.banks`) or an auto-assigned FD ledger —
is excluded (`otherIncomeCredits`'s `excludeKeys`), so no 194A/bank figure
moves. Totals-only parties (194R, bank 194A) take no other income.

Traceability: the **Books Events** sheet gains a `ledger` column and a `source`
value `other income`, one row per included credit (party, date, tax = amount,
voucher type, ref, ledger), so a reader sees why the basis grew. Masking is
unchanged and stays at the session boundary (`pseudoKey` / `pseudoName` /
`REF_MASK`).

## 14. Operator-declared manual matches and invoice links (2026-09-30)

Automatic matching is deliberately conservative: a subset fit that more than
one grouping could satisfy stays unmatched and counts as `ambiguous`, and a
sales invoice is only tied to a TDS entry by reference, by the section rate, or
— failing both — approximately, which carries no bill-value comparison. Both
leave rows on **Books not in 26AS** / **26AS unmatched** that a human can see
are the same money, or a books entry that a human can see belongs to a
particular invoice. The captain's ruling (2026-09-30) is that automatic
linking stays exactly as it is and the operator gets a channel to state the
decision.

### 14.1 The two sheets

Both live on the existing mapping template (`tb_write_26as_template`), written
empty with headers and pre-filled from the map in force, so a re-fill
round-trips an operator's earlier decisions:

* **Manual Matches** — columns `26AS name | kind | group | side | date | tax`.
  Rows sharing a 26AS name, kind and the operator's own `group` label form ONE
  instruction; a blank label is a group of one. One side carries a single row
  (1:1, 1:N, N:1) and both sides must balance within `AS26_TAX_TOLERANCE`.
* **Invoice Links** — columns `26AS name | kind | side | date | tax | invoice
  number`. One row pins one party entry to one sales invoice, identified by its
  voucher number (the report's *linked invoice ref*).

`side` is `books` or `26as`. `As26Map` gains `manualMatches` and
`manualLinks`; the JSON map channel may carry them, and a map with neither is
unchanged (`EMPTY_AS26_MAP`).

### 14.2 Binding by fact, never by row id

Row ids (`B12`, `D7`) shift between runs — they are assigned per run from the
sorted rows — so an instruction is bound to `(side, date, tax)`, the facts the
report prints on the row. Dates may be typed as the report prints them
(`16-Jan-2026`), as `20260116`, as `2026/01/16`, or left as an Excel date cell;
anything else refuses. Every refusal cites sheet, row, and column letter +
header — never a cell value, since a stray cell can be anything (a name, a PAN).

### 14.3 Refusal, not silent application

The whole point of a hand-stated decision is that applying it to the *wrong*
entry is worse than not applying it. An instruction is refused — a thrown,
operator-facing error naming the sheet and row — when:

* its 26AS name is not a party of this review (unmapped, absent from 26AS for
  the period, or the wrong kind), or is a shared-ledger party, which reconciles
  on totals and has no single entries to name (`assertManualParties`, run once
  before any party is reconciled so the whole map is checked up front);
* a date+tax pair matches no entry, or more than one, of that party;
* the group has no row on one side, has more than one row on both sides, or
  does not balance (the drift is quoted);
* the invoice number matches no sales invoice, or more than one, **on that
  party's own ledgers** (a link never reaches across parties);
* two links name the same entry (one invoice per entry).

### 14.4 Where manual runs, and what it may not change

In `reconcileParty`, manual links resolve against the party's WHOLE books/sales
pools — a link may name an entry the review already paired automatically,
because a paired entry still gets a bill-value comparison — while manual
matches resolve against the pools left unmatched after the exact 1:1 and
equal-amount-leftover stages and BEFORE the invoice-anchored and subset
searches. Manual therefore beats the automatic searches and can never compete
with them; one entry is consumed once, by the operator's instruction or by the
engine, never twice.

A manual match is pushed into `recon[].combinations` with `basis: "manual"`,
which is all the report needs: the consumed rows are re-emitted as `explained`
rows (ids reserved, hidden from the two unmatched sheets, cited by the
combination row) and appear on **Combination matches** with link basis
`manual`. A manual link is carried on `recon[].manualLinks` as a plain
`{side, date, tax, linked:{date, ref, taxable}}` — deliberately not a
`BooksSale`, so the session's masking stays simple — and
`buildBillRows` consults it first on the books, 26AS and value rows. On the
value rows a manual link replaces the automatic tie even when the only possible
automatic one was *approximate*, so the comparison the tool could not make now
runs and reports `linkBasis: "manual"`.

Nothing else moves: `booksTax`, `as26Tax`, the run totals, the Deductors sheet
figures and every automatic decision are untouched, and the identity
`Σ unmatched books − Σ unmatched 26AS = booksTax − as26Tax` (to
`AS26_TAX_TOLERANCE`) holds with and without instructions. `LinkBasis` gains
`"manual"` in both `src/as26.ts` and its `src/as26-bill.ts` twin.

### 14.5 Out of scope

`linkInvoice`, `linkInvoiceWithCapacity`, `reconcileParty`'s automatic stages
and every threshold in §5 are unchanged, and the TDS payable review is
untouched.
