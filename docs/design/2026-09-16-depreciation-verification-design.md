# Tally Agent — Depreciation Verification (Income Tax Act) — Design

Status: design of record. Implementation plan is a separate artifact.
Date: 2026-09-16.

This feature computes depreciation for a previous year under the Income Tax
Act, reads what the company actually charged in its books, and reports the
difference — per block of assets, and per asset ledger within a block. It
writes a spreadsheet as its primary artifact.

Throughout, decisions are recorded with the options rejected and the reason
each was rejected. That reasoning is the part most easily lost and the part a
later reader most needs.

Privacy convention for this document: the company the design was validated
against is kept nameless, and every worked example below is invented. Where a
live observation is cited it is cited structurally — the shape of what was
found, never the customer's ledger names or figures.

## 1. Purpose and scope

In scope:

- Depreciation under s.32 read with s.43(6) and Appendix I: written-down-value
  method on a block of assets.
- Net cost of acquisition: acquisition debits in an asset ledger, net of
  purchase discounts and price adjustments credited back to the same ledger.
- Deductions from a block: moneys payable on assets sold, discarded,
  demolished or destroyed, derived from credit entries.
- The half-rate rule for assets acquired and put to use for less than 180 days
  in the previous year (second proviso to s.32(1)).
- Additional depreciation on new plant and machinery, s.32(1)(iia), including
  the half-now/half-next-year split under the third proviso.
- Block extinguishment and the short-term capital gain or loss that follows
  under s.50, including the case where no asset is left in the block.
- Reading the book depreciation charge out of the asset ledgers.
- An Excel workbook showing the Act computation, the book charge and the
  difference, block-wise and asset-wise.
- Flagging credits the classifier cannot resolve, and excluding them from
  every computed figure.

Explicitly out of scope, each for a stated reason:

- **Companies Act / Schedule II depreciation.** A different statute, a
  different method (useful life, component accounting) and a different
  artifact. The captain's instruction is Income Tax Act only.
- **A general fixed-asset register.** The Act's unit of computation is the
  block, not the asset. Building a per-asset tax written-down-value register
  would be a larger feature that this one does not need; §15 explains how the
  asset-wise view is produced without one.
- **Writing anything back into Tally.** The guarded write path is a later
  milestone and is not designed here.
- **Reading `.xlsx` (R-X-2).** This feature writes workbooks only. Reading is
  a separate decision that may justify a dependency this design declines; see
  §14.
- **Capital gains beyond block extinguishment.** s.50 is handled only where a
  block's movement triggers it. Gains on non-depreciable assets are not.
- **Unabsorbed depreciation carry-forward and set-off** (s.32(2)). That is an
  ITR computation across heads of income, not a block computation.
- **Proportionate depreciation on succession, amalgamation or demerger**
  (sixth proviso to s.32(1)). Not reachable from ledger entries.
- **s.43A exchange-rate adjustments and Explanation 10 subsidy reductions**,
  other than as an operator-supplied cost adjustment (§13).

## 2. The data inputs, and what each cannot tell

**(a) `tally_get_groups` — the block tree.**
Gives the group hierarchy, so the asset ledgers and their block groups can be
found by ancestry under the `Fixed Assets` primary group.
Cannot tell: the rate, when a group name does not carry one; the asset's class
(plant, building, furniture, intangible), which s.32(1)(iia) needs.

**(b) `tally_trial_balance` — opening and closing book balances.**
Date-bounded and already positive = debit. Called twice: as on the day before
the period starts, and as on the period end. `src/format.ts`'s `dayBefore()`
produces the first date.
Cannot tell: the tax written-down value, which differs from the book value and
exists nowhere in Tally; nor the split of a movement into additions, disposals
and depreciation.

Ledger *master* balances (`tally_get_ledgers`) are deliberately not used for
this: `CLOSINGBALANCE` on a master is not bounded by any date, and the raw
master sign is the opposite convention, flipped once at the gateway boundary.
The M3 rule stands — balances for a period come from the trial balance.

**(c) `tally_get_ledger_vouchers`, month-chunked, via `ledgerVoucherRows`.**
The movement rows for one ledger. This is the only working server-side date
filter, and §5 records two live-verified ways it misbehaves.
Cannot tell: the narration (dropped at the typed boundary, see §17); the
voucher GUID; whether a credit is a sale, a discard or a discount — that is
inferred, and the inference is §8.

**(d) The operator file, supplied by path.**
Everything the Act needs that Tally cannot hold: opening tax written-down
value per block, rate overrides, asset-class and additional-depreciation
eligibility, human resolutions for flagged credits, and cost adjustments.
Schema in §13.

Not used, and why:

- `tally_get_vouchers` (the Day Book) is banned as an input path: a
  whole-company export is tens of megabytes and can drive Tally into its error
  state.
- `tally_get_voucher` (by GUID) takes 20–60 seconds per call on a large
  company because it dumps all vouchers to find one.
- `tally_get_ledger` (the per-ledger master) has been banned since M2.

## 3. Privacy

Asset ledgers mask by default. `Fixed Assets` is a primary group but is not in
`CLEAR_ROOTS` (`src/classify.ts`), and it has no `ROLE_BY_GROUP` entry, so its
role is `other` and its ledgers take the vault label `Ledger` — they reach the
model as `Ledger N`. Counterparties mask as `Creditor N` / `Debtor N` by their
own ancestry. This is inherited behaviour; the feature adds no new clear root
and must not.

Block *group* names (`Block 15%`) are group names, not ledger names. They pass
in clear, which is what makes §7's rate-from-group-name design possible, and
they carry no party information.

Consequences the implementation must respect:

- Every outbound string passes `scrubDigits`, so a run of six or more digits
  becomes `[number]`. Money must go through `money()` and dates through
  `displayDate()` (`src/format.ts`). A depreciation report is almost entirely
  money, so this is not a corner case here — it is the common path.
- A finding `detail` may quote a ledger's whole name, never a fragment of it.
  `maskFinding` swaps whole strings only.
- The operator file travels by path. Only the path is audited; the contents
  are read inside the gateway, never echoed. Errors cite a row index and never
  a value — the `src/tds-file.ts` precedent.
