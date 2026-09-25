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
- check 003's captain-deviation wording: when only the GST-inclusive
  interpretation matches, the finding detail says "matched on the
  GST-inclusive value" (also in the written report), and it fires only when
  BOTH interpretations miss by > `AS26_VALUE_TOLERANCE` (1000).
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
  `seenLedger`: a repeated 26AS name is fine, a ledger mapped twice (same or
  different name) — which also catches an exact duplicate row — is refused
  citing entry/row number only. The reverse (one ledger → many deductors)
  cannot happen and stays refused. `maskReconMatch` masks `ledgerNames`
  element-wise as well as `ledgerName`, so the original-case array never
  escapes through the `...m` spread.

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
  address keep-case) and `openingBalance` (raw tally sign, flipped ONCE at the
  boundary into `buildLoansRows`' `openings` map as outstanding, positive=owed).
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
