# Correcting the 26AS party mapping (Excel template)

The Tally-vs-Form-26AS reconciliation joins each 26AS deductor/collector to a
Tally ledger through an operator-supplied mapping. You supply it as a filled
Excel template, the same way the TDS review takes a filled TDS template.

## The workflow

1. **Run the review once.** `tb_26as_review` reports `mapping_gap` findings for
   every 26AS name and every books ledger that stays unjoined. Nothing is
   auto-matched: an unmapped party simply has no money checks computed for it.
2. **Generate the template.** `tb_write_26as_template` writes
   `as26-map-template-<company>-<date>.xlsx` into the report directory and
   returns its path. Pass it the 26AS export (`as26Path`); pass `as26MapPath`
   too if a mapping is already partly in effect, and `dayBookPath` if you want
   the ledger list taken from a day-book export rather than live Tally.
3. **Fill it in Excel.** The **Mapping** sheet has one row per 26AS name with
   its `kind` and `26AS tax`, and a **Tally ledger** column to fill. Rows
   already mapped come pre-filled, so you can re-fill and re-run iteratively.
   Leave a row's Tally ledger blank to leave that party unmapped.
   - **One 26AS name may need several rows.** If a deductor/collector is
     represented by more than one Tally ledger — a customer split across a site
     ledger and a head-office ledger, say — add another row with the **same
     26AS name** and pick the next ledger. One ledger per row. The review sums
     every ledger mapped to that name (tax, credits, sales, dates) and compares
     the total against 26AS once, as a single party, so a split customer no
     longer shows a false shortfall. The **reverse is refused**: a Tally ledger
     may map to only one 26AS name.
   - The **Tally ledger** column has a dropdown of the company's ledger names,
     backed by the **Ledgers** sheet (which lists them all, for reference). The
     dropdown works for any company size — it is bound to the Ledgers range,
     not to an inline list. If the company has no ledger masters available the
     Ledgers sheet is empty and the dropdown has nothing to offer; fill the
     column by typing the name.
4. **Pass the filled file back.** Give its path to `tb_26as_review` as
   `as26MapPath` and re-run. Repeat until the gaps close.

## The TDS/TCS credit ledgers

The books side of a 194C/206CL reconciliation reads the tax a customer
**deducted** from your ledger — the asset ledger that is debited when TDS or
TCS is booked. When the sheet is blank the review picks those ledgers by a name
rule (TDS/TCS + "receivable", under an asset group) and fails loudly if it
finds none. Plenty of real companies name that ledger something else —
`TDS (FY:25-26) A/c` under `Loans & Advances (Asset)`, for instance — and then
every deductor's tax reads as unbooked.

- Fill the **Credit Ledgers** sheet for those companies: one row per ledger,
  its **TDS/TCS credit ledger** name and its **kind** (`tds` or `tcs`, the
  dropdown). A ledger may be listed only once.
- A declared ledger is used **exactly as written**, and the name rule does not
  run for that kind. A ledger name that is not in the company's books is
  refused with an error rather than quietly ignored, so a typo cannot silently
  empty the books side.
- **The sheet overrides per kind, not as a whole.** A company whose TDS sits
  in `TDS (FY:25-26) A/c` under Loans & Advances but whose TCS sits in a
  rule-findable `TCS A/c` needs only the TDS row: the TCS kind keeps the name
  rule. Declare both only when both names defeat the rule.
- Leave the sheet blank to keep the name rule. The same applies when the
  ledger masters are unavailable: declared names are then taken on trust
  (a note goes to the log), since there is nothing to verify them against.
- This is a template-only input: a JSON mapping file carries party mappings
  only, like the Bank Interest sheet's bank list.

## Bank interest (s.194A) and fixed deposits

Some banks/deductors report interest in many small amounts that can never be
matched bill by bill. The template's **Bank Interest** sheet is the input for
them:

- One row per ledger. Write the bank's name **exactly as it appears in 26AS**
  in "26AS name (bank)", and its **Interest income ledger** and/or **FD
  ledger** in the next columns. Repeat the bank's name on extra rows for
  further ledgers; leave a column blank when that side does not apply.
- **The FD ledger column is optional.** Fixed-deposit ledgers under the
  Deposits (Asset) group are detected automatically (an FD token in the
  ledger name) and assigned to a listed bank by name — a distinctive word
  (e.g. "Canara") or a short form (e.g. UBI, UB, SBI; two-letter forms only
  as a standalone token) inside the FD ledger name, or, when this sheet
  lists exactly one bank, that bank. An explicit FD ledger here still wins.
  The report's **"FD ledger auto-assign"** sheet shows every auto-assigned
  ledger with the rule that fired, and then, listed first and marked
  *unassigned*, the FD ledgers that resolved to no bank. Those raise one
  review finding (counts and amounts only) — map them explicitly here if they
  belong to a bank.
- **Presence on this sheet is the bank mark.** A 26AS name listed here
  reconciles its 194A entries on **totals** (interest vs 26AS amount, TDS vs
  26AS tax) — never bill by bill, and its entries stay off the "Books not in
  26AS" / "26AS unmatched" sheets.