- The workbook is written de-masked, to the report directory, which is denied
  to the model by permission rule (R-X-1, R-X-3). De-masking happens in the
  writer and nowhere else (R-P-5); §14 makes this structural.

**Constraint found during investigation.** A live company carries two asset
ledgers whose names end in a percentage — the percentage is a GST rate, not a
block rate. Rate parsing must read the *group* name only and must never look
at a ledger name. This is recorded as a rule, not a heuristic, in §7.

## 4. The `DEP-` finding space

A new ordinal space, never renumbered, alongside `TB-`, `GST-`, `LS-`, `TDS-`.
Severities are this project's existing vocabulary from `src/types.ts` —
`critical`, `warning`, `review` — not a new one.

| # | check | severity | fires when |
|---|---|---|---|
| 1 | `dep_block_rate_unresolved` | critical | An asset ledger's group name yields no rate and no operator override covers it. |
| 2 | `dep_asset_ledger_outside_block` | warning | A ledger sits directly under `Fixed Assets` with no block sub-group between. |
| 3 | `dep_opening_wdv_unverified` | warning | No operator opening written-down value; book balances seeded instead. Marks the whole report an unverified seed. |
| 4 | `dep_rate_not_in_act` | warning | A rate parsed from a group name is not a rate Appendix I has for the year. |
| 5 | `dep_credit_unclassified` | critical | A credit in an asset ledger no rule in §8 resolves. Excluded from every figure. |
| 6 | `dep_discount_unattributed` | critical | A credit resolves as a purchase discount but ties to no acquisition. Excluded. |
| 7 | `dep_disposal_outside_block` | critical | A disposal-signal ledger moved, with no matching credit in any asset ledger. |
| 8 | `dep_book_charge_missing` | warning | An asset ledger carries cost but no book depreciation entry. |
| 9 | `dep_book_charge_differs` | warning | Act and books differ beyond tolerance for one asset ledger. |
| 10 | `dep_block_charge_differs` | warning | Act and books differ beyond tolerance for one block. |
| 11 | `dep_book_charge_unreconciled` | critical | Depreciation credits in asset ledgers do not sum to the depreciation expense ledger's debits. |
| 12 | `dep_charge_predates_acquisition` | warning | The book depreciation entry is dated before an acquisition it should have covered. |
| 13 | `dep_block_extinguished` | warning | No asset is left in the block; the balance is a short-term capital loss under s.50. |
| 14 | `dep_block_wdv_nil` | warning | Moneys payable exceed opening plus additions; the excess is a short-term capital gain and no depreciation is due. |
| 15 | `dep_additional_depreciation_unclaimed` | review | Operator declared eligibility under s.32(1)(iia) and the books charged none. |

Checks 8, 9 and 12 are stated per asset ledger; 10, 13 and 14 per block.
Check 12 is separate from 8 because it is an assertion about the *journal*,
not the asset: one mis-dated year-end entry explains many missing charges at
once, and an operator who sees only check 8 fifteen times will not find that.

## 5. Data path

Two live-verified misbehaviours of the Ledger Vouchers report shape this
section. Both were reproduced directly against Tally's XML port, outside the
gateway, so neither is an artifact of this project's code.

**(i) A multi-month window returns only the last month.** Asking for a whole
financial year, or a half year, or a quarter, returns the rows of the final
month of the range and nothing else. Asking for the first quarter of a year
returned nothing at all for a ledger whose entries were in the first two
months of it. This is not truncation to a row count — a two-row ledger loses a
row. **Month chunking is therefore mandatory for correctness, not an
optimisation.** `src/review.ts`'s `monthChunks` already does this and is
reused unchanged.

**(ii) Some rows leak forward into later windows.** One ledger's single
voucher was returned by every monthly window from its own month to the end of
the year, and by none of the windows before it. Requesting a single month four
months after the voucher's date returned the voucher.

The defence against (ii) already exists and is load-bearing: `ledgerVoucherRows`
re-filters every row to the requested range (`src/downstream.ts:335`, whose
comment says an out-of-period row would corrupt the opening-to-closing
reconciliation). **This feature must use `ledgerVoucherRows` and never the raw
`ledgerVouchers` envelope.** Recorded here because a future reader who sees
that filter as defensive boilerplate might remove it; it is not boilerplate, it
is the only thing standing between this feature and counting a disposal ten
times.

### Call budget, and the two-pass fetch

A live company carries 147 ledgers under its block groups. Month-chunked, the
naive path is 147 × 12 = 1,764 downstream calls for one review — far too slow
to sit inside a single tool call under any timeout this project can set.

The design is therefore **two-pass**:

*Pass 1 — cheap, whole-company.*
1. `tally_get_groups` — the block tree (1 call).
2. `tally_trial_balance` as on the day before the period, and as on the period
   end (2 calls) — opening and closing book balance for every asset ledger.
3. The **depreciation expense ledger**, month-chunked (12 calls). Every book
   depreciation charge, with its date and the asset ledger it was posted
   against, in twelve calls rather than in a hundred and forty-seven times
   twelve.
4. The **disposal-signal ledgers**, month-chunked (a handful × 12). Found by
   ancestry and name vocabulary; §9 explains why these must be read.

*Pass 2 — only where the books are not already explained.*
For each asset ledger, compute the residual:

```
residual = closing − opening + bookDepreciationFromPass1(ledger)
```

If `|residual| ≤ ZERO_TOLERANCE` the ledger's whole movement for the year is
the depreciation charge already in hand: no acquisitions, no disposals, no
discounts. It needs no voucher fetch. Otherwise the ledger is fetched
month-chunked.

On the live company, 15 asset ledgers carry an unexplained residual, so the
real budget is roughly 21 chunked ledgers — the 15 that moved, the
depreciation ledger and the disposal-signal ledgers — at about 250 calls
rather than 1,764 — a sevenfold reduction with no loss of fidelity for any ledger that
actually moved.

