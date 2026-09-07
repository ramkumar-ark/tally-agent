# Tally Agent

AI agent that uses any MCP server to interact with Tally Prime.

Used by an accountant to finalize company accounts.

## Core requirements

- MCP tool use for reading and writing accounting entries (vouchers, ledgers, masters).
- Guardrails on every write: validation, confirmation policy, dry-run/preview, audit log.
- Sensitive-data redaction: no raw accounting PII goes to the LLM as-is.
  Use masked / dummy / representative names for ledgers, parties, GSTIN, PAN,
  addresses, phone/email, bank details, and narration free text.
- Deterministic de-masking only at the MCP call boundary, never inside prompts.
- Excel read/write for imports, reconciliations and review sheets.
- Artifact/report generation from analysis (trial balance checks, GST summaries,
  mismatch reports, finalization checklist), exported as Excel/CSV/Markdown.

## Status

Milestone 1 — read-only trial balance review — is implemented. See
[`docs/design/2026-09-07-trial-balance-review-design.md`](docs/design/2026-09-07-trial-balance-review-design.md)
for the design and [`harness/`](harness/) for setup.

The gateway masks party, bank, capital and loan ledger identities, runs seven
trial balance checks in code, and writes de-masked reports to a directory outside
the harness's reach.

Later milestones, in order: GST summary and mismatch; single-ledger scrutiny;
Excel read/write; the finalization checklist; and only then the guarded write path.
