# The tax-audit workflow

## What this is

The four `tb_audit_workflow_*` tools run every review lane for one company and
one period as a single guided sequence, and collect all reports, filled Winman
sheets and findings into one folder you can copy away at the end. The lanes,
in order: GST working sheet, clause 44, TDS review (report + clause 34 fill),
No-TDS disallowance (clause 21(b)), 26AS reconciliation, depreciation review,
clause 18 depreciation, fixed asset register, PF/ESI (clause 20(b)) and loans
(clause 31 / ss.269SS/269T/269ST).

Nothing here writes to Tally. The workflow never modifies your own template or
Winman files — filled copies are written into the workflow folder.

## The loop

1. **Start** — `tb_audit_workflow_start` with the company name and the period
   (`YYYYMMDD`–`YYYYMMDD`). It creates the workflow folder, checks every
   input, generates the templates that need no other input (TDS, PF/ESI) into
   `to-fill/`, and returns the intake table: every input with its status, what
   it is for, and how to get it.
2. **Fill** — prepare the files the intake table asks for. Templates the
   workflow generated sit in `to-fill/`; fill them the way you would fill any
   template this project produces (each has its own walkthrough under
   `docs/operator/`: `tds-operator-template.md`, `gst-44-operator-template.md`,
   `26as-mapping-template.md`, `dep3cd-operator-template.md`,
   `notds-operator-template.md`, `pf-esi` via the PF/ESI template). The day
   book is the one input most reviews need: either export it yourself
   (`docs/operator/export-daybook.md`) and hand the path over, or call
   `tb_audit_workflow_export_daybook` and let the workflow export it into the
   workflow folder for you — that needs the upstream server's `dist/index.js`
   path in `TALLY_MCP_ARGS` (the same configuration the gateway already uses
   to reach Tally).
3. **Status** — `tb_audit_workflow_status` with the `workflowId`:
   - `setInputs` points the workflow at your filled files (paths only).
   - `accept` marks a file checked and final.
   - `approve` is for the GST working sheet only — set it when you have
     explicitly approved the nature-wise sheet's totals; the clause 44 fill
     takes its rows from it only after that approval.
4. **Run** — `tb_audit_workflow_run` runs **one planned step per call** and
   returns the next one; keep calling until every step is done. One step per
   call keeps each call inside the tool timeout chain.

A step that comes out `needs-input` is waiting for a file — fill it, point
`tb_audit_workflow_status` at it, and run the step again.

## The folder

```
audit-workflows/<company>-<from>-<to>-<stamp>/
├── workflow.json      the workflow's only state (safe to resume from)
├── to-fill/           generated templates waiting for you
├── in/                accepted input snapshots
├── pass-01-<stamp>/   one folder per pass
│   ├── 01-gst_working_sheet/   one sub-folder per step: reports,
│   ├── 03-tds/                 findings, filled Winman copies
│   ├── ...
│   ├── inputs.json   the input snapshot this pass ran against
│   ├── INDEX.md      human-readable index of everything so far
│   └── summary.json  the machine-readable summary of the pass
└── LATEST.txt         the last pass folder's name
```

When everything is done, the pass folder is the deliverable: every report,
findings sheet and filled Winman copy sits inside it, and `INDEX.md` /
`summary.json` say what is what.

## Two things to know

- A `done` step is not re-run when its inputs have not changed; `rerun` forces
  named steps. Filled files from earlier steps are carried forward into each
  new pass folder, so the latest pass folder is always complete.
- Winman sheets are filled on **copies** written into the step folder. Your
  original workbooks are never touched.
