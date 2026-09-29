# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Sharp edges found during Milestone 1 (trial balance review)

- The downstream `tally_get_ledger_vouchers` tool (in the sibling
  `tally_prime_mcp_server` repo, `src/tools/reads.ts`) returns a report
  envelope object (`{ source, company, ledgerName, ..., vouchers: [...] }`),
  not a bare array. Row fields are `partyLedgerName`, `counterLedgerName`,
  and `matchedLedgerName` — there is no `counterparty`/`ledgerName`/`party`
  field. `src/downstream.ts`'s `ledgerVouchers()` extracts `.vouchers`, and
  `src/review.ts`'s `NAME_FIELDS` list uses the real field names. Re-check
  this against the live server if `tally_prime_mcp_server` changes shape —
  the recorded fixtures do not update themselves.
- `src/vault.ts`'s `Vault.entries()` must return each alias in its original
  case (e.g. `"Creditor 1"`), not the lowercased lookup key used internally
  for case-insensitive `resolve()`. Getting this backwards silently breaks
  `demaskText` (the alias text in a masked finding/report never matches),
  which is exactly the de-masking path the trial balance report depends on.
- **Tally's ledger master balances are raw Tally sign: negative = debit** —
  while everything downstream of the gateway is positive = debit (R-MCP-5).
  The sibling server's own `tally_trial_balance` flips with `-toAmount(...)`
  (its `src/tools/reads.ts`), and `src/downstream.ts`'s `ledgers()` flips it
  at the gateway boundary too (fixed 2026-09-13, source-verified only). From
  WSL, live Tally is reachable at `127.0.0.1:9000` under mirrored networking;
  the NAT-mode host address `172.21.80.1` is stale and times out — do not use
  it. Its fixtures encode the raw master
  sign (`test/fixtures/tally-responses.json`). Any new consumer of master
  balances should rely on this convention, never re-flip.
- The masking group-name allowlist (`CLEAR_ROOTS`/`PRIMARY_GROUPS` in
  `src/classify.ts`) was verified against one live company, SJ Infra
  (FY 25-26), on 2026-09-08 — 63 groups read from `tally_get_groups`,
  corrected in commit `e883445`. What that verification found:
  - Tally spells it `"Branch / Divisions"`, with spaces around the slash.
  - A top-level group's `parent` field is not empty — it is a U+0004
    control character followed by `" Primary"` (Tally's internal root-of-
    primaries node). The ancestry walk treats that value as a root
    terminator exactly like an empty parent.
  - `Bank OD A/c`, `Secured Loans` and `Unsecured Loans` sit under the
    primary group `Loans (Liability)`, not at top level.
  - A real company can park operational sub-groups directly under Sundry
    Creditors (e.g. `SALARY`, `Wages`, `SITE EXPENSES`, `SUB CONTRACTORS`);
    these mask correctly by ancestry with no special-casing — this is
    exactly why the policy is default-mask rather than an enumerated
    mask-list.
  - This was verified against ONE company. A different company can still
    carry group names neither verification has seen; default-mask plus
    `config/overrides.json` is the safety net for that, not a guarantee
    the allowlist itself is complete.
- `TALLY_MCP_ARGS` must be a JSON array of strings whenever any path in it
  contains a space (every path does on the machine this was verified on) —
  see `src/config.ts`'s `parseDownstreamArgs`. A plain whitespace-separated
  value still works only when no argument contains a space.

## Sharp edges found wiring milestone 1 up for real (2026-09-09)

