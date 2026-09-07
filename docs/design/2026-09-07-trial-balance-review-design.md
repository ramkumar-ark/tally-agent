# Tally Agent — Trial Balance Review (Milestone 1) — Design

Date: 2026-09-07
Status: approved in design discussion; pending written-spec review
Project: tally-agent (local-only)
Depends on: `tally_prime_mcp_server` (separate local-only repo, unchanged by this work)

## 1. Purpose and scope

Give an accountant finalizing company accounts a read-only trial balance review, driven
from a chat harness, where no raw accounting PII reaches the language model.

**In scope for this milestone**

- A masking MCP gateway that is the only MCP server the harness connects to.
- Seven deterministic trial balance checks, computed in code.
- Masked findings, a de-masked Markdown report, a de-masked findings CSV, and a session audit log.
- Harness configuration for Claude Code and opencode.

**Explicitly out of scope for this milestone**

- Any write to Tally. The gateway exposes no write tool and never enables the downstream
  server's write path.
- Excel (`.xlsx`) output. CSV only; Excel is its own milestone in the project README.
- GST summary/mismatch analysis, single-ledger scrutiny, and the finalization checklist.
  Each is a later milestone that builds on this one.
- Name detection inside ledger names. Deferred in favour of a deterministic group rule plus
  an operator override file (§4.3).

## 2. Decisions taken

| Decision | Choice | Rationale |
|---|---|---|
| First workflow | Read-only trial balance sanity checks | Deterministic, testable without live Tally, smallest data exposure, natural front door to the finalization checklist |
| Agent shape | Chat agent inside an existing harness | Captain's choice; no bespoke UI to build or maintain |
| Harnesses | Claude Code and opencode | Both speak stdio MCP and both support per-path file permissions |
| Where masking lives | A gateway MCP server between harness and Tally server | The harness is the model; masking must be in the path, not advice to the model |
| Where checks run | In the gateway, in code, on unmasked data | An LLM scanning a trial balance is worse than a loop and unverifiable |
| Tally server | Unchanged | Keeps a hardened gateway a gateway; agent evolves independently |
| Masking policy | Mask by default; clear only for known-impersonal groups | A mask-list leaks on every group we forget; a clear-list fails safe |
| Report de-masking | Gateway substitutes real names on the way to disk | Mirrors downward de-masking; model is not in either path |
| Language | TypeScript on Node 22 | Matches the Tally server; one MCP SDK; toolchain already present |

## 3. Architecture

```
harness (Claude Code / opencode)
   │  MCP over stdio  ── the only connection the model has
   ▼
tally-agent gateway                    ← this project
   │  MCP over stdio
   ▼
tally_prime_mcp_server                 ← existing, unchanged
   │  XML/HTTP
   ▼
Tally Prime :9000
```

The harness is configured with exactly one MCP server: the gateway. It has no configuration
for the Tally server. That is the core safety property — unmasked data is not reachable by
the model, so no prompt can obtain it.

### 3.1 Components

**Downstream client** (`src/downstream.ts`)
Speaks MCP as a client to `tally_prime_mcp_server` over stdio. Spawns it as a child process
with `TALLY_ALLOW_WRITES` unset. Responsible only for transport and typed result parsing.

**Classifier** (`src/classify.ts`)
On first use per company, fetches the group tree once via `tally_get_groups` and builds an
ancestry map. Exposes one question: given a ledger's immediate parent group, is this ledger
masked or clear? Cached for the process lifetime, keyed by company.

**Vault** (`src/vault.ts`)
Holds `real name ↔ pseudonym` for masked entities. In memory only; never written to disk
except under an explicit debug flag. Pseudonyms are stable for the process lifetime, so the
same party is `Creditor 23` in every tool result and in the final report. Pseudonym form is
`<RoleLabel> <n>` where the role label comes from the ledger's masked group
(`Debtor`, `Creditor`, `Bank`, `Loan`, `Capital`, `Deposit`, `Investment`, `Branch`, `Ledger`).

**Masker** (`src/mask.ts`)
Applies the vault plus digit-run scrubbing to any payload leaving the gateway. Single choke
point: no tool result reaches the model except through it.

**Checks** (`src/checks/`)
One file per check. Pure functions from `(rows, groupTree, openings)` to `Finding[]`.
No I/O, no MCP, no model.

**Tool surface** (`src/tools/`)
Deliberately narrower than the downstream surface. Not a passthrough.

### 3.2 Data flow for one review

1. Model calls `tb_review(company, asOnDate)`.
2. Gateway calls the downstream `tally_trial_balance` and `tally_get_groups`, and
   `tally_get_ledgers` for opening balances.
3. Classifier tags each row masked or clear.
4. Checks run on **unmasked** data.
5. Findings are built, then passed through the masker.
6. Model receives masked findings and writes the narrative.
7. Model calls `tb_write_report`; the gateway substitutes real names as it writes to disk.

**Accepted consequence:** the model never sees the trial balance itself, only the exceptions.
It cannot answer "what is the balance on that account" unless a lookup tool exposes it. This
is intentional — it is what keeps masking cheap and findings verifiable.

