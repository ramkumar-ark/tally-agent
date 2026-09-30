import { join } from "node:path";
import { gstWorksheetFileName } from "./gst44-worksheet-template.js";

/**
 * The tax-audit workflow's static registry: the input table, the step table
 * and their types. Pure data — no I/O lives here. The runner (src/workflow.ts)
 * executes steps through the in-process handler map; the state module
 * (src/workflow-state.ts) reads this registry to plan passes.
 */

export type InputKey = string;

export interface WorkflowParams {
  company: string;
  fromDate: string;
  toDate: string;
  asOnDate: string;
}

/** How a missing input can be generated into the workflow's to-fill/ folder. */
export interface WorkflowInputGenerator {
  tool: string;
  /**
   * Inputs that must carry a path before args() can build anything. When one
   * is missing the intake reports the input as missing and names these.
   */
  needs?: InputKey[];
  /**
   * The tool arguments, or undefined when a path this generator needs is not
   * present yet (the input only becomes generatable once that lands).
   */
  args(
    params: WorkflowParams,
    paths: (key: InputKey) => string | undefined,
    toFillDir: string,
  ): Record<string, unknown> | undefined;
  /** The result field carrying the written file's absolute path. */
  resultKey: "templatePath" | "writePath";
  /**
   * Generated inside its own step, never at start/status: the generator needs
   * the TDS review cache only a step run builds.
   */
  stepOnly?: boolean;
}

export interface WorkflowInput {
  key: InputKey;
  label: string;
  extensions: string[];
  /** Operator documentation page describing how to fill this input. */
  doc?: string;
  /** Plain words on how to produce the file when there is no generator. */
  howToGet?: string;
  generator?: WorkflowInputGenerator;
  /**
   * The user may explicitly approve it after checking it in Excel (the GST
   * working sheet). Only present-or-filled files can be approved.
   */
  approvable?: boolean;
}

export interface StepInput {
  key: InputKey;
  need: "required" | "optional";
}

/**
 * What a step's action-argument closures see. `last` is the parsed JSON of
 * the previous action in the same step (a review result feeding a report);
 * the runner rebuilds the context before every action.
 */
export interface StepCtx {
  params: WorkflowParams;
  path(key: InputKey): string | undefined;
  status(key: InputKey): string | undefined;
  stepDir: string;
  toFillDir: string;
  last: unknown;
  narrative(stepTitle: string, result: unknown): string;
}

export interface WorkflowAction {
  tool: string;
  kind: "review" | "report" | "fill" | "template";
  args(ctx: StepCtx): Record<string, unknown>;
  /** true = run; a string = skip this action and record the reason in notes. */
  when?(ctx: StepCtx): true | string;
}

export interface WorkflowStep {
  id: string;
  title: string;
  clause?: string;
  inputs: StepInput[];
  /** Ordering only: named steps run first when they are in the same plan. */
  after?: string[];
  /** Needs live Tally; planPass holds the step when Tally is unreachable. */
  live?: boolean;
  actions: WorkflowAction[];
  custom?: "notds" | "gst_working_sheet" | "tds_payable";
}

