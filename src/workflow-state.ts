import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WORKFLOW_INPUTS,
  WORKFLOW_STEPS,
  stepById,
  type InputKey,
  type WorkflowInput,
  type WorkflowParams,
  type WorkflowStep,
} from "./workflow-registry.js";

/**
 * The workflow's on-disk state model: manifest construction, load/save
 (atomic tmp+rename), input status derivation, step readiness, fingerprints
 and pass planning. Everything but load/save is pure — the runner applies
 the plan to the manifest and persists it.
 */

export type InputStatus =
  | "missing"
  | "present"
  | "generated-unfilled"
  | "filled"
  | "accepted"
  | "approved"
  | "invalid";

export interface WorkflowInputEntry {
  path?: string;
  source?: "user" | "generated";
  generatedDigest?: string;
  digest?: string;
  status: InputStatus;
  accepted?: boolean;
  approved?: boolean;
  reason?: string;
}

export interface WorkflowStepState {
  status: "pending" | "needs-input" | "needs-tally" | "running" | "done" | "partial" | "failed" | "skipped";
  fingerprint?: string;
  lastPass?: string;
  outputs?: string[];
  findings?: { critical: number; warning: number; review: number };
  notes?: string[];
  error?: string;
  runningSince?: string;
  runningProcess?: string;
  gstWorksheetFindings?: string;
}

export interface PassRecordedEntry {
  id: string;
  state: "needs-input" | "needs-tally" | "carried";
  missing?: InputKey[];
  carriedFrom?: string;
}

export interface WorkflowPass {
  n: number;
  dir: string;
  startedAt: string;
  closedAt?: string;
  plan: string[];
  recorded?: PassRecordedEntry[];
}

export interface WorkflowManifest {
  version: 1;
  workflowId: string;
  createdAt: string;
  updatedAt: string;
  params: WorkflowParams;
  selectedSteps: string[];
  tallyReachable: boolean | null;
  inputs: Record<InputKey, WorkflowInputEntry>;
  steps: Record<string, WorkflowStepState>;
  passes: WorkflowPass[];
}

const SATISFIED: ReadonlySet<string> = new Set(["present", "filled", "accepted", "approved"]);

export function newManifest(
  params: WorkflowParams,
  inputs: Record<InputKey, WorkflowInputEntry> | undefined,
  selectedSteps: string[] | undefined,
  id: string,
): WorkflowManifest {
  const now = new Date().toISOString();
  const allInputs: Record<InputKey, WorkflowInputEntry> = {};
  for (const key of Object.keys(WORKFLOW_INPUTS)) {
    allInputs[key] = inputs?.[key] ?? { status: "missing" };
  }
  const selected = new Set(selectedSteps ?? WORKFLOW_STEPS.map((s) => s.id));
  const steps: Record<string, WorkflowStepState> = {};
  for (const step of WORKFLOW_STEPS) {
    steps[step.id] = { status: selected.has(step.id) ? "pending" : "skipped" };
  }
  return {
    version: 1,
    workflowId: id,
    createdAt: now,
    updatedAt: now,
    params,
    selectedSteps: [...selected],
    tallyReachable: null,
    inputs: allInputs,
    steps,
    passes: [],
  };
}

export async function saveManifest(dir: string, m: WorkflowManifest): Promise<void> {
  m.updatedAt = new Date().toISOString();
  const tmp = join(dir, "workflow.json.tmp");
  await writeFile(tmp, JSON.stringify(m, null, 2), "utf8");
  await rename(tmp, join(dir, "workflow.json"));
}

export async function loadManifest(dir: string): Promise<WorkflowManifest> {
  const raw = await readFile(join(dir, "workflow.json"), "utf8");
  return JSON.parse(raw) as WorkflowManifest;
}

/**
 * Derive an input's status per the intake contract: a user file that has not
 * changed since generation stays "generated-unfilled"; once its digest moves
 * it is "filled" (and its acceptance/approval may show); a vanished or
 * wrong-extension file falls back to missing/invalid.
 */