## 4. Masking policy

### 4.1 Classification is by ancestry, not immediate parent

A ledger's masking status is determined by walking its group ancestry to a recognised root.
A user group `Loans - Directors` under Unsecured Loans masks; a user group `Freight Outward`
under Indirect Expenses stays clear. Any group whose ancestry does not reach a known-impersonal
root is masked, so a newly created group is safe on the day it is created.

### 4.2 Group policy

**Left in the clear** (known-impersonal Tally predefined groups and their descendants):
Sales Accounts, Purchase Accounts, Direct Expenses, Indirect Expenses, Direct Incomes,
Indirect Incomes, Duties & Taxes, Stock-in-Hand, Cash-in-Hand, Reserves & Surplus,
Provisions, Suspense A/c, Misc. Expenses (ASSET).

**Masked:**
Sundry Debtors, Sundry Creditors, Capital Account, Bank Accounts, Bank OD A/c,
Secured Loans, Unsecured Loans, Loans (Liability), Loans & Advances (Asset),
Deposits (Asset), Investments, Branch/Divisions, **and anything not recognised**.

Rationale for the non-obvious entries:
- **Capital Account** carries partner and proprietor names.
- **Bank Accounts / Bank OD A/c** ledger names routinely embed the account number.
- **Unsecured Loans, Loans & Advances** are populated with individuals.
- **Fixed Assets** is left masked by falling through to the default, since asset ledgers are
  occasionally named after the person holding them.

The predefined group list is fixed and known, which is what makes the clear-list enumerable
and stable. Group names must be matched case-insensitively and against Tally's exact spellings
(including `Misc. Expenses (ASSET)` and `Suspense A/c`); this must be verified against a live
company during implementation rather than assumed.

### 4.3 Two additions on top of the group rule

**Digit-run scrubbing, everywhere.** Any run of 6 or more digits in a ledger name is replaced,
regardless of whether the ledger is masked or clear. Catches account numbers, PAN and GSTIN
fragments wherever they were typed, including in clear expense ledgers.

**Operator override file** (`config/overrides.json`). A checked-in list of ledgers or groups to
force-mask or force-clear. Force-mask covers the `Consultancy - <person>` ledger sitting under
Indirect Expenses. Force-clear is the escape hatch for a group that masks unhelpfully.
Overrides win over the group rule.

### 4.4 Stated limitation

A person's name typed into an expense or income ledger under an impersonal group remains in
the clear until it is added to the override file. Name detection is deferred deliberately: a
deterministic rule plus a correction list is honest, where an unreliable detector would imply
a guarantee it cannot keep.

### 4.5 Field-level policy

The downstream `tally_get_ledger` returns address, bank account number, IFSC code, email,
phone and GSTIN. **That tool is not exposed by the gateway in this milestone.** No gateway
tool returns bank details, address, email or phone. GSTIN, where it appears at all, is masked.

## 5. The checks

Seven checks. Severity is assigned by the rule that fires; the model may prioritise and
explain within a severity but may not promote or demote one.

### Critical — the books are wrong

1. **`out_of_balance`** — total debits ≠ total credits. Reports the difference and direction.
   The downstream trial balance already returns both totals and a `balanced` flag.
2. **`suspense_balance`** — any non-zero balance under Suspense A/c. Must be zero at
   finalization; a balance here is always unposted work.
3. **`negative_cash`** — a credit balance under Cash-in-Hand. Physically impossible;
   indicates unrecorded receipts or a wrongly dated payment.

### Warning — legitimate sometimes, but each needs a stated reason

4. **`wrong_side_balance`** — a balance on the side its account type should not carry:
   debtor in credit, creditor in debit, expense with a credit balance, income with a debit
   balance, negative stock. Innocent explanations exist (advances, debit notes); each should
   be a conscious answer rather than a surprise.
5. **`overdrawn_bank`** — credit balance in Bank Accounts. Correct with an OD facility, wrong
   on a current account. Flagged for confirmation, never auto-judged.

### Review — housekeeping

6. **`ledger_under_primary_group`** — a ledger whose parent is a primary group such as
   Current Assets rather than a proper sub-group. Numbers unaffected; it lands wrong in every
   report and signals hurried master creation.
7. **`dormant_balance`** — non-zero opening, no movement in the period, closing identical to
   opening. The stale advance or old creditor carried for years.

### Deferred to a follow-up

- **`round_sum_balance`** — exact round figures hinting at estimates or plugs. Noisy without
  tuning against real data.
- **Prior-year comparison** — valuable, but requires a second full trial balance fetch, and the
  downstream notes that path costs 10–30 seconds on a large company.

### 5.1 Finding contract

```
id        TB-004-17                 check ordinal + row ordinal; stable within a run
check     wrong_side_balance
severity  critical | warning | review
ledger    Creditor 23               masked where policy requires; nominal accounts real
group     Sundry Creditors          never masked
amount    41250.00
side      Dr
expected  Cr
detail    Creditor with a debit balance as of 31-Mar-2026
followUp  tb_ledger_activity(TB-004-17)
```