export const WORKFLOW_INPUTS: Record<InputKey, WorkflowInput> = {
  dayBook: {
    key: "dayBook",
    label: "Day-book export",
    extensions: [".json"],
    doc: "docs/operator/export-daybook.md",
    howToGet:
      "Run scripts/export-daybook.mjs against the open company for the whole period, or call tb_audit_workflow_export_daybook and let the workflow export it for you (needs the upstream server path in TALLY_MCP_ARGS).",
  },
  priorGstSheet: {
    key: "priorGstSheet",
    label: "Prior-year GST nature-wise sheet",
    extensions: [".xlsx"],
    howToGet:
      "The prior year's hand-prepared 'GST INWARD SUPPLY - NATURE WISE BREAK UP' workbook; optional, seeds the working sheet's treatments.",
  },
  gstRules: {
    key: "gstRules",
    label: "GST treatment rules",
    extensions: [".json"],
    howToGet:
      "Optional {rules:[...]} JSON extending the built-in treatment vocabulary for the working sheet.",
  },
  gstWorkingSheet: {
    key: "gstWorkingSheet",
    label: "GST nature-wise working sheet",
    extensions: [".xlsx"],
    doc: "docs/operator/gst-44-operator-template.md",
    generator: {
      tool: "tb_write_gst_working_sheet",
      needs: ["dayBook"],
      args: (c, paths, toFillDir) => {
        const dayBookPath = paths("dayBook");
        if (dayBookPath === undefined) return undefined;
        return {
          dayBookPath,
          fromDate: c.fromDate,
          toDate: c.toDate,
          company: c.company,
          ...(paths("priorGstSheet") ? { priorSheetPath: paths("priorGstSheet") } : {}),
          ...(paths("gstRules") ? { rulesPath: paths("gstRules") } : {}),
          outPath: join(toFillDir, gstWorksheetFileName(c.company, c.asOnDate)),
        };
      },
      resultKey: "writePath",
    },
    approvable: true,
  },
  gst44Template: {
    key: "gst44Template",
    label: "Clause 44 template (blank)",
    extensions: [".xlsx"],
    doc: "docs/operator/gst-44-operator-template.md",
    generator: {
      tool: "tb_write_gst44_template",
      needs: ["dayBook"],
      args: (c, paths, toFillDir) => {
        const dayBookPath = paths("dayBook");
        if (dayBookPath === undefined) return undefined;
        return { company: c.company, dayBookPath, outDir: toFillDir };
      },
      resultKey: "templatePath",
    },
  },
  winmanGst44: {
    key: "winmanGst44",
    label: "Winman clause 44 workbook",
    extensions: [".xlsm"],
    howToGet: "The client's Winman 3CD workbook; the clause-44 sheet is filled in place on a COPY written into the pass folder.",
  },
  tdsTemplate: {
    key: "tdsTemplate",
    label: "TDS operator template",
    extensions: [".xlsx"],
    doc: "docs/operator/tds-operator-template.md",
    generator: {
      tool: "tb_write_tds_template",
      args: (c, _paths, toFillDir) => ({ company: c.company, outDir: toFillDir }),
      resultKey: "templatePath",
    },
  },
  winmanTdsSummary: {
    key: "winmanTdsSummary",
    label: "Winman TDS summary sheet",
    extensions: [".xlsx"],
    howToGet: "Optional: the Winman TDS summary export, giving challan coverage for the deposit checks.",
  },
  winman34: {
    key: "winman34",
    label: "Winman clause 34 workbook",
    extensions: [".xlsm"],
    howToGet: "The client's Winman 3CD workbook (interest on TDS sheet); filled on a COPY written into the pass folder.",
  },
  notdsTemplate: {
    key: "notdsTemplate",
    label: "No-TDS operator template",
    extensions: [".xlsx"],
    doc: "docs/operator/tds-operator-template.md",
    generator: {
      tool: "tb_write_notds_template",
      args: (c, _paths, toFillDir) => ({ company: c.company, outDir: toFillDir }),
      resultKey: "templatePath",
      stepOnly: true,
    },
  },
  payableDecisions: {
    key: "payableDecisions",
    label: "TDS payable decisions workbook",
    extensions: [".xlsx"],
    doc: "docs/operator/tds-payable-statement.md",
    howToGet:
      "The filled tds-payable-decisions-*.xlsx from this exact tb_tds_review run: every critical finding " +
      "marked Accept or Reject. A workbook from another run is refused, and a blank decision is not a decision.",
    generator: {
      tool: "tb_write_tds_payable_decisions",
      args: (c, _paths, toFillDir) => ({ company: c.company, outDir: toFillDir }),
      resultKey: "templatePath",
      stepOnly: true,
    },
  },
  winmanNotds: {
    key: "winmanNotds",
    label: "Winman clause 21(b) workbook",
    extensions: [".xlsm"],
    howToGet: "The client's Winman 3CD workbook; the four 40(a) sheets are filled on a COPY written into the pass folder.",
  },
  as26Export: {
    key: "as26Export",
    label: "TRACES Form 26AS export",
    extensions: [".xlsm"],
    howToGet: "Download the TRACES 26AS workbook (all deductees, the whole year) from the TRACES portal.",
  },
  as26Map: {
    key: "as26Map",
    label: "26AS party map",
    extensions: [".xlsx", ".xlsm", ".json"],
    doc: "docs/operator/26as-mapping-template.md",
    generator: {
      tool: "tb_write_26as_template",
      needs: ["as26Export", "dayBook"],
      args: (c, paths, toFillDir) => {
        const as26Path = paths("as26Export");
        const dayBookPath = paths("dayBook");
        if (as26Path === undefined || dayBookPath === undefined) return undefined;
        return { as26Path, dayBookPath, company: c.company, outDir: toFillDir };
      },
      resultKey: "templatePath",
    },
  },
  depreciationFile: {
    key: "depreciationFile",
    label: "Depreciation file",
    extensions: [".json"],
    howToGet: "Optional JSON of operator depreciation facts; without it the depreciation review works from the books alone.",
  },
  dep3cdTemplate: {
    key: "dep3cdTemplate",
    label: "Clause 18 depreciation template",
    extensions: [".xlsx"],
    doc: "docs/design/2026-09-27-winman-3cd-depreciation-design.md",
    generator: {
      tool: "tb_write_dep3cd_template",
      needs: ["dayBook"],
      args: (c, paths, toFillDir) => {
        const dayBookPath = paths("dayBook");
        if (dayBookPath === undefined) return undefined;
        const winmanDep = paths("winmanDep");
        return {
          company: c.company,
          dayBookPath,
          ...(winmanDep ? { sourcePath: winmanDep } : {}),
          outDir: toFillDir,
        };
      },
      resultKey: "templatePath",
    },
  },
  winmanDep: {
    key: "winmanDep",
    label: "Winman depreciation workbook",
    extensions: [".xlsm"],
    howToGet: "The client's Winman 3CD workbook; the clause 18 schedule is filled on a COPY written into the pass folder.",
  },
  pfEsiTemplate: {
    key: "pfEsiTemplate",
    label: "PF/ESI operator template",
    extensions: [".xlsx"],
    generator: {
      tool: "tb_write_pf_esi_template",
      args: (c, _paths, toFillDir) => ({ company: c.company, outDir: toFillDir }),
      resultKey: "templatePath",
    },
  },
  winmanPfEsi: {
    key: "winmanPfEsi",
    label: "Winman clause 20(b) workbook",
    extensions: [".xlsm"],
    howToGet: "The client's Winman 3CD workbook; the clause 20(b) sheet is filled on a COPY written into the pass folder.",
  },
  loansTemplate: {
    key: "loansTemplate",
    label: "Loans operator template",
    extensions: [".xlsx"],
    generator: {
      tool: "tb_write_loans_template",
      needs: ["dayBook"],
      args: (c, paths, toFillDir) => {
        const dayBookPath = paths("dayBook");
        if (dayBookPath === undefined) return undefined;
        return { company: c.company, dayBookPath, outDir: toFillDir };
      },
      resultKey: "templatePath",
    },
  },
  winmanLoans: {
    key: "winmanLoans",
    label: "Winman clause 31 workbook",
    extensions: [".xlsm"],
    howToGet: "The client's Winman 3CD workbook; the 269SS/269T sheets are filled on a COPY written into the pass folder.",
  },
};