- Non-bank 194A deductors keep the ordinary bill-level reconciliation; nothing
  on this sheet affects them.
- Interest entries where the books show TDS of **about 20%** of the interest
  (the bank deducted the higher rate, often for a missing PAN) are **left out
  of the totals comparison** because they will not reflect in 26AS. They are
  listed separately on the report's **"FD interest 20% TDS"** sheet, with a
  count, interest and TDS totals, and a finding noting they are not expected
  in 26AS.
- If you name a bank but fill no ledgers, the review says so (and does not
  pretend a zero-books comparison is valid): fill the ledger names and re-run.
- A bank not on this sheet at all does not change anything: leave the sheet
  empty when no bank interest is involved, and older filled templates remain
  valid.

## Matching and linking entries by hand

Automatic matching is deliberately cautious, so two things stay on the report
until a human decides. Both have a home on the same template:

- a TDS entry on **Books not in 26AS** and an entry on **26AS unmatched** that
  you know are the same money (the tax was booked as one journal but 26AS shows
  it split, say — or the split could be grouped more than one way, so the tool
  honestly refused to guess);
- a TDS entry, books or 26AS, that belongs to a **particular sales invoice** the
  tool could not tie to one (no bill reference on the voucher, and the tax does
  not match the invoice's rate).

### Manual Matches sheet

Columns: `26AS name | kind | group | side | date | tax`. Rows that share a 26AS
name, a kind and a **group** label you type are one instruction; a blank label
is a group of one (a 1:1 match). Put the books row(s) with side `books` and the
26AS row(s) with side `26as`:

| 26AS name | kind | group | side | date | tax |
| --- | --- | --- | --- | --- | --- |
| Sample Builders LLP | tds | Mar-rent | books | 16-Mar-2026 | 12,000.00 |
| Sample Builders LLP | tds | Mar-rent | 26as | 20-Mar-2026 | 7,000.00 |
| Sample Builders LLP | tds | Mar-rent | 26as | 21-Mar-2026 | 5,000.00 |

One side must carry a single row (1:1, 1:N or N:1) and **both sides must add up
to the same amount**, to the rupee.

- A matched pair **leaves both unmatched sheets** and is listed on
  **Combination matches** with link basis `manual`; the entries keep their row
  numbers so earlier runs' references stay readable. The party's totals, its
  Deductors figures and every other decision are unchanged — only which entries
  are explained.
- Manual decisions are applied **before** the automatic searches, so an entry
  you have named is never consumed twice, by you or by the tool.
- Identify each row by its **date and tax exactly as the report prints them**,
  not by its row number: numbers move between runs, the facts do not.

### Invoice Links sheet

Columns: `26AS name | kind | side | date | tax | invoice number`. One row pins
one entry to one sales invoice, named by its **voucher number** — the number the
report prints in the *linked invoice ref* column.

| 26AS name | kind | side | date | tax | invoice number |
| --- | --- | --- | --- | --- | --- |
| Sample Builders LLP | tds | books | 25-Mar-2026 | 4,000.00 | NC/17 |

- The entry may be one the review already paired automatically: a paired entry
  still gets a bill-value comparison, and yours overrides whatever was inferred.
- Once named, the row's linked-invoice columns fill with link basis `manual`,
  and the **Bill value mismatch** sheet reports the invoice-value comparison for
  it even when the only tie the tool could infer was an approximate one.
- The invoice must be one of **that party's own** sales; a number belonging to
  another party's ledger does not count.

### When an instruction is refused

The run stops with an error naming the **sheet and row** (never a name, a PAN
or any cell value) when an instruction no longer identifies exactly one thing —
which is the honest answer, since row numbers move:

- the 26AS name is not a party of that review (unmapped, not on 26AS for the
  period, or the wrong kind), or it shares a Tally ledger with another name
  (such a party reconciles on totals, so it has no single entries to name);
- a date + tax matches no entry, or more than one, of that party;
- the group has no row on one side, has more than one row on both sides, or its
  two sides do not add up (the difference is quoted);
- the invoice number matches no invoice on that party's ledgers, or more than
  one;
- two links name the same entry — one invoice per entry.

Dates may be typed `16-Mar-2026` (as the report prints them), `20260316`,
`2026/03/16`, or left as an Excel date cell. Both sheets are pre-filled from
the mapping already in force, so re-filling and re-running keeps your earlier
decisions.

## Notes

- The file carries company and party names. **Never paste its rows into chat.**
  Pass its path; the gateway reads the file itself and only the path is audited.
- Do not rename the sheets or header columns — the parser binds columns by
  header text, so an inserted helper column is fine, but the headers must stay.
- Leave a cell blank to mean "not yet mapped". Pre-filled rows whose Tally
  ledger is still empty are skipped.
- If the review refuses the file, the error cites the sheet, the Excel row
  number and the column — never a name from your file.

The JSON map (`config/as26-map.json`, format
`{ "mappings": [{ "ledger": "...", "as26Name": "..." }] }`) still works and is
the default when no `as26MapPath` is given. `tb_26as_review` chooses the
template parser or the JSON parser by the file's extension.