Three properties are deliberate:

- **The ledger identity may be a pseudonym; the group never is.** The group makes a finding
  actionable and carries no personal information.
- **Follow-up is by finding id, not ledger name.** The model never holds or retypes a real
  name; the gateway resolves the id internally when querying vouchers.
- **Severity comes from the rule, not the model.**

## 6. Tool surface

| Tool | Purpose |
|---|---|
| `tb_review(company?, asOnDate)` | Runs all seven checks. Returns totals, counts by severity, and the masked findings. |
| `tb_ledger_activity(findingId, fromDate?, toDate?)` | Voucher-level context for one finding. Resolves the id to a real ledger internally, calls the downstream ledger-vouchers tool, returns masked rows. |
| `tb_list_companies()` | Company names as returned by Tally. Not masked — the operator's own company is not PII to the operator. |
| `tb_write_report(markdown, findings?)` | Writes the de-masked Markdown report and the findings CSV to the configured output directory. Returns the paths written. |

No other downstream tool is proxied. Adding one is a deliberate act that must pass the leak
test in §8.

## 7. Report artifacts and de-masking

Masking de-masks **downward**, when a pseudonym passes into a tool call bound for Tally.
Reporting de-masks **outward**, when text bound for the operator's screen passes through the
gateway on its way to disk. The model stands in neither path.

The model composes the write-up in masked terms; `tb_write_report` substitutes real names as
it writes. Three artifacts per run, into a configured output directory:

- **`trial-balance-review-<company>-<date>.md`** — narrative report, real names.
- **`findings-<company>-<date>.csv`** — one row per finding, real names: check, severity,
  ledger, group, amount, side, expected side, detail.
- **`session-<timestamp>.jsonl`** — one audit line per tool call: tool, arguments, row count,
  what was masked. Read-only work still deserves a record of what reached the model.

The vault mapping is **not** written by default; it is the one artifact that reverses every
other protection. A debug flag can dump it when masking itself is being diagnosed.

### 7.1 Read-back exposure, and the two mitigations

The gateway writes the de-masked file, but the harness has its own file tools. Nothing at the
protocol level prevents the model reading back what the gateway just wrote. **Both** mitigations
are adopted:

1. **Reports are written outside the harness's working directory.** The output directory
   defaults to a location outside the project, configured by `TALLY_AGENT_REPORT_DIR`.
2. **Harness file permissions deny that path.** Both Claude Code and opencode support per-path
   deny rules; the shipped harness configuration in `harness/` includes them.

This is a configuration boundary, not a cryptographic one, and is documented as such. The
airtight alternative — the gateway writing nothing, and a separate command de-masking after
the session ends — was considered and rejected as more steps for the operator; it remains
available if the boundary proves insufficient in practice.

## 8. Testing

No test requires a running Tally, and none requires the operator's real company to be loaded.

1. **Check tests.** Table-driven over hand-built trial balances. Every check gets its
   near-misses: a debtor at exactly zero, a bank with a declared OD facility, a dormant account
   that moved by one rupee, a suspense balance below the rounding threshold.
2. **Classifier tests.** Ancestry walks over a real group tree, including user groups nested
   under both masked and clear roots, and an unrecognised group proving the default is masked.
3. **Gateway tests against a fake downstream.** A stub MCP server replaying recorded responses,
   proving the wiring end to end without Tally.
4. **Leak test — build-failing.** Over the fixture corpus, run every gateway tool and assert
   that no real party name, bank account number, or GSTIN from the fixtures appears in any
   outbound payload. This is a property over the whole tool surface, not an example per tool,
   so it catches a tool added later that forgets to route through the masker.

**Fixtures** are recorded once from the real Tally server, then sanitized: real names replaced
with invented ones, real shapes kept. Committed to the repo.

## 9. Risks

| Risk | Consequence | Handling |
|---|---|---|
| Downstream tool contract changes | Gateway breaks | Recorded fixtures fail at test time, not in front of an accountant. Coupling is documented. |
| Predefined group spellings differ from those assumed | Ledgers misclassified — possibly a mask that should be clear, or worse | Verify group names against a live company before the classifier is considered done. Unrecognised defaults to masked, so the failure direction is safe. |
| Person name inside a clear-group ledger | Real name reaches the model | Override file; documented limitation; name detection deferred |
| Model reads back a de-masked report | Real names reach the model | Both §7.1 mitigations |
| Trial balance fetch is slow on large companies | Poor first-call experience | Downstream caches for 5 minutes; `tb_review` fetches once and runs all seven checks over that one result |

## 10. Milestone boundary

This milestone is complete when an accountant can, from Claude Code or opencode, ask for a
trial balance review of a real company and receive a de-masked Markdown report and findings
CSV, with the leak test green, and with no party name, bank account number or GSTIN having
reached the model.

Follow-up milestones, in the order the README implies: GST summary and mismatch; single-ledger
scrutiny; Excel read/write; the finalization checklist; and only then the guarded write path.