export function inputStatus(
  spec: WorkflowInput,
  entry: WorkflowInputEntry,
  digestNow: string | undefined,
): InputStatus {
  if (entry.path === undefined || digestNow === undefined) return "missing";
  const ext = entry.path.slice(entry.path.lastIndexOf(".")).toLowerCase();
  if (!spec.extensions.includes(ext)) return "invalid";
  if (entry.generatedDigest !== undefined && digestNow === entry.generatedDigest) {
    return "generated-unfilled";
  }
  if (spec.approvable && entry.approved) return "approved";
  if (entry.accepted) return "accepted";
  return entry.generatedDigest !== undefined ? "filled" : "present";
}

export function satisfied(key: InputKey, manifest: WorkflowManifest): boolean {
  return SATISFIED.has(manifest.inputs[key]?.status ?? "missing");
}

/**
 * Required-input readiness. A required input whose generator is stepOnly
 * (the no-TDS template) does not block planning: the step itself generates
 * it mid-run and then ends needs-input.
 */
export function stepReadiness(
  step: WorkflowStep,
  manifest: WorkflowManifest,
): { ready: boolean; missing: InputKey[] } {
  const missing: InputKey[] = [];
  for (const si of step.inputs) {
    if (si.need !== "required") continue;
    if (WORKFLOW_INPUTS[si.key]?.generator?.stepOnly) continue;
    if (!satisfied(si.key, manifest)) missing.push(si.key);
  }
  return { ready: missing.length === 0, missing };
}

/**
 * What a step's run depends on, hashed. Live steps depend on the period
 * parameters only (live Tally data changes under us); file-driven steps
 * additionally depend on every declared input's digest and status, so a
 * changed day book or a fresh approval re-runs the step.
 */
export function fingerprint(step: WorkflowStep, manifest: WorkflowManifest): string {
  const basis = step.live
    ? { params: manifest.params }
    : {
        params: manifest.params,
        inputs: step.inputs.map(({ key }) => {
          const e = manifest.inputs[key];
          return [key, e?.digest ?? null, e?.status ?? null];
        }),
      };
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

/**
 * Plan one pass. Pure: returns the runnable step ids (registry order,
 * after-stabilised) and records for every other selected step why it is not
 * in the plan — needs-input, needs-tally, or carried forward from its last
 * pass. A pass that is still open keeps its number; otherwise the next one
 * is planned. The runner stamps and persists the pass folder.
 */
export function planPass(
  manifest: WorkflowManifest,
  opts: { rerun?: string[] } = {},
): { n: number; plan: string[]; recorded: PassRecordedEntry[]; reopened: boolean } {
  const rerun = new Set(opts.rerun ?? []);
  const open = manifest.passes[manifest.passes.length - 1];
  const reopened = open !== undefined && open.closedAt === undefined;
  const n = reopened ? open.n : manifest.passes.length + 1;
  const lastDirOf = (id: string): string | undefined => {
    const st = manifest.steps[id];
    return st?.lastPass;
  };

  const plan: string[] = [];
  const recorded: PassRecordedEntry[] = [];
  const pendingIds: string[] = [];

  for (const step of WORKFLOW_STEPS) {
    if (!manifest.selectedSteps.includes(step.id)) continue;
    const state = manifest.steps[step.id] ?? { status: "pending" as const };
    const readiness = stepReadiness(step, manifest);
    if (!readiness.ready) {
      recorded.push({ id: step.id, state: "needs-input", missing: readiness.missing });
      continue;
    }
    if (step.live && manifest.tallyReachable !== true) {
      recorded.push({ id: step.id, state: "needs-tally" });
      continue;
    }
    const fp = fingerprint(step, manifest);
    const done = state.status === "done" || state.status === "partial";
    const unchanged = done && state.fingerprint === fp && !rerun.has(step.id);
    if (unchanged) {
      recorded.push({
        id: step.id,
        state: "carried",
        carriedFrom: lastDirOf(step.id) ?? (reopened ? open.dir : undefined),
      });
      continue;
    }
    pendingIds.push(step.id);
  }

  // after-stabilisation within the plan: a named prerequisite that is itself
  // planned runs first. Registry order already respects the known edges;
  // this keeps the guarantee if steps are ever reordered.
  const chosen = new Set(pendingIds);
  for (const id of pendingIds) {
    const step = stepById(id);
    for (const dep of step?.after ?? []) {
      if (chosen.has(dep) && !plan.includes(dep)) {
        plan.push(dep);
        chosen.delete(dep);
      }
    }
    if (!plan.includes(id)) plan.push(id);
  }

  return { n, plan, recorded, reopened };
}