- **The upstream Tally MCP server is `F:\Software Projects\tally_prime_mcp_server`**
  (package `tally-prime-mcp-server`; its `dist/` is gitignored build output,
  not committed — run `npm run build` in that folder after pulling its changes,
  then restart the gateway/session to pick them up). Confirm any candidate by
  grepping its `dist/` for the five tools
  `src/downstream.ts` calls. The `tally_mcp_server_v6` directory under
  `F:\AgenticWorkspace\Tally Prime Automation\` is a decoy — an unrelated older
  server registering none of them — and its `1766393040_`-prefixed sibling is
  empty.
- **Never compare `import.meta.url` to `process.argv[1]` as strings.** A file
  URL percent-encodes a space; argv does not. Getting this wrong made the
  gateway exit 0 in silence on every install path containing a space, which a
  harness reports only as "the server would not start". Same root cause bit
  `URL.pathname`, which yields the `/C:/...` form that Windows `fs` rejects.
  Both are now `fileURLToPath`-based in `src/index.ts` (`isEntrypoint`,
  `overridesPath`), covered by `test/entrypoint.test.ts`. Any new path
  derivation in this project should go the same way.
- `loadOverrides` fails open by design — a missing overrides file is normal —
  so it now takes a `warn` callback and `src/index.ts` prints the reason to
  stderr. Silence there is what hid the `pathname` bug for a whole milestone;
  keep the warning if that code is touched.
- **The `Read(<reportdir>/**)` deny rule also blocks Bash reads of that path**,
  verified in isolated `claude -p` runs (control without the rule leaks the
  file; control on a non-denied path proves Bash was genuinely enabled). So a
  single `Read(...)` rule is sufficient and no Bash restriction is needed. The
  method for re-verifying is in `harness/claude-code.md`.
- `harness/claude-code.md` is the verified, real-paths setup document and the
  single owner of the machine specifics; `harness/opencode.md` deliberately
  points at it rather than duplicating them.

## Sharp edges found during Milestone 2 (GST summary & mismatch, 2026-09-13)

- The masked tax-ID channel (design: `docs/design/2026-09-13-gst-summary-mismatch-design.md`)
  is the pattern every later tax-ID feature must follow: fetch IDs internally
  via the narrowest downstream field set (`tally_get_ledgers` verbose:true —
  *not* `tally_get_ledger`, whose ban stands), ingest ID-bearing operator data
  by file path only (`tb_gst_mismatch`'s `returnsPath`), correlate through
  vault aliases (`TaxId N`), and keep `redactTaxIds` on every outbound string.
- **Money figures in finding details must never be bare 6+-digit numbers**:
  `scrubDigits` eats digit runs of ≥6, and bare `"100000.00"` reaches the
  model as `"[number].00"`. GST details use Indian grouping
  (`1,00,000.00`) for this. The M1 check details still use `toFixed(2)` —
  the same latent collision is un-fixed there (milestone boundary).
- Party buckets in `gstBooks` must be creatable from either a tax line or a
  taxable line — whichever the voucher lists first — or taxable value reads
  zero for the normal Tally layout (party line before tax lines).

## Sharp edges found during Milestone 3 (single-ledger scrutiny)

- Every outbound string passes `scrubDigits` (6+ digit runs → `[number]`),
  so finding details must use `src/format.ts`: `money()` (Indian grouping)
  and `displayDate()` (`16-Jan-2026`). A bare `YYYYMMDD` or `100000.00`
  reaches the model mangled.
- Ledger balances for a period come from `tally_trial_balance` (date-bounded,
  positive = debit), never from the ledger master: the raw Tally master sign
  (negative = debit) is flipped once at the gateway boundary by `ledgers()`
  (see the M1 bullet above), but `CLOSINGBALANCE` is not bounded by any date.
- The downstream ledger report nests `taxBreakup.taxLedgers[]` and
  `matchCandidates[]`; `maskVoucherRow` in `src/review.ts` masks and sweeps at
  every depth. A new nested name field must be added to `NAME_FIELDS`.
- `matchedSide` is `"debit"`/`"credit"` from the live server but `"Dr"` in the
  older M1 fixture row; `ledgerVoucherRows()` accepts both.

## Sharp edges found during the WSL setup (2026-09-14)

- The gateway→upstream request timeout defaults to the MCP SDK's 60 s, which
  aborts `tb_review` on any real company. `TALLY_AGENT_DOWNSTREAM_TIMEOUT_MS`
  (parsed in `src/config.ts`, passed to `client.callTool` in
  `src/downstream.ts`) raises it; the upstream's `TALLY_TIMEOUT_MS` and Claude
  Code's `MCP_TOOL_TIMEOUT`/`MCP_TIMEOUT` must rise with it. The real ceiling on
  a large company is the upstream connector's whole-company voucher export (40 MB
  trial balance, 53 MB GST day book, no date filter), which can drive Tally into
  its `Error` state; a timeout there is upstream, not the gateway, and Tally
  recovers only on restart. Per-setup details: `harness/claude-code.md`'s WSL2
  section.
- WSL2 mirrored networking puts Tally at `127.0.0.1`, not a NAT-mode host IP;
  POSIX permission rules need the `//` prefix
  (`Read(//home/ram/tally-reports/**)`); and `TALLY_DEFAULT_COMPANY` is
  recommended because the upstream will not auto-select the loaded company. See
  `harness/claude-code.md`.

## Sharp edges found adding check 8 (ledger in wrong group)

- A finding `detail` may quote a ledger's whole name, never a word of it.
  `maskFinding` swaps only the whole string for its pseudonym, so a quoted
  fragment of a masked name reaches the model. `test/leak.test.ts` holds
  `orchid` and `medical` as secrets to catch exactly this.
- The `wrongGroup` key of `config/overrides.json` is read by
  `loadWrongGroup` (`src/overrides.ts`), separately from `loadOverrides`.
  Unlike `loadOverrides`, it throws on a bad keyword. `Finding.expected` may
  hold a group nature (`expense`, `asset`, …) as well as a side.

## TDS compliance review (design of record)

- The TDS review design is `docs/design/2026-09-14-tds-compliance-review-design.md`
  (operator-file contract, `TDS-` ordinal space, law table with its C1–C8
  confirm markers) — read that doc before touching `src/tds*.ts`.
- The TDS review rides the per-ledger monthly Ledger-Vouchers path, never the
  Day Book; the operator TDS file is the TDS `returnsPath` channel (path only,
  TANs never echoed); the FY-25-26-only law table lives in `src/tds-law.ts`
  with its C1–C8 confirm flags.
- **Booking-side sign (fixed 2026-09-22):** a TDS booking is a **debit** row
  on an expense/purchase ledger (a normal `Dr Expense / Cr Party` voucher);
  downstream of the gateway positive = debit, so `extractEvents`
  (`src/tds.ts`) tests `r.amount > 0` and takes `gross: r.amount`. The
  predicate previously tested a **credit** (`r.amount < -ZERO`), which never
  fires for a normal booking, so every real booking was invisible (0 findings);
  the unit fixtures encoded the same inversion until corrected with the fix.
  Never re-flip the sign: the gateway flip is `src/downstream.ts`'s `ledgers()`
  and `ledgerVoucherRows`' `sideSign`, once, at the boundary (R-MCP-5). The
  payment (party-ledger debit) and duty (credit = deduction, debit = deposit)
  predicates were already correct and are unchanged.
- **TDS party→master resolution is indexed once** (`masterOf`, `src/review.ts`'s
  TDS session): `analyzeTds` calls `panKeyOf`/`entityOf`/`deducteeTypeOf`/
  `certificateRateOf` per booking, and the linear `masters.find` each closure
  used blocked the event loop for 30+ min on a real FY 25-26 day-book run
  (~6.8k bookings against ~2.7k masters). Never reintroduce a `find` there;
  `test/tds-review-perf.test.ts` is the regression guard. On finding-heavy runs
  the remaining cost is masking (`maskKnownNames`, `src/mask.ts`): O(findings ×
  vaulted names), rebuilding a RegExp per entry per string.
- **The engine's duty side is the union of master-flagged duty ledgers and the
  operator template's `TDS Duty` rows** (`dutyLedgerNamesAll`, `src/review.ts`).
  Tally masters on a real company can carry zero TDS flags, leaving the
  master-derived set empty and every booking reported as undeducted; the
  template's `Ledger Kind: TDS Duty` rows are then the only duty signal.
  Master-flagged behaviour is unchanged (the union is a superset), canonical-key
  deduplicated; `test/tds-duty-ledgers.test.ts` guards both cases. Populating
  the duty side is necessary but not sufficient: if the books genuinely contain
  few duty credits against many bookings, the bulk of `tds_not_deducted` is
  **substantive**, not a wiring artifact — read that total as an upper bound.

## Sharp edges found fixing the s.194Q threshold (2026-09-23)

- **A non-wholeYear section's liable base is the running cumulative through
  each booking, never the year total.** The pre-fix code measured against the
  year-end aggregate, so every pre-crossing booking was liable whenever the
  year's excess covered it (on a real FY 25-26 run: 3,433 194Q findings, median
  ~₹888). `analyzeTds`'s per-aggregate loop now sorts a copy by date, computes
  the crossing with a running `before`, then a second pass tracks `cumulative`
  and takes `max(0, min(gross, cumulative - threshold.aggregate))`. Never
  re-measure against `agg.gross` here; `wholeYear` sections keep the old
  whole-year rule.
- **194Q is applicable by default** (captain, 2026-09-23). The
  buyer-turnover condition is an operator fact, not book evidence: the
  template's **optional `Settings` sheet** (`194Q Applicable`, pre-filled `Y`)
  and the JSON `section194QApplicable` key suppress the whole section when
  false; absent or blank means applicable. `parseOperatorTemplate` tolerates a
  missing Settings sheet (`settings194QApplicable`), `EMPTY_TDS_OPERATOR`
  carries `true`, `analyzeTds` skips 194Q aggregation when suppressed, and
  `TdsReviewResult.section194QApplicable` reports the state. Operator
  walkthrough: `docs/operator/tds-operator-template.md`.
- Measuring offline: a stub downstream whose `groups`/`ledgersTax` reject plus
  a day-book bundle runs `Session.tdsReview` with no live Tally (the session
  degrades by design and reads the bundle's groups/ledgers).

## Sharp edges found implementing depreciation (2026-09-16)

- The design of record is `docs/design/2026-09-16-depreciation-verification-design.md`
  (including §18.1 live validation) — read it before touching `src/depreciation*.ts`.
- The Ledger Vouchers report honours only the **last month** of a multi-month
  range (month chunking is correctness, not optimisation) and some rows leak
  **forward** into later windows, which is why the range re-filter in
  `ledgerVoucherRows` (`src/downstream.ts`) must never be removed.
- Block rates come from the **group** name; a `%` in a **ledger** name is a
  GST rate and must never be parsed as one (live ledgers end `- 18%` / `- 28 %`).
- Book depreciation is identified by the counter ledger's group and name
  (`/deprecia/i` under an expense root), never by voucher type or a year-end
  date; the live annual journal predates year end and leaves later
  acquisitions undepreciated (check `DEP-012`).
- A disposal can be routed entirely outside the asset ledgers (credited to a
  disposal ledger under `Sales Accounts`), so the disposal-signal income
  ledgers are a required input, and `DEP-007` fires critical on an unmatched
  disposal-signal row.
- **The depreciation review's two-pass residual skip does not fire on live
  Tally**: Ledger Vouchers seen from the expense side returns per-voucher rows
  (voucher-total amount, one display-particulars counterparty), so per-asset
  charge attribution is impossible there and pass 2 fetches every asset
  ledger. A full-FY run is ~12 min (needs the 900 s timeout chain in
  `harness/claude-code.md`); the skip remains under `TALLY_AGENT_DEP_DEBUG`
  diagnostics. See design §18.1 before trying to "fix" the skip.
- Masked review output masks block group names too (over-redaction beyond
  design §3's letter); the workbook de-masks them via the vault. Recorded so
  the two documents do not look contradictory.

## Sharp edges found implementing the TDS spreadsheet input (2026-09-16)

- The design of record is
  `docs/design/2026-09-16-tds-spreadsheet-input-design.md` (kept in the
  firstmate data tree, section-source report). Section resolution is
  `resolveSection(expenseLedger)` — one argument, no party — and a bare
  `194-I` key is rejected everywhere; only `194-I(a)` (plant/machinery) and
  `194-I(b)` (land/building) exist in the law table.
- `src/xlsx-read.ts` (reader) deliberately shares **no code** with
  `src/xlsx.ts` (writer): two independent zip+XML stacks, both zero-new-deps.
  The writer's `Sheet extends state` (used for the Winman fixture's
  veryHidden `List` decoy) is the only writer-side addition since the
  depreciation plan.
- Template parser and Winman parser share the error contract: sheet, row
  (as Excel shows it), column letter + header — never a cell value (a stray
  operator cell can be a PAN/TAN). The parse of the generated blank template
  is `EMPTY_TDS_OPERATOR`, which is also the no-operator-facts run input.
- Winman's Deductor block TAN is parsed and **dropped immediately**; it is
  never bound to a variable any caller can see. Winman challans are derived
  from the **Deduction sheet's allocation** joined to the Challan sheet by
  `(id, quarter)` (challan ids restart each quarter); the Challan sheet's own
  section label is never a section key, and a bare `194I` label counts into
  `skipped.noSection` instead of folding to either 194-I sub-section.
- `OperatorParty.pan`/`panRow` exist only for §8.4's template-vs-Winman PAN
  agreement check (error cites the Parties row, never the value); the JSON
  channel never sets them, and nothing downstream reads the PAN directly —
  the Winman-name join adopts the PAN through `vault.pseudonym(.., "tax_id")`
  like every other tax id.
- The writer emits `{header:""}` blanks fine, but `buildWorkbook` maps data
  cells positionally against `columns` — a row cell past the column list is
  silently dropped (the winman fixture caught this).

## Sharp edges found adding the offline day-book input (2026-09-22)

- The gateway's `StdioClientTransport` cannot receive a whole-FY day book —
  three of three attempts ended `McpError -32000: Connection closed` with the
  upstream exiting `code=0` mid-response, while a raw newline-delimited stdio
  client took the same export without trouble. This is why the day book is a
  file channel and why `scripts/export-daybook.mjs` eschews the SDK.
  Live-verified: whole-FY 14,356 vouchers = 16.0 MB written in 126 s.
- A Ledger-Vouchers call costs a near-fixed ~5.7 s whatever its row count,
  and `fetchLedgerRows` is sequential, so cost scales with *call count*
  (~600 active ledger-months ≈ 57 min). Optimise call count, never payload
  size — passing `dayBookPath` removes the calls entirely (measured month
  comparison: live 39 s vs file 12 s).
- The live day book returns `date` and sometimes `voucherNumber` as JSON
  **numbers**. `normDate` and the projector coerce with `String(...)`; any
  new comparison must too. A `===` between a string date and a numeric one
  fails silently and looks like "no data" — the Task 9 join probe hit
  exactly that before switching to `String(...)` on both sides.
- `readFile` + `JSON.parse` on a 67 MB day book measured **483 MB peak RSS
  in 3.0 s** (300k synthetic vouchers; scales roughly linearly, so the 64 MB
  `TALLY_AGENT_DAYBOOK_MAX_MB` default is safe on any machine with ≥4 GB
  free). Streaming is not needed below the ceiling.
- The verbose ledger master export carries no PAN and no TDS flags (the
  upstream never requests those fields) — those facts come only from the
  operator TDS file. What the masters really supply is `parent`, which
  drives classification and masking; a bundle's `ledgers`/`groups` arrays
  substitute for it (`mastersSource: "bundle"`), and with neither every
  ledger default-masks and raises `tds_daybook_ledger_unmastered`.
- The live Ledger-Vouchers report **dedupes its display rows**: entries
  repeating the same date, voucher type and amount collapse to one row, so
  a day-book projection legitimately yields 2,399-FY findings where live
  yields ~10 fewer `tds_not_deducted` per matching month window (whole-FY
  detection). The projector is per accounting entry — do not imitate the
  display dedupe to make the paths "match" (same D5 reasoning; recorded in
  design §10, 2026-09-22).

## Sharp edges found implementing the 26AS mapping template (2026-09-23)

- The fillable 26AS party-mapping template (`src/as26-template.ts`,
  `tb_write_26as_template`) is the Excel sibling of the TDS template: the
  operator fills the "Tally ledger" column and passes it back as
  `as26MapPath`. `loadAs26MapFile` dispatches on extension
  (`/\.xls[xm]$/i`) to `parseAs26MapTemplate`, else `loadAs26Map`;
  `Session.as26Review` calls `loadAs26MapFile`, so the JSON map is unchanged.
  Worksheet row numbers and JSON entry indices are different NUMBER spaces —
  the template error cites the 1-based Excel row, the JSON error the 1-based
  entry index; both never echo a name.
- The template is written directly by `buildWorkbook` (NOT the de-masking
  `writeWorkbook` vault wrapper): it carries real 26AS and ledger names on the
  operator's disk, like the report workbook, and nothing in it was ever
  masked. `tb_write_26as_template` pre-fills previously effective mappings
  (from the map) and one row per distinct canonical 26AS name (tax summed
  across summaries) for iterative re-fill; a name mapped to several ledgers
  emits its deductor row plus one follow-on row per extra ledger (same
  name/kind, blank tax), so a multi-ledger map round-trips on re-fill.
- The Tally-ledger dropdown is always backed by the `Ledgers` sheet's range
  (`Ledgers!$A$2:$A$N`), never an inline OOXML list: an inline list is one
  comma-joined quoted string capped at 255 chars and breaks on a comma or
  quote, so it cannot carry a real company's ledger list (thousands of names).
  The writer's `Column.validation` accepts `{ formula }` for exactly this; the
  `Ledgers` sheet is written even when the list is empty. The list comes from
  `dayBookPath` (`readDayBookLedgerNames`, which reads only `ledgers[]` and
  skips the period validation `readDayBook` enforces) else live masters
  (`Session.ledgerNames`, degrades to [] with a warning when Tally is down).
- Design of record §10 covers the workflow; operator walkthrough is
  `docs/operator/26as-mapping-template.md`.

## Sharp edges found implementing 26AS reconciliation (2026-09-22)

- The design of record lives in `docs/design/2026-09-22-form-26as-reconciliation-design.md`
  (ordinal table, tolerances, honesty rules, privacy contract, operator
  mapping workflow) — read it before touching `src/as26*.ts`.
- TRACES 26AS summary sheets are matched by normalized sheet name
  **ignoring hidden state** — every TRACES data sheet is hidden, unlike the
  Winman parser's visible-only filter. Detailed-sheet names band down
  (carry the last non-blank forward); transaction dates are text
  `dd-MMM-yyyy`, and float tails like `230000.8900000001` are round-2'd at
  the parser.
- TAN/deposit/subtotal columns are never bound by the parser; errors cite
  sheet/row/column, never a cell value. Real TRACES headers carry `(Rs.)`
  suffixes, so `bindHeader` is two-pass — exact token first, prefix second
  (`Amount Paid / Credited(Rs.)` ≠ `amountpaidcredited`); first bind wins,
  which is also what keeps `GROSSRECEIPT` from stealing its
  `GROSSRECEIPTSASPER26AS` column.
- check 003 is **taxable-only** since D3: `assessable_value_mismatch` compares
  26AS gross against books taxable (Sales-Accounts-root debit magnitudes) with
  `AS26_VALUE_TOLERANCE` (1000); the GST-inclusive reading was dropped from the
  check and re-homesteaded on the Deductors sheet. Its detail ends with the
  honest pointer "Bill-level value rows, where present, carry the per-invoice
  detail." — never promise a sheet that may be empty.
- `matchParties` is mapping-only (captain deviation): no canonical
  auto-match exists anymore — unmapped/ambiguous pairs become `mapping_gap`
  findings; `config/as26-map.json` follows the overrides-file semantics
  (missing→EMPTY+warn, malformed/dup/blank throw citing the entry NUMBER),
  `config/as26-map.sample.json` ships committed, and `tb_26as_review` takes
  an optional `as26MapPath` override for iterative correction.
- Books evidence split: deductions ride the month-chunked receivable-ledger
  path (`deductionEvents`, positive=debit at the boundary — never re-flip),
  sales ride the voucher walk (`booksSales`, one BooksSale per outward
  voucher, taxable = Sales-Accounts-root debit magnitudes; ref =
  `voucherNumber` because `VoucherRow` has no `reference` field). Party+period is
  the join; `kindOf`/`partyOf` are exported additively from `src/gst.ts`.
- `booksSales`' `kindOf` needs `ctx.groupOf(ledger)` populated from the
  **ledger master pairs** (`ledgersTax`/bundle ledgers), NOT the group tree:
  without a master row for a sales ledger its sale silently vanishes (test
  fakes must include sales-account ledgers in masters).
- All dates the review result emits are `displayDate`-formatted at the
  session boundary (schedule labels, recon items, book events): a bare
  `YYYYMMDD` string in any outbound string is eaten by `scrubDigits`
  (`[number]`). `tb_26as_review`'s books dates included.
- The 26AS books-side credit ledgers are the operator's **Credit Ledgers
  sheet** on the mapping template (`As26Map.creditLedgers`, `CreditLedgerMapping
  {ledger, kind}`, sheet name `CREDIT_SHEET`). The override is **PER KIND**:
  a kind with declared ledgers uses exactly those (verified against the ledger
  masters — an unknown name is a hard error, never dropped), a kind with none
  declared still runs the heuristic. Never make it whole-list: declaring only
  the year-scoped `TDS (FY:25-26) A/c` under `Loans & Advances (Asset)` must
  not silently drop a `TCS A/c` the rule already finds. The all-heuristic run
  keeps its hard error; a run that took a declared ledger never raises it (a
  company that books no TCS at all must not be told to name one). `counts.
  creditLedgerSource` is `{tds, tcs}`, one `"map"`/`"heuristic"` per kind.
  JSON maps carry no `creditLedgers` (template-only, the `banks` precedent).
- `receivableLedgers` is a name heuristic (`(tds|tcs)` + `receivable` under
  an asset root) with a hard operator-facing error when it finds nothing;
  when ledger masters degrade, a voucher-entry name fallback applies. The
  planned group-override key for it is NOT built (open follow-up).
- The combination search is honesty-bounded: unique-both-ways 1:1 pairing,
  subsets sized 2..4, >1 fit ⇒ `ambiguous` stays unmatched, >40 unmatched
  per side ⇒ `combinationSearchSkipped` flag; totals never mutate.
- The written workbook de-masks cells+titles on disk only
  (`writeWorkbook` + vault); its Deductors sheet carries
  `booksTaxableValue`/`booksGrossValue`/`as26GrossValue` set in
  `analyzeAs26`, and its Mapping sheet lists matches UNION gaps so an
  empty-map report doubles as the operator's correction worksheet.
  `maskedCountAs26` counts parties under `/^(\w+) \d+$/`.
- Two traps in the 26AS books path (fixed 2026-09-23, `src/review.ts`
  `as26Review`):
  - Every rows `Map` handed to `rowsByLedger` must be keyed by
    `canonicalKey(name)`, never the raw ledger name — a real ledger's
    uppercase letters make a raw key unreachable and the whole books side
    silently reads zero (the live and TDS day-book paths already did this;
    the 26AS day-book branch did not).
  - `receivableLedgers` must be given the **group tree as well as the
    ledger pairs** (`[...masterPairs, ...groups]`): a ledger's immediate
    parent is usually a group, so a ledger-only chain never reaches an
    asset root. Only fall back to the loose voucher-name heuristic when
    masters are genuinely absent (`masterPairs.length === 0`), never merely
  because the run is a day book — otherwise GST TDS receivables (under
  `Duties & Taxes`) are misread as income-tax TDS.
- **One 26AS deductor may own several Tally ledgers** (a customer split across
  a site ledger and a head-office ledger). `matchParties` groups mappings by
  `${kind}|${nameKey}` and emits one `PartyMatch` whose `ledgerKeys`/
  `ledgerNames` (original case, mapping order) hold the whole group; the
  `ledgerName` display label is `ledgerNames.join(" + ")` and is what every
  finding and the report's Mapping sheet print. `reconcileParty` filters with
  `new Set(match.ledgerKeys)` and `analyzeAs26` looks sales up with
  `match.ledgerKeys.flatMap(...)` — any new per-party computation must
  aggregate over the whole group, never one ledger. Both loaders keep only
  `seenPair`: a repeated 26AS name is fine, a ledger mapped to SEVERAL names is
  fine (a shared-ledger group, below), and only an exact ledger+name repeat
  is refused, citing entry/row number only. `maskReconMatch` masks `ledgerNames`
  element-wise as well as `ledgerName`, so the original-case array never
  escapes through the `...m` spread.
- **Shared-ledger groups (one Tally ledger, several 26AS names, 2026-09-29):**
  `matchParties` unions the name groups that share a ledger — as connected
  components over the bipartite name↔ledger relation, **partitioned by kind**,
  so a ledger mapped to a TDS and a TCS name stays two parties (the books side
  is kind-filtered, so no double count). A component with ≥2 names carries
  `shared: true` + `members[]` (each name's own 26AS tax and ledgers); both
  fields are ABSENT for a one-to-one party, so existing maps stay byte-identical
  (emit order = `groupsByKey` insertion order, ledgers in first-appearance
  order). `reconcileParty` short-circuits for a shared group: it sums the
  group's deduped ledgers against the SUM of the names' 26AS tax and returns
  **no** paired/combinations/unmatched items — the books carry no marker of
  which name a deduction belongs to, so pairing items between names would be
  guesswork. Hence `totalsOnly` is forced true: no 001/002/003/007/008, no
  drill-down rows, and the money check is `as26_totals_mismatch` (009, critical
  only on a real miss) listing every member name with its own tax. The Deductors
  sheet's party cell joins the member names, the Mapping sheet emits one row
  per member, and `as26Markdown` adds a "Shared ledger …" block. `maskReconMatch`
  must pseudonymize `members` element-wise AND `review.ts` must vault those
  names BEFORE the findings sweep runs — the 009 detail quotes them.
- **Bill-level drill-down shipped 2026-09-24** (`src/as26-bill.ts`, pure;
  wiring/masking in `src/review.ts`; three sheets in `src/report.ts`; design
  doc §11):
  - **Section strings are normalized before `lawOf`.** TRACES writes rent as
    `194I(a)`/`194I(b)`; `normalizeAs26Section` maps those onto
    `194-I(a)`/`194-I(b)` (case/hyphen/space tolerant) at the `linkInvoice`
    lookup only. Every other string passes through unchanged, so sections
    absent from the law table (`194R`, `206CL`) honestly fall to
    `approximate`. The row always stores/emits the ORIGINAL section — never
    rewrite a displayed section.
  - **`linkBasis` is the four-step A2 scheme** `reference` → `taxable-rate`
    → `invoice-rate` → `approximate` (no sale ⇒ `none`); rate steps use
    `lawOf(section).rates.standard` (a decimal) and are date-gated. The
    `Bill value mismatch` sheet's V rows are emitted ONLY for non-approximate
    links whose delta exceeds `AS26_VALUE_TOLERANCE`; an approximate link
    never produces a V row.
  - **The day-book channel has no bill reference**: `BILLALLOCATIONS.LIST`
    NAME is empty in the reviewed company and `parseVoucherRows` drops bill
    allocations anyway, while `projectLedgerRows` hard-sets `reference: ""`.
    Only the live channel surfaces `LedgerVoucherRow.reference` (carried into
    `BooksDeduction.reference`), so linkage step 1 fires live only; steps 2–4
    carry a `dayBookPath` run. Documented gap, no code change (M-5).
  - **The three new sheets exist with ids matching the pointers**: `Books
    not in 26AS` (`B1..`), `26AS unmatched` (`D1..`), `Bill value mismatch`
    (`V1..`), each with `link basis` + `window` columns; combination-consumed
    entries are absent from the two unmatched sheets. Finding details append
    `see <sheet> rows <ids>.` AFTER masking (001/008→B, 002/005→D, 007→B+D,
    003→V) and omit the pointer when the party has no such rows.

## Sharp edges found adding totals-only 194R/bank-194A and 20% FD TDS (2026-09-26)

- Design of record is design doc §12. Party routing is **totals-only at party
  level** (a party whose every summary section is 194R, or 194A with the
  operator-marked bank): books deduction events carry no section, so a
  per-section split is impossible, and a mixed party keeps bill-level
  behaviour. Checks 001/002/007/008 and all `buildBillRows` loops skip
  `recon[i].totalsOnly` parties; 005 stays.
- `As26Map.banks` comes only from the template's new **Bank Interest** sheet
  (JSON channel never sets it); **presence on the sheet is the bank mark** —
  "is a bank" is never guessed from names. `matchParties` unions the bank's
  interest/FD ledgers into the party, so the bank pilgrims even when its
  ledgers are absent from the master list.
- The bank-194A books side is built ONLY from the operator's ledgers
  (`review.ts`): one event per voucher touching a bank ledger; the TDS credit
  counts only inside such a voucher and only on a receivable ledger. FD
  debit is carried, never compared. A marked bank with zero ledgers surfaces
  check 009 as **review** (no zero-books critical).
- is20 (`src/as26.ts`): `|tax − 0.20×interest| ≤ max(1, 0.01×interest)`; a
  20% event is excluded from the totals compare and emitted as
  `result.fd20` (raw `BankBooksEvent[]`) → the session masks party/date →
  the `FD interest 20% TDS` workbook sheet (`F20-n` rows + a totals row).
  `writeAs26Report` tolerates a `fd20` of undefined (`?? []`) because older
  test fixtures build results without it.
- Mind the datetime and ordinal precedents: `count()` in `src/format.ts`
  formats a NUMBER — `${count(arr)}` is not `${arr.length}` (regression twice
  in one afternoon); checks 009/010 extend `AS26_CHECK_ORDINAL` (frozen table
  in the design doc §6 was not renumbered — new checks are appended).

### FD auto-assignment (addendum 3/3a, 2026-09-26, `src/as26.ts`)

- The Bank Interest sheet's FD column is **optional**; FD ledgers are
  auto-detected (`isFdLedgerName`: ancestry hits canonical `deposits
  (asset)` — only when ledger masters exist, `masterPairs.length > 0` in
  `as26Review` — AND the name carries whole-token FD/F.D/F-D/FIXED+
  DEPOSIT; EMD/security/retention never). Assignment: distinctive token or
  short form of exactly ONE listed bank → name-match; else exactly one
  bank listed → only-bank; else unassigned ⇒ one review finding
  AS26-011 `fd_ledgers_unassigned` (count + credit total via `money()`,
  names only in the workbook "FD ledger auto-assign" sheet).
- Short forms = curated rows (`BANK_CURATED_SHORTFORMS`, extend by adding a
  row; canonical-key match — a branch suffix in the 26AS name breaks the
  curated hit) + derived initialisms over tokens where **trailing generic
  words after the last "of" are stripped while keeping the first tail word**
  (so "United Bank of India" keeps UBI — stripping its INDIA made the
  derived UBI a UB and mis-assigned; and a grand filter is pointless —
  initial of every word, words-but-"of", words-before-"of"). Generic words
  (`BANK_GENERIC_WORDS`) include city names; extend on misfires.
- Matching is whole-token; a run of single-letter tokens joins, so "U.B.I"
  tokenises as U/B/I and still matches UBI (initials are punctuated).
  Two-letter forms are standalone tokens only — inside words never match.
  A short form fitting 2+ listed banks matches none (unassigned).
- Everything 3a-derived is simulated in tests: no real-data run — counts/
  amounts only on live verification.

## Masking sharp edges (whole-token substitution, 2026-09-23)

- `maskKnownNames`, `demaskText` and `maskFinding`'s ledger substitution in
  `src/mask.ts` are whole-token only, never bare substring replaces. A 26AS
  schedule row label or sale voucher reference can be the bare string `"1"`,
  vaulted under the doc role as `Doc N`; a substring replace turned
  `"1,40,011.00"` into the pseudonym three times and `"01-Apr-2025"` into
  `"0Doc N-Apr-2025"` (see the regression tests in `test/mask.test.ts`).
- Boundary guards: word boundaries always; a purely numeric value
  (`/^\d+$/`) additionally requires no numeric connector (`. , / : -`)
  attached to a word character, so `1` matches neither `1,40,011.00` nor a
  date's year. Alphabetic names must still match inside hyphenated references
  (`Inv-Acme Traders-2201`) — over-tightening the guard leaks real names
  (`test/leak.test.ts` catches it).
- `maskKnownNames` matches existing vault aliases first and leaves them
  untouched, or a real value that is a token of its own alias (`1` inside
  `Doc 1`) would re-substitute to `Doc Doc 1`.

## Winman 3CD PF/ESI design (2026-09-23)

- Read `docs/design/2026-09-23-winman-3cd-pf-esi-design.md` before touching
  `src/xlsm.ts` / `src/winman3cd.ts` / `src/pf-esi*.ts` — it is the design of
  record for the Winman 3CD round-trip foundation and clause 20(b) PF/ESI.
- The xlsm package stack (`src/xlsm.ts`) is a THIRD independent zip stack: no
  shared code with `src/xlsx.ts` (writer) or `src/xlsx-read.ts` (reader).
- Winman rows 1/2/6 are hidden machine state (row 1 form id = the discriminator,
  row 2 machine keys), the first data row is row 7, and `writeSheetRows` must
  keep rows `< firstDataRow` byte-identical or Winman re-import breaks.
- `pfEsiLedgers` (config/overrides.json) reaches the review through both
  channels (session default and per-call `overridesPath`); an explicit
  per-fund empty array replaces the heuristic wholesale — only a missing key,
  `null` or bare `{}` is unset. Evidence channel: day book primary, live
  Tally fallback; contributions arrive as fund-ledger credits (negate-free:
  `findFundLedgers`/`employeeEvents` take abs). V4 (Winman import click) is
  captain-operated and recorded in the design doc §10.1.

## Winman 3CD loans 269SS/T/ST (2026-09-25)

- Clause 31 (l.269SS/l.269T) and l.269ST live in `src/loans.ts` +
  `src/loans-law.ts` (its C1–C8 confirm table is the rules of record) with the
  operator template in `src/loans-file.ts` (`tb_write_loans_template` →
  `tb_loans_review` → `tb_write_3cd_loans`).
- The Winman loans sheet names carry `&` ("Sec.269SS Loans & Deposits",
  "Sec.269T Repayments Cheque & DD") and workbook.xml stores them escaped
  (`&amp;`). `resolveSheetPart` matches DECODED attribute values, so lookups
  must pass the unescaped name — a raw-bytes comparison against the part text,
  or the escaped form, never matches. The test fixture encodes exactly this.
- Unlike PF/ESI's date+number-only sheets, the loans sheets carry text columns,
  so `write3cdLoans` resolves every vault alias back to its real value through
  the cached `lastLoansVault` snapshot (26AS-template write-side precedent; on
  the operator's disk only). The operator PAN/Aadhaar rides
  `LoansSheetRow.panAlias` RAW through the engine (both books and template
  rows); `Session.loansReview`'s `maskRow` is the SINGLE vaulting point
  (`vault.pseudonym(.., "tax_id")`) — the engine never repaints a raw value as
  a pseudonym itself.
- Journal-mode movements are never auto-breaches (C3): a loan event with no
  cash/bank counter and no operator override earns one `loans_mode_unknown`
  advisory per party and no row; narration hints (RTGS/NEFT/IMPS/UPI) or the
  Settings `Default bank mode` give a bank movement its F-token (C4, default
  ECS).
- Bank-party loans are exempt counterparties (C6): an operator-declared
  `exempt` party's buckets are excluded from rows and from the
  splitting/max-amount advisories entirely.
- MAXAMOUNT/SQUAREDUP are movement-only from a 0 opening (C7): when ledger
  masters are absent (`mastersSource: "absent"`) each moving party earns a
  `loans_max_amount_estimated` advisory and the peak is an estimate.
- Loans checks occupy ordinals 19–26 in `CHECK_ORDINAL` (`src/types.ts`);
  ordinals 15–18 belong to the concurrent clause-44 lane (captain ruling).
  Never renumber.
- Sheet5 (Sec.269T Repayments Cheque & DD) is engine-empty by construction —
  the books cannot invent a declared cheque/DD repayment — and needs a
  sheets-4-style operator declaration channel (like `Cash-breach-declared`
  feeding sheet4) before it can carry rows.
- The fill clones `write3cdPfEsi` mechanics: INTER handshake asserted, per
  sheet the formId `269SS/269T_LoansAc/RpinCash` pinned; only non-empty sheets
  are written, a sheet the workbook lacks is skipped with a stderr warning,
  and a workbook carrying none of the seven refuses. Target is
  `<stem> - filled - <YYYYMMDD>.xlsm` inside the `outPath` directory (or the
  exact `outPath` when it ends in `.xlsm`), with a `realPathId` self-overwrite
  guard. Optional cells are written only when the row carries them — a
  defined-but-empty text value (`bearer: ""`) omits the cell rather than
  writing an empty inlineStr.

## Sharp edges found adding the loans 269SS/T addenda (2026-09-26)

- **OD/OCC-ancestry ledgers are BANK for loans review** (`bank od a/c`/`bank occ a/c`
  anywhere in the ancestry chain, canonical match; `isBankOdLedger`/`isBankOdLoan`
  in `buildLoansCtx`). They are bank for mode inference and 269ST externals (so OD
  cash withdrawals/contra transfers leave sheet6), AND they are excluded from
  loanLedgerEvents entirely — OD "loans" never row on sheets 1/3 even though they
  sit under Loans (Liability).
- The clause-31 auto-exempt map: `loanAutoExemptNames` (bank-name match on an
  NBFC-guarded token list; reason order **OD/OCC ancestry > bank name match >
  secured-loan ancestry**) → check `loans_auto_exempt` ordinal **27** (19–26
  never renumbered; test/loans-tools.test.ts pins the CHECK_ORDINAL total at
  23). Operator Y/N always wins; blank ≠ exempt at parse time; review-time
  auto-exemption must be flagged with the exact detail `auto-exempt: bank name
  match` / `auto-exempt: bank OD/OCC ancestry` / `auto-exempt: secured loan`
  (Secured Loans ancestry exempting, `isSecuredLoanLedger`). Template pre-fill
  happens ONLY at generation (tb_write_loans_template). `UB` is a whole-word
  token — a bank-lender name must clear BOTH the NBFC stem guard AND a bank
  token: the guard regexes are stems (`(?:^|[^a-z0-9])Financ` with no trailing
  boundary) so they match Finance/Financial; a whole-token guard never would.
- Two identity/openings channels are additive next to `{name,parent}` in day-book
  bundles: ledgers may carry `pan`/`gstin`/`address` (PAN/gstin uppercased,
  address keep-case) and `openingBalance` — **the bundle value rides the RAW
  Tally master sign (credit positive = loan outstanding); it is NOT already
  gateway-flipped, so the bundle path sets `openings` with the raw value and
  callers must not negate it again**, while the live trial-balance path keeps
  `-row.balance` (TbRows are gateway-flipped positive=debit, one more negation
  to outstanding). Double-negating the bundle value costs exactly 2× opening in
  MAXAMOUNT (009 fix, 2026-09-26, commit 724d366).
  Precedence: template PAN/address > master PAN/GSTIN-derived > master address;
  `maskRow` stays the single vaulting point. Openings never enter the 269SS/T
  crossing test (MAXAMOUNT only). The `loans_max_amount_estimated` gate is
  per-party `openings.has(key)` when the caller passed a map, else legacy
  `mastersPresent` — don't collapse the two.
- The upstream `tally_prime_mcp_server` needed a verbose `IncomeTaxNumber` → `pan`
  field (patched + built 2026-09-26; needs a server restart); it does NOT fetch
  Tally's Address (a list field in masters). PAN/address on real data stays
  not-yet-exercised until the operator re-exports the day book with the updated
  `scripts/export-daybook.mjs` (which now runs `tally_get_ledgers` verbose:true).

## Sharp edges found implementing clause 44 (GST expenditure breakup, 2026-09-25)

- Design of record: `docs/design/2026-09-24-gst-44-clause-44-design.md`; plan at
  `/home/ram/firstmate/data/ta-3cd-gst-breakup-plan/report.md`; code
  `src/gst44*.ts`, tools `tb_write_gst44_template` / `tb_gst44_review` /
  `tb_write_3cd_gst44` / `tb_write_gst44_report`; operator walkthrough
  `docs/operator/gst-44-operator-template.md`.
- **The Winman row-2 key `REGISTEREDUNDERGST` names the *not-registered*
  column F** — the registered-entity split rides C/D/E (`TOWARDSSUPPLIES`
  exempt, `COMPOSITIONSUPPLIER`, `OTHERS`). Never map columns by key-name
  intuition; the inversion imports the form backwards.
- `writeSheetRows` drops pre-existing rows ≥ firstDataRow, and the real
  workbook pre-fills only the `Capital Expenditure`/`Revenue Expenditure`
  labels in column A (rows 8/9) — the writer must carry the
  `PARTICULARS` labels itself or the import gets two label-less rows.
- The real workbook's xf 88 (quotePrefix numFmt 1) has no style twin, so the
  first clause-44 write also rewrites `xl/styles.xml` via
  `resolveStyleTwins`' append path (PF/ESI's workbook did not); the sheet's
  column G has no row-2 key and is never written.
- Day-book `ledgers[]` carry no GSTIN, so `gst44Review` calls the narrow M2
  `ledgersTax()` channel **live even beside a day book** (approved Decision 2,
  Q3) — a standing deviation from the PF/ESI "never alongside" rule.
  With no GSTIN evidence and uncovered spend-carrying parties it throws a hard
  operator-facing error (never fabricates unregistered by default).
- Bills of mixed evidence per party are split across buckets per voucher (Q5);
  composition is reachable only through the operator template's GST Status
  sheet; a GSTIN master with no tax charged defaults to the exempt column with
  a `gst44_composition_unknown` ambiguity finding (C6).
- The report's Clause 44 sheet title also echoes
  `Total expenditure: money(sum)` — numbers only, no names — so the C5
  books-total figure is checkable on-sheet; findings ordinals are
  TB-space 15–18 (`GST44-015..018-%d` ids).
- **TOTALEXPENDITURE is the BOOKS total (captain's v1 brief, 2026-09-27)**
  on every route to the Winman sheet: `readWorksheetTotals` uses the row's
  column B/I (`amount`), and `gst44()`'s `mkRow` adds the row's unattributed
  spend to its buckets. The four split columns (C/D/E/F = G+H) are unchanged,
  so a row deliberately does NOT add across — the shortfall is column J (not
  supply / paid to govt) plus anything unattributed. The unattributed finding
  stays informational (`review`/`warning`) and must never fail or block the
  fill. Never "restore" `total = amount - notSupply` or the attributed sum.

## Sharp edges found implementing the nature-wise working sheet (2026-09-26)

- Phase B of the captain's addendum (analysis of record:
  `/home/ram/firstmate/data/ta-3cd-gst-breakup/gst-working-sheet-analysis.md`).
  Code `src/gst44-treatments.ts` (vocabulary), `src/gst44-prior.ts`
  (prior-year reader), `src/gst44-worksheet.ts` (engine),
  `src/gst44-worksheet-template.ts` (writer); tool `tb_write_gst_working_sheet`;
  findings TB-028/029/030 (ordinals 28–30 after the merge: 19–27 are the
  concurrent loans lane; TDS-table-only numbering).
- **Column B (captain 2026-09-26h): REVENUE is the ledger's net FY movement
  (debits minus credits); CAPITAL is the debit total (additions only).** The
  26e fix had made the walk debit-only throughout (`if (e.amount <= 0) continue`),
  which left a real mismatch: the REVENUE "As per books" total was
  ₹72,12,02,418.73 against Tally's purchase + direct + indirect expense total
  ₹71,46,12,343.70 — the entire ₹65,90,075.03 difference was the credit side
  (returns, discounts, credit notes) of 19 three-root ledgers that debit-only
  column B dropped. Revenue now accumulates signed entries into `amount` and
  every treatment pot, so B and the buckets tie Tally to the paisa (modulo
  Tally's own aggregate rounding). Capital still skips credits: a year-end
  depreciation credit is the annual charge, not a reversal of an addition
  (netting it produced a negative capital sheet, −₹27.8 lakh, on the first real
  run), so capital's `amount` stays a debit sum and the 26e zero-row drop still
  holds. The Phase-A analysis doc's "≈₹3.16 cr" capital figure is the abs-sum of
  both sides, not the debit total.
- The FY 25-26 day book's group parents arrive **HTML-escaped** in the raw
  export (`"&#4; Primary"` for the root-of-primaries control char); the gateway
  reader de-escapes. Any direct raw-JSON probe must account for that.
- Real-run lesson: `Bad Debts Written Off A/c` seeded Exempt through party
  evidence (registered customers, no tax) before a `bad-debts` policy rule was
  added — written-off debts are not expenditure on any supply. Party-evidence
  seeds for non-purchase ledgers deserve the same scrutiny each run.
- Prior-year `Rates and Taxes` carried not_supply (J ₹40.46 lakh), agreeing with
  the policy rule, so it raises no change finding; the only prior_year_changed
  finding on the real run is Pooja Expenses (split profile, largest column kept).
- Addendum 2026-09-26g fixes (same regen `...-20260926f.xlsx`): new
  `bill-factoring` POLICY rule (interest/discount on bill factoring or
  financing → exempt; deliberately not bare `factoring`, which would hijack a
  taxable `-18%` factoring fee); and a `0%`-name ledger keeps its no-tax
  registered part exempt (`Acc.noTaxGstin` seeds D, taxed spend stays in F via
  a mixed seed — voucher-level tax flags can mix on one ledger, e.g. a freight
  line on a taxed purchase bill). Pre-existing `Financing Charges A/c`
  no-policy test updated: 26g supersedes it.
- Addendum 2026-09-26f fixes (two halves, same regen `...-20260926e.xlsx`):
  supplier GSTINs live in Tally's `LEDGSTREGDETAILS.LIST` sub-blocks
  (APPLICABLEFROM-dated, multi-registration capable), NOT in `PartYGSTIN` —
  `FETCH` cannot see them, only `NATIVEMETHOD LEDGSTREGDETAILS` (verified TDL
  mechanics; fix lives in the sibling `tally_prime_mcp_server` as `regListGstin()`,
   latest-dated non-empty block wins).
  The gateway needed no change: `writeGstWorksheet` already gap-fills bundle
  GSTINs from live `ledgersTax`. And the engine no longer seeds exempt from
  "GSTIN + no tax lines" (blocked-credit s.17(5) tax can sit inside the asset
  cost, e.g. the Creta) — a registered supplier with no tax now seeds others
  with a move-to-exempt-only-with-evidence note (`Acc.noTaxGstin`, mirroring
  26e's `taxNoGstin`). Exempt from party evidence is therefore dead; only
  policy/evidence/prior/`0%`-pattern seeds reach column D.
- Addendum 2026-09-26e fixes (`src/gst44-worksheet.ts`, `src/gst44-treatments.ts`):
  capital drops zero-debit rows (year-end depreciation credits); a voucher that
  charged GST seeds others even when the supplier master carries no GSTIN (the
  seed reason tells the operator to verify the registration — RCM is the known
  limitation); new `credit-card` evidence rule; `insurance` (incl. the
  `insurence` misspelling) always beats `urd`, with a `gst44_ws_rule_conflict`
  warning when a later evidence rule disagrees.
- Seeded D/E/F/G/H/I/J cells: D/E/H/J are literals but F/G/I are formulas
  (I=B, G=I-H-J, F=G-E-D) with no cached values until Excel recalculates — so
  a raw read of the .xlsx sees F=blank. Diff runs via Seeded-as + H literals,
  or implied F = B-H-J-E-D.
- **Approved-sheet → Winman write (2026-09-27, Q-F flow):** `tb_write_3cd_gst44`
  takes an optional `worksheetPath`; with it, `src/gst44-worksheet-read.ts`'s
  `readWorksheetTotals` recomputes the two clause-44 rows from the working
  sheet's LITERAL cells only (B, D, E, H, J) using the sheet's own identities
  (I=B, G=I−H−J, F=G−E−D) — never reading G/F/I, which are formulas with no
  cached value until Excel recalculates. Winman mapping: TOWARDSSUPPLIES=D,
  COMPOSITIONSUPPLIER=E, OTHERS=F, REGISTEREDUNDERGST=H (the unregistered
  column), TOTALEXPENDITURE=I=B (the books total, C5); the split columns
  C+D+E+F = G+H fall short of it by J (not supply / paid to govt), which has
  no clause-44 column. Without `worksheetPath` the source
  is unchanged (cached review rows). The source .xlsm is never overwritten.

## Sharp edges found implementing No TDS Disallowance (clause 21(b))

- Read `docs/design/2026-09-24-no-tds-disallowance-design.md` before touching
  `src/notds*.ts` or the notds branches of `src/review.ts` — it is the design
  of record for the 3CD clause 21(b) fill (s.40(a)(i)/(ia)/(ib)/(iii)).
- Section spelling map: the law key `194-I(a)` reaches the Winman TDSSECTION
  cell as `194I (a)` and `194-I(b)` as `194I (b)`; every other law key is its
  own spelling; a bare `194-I` throws everywhere.
- **The agent computes no disallowance percentages** — the sheets carry payment
  facts only; Winman applies 30%/100% itself. Percentages appear only in
  masked review prose quoting the law.
- **21(b) rows ARE the review findings, not a rescan** (2026-09-26 005): rows
  project `analyzeTds`'s own `clause21b: Clause21bBookRow[]`, accumulated at
  the exact `tds_not_deducted` / staged `tds_short_deducted` / `tds_not_deposited`
  raise sites (per-booking, 194Q party-month, and timing-only per-partner-draw).
  `booksCandidates` is now a pure projector over those rows — it must never
  re-derive a liability predicate from `events`/`liabilities` again, or the
  four sheets stop reconciling to the review (the 20260926j bug: 194Q flooded
  every per-booking liability → 1924 phantom rows; 194T was one lump row
  instead of one per partner draw). Advisories (`tds_threshold_crossed`,
  `tds_late_deposit`, master-gap) carry no 40(a)(ia) amount and are rightly absent.
- A per-partner 194T expense share rides `TdsDeduction.drawGross` (set only in
  the `draws` split in `extractEvents`); the timing-only monitor's row uses it
  for `gross`. `winmanSectionKey` (`src/tds-file.ts`) already normalizes Winman
  labels to law keys, so `a.section === d.section` challan matching is correct
  — a "deposited 0" row means genuinely uncovered, not a spelling mismatch.
- **`Clause21bBookRow.gross` is the UNDEDUCTED expense, not the payment**
  (captain 2026-09-26): on a `not_deducted`/`short_deducted` row it is
  `liable tax / applicable rate` (194Q party-month: only the liable excess
  beyond the ₹50 lakh crossing), and `tdsDone`/`tdsDeposited` are **0** — no tax
  was deducted on that portion. Only a `not_deposited` row still carries the
  payment base with `tdsDone` = the deduction. The engine's clause21b push
  sites own this (src/tds.ts); `booksCandidates` stays a pure projector, so
  never re-derive an amount in `src/notds.ts`. Rate guards there must test
  `rate > 0`, never `> ZERO` — `ZERO = 0.005` is a money tolerance and the
  194Q rate is 0.001, so `> ZERO` silently falls back to the full base.
- The clause-21(b) lane reads the TDS operator template, so it must be rebased
  onto whichever main carries the TDS lane's current `Settings` schema (e.g.
  `Late Deduction Interest`, 26o 061-067). `parseOperatorTemplate` throws on an
  unknown Settings row by design — do not loosen it to unblock a stale base.
- **A no-deduction 21(b) row must show an explicit `0` in the TDS done /
  TDS deposited columns** (captain 2026-09-27; a blank cell read as "not
  reported"). `write3cdNoTds` (`src/review.ts`) therefore emits each cell
  whenever the sheet carries the column (`doneKeyOf`/`depositedKeyOf`), not
  only when the value is `> 0`; the `40(a)(iii)` sheet has neither column key
  and stays unchanged. Test: `test/notds-write.test.ts` "writes an explicit 0…".

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

## Sharp edges found implementing TDS (2026-09-15)

- Pending C5, `interestOn`'s round100 applies the ₹100 treatment only to
  sub-₹100 figures; exact figures (the ₹225 worked example) pass through
  untouched behind `TALLY_AGENT_TDS_ROUND100_OFF=1`.
- Plan QA: Task 2's verbatim test pinned 12 checks but Task 9 names a
  `tds_threshold_crossed` advisory; resolved as ordinal 13 — the TDS table only
  (TB/GST/LS never renumbered).
- The live Tally gateway at 127.0.0.1:9000 returned `tally_list_companies`
  timeouts on 2026-09-15's run attempt, so Task 13's live `tb_tds_review`
  validation remains open, captain-assisted; the mechanical timeout chain is
  documented in `harness/claude-code.md`.
- Task 13's live validation was completed 2026-09-15: both narrow-month and
  full-FY runs execute end-to-end with the Task 12 degradation (see §10 of
  the TDS design doc), but the company's masters carry 0 TDS flags — zero
  findings is by construction until it masters its TDS flags or the operator
  file lands (a separate captain call).

## PAN from GSTIN when the master PAN is empty (2026-09-23)

- A ledger master with no PAN but a well-formed GSTIN now yields a derived
  PAN: `panFromGstin` (`src/review.ts`) requires a 15-char GSTIN whose
  chars 3-12 match `PAN_SHAPE` (`/^[A-Z]{5}[0-9]{4}[A-Z]$/`). The derived PAN
  feeds the same paths as a master PAN — `panOf`/`panAliasOf` (vault
  pseudonym), `entityOf`'s PAN 4th character, and therefore the s.206AA
  decision. A malformed/short GSTIN yields nothing (unchanged behaviour).
- Precedence: operator-template/Winman PAN > explicit master PAN > GSTIN-
  derived. The operator/Winman override deletes the key from `panDerived`, so
  an overridden deductee never carries the derivation note. `ctx
  .panDerivedFromGstinOf` (optional on `TdsCtx`) drives the
  `" (PAN derived from GSTIN)"` detail suffix; raw PAN/GSTIN never leave the
  vault.
- The no-PAN rate is a hard 20% (`S206AA_RATE` in `src/tds.ts`), NOT
  `law.rates.noPan` — the 194Q `noPan: 0.05` entry is unused. Never wire
  `rateFor` to `law.rates.noPan` without a captain call; the design of record
  is the s.206AA floor.
- Measured on one real FY 25-26 day-book run (counts/amounts only): 206AA-note
  findings 3162 → 771, 194Q `tds_not_deducted` 2296 → 1912, `tds_master_gap`
  542 → 416, total not-deducted ₹82,09,983 → ₹15,06,375; 1873 findings now
  carry the derivation note. The drop is the expected direction (many masters
  carry a GSTIN but no PAN); the residual 206AA findings are masters with
  neither.

## Sharp edges found implementing grouped 26AS matching + addendum 5a (2026-09-26)

- **The day-book channel has no `d.reference`** — invoice ties for the
  ref-group stage (`reconcileParty`, addendum 5) must be recomputed with
  `linkInvoice` (moved into `src/as26.ts`, re-exported by `src/as26-bill.ts`;
  circular dep now flows one way). Key the groups by `normRef(link.sale.ref)`;
  approximate-basis links count (the live 194C party's whole tie is
  approximate). The workbook "linked invoice ref" column and the engine
  agree by construction.
- **Grouped fit is unique-both-ways or nothing**: exactly one group per
  target AND one target per group; more fits ⇒ `ambiguous`, item stays
  unmatched. Combined with the bounded subset search, 11+1 book-journals
  against one 26AS row is the canonical case (B1–B11/D1).
- `as26Review`'s 5th argument is the MAP PATH STRING, not a parsed map.
- Findings/billRows/byParty party labels are the **26AS name masked with
  `vault.pseudonym(_, "debtor")`** everywhere consistently (findings, bill
  rows, fd20, byLedgerParty) — mixing roles breaks the sheet row-id pointer
  join. Party cells no longer show the ledger join.
- Bank parties report ONE books-tax channel (the operator-mapped events),
  both in check 009 and on the Deductors sheet; value delta picks the
  closest basis (taxable / GST-inclusive / interest) and names it.
- The bounded search's skip bound is 40 unmatched items per side; the skip
  is stated in plain words on the party's findings (append after masking).

## Sharp edges found restoring the bank 194A books tax (2026-09-26)

- The bank 194A books-tax channel (`src/review.ts` bankEvents) must test the
  receivable row as a **debit** (`amount > 0`); testing it as a credit zeroed
  every real bank event and kept the 20% rule dormant on live data. Bank
  `touched` is voucher-wide (entry order varies); the receivable debit counts
  when the voucher carries a mapped interest/FD ledger OR the row's display
  counterparty is one (`counterpartyOf`). A bank's FY interest total then
  splits honestly into a regular stream plus a set of `fd_20pct_tds` events
  whose tax is exactly 20% (excluded from the totals compare).

## Sharp edges found adding the rate-exact fallback's unexplained-only pool (2026-09-26)

- The addendum-7 rate-exact fallback's pool must be the UNEXPLAINED journals
  only — no `linkInvoice` link at all (any basis, approximate included) under
  the same capacity-aware linker the sheets use — never the whole unmatched
  tail. Approximately-anchored journals already have an invoice explanation,
  however weak; letting those guesses into the pool manufactures competing
  exact subsets that bury the true one (live: four pre-invoice journals
  summing exactly to their invoice's TDS lost among anchored decoys, 8 fits,
  honest give-up). `anchorOf` (`src/as26.ts`) is computed with the same
  `linkInvoiceWithCapacity` + ledger scoping the sheets use, so engine and
  workbook agree by construction; `test/as26.test.ts` pins both directions
  (unexplained-only unique fit matches; fully-anchored pool stays unmatched).
- `linkInvoice` prefers same-ledger candidates when `ledgerKey` is present
  (deductor spanning zone ledgers); every caller that has a ledger key must
  pass it (`reconcileParty` pools, `buildBillRows`), or cross-zone deposits
  anchor to the wrong zone's invoice and the pools disagree.

## Sharp edges found routing income-counterparty TDS debits (2026-09-26, addendum 9)

- Deduction events key on the row's display counterparty, which is the
  deductor on a normal two-line TDS-vs-party voucher — but on a gross-up
  journal (Dr TDS + Dr party, Cr income) the largest opposite-sign row is the
  income ledger, so the event keys to income, gaps as unmapped, and never
  joins the deductor's totals (live: a gross-up journal crediting an exempt
  income ledger left one deductor's 26AS over its books by exactly the TDS).
  `deductorKey` /
  `rekeyDeductionsToDeductor` (`src/as26.ts`, wired in `src/review.ts`'s
  day-book branch) fall back to the voucher's party line ONLY when the
  counterparty is not a party ledger and the party line is one (under Sundry
  Debtors/Creditors — a retention-money ledger is itself Sundry Debtors, so the
  party line must never win blindly: most normal debits carry it while the
  counterparty is the true deductor). No voucher or no party-type party ⇒ key
  kept, honest gap. The live path has no voucher party and is untouched.
- `rekeyed !== deductions` aliasing: when the re-key is skipped, never
  `length = 0` + re-push the same reference — that empties the array (killed
  6 review/report tests). Guard with `if (rekeyed)` on a nullable.

## Sharp edges found on retention-release journals (2026-09-29)

- A retention-release journal is SIX lines and its internal
  `Dr Retention / Cr Warranty Liability` transfer is the largest
  opposite-signed line of the tax row, so `counterpartyOf` named the warranty
  bucket and `rekeyDeductionsToDeductor` then fell to `partyLedgerName` —
  which is the retention bucket, itself a Sundry-Debtors ledger that passes
  `isPartyLedger`. Live: one deductor's whole 45,70,053.00 read as books tax
  0.00 and was filed against an unmapped retention bucket, inflating 26AS
  over books and making a 194C shortfall appear where none exists.
- **Mirror exclusion is OPT-IN (`CounterpartyHint.skipMirroredPairs`), not a
  change to `counterpartyOf`'s default.** A line mirrored by an equal-amount,
  opposite-signed line on a DIFFERENT ledger is an internal transfer, and
  that is exactly what an asset transfer in `classifyMovements`
  (`src/dep3cd.ts`) is — making it the default would reclassify depreciation
  transfers. Only `as26Review`'s `projectLedgerRows` call opts in.
- The mapped-deductor rule fires only where the party-line fallback would
  have won, requires that party line to be unmapped, and needs EXACTLY ONE
  mapped party ledger on the voucher (`soleMappedDeductorOf`). Two ⇒ today's
  answer stands and the event surfaces as an unmapped gap. `isMappedDeductor`
  is built from `map.mappings` alone — never the Bank Interest sheet, or a
  bank interest posting would key its receipt to the bank instead of the
  party.
- **The live 26AS path is refused (2026-09-29):** `tally_get_ledger_vouchers`
  returns one display counterparty per row and no voucher composition, so a
  journal that also moves funds between the company's own ledgers (the
  retention-release/warranty case above) cannot be attributed to its deductor
  live — the internal transfer is what the row displays, and the deduction
  keys to the wrong bucket. `tb_26as_review` therefore requires
  `dayBookPath`: `refuseLiveAs26Read` (guard + message
  `AS26_LIVE_READ_REFUSED` in `src/as26.ts`, called once from
  `src/review.ts`'s `as26Review` after the date check) throws without a
  bundle. The whole live branch stays in place under a DEAD-WHILE-THE-GUARD-
  STANDS comment; lifting the restriction is deleting that one call, once the
  upstream exposes the voucher's entries per row. Every other lane still
  runs live. Tests: `test/as26-review.test.ts` / `test/as26-report.test.ts`
  / `test/as26-leak.test.ts` now supply a day book; `test/as26-live-guard.test.ts`
  pins the refusal and that other tools still hit Tally.

## Sharp edges found implementing the 3CD TDS/TCS summary (2026-09-24)

- Design of record: docs/design/2026-09-24-tds-tcs-3cd-design.md. Read it before touching src/tds3cd.ts / src/tcs*.ts.
- The Winman TDS dropdown spells the rent sections "194I (a)"/"194I (b)" (space, no hyphen) while the law table uses
  "194-I(a)"/"194-I(b)": the only conversion is the WINMAN_TDS_SECTIONS table, never string surgery. Column K of both
  the TDS and TCS sheets is tax deducted/collected BUT NOT DEPOSITED (Winman's header), not the total.
- Quarter cells in Return details/Interest sheets take numeric literals 1-4 (dropdown INTER!$D$86 is numeric);
  the engine's "Q1".."Q4" converts only at the write3cdTdsTcs boundary.
- The operator TAN lives RAW in session memory (panOf precedent), reaches disk only inside the filled workbook,
  and must never appear in an error, preview, or tool response. Shape errors cite the Settings row, not the value.
- Interest-on-TDS quarters whose statement form is outside the sheet's five-form dropdown (24Q/26A/26Q/26QB/27Q)
  are skipped and listed in skippedInterestQuarters as "Q2:26QE" — form+quarter only.
- 206C(1H) is intentionally absent from TCS_NATURES (Finance Act 2025 removed it); the 13 Winman nature strings
  are exact-match (no trim) — a stray space breaks the dropdown on import.

## Sharp edges found in the 8-item TDS fix batch (2026-09-26)

- **Duty-line attribution (item 7):** `counterpartyOf` now returns the voucher's
  `partyLedgerName` whenever that party ledger is present among the entries and
  is not the line itself; the largest-opposite-sign rule is only the fallback.
  This is what joins `Dr Expense / Cr Party (net) / Cr TDS` deductions. The
  LIVE path cannot be fixed gateway-side: the upstream Ledger-Vouchers report
  row carries one display counterparty (`counterLedgerName`), no per-line
  entries — a false TDS-001 on live runs means the upstream must expose the
  party ledger per row.
- **The Deductor TAN is now parsed** (`WinmanFacts.tan`, item 1): it fills a
  missing operator Settings TAN, an operator value always wins, and a
  conflict raises a `tds_master_gap` diagnostic naming neither value. It lives
  in session memory like a PAN (panOf precedent) — never in an error, preview
  or tool response; it reaches disk only inside the filled workbook.
- **No-PAN master-gap is per party+section and only when TDS is due** (items
  4+5): an agg is reportable when it crossed its threshold, had a liability
  above tolerance, or its party had a joined deduction. Below-threshold
  parties are silent. Each gap's amount is that section's own gross.
- **Exposures:** s.40(a)(ia) is 30% of the EXPENDITURE (booking gross) of the
  affected bookings — `notDeductedBase`/`notDepositedBase` accumulators — not
  30% of the tax; s.271C = notDeducted + shortDeducted and now fires on a
  short-only run (no fully-missed deduction needed).
- **Deductee type is the PAN's 4th character** (P/H/C/F/A/B/T/L/J/G), incl.
  PANs derived from GSTINs; the Tally-master `tdsDeducteeType` field is no
  longer read and the "deductee type missing or Unknown" finding is gone.
  Letters a section's `pan4thChar` table does not name fall back to that
  section's standard rate inside `rateFor`.
- **Day-book bundles now carry per-ledger `pan`+`gstin`** (item 3):
  `export-daybook.mjs` runs `tally_get_ledgers` verbose; `readDayBook`
  normalizes both to null-able strings, older bundles load unchanged, and the
  bundle fills only PAN/GSTIN gaps the live masters left (live wins). Full
  PAN carry-through on a fresh export also needs the upstream's
  `tally_get_ledgers` verbose fields list to add `IncomeTaxNumber`
  (report deliverable, upstream repo) — until then the export carries the
  GSTIN and the PAN derives from it.
- Fleet findings label themselves now (item 2): statement findings say
  `statement Qn`, exposures carry a blank deductee; `maskLedgerName("")
  === ""` (blank short-circuit; never mint a pseudonym for "") and the
  statement labels are force-cleared in `tdsReview`'s classifier.

## Sharp edges found implementing the 2026-09-26c TDS addendum (joinEvents, ambiguous duty, 194-I)

- **joinEvents phase-1 must never claim across sections** (`src/tds.ts`): the by-voucher pick and the
  month-window filter both require `d.section === b.section`. A cross-section claim made BOTH bookings
  fire TDS-001 and removed the tax from the deposit chain (measured 8 vouchers on real data). When a
  duty row's section is null (ambiguous ledger), deposits join only by `e.ledger === d.ledger` — the
  `ledger` stamp on TdsDeduction/TdsDeposit is what makes that work.
- **Ambiguous duty ledgers resolve per row, never per ledger**: `dutyCandidatesOf` (optional on
  TdsCtx) supplies the ledger's candidate sections; `extractEvents` intersects same-voucher (else
  same-date, counterparty-matched) debit-expense sections with that candidate set and adopts the
  section only when exactly one remains. Evidence outside the candidates never resolves (contradictory
  evidence, never guess); unresolved rows stay skipped under the ledger-level TDS-012, and two-line
  journals with no resolving same-date bill stay unresolved by design.
- **perMonth is a whole-month rule, not excess-only**: when `threshold.perMonth` is set (194-I a/b),
  every booking of a month whose total exceeds the threshold is fully liable (month-scoped sibling of
  wholeYearOnCross); `agg.crossed` fires at the first booking of the earliest over-threshold month.
  Aggregate-only sections are untouched.
- **Null-section deposits belong to no Winman section**: `tds3cd.ts`'s deposit loop skips
  `dep.section === null`; never widen that to "resolve by ledger".

## Sharp edges found implementing the 2026-09-26i TDS addendum (subsequent-year challan coverage)

- **Winman challan coverage is deductee-level, never section+month** (`src/tds.ts`
  `SubsequentDeposit`, `src/tds-file.ts` `WinmanAllocation`, `src/review.ts` winmanName
  join): a post-FY challan covers a book deduction only on same party (template Winman
  Deductee Name, exact trimmed match — §8.4 precedent, never fuzzy) + same section +
  same deduction month + tax within `TDS_TOLERANCE`, only when the books carry no 1:1
  deposit for it, only when the challan date is after the FY end and on/before the
  `s139DueDate` audit-case date (`src/tds-law.ts`), each allocation consumed once. Live
  proof: the template mapped the rent ledger to a 194T-only Winman name while the
  return's 19,000+6,600 pattern sat under a different deductee — the four Feb/Mar rows
  correctly stayed `tds_not_deposited`. A wrong declaration fails closed; never
  "fix" it with fuzzy matching — the operator corrects the name.
- **Challan matching runs before the month pool and skips it** (`analyzeTds`): a
  challan-covered deduction never consumes pool FIFO and never fires `tds_not_deposited`
  (so no s.40(a)(ia) base); lateness interest (ii) still runs deduction→challan date as
  `tds_late_deposit`, and `tds3cd.ts` excludes the covered credit from notDeposited
  (the 21(b) writer needs the same exclusion — applied worktree-local in the wt-e
  merge for the e-workbook; the sibling branch owns that file).
- **The month pool never contains a 1:1-joined debit** (fixed with 26i): the pool
  double-spent it — once through the join, once as pool — so a February book deposit
  silently covered March's need. `test/tds-subsequent.test.ts` guards the 26i paths;
  the wt-e merged-tree port procedure (copy wt-notds, port hunks, rebuild, run
  notds-write-e.mjs) is session scaffolding, not repo process.

## Sharp edges found implementing the 2026-09-26k TDS addendum (perMonth year guard, 194Q month matching)

- **The 194-I perMonth proxy is gated on the year cap** (`stampLiabilities`, src/tds.ts): the FA 2025 proviso
  tests ₹50,000 per month or part of a month, but the books' voucher month is only a proxy (one voucher can
  book several months' rent as one lump — the TDS-013-75 false positive). Months partition the year, so
  "some month > 50k" ⇔ "year > 50k × 12"; the proxy now counts only when the year gross exceeds
  `perMonth * 12`. Accepted residual: a genuine single >50k month in a ≤6L year stays silent (captain's
  word, 2026-09-26). The old per-booking fixtures pin the guard — scale synthetic 194-I runs past the 6L cap.
- **194Q findings match at party-month level** (pass 2): the month's resolved duty credits
  (`monthCredit`) are matched against the month's whole liability — zero credits raise ONE
  `tds_not_deducted` per party-month, partial credits raise ONE `tds_short_deducted` for the shortfall;
  the per-booking not/short raise is skipped for 194Q only. The ₹50 lakh FY crossing and the C8
  excess-only base are untouched, and the 1:1 join still drives late-deduction/deposit chains for the
  joined row. Month-level details carry the same panNote (206AA / PAN-derived) suffix — tests assert it.
- **Run-to-run comparisons must pin the operator file version**: the 20260926f run predates the
  template dedup (its backup `tds-operator-filled-rvs-25-26-dedup-backup-20260926f.xlsx` has 0 statement
  rows vs 4 now), so statement_missing 3→0 and some deposit-chain reshuffles between f and g are operator
  data changes, not engine changes. Winman allocations under an undeclared deductee name are dropped by
  the 26i join in every run — a corrected threshold just changes which bookings surface them, turning
  late_deposit wording into honest `tds_not_deposited` (fail-closed).

## Sharp edges found in the 2026-09-26o TDS batch (same-PAN, debit notes, 194T)

- **A deductee is keyed by PAN when known, else its canonical ledger name** (`deducteeKeyOf`, src/tds.ts).
  It is used in aggregate keys, `monthLiability`, `monthCredit`, `joinEvents` and the subsequent-year
  challan match. Two Tally ledgers of one PAN are one deductee for every per-party figure; never fall back
  to the raw ledger name in a new per-deductee computation.
- **`netDebitNotes` nets an expense-ledger credit from a TDS party against that deductee+section's
  bookings, LIFO (most recent open bill first)**, and drops a fully-netted booking. The grain is
  **deductee + section, not ledger**: a materials debit note on one material ledger must cancel a bill on
  another material ledger of the same party (verified on a real materials party). Expense credits count in
  any voucher type, including `Debit Note`. An advance credit (note before any bill) carries forward.
- **`counterpartyOf`'s duty-line rule (src/tds-daybook.ts)**: with an empty `partyLedgerName`, a
  duty-ledger line's counterparty is the voucher's known party line (largest-magnitude party entry,
  same-sign first) — not merely the largest-opposite-sign expense line. This is what recognises
  `Dr Interest / Cr Party (net) / Cr TDS on Interest - 194A` journals. The hint is supplied by `review.ts`
  from the duty/party key sets; without it the old fallback stands.
- **A deductee's total short-deducted tax for the FY below ₹100 is not reported**
  (`SHORT_DEDUCTION_MIN`, src/tds.ts), measured per deductee across all rows/sections, not per row. The
  suppressed amount also leaves the s.271C base.
- **194T is timing-only** (`timingOnlySection`, src/tds-law.ts): no not-deducted / short / threshold /
  no-PAN finding ever fires for it; deposit lateness and not-deposited still do. A 194T booking may be
  formed even when its counterparty is **not** in `ctx.tdsParties` — partner remuneration credits the
  partners' Capital/Current accounts, so the operator's 194T expense mapping (not a declared party) is the
  liability signal. Because the 1:1 partner join often cannot fire (lump journals give each partner a
  different counterparty), a section-level monitor raises `tds_not_deposited` for the un-covered credit
  and feeds the section's whole booking gross into `notDepositedBase` once — the s.40(a)(ia) exposure is a
  bounded estimate, never per-partner. The 21(b) clause-34 row aggregates 194T by section.
- **A lump duty credit splits per partner draw** (2026-09-26o item 038/039): a 194T voucher credits the
  duty ledger once and debits EACH partner current account (`Dr A 15L / Dr B 15L / Cr Duty 30L`). The
  day-book projection stamps the credit row's `draws` (`LedgerVoucherRow.draws`, src/downstream.ts /
  src/tds-daybook.ts `projectLedgerRows`) and `extractEvents` emits one deduction per draw (proportional,
  last draw takes the round2 remainder). Deposit coverage for a timing-only section then matches by
  **section + deduction month + tax alone** (`loose = timingOnlySection(d.section)` in the subsequent-challan
  loop), because the partner Capital Accounts are not operator Parties / Winman names — an allocation whose
  Winman name no template party declares is carried into `ctx.subsequentDeposits` with `party` = the raw
  Winman name rather than dropped (src/review.ts). The live Ledger-Vouchers path has no voucher composition
  and keeps the single-counterparty behaviour. The section's s.40(a)(ia) base is proportional to the tax
  actually NOT deposited (`section gross × undeposited tax / the section's total tax`, 2026-09-26o item 041):
  a challan that did cover its share removes that share of the base — never the whole section gross. The same
  proportional rule applies per booking (`b.gross × ded.tax / liability`) for non-timing sections, so a split
  draw that carries only part of a booking's tax disallows only that share.
- **Duty and expense classification is the operator's `Ledger Kind`** (`kind?: "expense" | "duty"`,
  omitted = expense; src/tds-file.ts, src/review.ts `expenseLedgerNames`). A hand-built test operator that
  omits `kind` on a duty row makes that ledger expense too, so its duty credit is read as a reduction of
  the same deductee+section — always set `kind: "duty"` on duty rows in fixtures.
- **A subsequent-year challan's own Interest column is the interest actually paid** (2026-09-26p):
  `WinmanAllocation.interestPaid`/`challanId` come from the Challan sheet's `Interest` column joined by
  `(ID No., Quarter)`; `SubsequentDeposit.interestPaid`/`challanId` carry them to the engine. A timing-only
  credit covered by such a challan now raises `tds_late_deposit` with s.201(1A)(ii) interest
  (`1.5% × calendarMonths(deduction, deposit)`, stamped on `ded.interestII`) — but **only for an orphan
  credit** (`if (d.booking) continue`, src/tds.ts): a booked credit's lateness is already raised by the
  per-booking `ded.subsequentDeposit` branch, so reporting it here too would double-count. The clause-34
  `Interest on TDS` row's `paid`/`paidOn` are taken from those challan stamps, **deduped by
  `subsequentChallanId`** (one challan covering several deductions of a section — the two 194T partners —
  has its single interest counted once; `section|depositDate` is only the fallback key).

## Winman 3CD depreciation (clause 18 additions/deletions, 2026-09-27)

- Design of record: `docs/design/2026-09-27-winman-3cd-depreciation-design.md`; engine `src/dep3cd.ts`
  is voucher-level (day book only) and NEVER reuses `groupAcquisitions` — its 90-day same-party merge
  folds two same-day purchases into one row.
- Deletions are consideration received (money/party debit minus output tax, or the transfer out of a
  Sales-Accounts disposal ledger), never the asset credit: P/L-on-sale journals DEBIT asset ledgers on
  real books and must classify `sale_pl`, not as an addition. D3CD-006 is scoped to the Sales-Accounts
  chain (`SALES_ACCOUNTS` in `src/dep3cd.ts`) — an income-root test alone wrongly flagged a
  non-sale "Profit on Sale…" ledger under Indirect Incomes.
- The first-column block text must be one of the workbook's own dropdown strings (`readListValues`);
  Winman's validation is only a warning, so the writer refuses anything else. Rows carry no names —
  the writer needs no vault de-masking.
- D3CD findings have their own ordinal space; `CHECK_ORDINAL` is untouched. `INCLUDE_SAME_VOUCHER_CHARGES`
  is `false` (captain Q3: an expensed charge is not added), so D3CD-010 never fires; a cash-in-hand part
  over ₹10,000 is EXCLUDED and flagged D3CD-011 (Q9).

## Sharp edges found fixing the TDS pairing cascade and TDS-012-1 (2026-09-29)

- **One duty credit may cover SEVERAL bookings** (`TdsShare` on `TdsDeduction`,
  `allocateSplitCredits`/`splitSubset` in `src/tds.ts`, run before the 1:1 walk). A month of bills
  netted into one TDS journal is ordinary practice; under the strict 1:1 `claimed` set the credit
  attached to one bill, stranded the other, and the pairing cascaded by nearest date (measured on a
  real FY: 9 findings, ~95% of the not-deducted total, for deductions present in the books).
- **A share is a per-booking VIEW, never an event**: the credit keeps its own tax, its 1:1 deposit
  chain, its return-challan allocation and its month-pool place. A share must never enter those
  streams — a 26Q return carries ONE allocation for the journal, not one per bill, so injecting
  per-booking deductions into `events.deductions` would break the challan and pool matching.
  Consequences to remember: pass 2 reads `dedTax` (the share) in place of `ded.tax` everywhere;
  interest stamps go on the SHARE and `src/tds3cd.ts` sums `d.shares[].interestI/II` (stamping the
  parent would both double-count per booking and lose all but the last).
- **Exact 1:1 always wins over a split** (a credit that fits one liability is never spread), the
  search is bounded (`SPLIT_MAX_BOOKINGS` 4, `SPLIT_MAX_CANDIDATES` 12, same 30-day window as the
  1:1 join) and the tie-break is total (fewest bookings, tightest date span, earliest) so the choice
  never depends on iteration order.
- **The party-month coverage rule hides a same-month split.** `monthCredit >= monthLiability`
  already silences two bills and their credit when all three fall in one month, so a regression test
  for the allocation MUST place the bills in months the credit is not in, or it passes with or
  without the fix. (`test/tds-split-allocation.test.ts`.)
- **"Mapped" for a duty ledger means ≥1 candidate section, never `dutySectionOf !== null`** —
  `dutySectionOf` returns a section only for a SINGLE mapping, so reading its null as unmapped
  called the 194-I hire/rent ledger (mapped to both 194-I(a) and 194-I(b)) unmapped while all
  ₹4.42 lakh of its credits were in fact analysed per row. Without `dutyCandidatesOf` the caller
  cannot disambiguate at all, so the old gap wording is then the honest one.
- A not-deducted finding now ends with `creditEvidence(...)` (dates and `money()` only, never a
  name, voucher number or PAN) naming the credit that was considered — "no duty credit was found"
  sent the operator hunting a payment the books already held.