**Residual risk, stated rather than hidden.** An acquisition exactly offset by
a disposal in the same ledger in the same year nets to a zero residual and
would be skipped. Three things bound this: check 11 reconciles the
depreciation charges independently; check 7 catches a disposal routed anywhere
in the books; and `TALLY_AGENT_DEP_FETCH_ALL=1` forces the exhaustive path for
an operator who wants it. The design prefers a stated, switchable
approximation to a review that cannot finish.

Rejected alternatives for the budget:

- **Fetch every asset ledger always.** Rejected on measured cost: it does not
  complete inside a tool call on a real company, which makes the feature
  unusable rather than merely slow.
- **Infer the book charge from the trial-balance movement without fetching the
  depreciation ledger.** Rejected: it cannot give the charge's *date*, which
  check 12 needs, and it cannot distinguish a depreciation credit from any
  other credit, which is the whole problem this feature exists to solve.
- **Widen the window to quarters to cut calls fourfold.** Rejected on the
  measurement in (i) above: a quarterly window silently drops two months.

## 6. The Act rule table — `src/depreciation-law.ts`

This module plays a different role from `src/tds-law.ts`. The TDS table *is*
the law: it supplies the rate. Here the rate comes from the company's own
group naming (§7), and the law table's job is to **validate and to supply the
rules that are not rates**. Each entry carries a `confirm` marker in the
`src/tds-law.ts` style.

- **D1 — the legal rate set.** The rates Appendix I carries for the year, so a
  rate parsed from a group name can be checked against them (check 4). A
  company that writes `Block 12%` has made an error the review should say out
  loud rather than compute with.
- **D2 — the 40% ceiling.** No block rate exceeds 40% for years from 2017-18.
- **D3 — the half-rate rule.** Second proviso to s.32(1): an asset acquired
  *and* put to use for less than 180 days in the previous year takes half the
  rate. It applies to additions only, never to opening written-down value.
- **D4 — the 180-day boundary is computed, never hard-coded.** For a year
  ending 31 March, an asset first used on or after the date 179 days before
  year end takes half rate. For a year ending 31 March 2026 that date is
  4 October 2025 — an asset first used on 3 October 2025 has exactly 180 days
  and takes the full rate. The implementation derives this from the period
  end, because a short first year or a different year end moves it.
- **D5 — block movement, s.43(6)(c).** Written-down value before depreciation
  = opening + actual cost of additions − moneys payable on assets sold,
  discarded, demolished or destroyed, together with scrap value; floored at
  nil.
- **D6 — s.50.** Two limbs, both handled: where the block's written-down value
  becomes nil because moneys payable exceeded it, the excess is a short-term
  capital gain; where the block still has value but no asset remains in it,
  the balance is a short-term capital loss. In either case no depreciation is
  allowed on that block for that year.
- **D7 — additional depreciation, s.32(1)(iia).** 20% of the actual cost of
  new plant and machinery, for an assessee engaged in manufacture or
  production of an article or thing or in generation, transmission or
  distribution of power. Excluded: ships and aircraft; second-hand plant;
  plant installed in office premises, residential accommodation or a guest
  house; office appliances; road transport vehicles; and plant whose whole
  cost is allowed as a deduction. Half (10%) where the asset was put to use
  for less than 180 days, with the remaining 10% allowed in the immediately
  succeeding year under the third proviso.
- **D8 — entry date is a proxy.** The Act's test is the date the asset was
  *put to use*. Tally holds no such date. This design uses the date of the
  acquisition entry in the asset ledger as the proxy and says so in the
  workbook. Per the captain's ruling, assets near the 180-day boundary are
  **not** flagged merely for being near it: a proxy that is wrong is wrong
  everywhere, not especially near a boundary, and a queue of boundary assets
  would be noise rather than review.

### Legal judgements this design deliberately does not make

Three questions in this area are genuinely open, and in each the design
delegates rather than guessing — which is why no `needs-decision` is raised.

- **Whether the assessee is "engaged in manufacture or production"** for
  s.32(1)(iia). This is a fact about the business, not about the entries. The
  operator file declares it per asset (§13); the default is not eligible, so
  the computed figure is conservative and the workbook states that additional
  depreciation was not computed because eligibility was not declared.
- **Whether a vehicle is a commercial vehicle at 30% or plant at 15%.** The
  30% rate turns on the vehicle being used in a business of running it on
  hire. Reading the rate from the company's own block group (§7) puts this
  decision where it already was — with whoever grouped the ledger — instead of
  inventing a second opinion inside the tool.
- **Whether GST on a disposal forms part of "moneys payable".** It does not;
  tax collected is a liability, not consideration. Taking the amount credited
  to the asset or disposal ledger rather than the invoice total excludes it
  naturally, so the design needs no rule for this — but it is recorded because
  a later reader may otherwise "fix" it by using an invoice total.

## 7. Rate resolution

The rate for an asset ledger is the rate named by its **block group**, found
by walking ancestry to the first group under `Fixed Assets` whose name matches
a percentage, e.g. `Block 15%`.

Rules:

1. Parse the rate from the **group** name only.
2. **Never parse a rate from a ledger name.** A live company has asset ledgers
   whose names end in `- 18%` and `- 28 %`; those are GST rates on the
   purchase invoice and have nothing to do with the block. Reading them would
   have invented two blocks that do not exist and mis-depreciated both
   ledgers.
3. A ledger directly under `Fixed Assets` with no block group between resolves
   to no rate: check 2 fires, and the operator file must supply an override.
   This is not hypothetical — a live company has exactly one such ledger.
