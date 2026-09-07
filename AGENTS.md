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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