/**
 * The ten workflow steps in their run order. `after` is ordering within a
 * pass, never a blocker: a step whose prerequisite is not planned still runs.
 */
export const WORKFLOW_STEPS: WorkflowStep[] = [
  {
    id: "gst_working_sheet",
    title: "GST nature-wise working sheet",
    clause: "44 (preparation)",
    inputs: [
      { key: "dayBook", need: "required" },
      { key: "priorGstSheet", need: "optional" },
      { key: "gstRules", need: "optional" },
    ],
    actions: [],
    custom: "gst_working_sheet",
  },
  {
    id: "gst44",
    title: "3CD clause 44 review",
    clause: "44",
    inputs: [
      { key: "dayBook", need: "required" },
      { key: "gst44Template", need: "optional" },
      { key: "gstWorkingSheet", need: "optional" },
      { key: "winmanGst44", need: "optional" },
    ],
    after: ["gst_working_sheet"],
    actions: [
      {
        tool: "tb_gst44_review",
        kind: "review",
        args: (c) => ({
          fromDate: c.params.fromDate,
          toDate: c.params.toDate,
          company: c.params.company,
          dayBookPath: c.path("dayBook"),
          templatePath: c.path("gst44Template"),
        }),
      },
      {
        tool: "tb_write_gst44_report",
        kind: "report",
        args: (c) => ({ company: c.params.company, outDir: c.stepDir }),
      },
      {
        tool: "tb_write_3cd_gst44",
        kind: "fill",
        when: (c) => {
          if (c.path("winmanGst44") === undefined) return "Winman clause-44 workbook not given";
          if (c.status("gstWorkingSheet") !== "approved")
            return "working sheet not approved — Winman write held";
          return true;
        },
        args: (c) => ({
          sourcePath: c.path("winmanGst44"),
          outPath: c.stepDir,
          worksheetPath: c.path("gstWorkingSheet"),
        }),
      },
    ],
  },
  {
    id: "tds",
    title: "TDS review, report and clause 34 filler",
    clause: "34",
    inputs: [
      { key: "dayBook", need: "required" },
      { key: "tdsTemplate", need: "required" },
      { key: "winmanTdsSummary", need: "optional" },
      { key: "winman34", need: "optional" },
    ],
    actions: [
      {
        tool: "tb_tds_review",
        kind: "review",
        args: (c) => ({
          fromDate: c.params.fromDate,
          toDate: c.params.toDate,
          asOnDate: c.params.asOnDate,
          company: c.params.company,
          templatePath: c.path("tdsTemplate"),
          winmanPath: c.path("winmanTdsSummary"),
          dayBookPath: c.path("dayBook"),
        }),
      },
      {
        tool: "tb_write_tds_report",
        kind: "report",
        args: (c) => ({
          company: c.params.company,
          fromDate: c.params.fromDate,
          toDate: c.params.toDate,
          markdown: c.narrative("TDS review", c.last),
          outDir: c.stepDir,
        }),
      },
      {
        tool: "tb_write_3cd_tds_tcs",
        kind: "fill",
        when: (c) => (c.path("winman34") === undefined ? "Winman clause-34 workbook not given" : true),
        args: (c) => ({ sourcePath: c.path("winman34"), outPath: c.stepDir }),
      },
    ],
  },
  {
    id: "notds",
    title: "No-TDS disallowance, clause 21(b)",
    clause: "21(b)",
    inputs: [
      { key: "dayBook", need: "required" },
      { key: "tdsTemplate", need: "required" },
      { key: "notdsTemplate", need: "required" },
      { key: "winmanNotds", need: "optional" },
    ],
    after: ["tds"],
    actions: [],
    custom: "notds",
  },
  {
    id: "as26",
    title: "Form 26AS reconciliation",
    inputs: [
      { key: "dayBook", need: "required" },
      { key: "as26Export", need: "required" },
      { key: "as26Map", need: "required" },
    ],
    actions: [
      {
        tool: "tb_26as_review",
        kind: "review",
        args: (c) => ({
          fromDate: c.params.fromDate,
          toDate: c.params.toDate,
          company: c.params.company,
          as26Path: c.path("as26Export"),
          dayBookPath: c.path("dayBook"),
          as26MapPath: c.path("as26Map"),
        }),
      },
      {
        tool: "tb_write_26as_report",
        kind: "report",
        args: (c) => ({
          company: c.params.company,
          fromDate: c.params.fromDate,
          toDate: c.params.toDate,
          markdown: c.narrative("Form 26AS reconciliation", c.last),
          outDir: c.stepDir,
        }),
      },
    ],
  },
  {
    id: "depreciation",
    title: "Depreciation review (IT Act)",
    inputs: [{ key: "depreciationFile", need: "optional" }],
    live: true,
    actions: [
      {
        tool: "tb_depreciation_review",
        kind: "review",
        args: (c) => ({
          company: c.params.company,
          fromDate: c.params.fromDate,
          toDate: c.params.toDate,
          depreciationFilePath: c.path("depreciationFile"),
        }),
      },
      {
        tool: "tb_write_depreciation_report",
        kind: "report",
        args: (c) => ({
          company: c.params.company,
          fromDate: c.params.fromDate,
          toDate: c.params.toDate,
          outDir: c.stepDir,
        }),
      },
    ],
  },
  {
    id: "dep3cd",
    title: "3CD clause 18 depreciation",
    clause: "18",
    inputs: [
      { key: "dayBook", need: "required" },
      { key: "dep3cdTemplate", need: "required" },
      { key: "winmanDep", need: "optional" },
    ],
    after: ["depreciation"],
    actions: [
      {
        tool: "tb_dep3cd_review",
        kind: "review",
        args: (c) => ({
          fromDate: c.params.fromDate,
          toDate: c.params.toDate,
          company: c.params.company,
          dayBookPath: c.path("dayBook"),
          templatePath: c.path("dep3cdTemplate"),
          sourcePath: c.path("winmanDep"),
        }),
      },
      {
        tool: "tb_write_dep3cd_report",
        kind: "report",
        args: (c) => ({ company: c.params.company, outDir: c.stepDir }),
      },
      {
        tool: "tb_write_3cd_depreciation",
        kind: "fill",
        when: (c) => (c.path("winmanDep") === undefined ? "Winman depreciation workbook not given" : true),
        args: (c) => ({ sourcePath: c.path("winmanDep"), outPath: c.stepDir }),
      },
    ],
  },
  {
    id: "fa_register",
    title: "Fixed asset register",
    inputs: [],
    after: ["depreciation"],
    live: true,
    actions: [
      {
        tool: "tb_fixed_asset_register",
        kind: "review",
        args: (c) => ({
          company: c.params.company,
          fromDate: c.params.fromDate,
          toDate: c.params.toDate,
        }),
      },
      {
        tool: "tb_write_fixed_asset_report",
        kind: "report",
        args: (c) => ({
          company: c.params.company,
          fromDate: c.params.fromDate,
          toDate: c.params.toDate,
          outDir: c.stepDir,
        }),
      },
    ],
  },
  {
    id: "pf_esi",
    title: "PF/ESI clause 20(b)",
    clause: "20(b)",
    inputs: [
      { key: "dayBook", need: "required" },
      { key: "pfEsiTemplate", need: "required" },
      { key: "winmanPfEsi", need: "optional" },
    ],
    actions: [
      {
        tool: "tb_pf_esi_review",
        kind: "review",
        args: (c) => ({
          fromDate: c.params.fromDate,
          toDate: c.params.toDate,
          company: c.params.company,
          templatePath: c.path("pfEsiTemplate"),
          dayBookPath: c.path("dayBook"),
        }),
      },
      {
        tool: "tb_write_pf_esi_report",
        kind: "report",
        args: (c) => ({ company: c.params.company, outDir: c.stepDir }),
      },
      {
        tool: "tb_write_3cd_pf_esi",
        kind: "fill",
        when: (c) => (c.path("winmanPfEsi") === undefined ? "Winman PF/ESI workbook not given" : true),
        args: (c) => ({ sourcePath: c.path("winmanPfEsi"), outPath: c.stepDir }),
      },
    ],
  },
  {
    id: "loans",
    title: "Loans clause 31 / 269SS / 269T / 269ST",
    clause: "31 / 269SS / 269T / 269ST",
    inputs: [
      { key: "dayBook", need: "required" },
      { key: "loansTemplate", need: "optional" },
      { key: "winmanLoans", need: "optional" },
    ],
    actions: [
      {
        tool: "tb_loans_review",
        kind: "review",
        args: (c) => ({
          fromDate: c.params.fromDate,
          toDate: c.params.toDate,
          company: c.params.company,
          dayBookPath: c.path("dayBook"),
          templatePath: c.path("loansTemplate"),
        }),
      },
      {
        tool: "tb_write_loans_report",
        kind: "report",
        args: (c) => ({ company: c.params.company, outDir: c.stepDir }),
      },
      {
        tool: "tb_write_3cd_loans",
        kind: "fill",
        when: (c) => (c.path("winmanLoans") === undefined ? "Winman loans workbook not given" : true),
        args: (c) => ({ sourcePath: c.path("winmanLoans"), outPath: c.stepDir }),
      },
    ],
  },
  {
    // Appended, never inserted: a step's position fixes every later step's
    // `01-`/`02-` directory prefix, so an inserted step would make every
    // older workflow folder on disk read the wrong folder.
    id: "tds_payable",
    title: "TDS payable statement (s.201(1A) shortfall and interest)",
    clause: "201(1A)",
    inputs: [
      { key: "dayBook", need: "optional" },
      { key: "payableDecisions", need: "optional" },
    ],
    after: ["tds", "notds"],
    actions: [],
    custom: "tds_payable",
  },
];

export function stepById(id: string): WorkflowStep | undefined {
  return WORKFLOW_STEPS.find((s) => s.id === id);
}

/** The pass folder's step directory name: `01-gst_working_sheet`, … `10-loans`. */
export function stepDirName(step: WorkflowStep, index: number): string {
  return `${String(index + 1).padStart(2, "0")}-${step.id}`;
}