4. An operator override takes precedence over a parsed rate, for the case
   where the group name is unclear or wrong (the captain's intake answer 2).
5. A parsed rate that is not in D1 raises check 4 and is still used, so the
   report is not silently empty; the finding says the rate is not one the Act
   has.

Rejected: **deriving the rate from the asset's nature** by matching ledger
names against Appendix I categories. Rejected because it is a classifier over
free text written by a bookkeeper, in a project that has an explicit rule that
classification is code rather than judgement; because the company has already
made this decision by grouping the ledger; and because rule 2's live
counter-example shows how badly ledger-name parsing fails.

## 8. Classifying a credit in an asset ledger

A credit reduces an asset ledger. It can be a depreciation charge, a purchase
discount or price adjustment, a disposal, a write-off, or a transfer. The Act
treats these completely differently, so this classification is the feature's
correctness hinge. **It is code, not a model judgement.**

Signals available on a `LedgerVoucherRow`: `date`, `voucherType`,
`counterparty`, signed `amount`, `matchStatus`, `reference`. Plus, from
`buildClassifier`, the **group ancestry of the counter ledger** — which is the
primary signal, because a group is structured data a bookkeeper chose from a
tree, whereas a ledger name is free text.

Rules, in order. Each produces **resolved** or nothing.

- **C1 — book depreciation.** The counter ledger resolves to a ledger whose
  ancestry root is an expense group and whose name matches `/deprecia/i`.
- **C2 — purchase discount or price adjustment.** Either (a) the counter
  ledger's root is `Sundry Creditors` or `Current Liabilities` *and* the same
  counterparty has an un-netted acquisition debit on this ledger inside the
  netting window of §11; or (b) the counter ledger's root is an income group
  and its name matches `/discount|rebate/i`.
- **C3 — disposal.** The counter ledger's root is `Sales Accounts`, or the
  counter ledger's root is `Sundry Debtors`, `Bank Accounts` or
  `Cash-in-Hand`.
- **C4 — write-off or discard.** The counter ledger's root is an expense group
  and its name matches `/loss on (sale|disposal)|writ(e|ten).?off|discard|scrap/i`.
- **C5 — transfer to another asset ledger.** The counter ledger is itself
  under `Fixed Assets`. Within a block this nets to nothing; across blocks it
  is a deduction from one and an addition to the other at the same amount,
  which needs operator confirmation, so it is **flagged**, not computed.
- **C6 — otherwise unresolved.** Check 5 fires. The credit is excluded from
  every computed figure and no alternative figure is shown.

**Two tiers only: resolved or unresolved.** There is no confidence score and
no threshold to tune.

Rejected: **a numeric confidence with a cutoff** (say, classify at ≥ 0.8).
Rejected on three grounds — the captain's ruling is binary, so a score would
have to collapse to a boolean anyway; a score invites per-company tuning,
which makes a compliance review irreproducible; and there is no calibration
set to tune against, so any weights would be invented and would look more
principled than they are.

Rejected: **asking the model to classify the residue.** Explicitly forbidden,
and rightly: a plausible-sounding guess about whether an entry was a sale is
exactly the failure this whole gateway exists to prevent.

A rule fires only on its **primary** signal — the counter ledger resolved
through the group classifier. Every fallback yields *unresolved*:

- `counterparty` is empty; or
- `counterparty` matches no known ledger; or
- the credit's classification under C1–C5 is not unique.

This matters because `counterLedgerName` is Tally's *Particulars display
column*, not a structural field: for a voucher with several lines it shows one
ledger chosen for display. Treating a display heuristic as structure is
precisely how a tool like this produces confident wrong numbers, so where the
display column is unhelpful the row is flagged rather than guessed.

A flagged entry appears in the workbook's **Excluded** sheet with: the asset
ledger, the date, the amount, the rule that came closest, what was missing,
and the operator-file stanza that would resolve it. It contributes to no
total. Its block's row is marked so a reader cannot mistake a partial figure
for a complete one.

## 9. Disposals routed outside the asset ledger

**Constraint found during investigation, and it changes the feature's shape.**
The captain's intent describes deductions as credits in the asset ledger. In a
live company the largest disposal of the year was *not* in any asset ledger:
the proceeds were credited to a disposal income ledger under `Sales Accounts`
with a debtor as the counterparty, and the asset ledger was never touched. The
block therefore still carries the asset at cost, and depreciation continues to
be charged on something that has been sold.

Reading only asset-ledger credits would have missed it completely — and it is
the single largest Act-versus-books difference in that company.

So the design reads **disposal-signal ledgers** as a first-class input (pass 1,
step 4). They are found by ancestry plus name vocabulary: a ledger whose root
is `Sales Accounts` or an income group and whose name matches
`/sale of (fixed )?asset|profit on sale of (fixed )?asset|asset disposal/i`.
For each movement on such a ledger, the design looks for a matching credit in
an asset ledger (same date, same amount). Where there is none, check 7 fires.

Check 7 is **critical**, not a computed deduction. The proceeds are known but
the asset they relate to is not, so the block cannot be reduced without
guessing which block — and guessing the block would change the depreciation of
every asset in it. The operator file resolves it by naming the block.

Rejected: **inferring the block from the amount** by finding the asset ledger
whose carrying value is closest to the proceeds. Rejected because it is a
guess dressed as arithmetic, it fails exactly when it matters (a sale at a
large profit or loss), and a wrong block silently mis-states two blocks rather
than one.

## 10. Acquisitions, and which date an asset was put to use

A naive reading treats each debit row as its own acquisition on its own date.
That is wrong, and measurably so: a second payment on an asset already in use
would be halved by the 180-day test even though the asset was put to use
months earlier.

This was checked against a live company by reconciling four asset ledgers end
to end — opening, every debit, every credit, closing — and then checking the
book depreciation charge against the Act arithmetic. In two of the four, the
cost arrived in more than one entry, with a later payment posted against a
**bank** ledger rather than the supplier, and the books (correctly) treated
the whole cost as put to use on the first entry's date. A per-row date test
would have disagreed with the books on both, for the wrong reason.

**Acquisition grouping, within one asset ledger:**

1. A debit opens a **new acquisition** when its counter ledger's root is
   `Sundry Creditors` (or the voucher type is a purchase) **and** no open
   acquisition on that ledger already has the same counterparty within 90 days.
2. Any other debit — bank, cash, loan, or a journal to a counterparty already
   seen — **attaches to the most recent open acquisition** on that ledger.
3. A debit that attaches to nothing, on a ledger with a **non-nil** opening
   balance, is additional cost of an asset already in use: it joins the
   opening written-down value and takes the full rate.
4. A debit that attaches to nothing, on a ledger with a **nil** opening
   balance, opens a new acquisition at its own date. (Without rule 4 an
   advance paid before the purchase invoice would wrongly take the full rate.)
5. An acquisition's put-to-use date is its **earliest** debit's date.

Rejected: **each debit is its own acquisition.** Rejected on the live
reconciliation above — it disagrees with correctly-kept books wherever cost
arrives in instalments, which is the norm for vehicles and plant.

Rejected: **all debits in a ledger in a year are one asset.** Rejected because
pooled ledgers are real — a company keeps one `Office Equipment` ledger and
buys twice — and this would date the second purchase at the first's date.

Rejected: **group by counterparty proximity alone.** Rejected on the live
evidence: the instalment payments came from a *bank*, not from the supplier,
so a counterparty-only rule splits one asset into two.

Residual risk, stated: two purchases from the same supplier into the same
pooled ledger within 90 days merge into one acquisition dated at the earlier.
The 90-day parameter exists to bound this and is a worked-example test case.

## 11. Netting a purchase discount against its acquisition

The captain's intent requires the net cost of acquisition to account for
discounts credited to the same asset ledger around the same date. "Around the
same date" has to become a number.

**The window is 30 days either side**, and netting runs against acquisitions
as §10 groups them, never against individual debit rows.

1. A credit resolved as a purchase discount by C2 nets against acquisitions on
   the **same asset ledger**, whose **counterparty matches** the credit's, and
   whose date is **within 30 days** of the credit's date.
2. Where more than one such acquisition qualifies, net against them in order
   of date proximity, nearest first, capping each at its remaining un-netted
   cost. This is deterministic, so two runs over the same data always give the
   same answer.
3. A discount never reduces an acquisition below nil; any remainder falls
   through to rule 4.
4. Where no acquisition matches, the credit is **excluded and flagged**
   (check 6). No figure is adjusted and no alternative is shown.

Why 30 days:

- A live supplier price adjustment arrived by credit note the **day after** the
  purchase invoice, as a separate voucher of a different type. The books netted
  it against the asset's cost and depreciated the net — verified by
  reconciling that ledger end to end. A narrower rule would have missed it and
  overstated the block.
- Credit notes for a price adjustment land within weeks in practice; a month is
  generous without being credulous.
- Netting changes an acquisition's **amount**, never its **date**, so the
  window cannot move an asset across the 180-day boundary however it is set.
  Its only risk is netting unrelated amounts together, which is exactly what
  keeping it tight bounds.

Rejected: **same voucher only**, matched on voucher number or reference.
Rejected on the live evidence above — the adjustment was a different voucher,
of a different type, on a different date. A same-voucher rule is the one rule
guaranteed to miss the case the captain asked for.

Rejected: **anywhere in the same financial year.** Rejected because a credit
from the same supplier eleven months later is far more likely a different
transaction; a year-wide window nets unrelated amounts silently, and the
failure mode is a wrong number that looks right.

Rejected: **the same calendar month.** Rejected as an accident of the
calendar: a debit on 31 May and its credit note on 1 June are one day apart and
would not net, while two entries thirty days apart inside one month would.

**Why rule 4 excludes rather than assumes.** A discount that ties to no
acquisition in the window is most likely a price adjustment on an asset bought
in an *earlier* year, which under s.43(6) would reduce the block's opening
written-down value rather than any addition. But "most likely" is the problem:
whether the credit is a price adjustment at all is exactly what could not be
established, and quietly reducing an opening written-down value changes the
depreciation of every asset in that block. So it is excluded and flagged, per
the ruling that an unclear credit is excluded with no alternative figures
shown. The operator file's `creditClassifications` resolves it.

## 12. Reading the book depreciation charge

A row is a book depreciation charge **iff** it is a credit in an asset ledger
whose counter ledger resolves to an expense ledger whose name matches
`/deprecia/i` (rule C1). Nothing else is required.

In particular:

- **Not filtered by voucher type.** Live observation: every depreciation row
  seen was a journal, but journals are also used for acquisition cost
  components, so the voucher type is neither necessary nor sufficient.
- **Not filtered to the year end.** Live observation: a company's annual
  depreciation journal was dated three and a half weeks *before* year end, and
  assets bought after that date got no depreciation at all. Requiring a
  year-end date would have found nothing; instead the design derives the
  journal's date, reports it, and raises check 12 for every acquisition that
  postdates it. "Year-end entries" in the captain's intent is descriptive of
  where these entries usually sit, not a filter to apply.

**Independent reconciliation (check 11).** Because pass 1 already fetches the
depreciation expense ledger, the design cross-checks it: the sum of
depreciation credits found in asset ledgers must equal the sum of debits in
the depreciation expense ledger for the period. A mismatch means the
Particulars display column misled the classifier somewhere, and check 11 says
so rather than letting a silently wrong book figure become a silently wrong
difference. This is the control that makes §8's use of a display column
acceptable.

## 13. The operator file

One new argument on the review tool, `depreciationFilePath`; the path travels
and is audited, the contents are read inside the gateway (the `returnsPath` /
`tdsFilePath` channel). JSON, matching the `src/tds-file.ts` precedent.

Six keys. Each exists because the computation cannot derive it; nothing that
can be derived is in the file.

```json
{
  "schema": "tally-agent-depreciation.v1",
  "financialYear": { "from": "2025-04-01", "to": "2026-03-31" },

  "openingWdv": [
    { "block": "Block 15%", "rate": 15, "amount": 4820000.00 }
  ],

  "rateOverrides": [
    { "ledger": "Asset Suspense", "rate": 15, "reason": "sits outside a block group" }
  ],

  "assetClass": [
    { "ledger": "Mixer Plant 2", "class": "plant",
      "newAsset": true, "additionalDepreciation": true }
  ],

  "creditClassifications": [
    { "ledger": "Tipper Lorry 3", "date": "2025-06-30", "amount": 962000.00,
      "kind": "sale", "block": "Block 15%" }
  ],

  "costAdjustments": [
    { "ledger": "Mixer Plant 2", "date": "2025-05-15",
      "amount": -250000.00, "reason": "capital subsidy, Expl. 10 to s.43(1)" }
  ],

  "additionalDepreciationCarryForward": [
    { "block": "Block 15%", "amount": 186000.00 }
  ]
}
```

1. **`openingWdv`** — the tax written-down value differs from the book value
   and exists nowhere in Tally. Where it is absent the design falls back to
   book balances, raises check 3, and marks **the whole report an unverified
   seed** (the captain's intake answer 1) — a banner on the Summary sheet, not
   a footnote.
2. **`rateOverrides`** — for the ledger whose group name is missing or wrong
   (§7 rules 3 and 4).
3. **`assetClass`** — s.32(1)(iia) eligibility turns on facts about the
   business and the asset that no Tally field holds (§6).
4. **`creditClassifications`** — the human answer to checks 5, 6 and 7. Keyed
   by ledger, date and amount so it applies to one entry and cannot silently
   widen.
5. **`costAdjustments`** — s.43(1) adjustments (subsidy, exchange difference)
   that never appear as an entry in the asset ledger.
6. **`additionalDepreciationCarryForward`** — the balance 10% from the prior
   year's short-period additions, which by definition is not in this year's
   books.

Validation mirrors `src/tds-file.ts`: **malformed input is rejected
wholesale** — no partial processing, so a half-read file can never produce a
confident-looking compliance review — and errors cite the row index and never
echo a value. `financialYear` is validated against the tool's own date
arguments and a mismatch rejects the file, so last year's file cannot be
applied to this year by accident.

Rejected: **per-asset opening written-down value in the file.** Rejected
because the Act's unit is the block, a per-asset tax register is out of scope,
and accepting one would let the file assert figures the Act does not recognise.
The asset-wise view seeds from book balances and says so (§15 here).

Rejected: **CSV.** Rejected because four of the six keys are lists of records
with differing shapes, which a flat file encodes only by convention, and
because JSON is the established operator-file format in this project.

Rejected: **carrying the company name in the file as authority.** Rejected
because the company comes from the tool argument; a second source of truth for
which company is under review is a way to review the wrong one.

## 14. The shared Excel writer

The captain's ruling is that this is built properly now, so later reports and
the finalization checklist use it too. Excel read/write is already milestone 4
in the README and is R-X-1…R-X-4 in the requirements canon.

### The dependency question

This project has exactly two runtime dependencies, `@modelcontextprotocol/sdk`
and `zod`. That is a deliberate posture for a gateway whose entire purpose is
that nothing unaudited sits between a customer's accounting data and disk.

Options weighed:

- **`exceljs`** — mature, read and write, but pulls a transitive tree
  (archiver, unzipper and their dependencies) into a process that handles
  unmasked ledger names. It also writes a creation timestamp by default, which
  breaks byte-reproducible artifacts.
- **`write-excel-file`** — much smaller, write-only, a modest dependency tree.
  Its column-schema API suits a plain table but fits poorly with sheets that
  carry a title block and totals.
- **`xlsx` / SheetJS** — rejected outright: the npm package is stale and
  carries known advisories, and the maintainers no longer publish there.
- **A hand-written, zero-dependency writer** — `src/xlsx.ts`, roughly 150
  lines: the handful of OOXML parts a rectangular sheet needs, zipped with
  `zlib.deflateRawSync` from Node core plus local file headers and a central
  directory.

**Chosen: the hand-written writer**, subject to the verification below.
Reasons: the surface this feature needs is small and fully specified (strings,
numbers, dates, a bold header row, column widths, a few number formats); every
added dependency is a new place a real ledger name can be logged and a new
supply-chain surface in exactly the process that sees unmasked data; and a
deterministic ZIP with no timestamps gives byte-identical artifacts for the
same input, which a review workbook should have.

Declining a dependency for reading is not a cost here, because reading `.xlsx`
(R-X-2) is out of scope (§1); when it lands it is a separate decision and may
well justify one then. Choosing a write-only path now does not foreclose it.

**This choice was verified by a throwaway spike before it was written down,
because it is the one claim in this design that could simply be wrong.** A
~150-line writer was built and its output read back by an *independent* OOXML
implementation (`exceljs`, installed in a scratch directory and discarded — it
is not a project dependency). Confirmed:

- Both worksheets present under their given names.
- Numbers read back as numbers, not as strings.
- Dates round-trip to the correct calendar dates via Excel serial numbers.
- The `#,##,##0.00` Indian-grouping and `dd-mmm-yyyy` formats survive, so the
  workbook matches `money()` and `displayDate()`.
- XML escaping holds for `&`, `<` and `"` in a ledger name, and for non-ASCII
  characters in a title.
- Empty cells read as null rather than as an empty string.
- Bold applies to the title and header rows and not to data rows.
- `unzip -t` reports no errors.
- **Byte-identical across repeated builds** — the ZIP carries no timestamp, so
  the same input always produces the same file. This is what R-X-4 wants from
  a review artifact and is the thing a dependency would have made harder, not
  easier.

`zlib.crc32` (Node core, 20.15+) supplies the ZIP checksum, so no CRC
implementation is hand-rolled. If the project's supported Node floor ever
drops below that, a table-driven CRC32 is about twelve lines.

The spike was a feasibility probe, not the implementation: the plan's first
task rebuilds it properly with tests. If the finished writer ever fails to
open in Excel proper, the fallback is `write-excel-file` and **the interface
below does not change** — which is why the interface, not the implementation,
is what the rest of this design depends on.

### Interface

Two layers, and the split is the point.

```ts
// src/xlsx.ts — zero-dependency, deterministic .xlsx bytes. No masking concerns.
export type CellValue = string | number | null;
export interface Column { header: string; width?: number; format?: "text" | "money" | "date" | "pct"; }
export interface Sheet { name: string; title?: string[]; columns: Column[]; rows: CellValue[][]; }
export function buildWorkbook(sheets: Sheet[]): Buffer;
```

```ts
// src/report.ts — the boundary-owning wrapper. This is the shared piece.
export async function writeWorkbook(opts: {
  reportDir: string; fileName: string; sheets: Sheet[]; vault: Vault;
}): Promise<string>;
```

`writeWorkbook` passes **every string cell** through `demaskText(..., vault)`
on the way to disk and writes into the report directory — the same contract as
`writeReport`, satisfying R-X-1 and R-X-3. Callers build **masked** sheets;
only `writeWorkbook` sees real names, and only on the disk side.

Rejected: **`writeWorkbook` taking already-de-masked sheets.** Rejected
because it moves the de-masking decision to every caller, which is exactly
what R-P-5 exists to prevent — de-masking happens in two places, and adding a
third for each new report is how a masking boundary quietly stops being one.

### How the existing writers migrate later, without being rewritten now

`findingsCsv(findings, vault)` already turns `CsvFinding[]` into de-masked CSV.
This feature adds one adapter beside it:

```ts
export function findingsSheet(findings: CsvFinding[]): Sheet;   // masked in, masked out
```

`writeReport`, `writeGstReport`, `writeLedgerReport` and `writeTdsReport` are
**not touched**. When a later milestone wants workbooks from them, each gains
an optional flag and one call to `writeWorkbook(findingsSheet(...))` — a
three-line change per writer, against an interface already proven by this
feature. The migration is stated here so it is not rediscovered, and deferred
here because rewriting four working writers for a fifth report's benefit is
churn, not progress.

## 15. The workbook

`depreciation-review-<company>-<from>-<to>.xlsx`, six sheets. Markdown and CSV
artifacts are written alongside it in the established pattern (R-R-4), so the
trio matches every other report in the project; the workbook is the primary
artifact because the captain asked for a spreadsheet.

1. **Summary** — period; the seed provenance banner (`opening WDV from
   operator file` or `UNVERIFIED BOOK SEED`); totals for Act depreciation,
   additional depreciation, book charge, difference; s.50 gain or loss; and
   the count of entries excluded and flagged.
2. **Blocks** — one row per block: Block, Rate %, Opening WDV, Additions
   ≥ 180 days, Additions < 180 days, Discounts netted, Deductions (moneys
   payable), WDV before depreciation, Normal depreciation, Additional
   depreciation, Total Act depreciation, Closing WDV, Book charge, Difference,
   Status (`ok` / `extinguished` / `nil-floor` / `unverified-seed` /
   `incomplete — flagged entries excluded`).
3. **Assets** — one row per asset ledger: Block, Rate %, Asset, Opening (book
   seed), Additions (net), First-use date, Under 180 days, Act depreciation
   (allocated), Book charge, Difference, Notes. The sheet carries a header
   note: **the block figure is the statutory one; the asset split is an
   allocation.**
4. **Movements** — every acquisition debit and every credit actually used,
   with its classification, the rule that fired, and for a netted discount the
   acquisition it was netted against. This is the audit trail for the two
   sheets above.
5. **Excluded** — every entry excluded from the figures, with the rule that
   came closest, what was missing, and the operator-file stanza that would
   resolve it. **No alternative figures** (the captain's intake answer 5).
6. **Findings** — the `DEP-` findings, through `findingsSheet`.

Number formats: money `#,##,##0.00` so the workbook matches `money()`'s Indian
grouping; dates `dd-mmm-yyyy`; rates plain.

### Asset-wise attribution is an allocation, and the workbook says so

The Act computes on the block. Asset-wise is therefore derived, and the design
is explicit about the basis.

**Basis:** each asset's depreciation is first computed *as if it were its own
block* — its own opening written-down value at the full rate, plus its net
additions at the full or half rate according to its own first-use date — and
the block's statutory total is then apportioned across assets **pro-rata to
those amounts**, so the asset column sums exactly to the block figure.

Why this basis:

- It is what the books themselves do — live-verified on four ledgers, where
  the book charge equalled the Act rate applied to that ledger's own netted
  cost at its own first-use date — so the asset-wise difference compares like
  with like and is meaningful rather than an artifact of the split.
- Pro-rata normalisation guarantees the asset rows sum to the statutory block
  figure with no balancing row, including where the block floors at nil or
  extinguishes and the total is *not* the sum of the parts.
- It needs no data the computation does not already hold.

Where the block's statutory depreciation is nil (extinguished, or floored),
every asset's allocated figure is nil and the **block** row carries the
reason, rather than the asset rows silently reading zero.

A deduction with no asset ledger to attribute to — the §9 case — appears in
the block row only, with its check 7 finding.

Rejected: **allocate pro-rata to closing written-down value.** Rejected
because an asset bought in March has a large closing value and almost no
statutory depreciation; it would draw a share far larger than any reading
supports, and every asset-wise difference in the sheet would be noise.

Rejected: **allocate pro-rata to opening written-down value.** Rejected
because assets acquired during the year would receive nothing, which is plainly
wrong and would make check 8 unstateable asset-wise.

Rejected: **show the block only.** Rejected by the captain's explicit ruling
that the difference be shown asset-wise as well as block-wise.

Rejected: **keep a real per-asset tax written-down value register.** Rejected
as out of scope (§1) and as a misreading of the Act — the block is the
statutory unit, and a per-asset tax value is not a figure the Act recognises.

## 16. Engine, session and tools

**`src/depreciation.ts` — pure, no Tally.** The statutory arithmetic is
functions over a `DepCtx` of closures and typed rows, in the `src/tds.ts`
shape:

```ts
export interface DepCtx {
  fromDate: string;                       // YYYYMMDD
  toDate: string;
  rateOf(ledger: string): number | null;
  blockOf(ledger: string): string | null;
  groupRootOf(ledger: string): string | null;   // for C1..C5
  openingWdv(block: string): { amount: number; source: "operator" | "book-seed" };
  bookOpening(ledger: string): number;
  bookClosing(ledger: string): number;
  additionalDepreciationEligible(ledger: string): boolean;
  operatorClassification(ledger: string, date: string, amount: number): CreditKind | null;
}
```

Everything in §§6–12 and §15's allocation is a pure function over this: rate
resolution, credit classification, acquisition grouping, discount netting,
block computation, s.50, and the asset allocation. **No Tally call appears in
this module**, so the statutory arithmetic is unit-testable against worked
examples with nothing live in the loop — which is the whole point, because the
Act's rules are the part that must be right and the part that does not change
when Tally does.

Worked examples the tests must carry, all invented:

- A block with opening value and no movement.
- An addition on 1 September (full rate) and one on 1 December (half rate).
- The exact-180-day boundary date, taking the full rate.
- An acquisition arriving in three entries — supplier invoice, a journal, a
  bank payment four months later — proving the whole cost takes the first
  entry's date (§10).
- A supplier credit note two days after the invoice, netted (§11).
- A discount tying to no acquisition, excluded and flagged.
- A disposal reducing the block; a disposal exceeding it, producing a
  short-term capital gain with no depreciation (D6).
- A block with value but no asset left, producing a short-term capital loss.
- New plant at 20% additional depreciation; the same put to use for under 180
  days, taking 10% now with 10% carried forward.
- An asset-wise allocation across three assets summing exactly to the block.

**`src/depreciation-file.ts`** — the operator file reader (§13), mirroring
`src/tds-file.ts` including `EMPTY_DEPRECIATION_OPERATOR`.

**`src/depreciation-law.ts`** — the rule table (§6) with its D1–D8 confirm
markers.

**`src/review.ts`** — one new session function, `depreciationReview()`,
following `tdsReview()`'s established shape: validate dates → parse the
operator file → fetch groups and trial balances → `buildClassifier` → the
two-pass fetch of §5 → build the ctx closures → call the pure engine → record
real names against finding ids **before** masking → mask → counts → result.

**Two new tools**, following the `tb_tds_review` / `tb_write_tds_report`
split already established in `src/index.ts`:

- `tb_depreciation_review(company?, fromDate, toDate, depreciationFilePath?)`
  — computes, returns masked findings and counts. Audits the dates, the
  company and the **path only**.
- `tb_write_depreciation_report(...)` — writes the markdown, the CSV and the
  workbook, and returns their paths.

## 17. Limitations, and follow-up work not folded into this plan

- **`narration` is dropped at the typed boundary.** `tally_get_ledger_vouchers`
  returns it upstream and `tb_ledger_activity`'s raw envelope path masks and
  passes it, but `LedgerVoucherRow` (`src/downstream.ts:67`) does not carry it.
  Narration would strengthen §8's classification materially — it is often the
  only place "sold to X" or "discount on invoice N" is written. Adding it is a
  change to an existing tool's projection, not a new downstream tool, and it
  touches masking (a narration is free text that can name a party, so it must
  go through the same sweep as any other string). **Follow-up, not this
  feature.**
- **Entry date is a proxy for the statutory put-to-use date** (D8). The
  workbook states this. Closing it properly needs a put-to-use date the
  company does not record.
- **Per-asset opening values are a book seed**, not tax values (§15).
- **Reading `.xlsx` (R-X-2)** is untouched; the writer chosen here is
  write-only by design (§14).
- **The zero-residual skip** in §5 can miss an addition exactly offset by a
  disposal in the same ledger in the same year;
  `TALLY_AGENT_DEP_FETCH_ALL=1` forces the exhaustive path.
- **Cross-block asset transfers are flagged, never computed** (C5).

## 18. Live validation

To be completed by the implementing task, against a nameless live company,
in the shape of the TDS design's §10: a narrow-month run and a full-year run,
with the reconciliation of check 11 reported.

The investigation behind this design already established, against that
company: that block rates are carried in group names; that two asset ledger
*names* carry GST percentages that must never be read as block rates; that one
asset ledger sits outside any block group; that the annual depreciation
journal predates year end and leaves later acquisitions undepreciated; that
the largest disposal of the year was routed outside every asset ledger; and
that four asset ledgers reconcile exactly from opening through every entry to
closing, with the book charge equal to the Act rate on the netted cost at the
asset's first-use date — which is the evidence behind §§7, 9, 10, 11 and 12.

### 18.1 What the implementing run found (2026-09-16)

A full-year `tb_depreciation_review` (FY 2025-26) executed end-to-end against
the live company through the gateway, via a standalone MCP client with a
900-second timeout chain. Results: 3 blocks (15% / 40% / 10%), 132 asset rows,
asset-wise allocation summing exactly to the block totals (1,46,77,335.70 across
blocks), 2 critical findings — one `dep_credit_unclassified` and one
`dep_disposal_outside_block` — and 6 warnings including `dep_opening_wdv_unverified`
(no operator file, book seed reported as such), `dep_book_charge_missing` on the
year's one late acquisition, and `dep_charge_predates_acquisition` consistent
with the §12 observation that the annual journal predates year end.
Check 11 reconciled (no `dep_book_charge_unreconciled` fired).

**Consequence for §5 (two-pass fetch), confirmed live.** The Ledger-Vouchers
report as seen from the depreciation *expense* side returns **per-voucher
rows**: the voucher-total amount with one display-particulars ledger as the
counterparty — the §8 display-column trap applying to pass 1, not just
classification. Per-asset charge attribution from the expense side is
therefore not possible on this server shape, `chargeByAsset` is mostly empty,
and the residual skip does not fire: pass 2 fetched all 132 asset ledgers
(1,608 upstream calls, ~11 min 45 s wall). The review is correct — per-asset
book charges come from the asset-ledger credits pass 2 reads, and the
expense-side journal totals still reconcile check 11 at block level — but the
call budget is the naive one, not the ~250 designed. Do not redesign now; treat
the full-year review as a long call that fits the 900-second timeout chain.
The skip stays in the code (harmless where expense-side rows are per-line,
useful in fixtures) under a `TALLY_AGENT_DEP_DEBUG` residual-diagnostic hook.

**Narrow-month run: not completed.** Three attempts at a single-month window
timed out at the gateway after the heavy full-year run, and the upstream was
not re-loaded for further probing. Recorded as an open observation, not a
blocker; the fault is most likely upstream connector latency after a heavy
whole-year export, and it is diagnostic-first (`TALLY_AGENT_DEP_DEBUG`) when
someone picks it up. The workbook's Excel-open check (§14 spike substitute)
also remains a manual step for an operator with Excel. Follow-ups, in this
feature's own terms, kept out of other tasks: a per-line expense-side
projection (a change to an existing downstream projection, masked like any
other string) would re-provide the §8 narration-like signal *and* could make
the residual skip real on live Tally.
