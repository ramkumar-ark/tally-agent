import { createHash } from "node:crypto";
import { access, mkdir, readdir, rename, readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { z } from "zod";
import type { ToolRegistrar, ToolsConfig } from "./index.js";
import type { Session } from "./review.js";
import { maskKnownNames, scrubSecrets } from "./mask.js";
import { loadDayBookText, readDayBook } from "./tds-daybook.js";
import {
  WORKFLOW_INPUTS,
  WORKFLOW_STEPS,
  stepById,
  type InputKey,
  type WorkflowParams,
} from "./workflow-registry.js";
import {
  inputStatus,
  loadManifest,
  newManifest,
  saveManifest,
  satisfied,
  stepReadiness,
  type WorkflowInputEntry,
  type WorkflowManifest,
} from "./workflow-state.js";
import { uniquePath } from "./workflow-package.js";

/**
 * The three tax-audit workflow tools: tb_audit_workflow_start,
 * tb_audit_workflow_status and tb_audit_workflow_run. The workflow folder is
 * the only state — every call reads and writes workflow.json on disk, so a
 * run survives the process. Handlers go through the in-process handler map
 * (ctx.call); file contents are never returned, only paths.
 */

export interface WorkflowToolCtx {
  /** Calls another tool's handler in-process (never the MCP wire). */
  call(name: string, args: Record<string, unknown>): Promise<string>;
  session: Session;
  cfg: ToolsConfig;
  sessionId: string;
  audit(tool: string, args: Record<string, unknown>, rows: number, masked: number): Promise<void>;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const stamp = (d = new Date()): string =>
  d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

const todayYmd = (): string => new Date().toISOString().slice(0, 10).replace(/-/g, "");

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const sha256 = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Every stored or returned error passes through the vault and the scrubbers. */
const scrubbed = (e: unknown, session: Session): Error =>
  new Error(scrubSecrets(maskKnownNames(errMsg(e), session.vault)));

const wfRoot = (cfg: ToolsConfig): string => join(cfg.reportDir, "audit-workflows");

function resolveSteps(args: {
  steps?: string[];
  excludeSteps?: string[];
}): string[] {
  const valid = new Set(WORKFLOW_STEPS.map((s) => s.id));
  const unknown = (args.steps ?? []).filter((id) => !valid.has(id));
  if (unknown.length) {
    throw new Error(`unknown step id(s) ${unknown.join(", ")}; valid ids: ${[...valid].join(", ")}`);
  }
  const excluded = new Set(args.excludeSteps ?? []);
  const selected = (args.steps ?? WORKFLOW_STEPS.map((s) => s.id)).filter((id) => !excluded.has(id));
  if (selected.length === 0) throw new Error("no steps selected");
  return selected;
}

function validKeys(keys: string[] | undefined, what: string): InputKey[] {
  if (!keys?.length) return [];
  const unknown = keys.filter((k) => !WORKFLOW_INPUTS[k]);
  if (unknown.length) {
    throw new Error(
      `unknown input key(s) in ${what}: ${unknown.join(", ")}; valid keys: ${Object.keys(WORKFLOW_INPUTS).join(", ")}`,
    );
  }
  return keys;
}

/** One per-input row of the §4.4 intake table. */
function intakeRows(m: WorkflowManifest) {
  return Object.values(WORKFLOW_INPUTS).map((spec) => {
    const e = m.inputs[spec.key];
    const blocks = m.selectedSteps.filter((id) =>
      stepById(id)?.inputs.some(
        (si) =>
          si.key === spec.key &&
          si.need === "required" &&
          !WORKFLOW_INPUTS[si.key]?.generator?.stepOnly &&
          !satisfied(si.key, m),
      ),
    );
    return {
      key: spec.key,
      label: spec.label,
      status: e.status,
      ...(e.path ? { path: e.path } : {}),
      ...(e.reason ? { reason: e.reason } : {}),
      ...(spec.doc ? { doc: spec.doc } : {}),
      ...(spec.howToGet ? { howToGet: spec.howToGet } : {}),
      blocks,
    };
  });
}

function stepRows(m: WorkflowManifest) {
  return m.selectedSteps.map((id) => {
    const step = stepById(id)!;
    const readiness = stepReadiness(step, m);
    return {
      id,
      title: step.title,
      status: m.steps[id]?.status ?? "pending",
      ...(readiness.ready ? {} : { missing: readiness.missing }),
    };
  });
}

function nextAction(m: WorkflowManifest): string {
  const anyReady = m.selectedSteps.some((id) => stepReadiness(stepById(id)!, m).ready);
  const anyLiveHeld = m.selectedSteps.some(
    (id) => stepById(id)?.live && m.tallyReachable !== true,
  );
  if (!anyReady) {
    return "provide the missing inputs above (fill the generated files in to-fill/), then call tb_audit_workflow_status";
  }
  return (
    "call tb_audit_workflow_run to open the next pass" +
    (anyLiveHeld ? " (live steps wait until Tally is reachable)" : "")
  );
}

function workflowView(m: WorkflowManifest, wfDir: string) {
  return {
    workflowId: m.workflowId,
    workflowDir: wfDir,
    params: m.params,
    tallyReachable: m.tallyReachable,
    inputs: intakeRows(m),
    steps: stepRows(m),
    nextAction: nextAction(m),
  };
}

async function digestUserFile(
  m: WorkflowManifest,
  ctx: WorkflowToolCtx,
  key: InputKey,
  entry: WorkflowInputEntry,
): Promise<{ digest?: string; invalid?: string; reason?: string }> {
  const spec = WORKFLOW_INPUTS[key];
  const path = entry.path as string;
  if (!(await exists(path))) return { reason: "file does not exist" };
  const ext = extname(path).toLowerCase();
  if (!spec.extensions.includes(ext)) {
    return { digest: sha256(await readFile(path)), invalid: `expected ${spec.extensions.join(" or ")}, got ${ext || "no extension"}` };
  }
  const digest = sha256(await readFile(path));
  if (key === "dayBook") {
    try {
      const text = await loadDayBookText(path, ctx.cfg.dayBookMaxBytes);
      readDayBook(text, {
        company: m.params.company,
        fromDate: m.params.fromDate,
        toDate: m.params.toDate,
      });
    } catch (e) {
      return { digest, invalid: `day book failed validation: ${errMsg(e)}` };
    }
  }
  return { digest };
}

/**
 * Generate one input into to-fill/ through its registered generator tool.
 * Throws only on tool failure; the caller records the reason.
 */
async function generateInput(
  m: WorkflowManifest,
  ctx: WorkflowToolCtx,
  wfDir: string,
  key: InputKey,
): Promise<void> {
  const spec = WORKFLOW_INPUTS[key];
  const gen = spec.generator;
  if (!gen) throw new Error(`${key} has no generator`);
  const toFillDir = join(wfDir, "to-fill");
  const genArgs = gen.args(m.params, (k) => m.inputs[k]?.path, toFillDir);
  if (genArgs === undefined) return;
  const raw = await ctx.call(gen.tool, genArgs);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${gen.tool} returned non-JSON output`);
  }
  const outPath = parsed[gen.resultKey];
  if (typeof outPath !== "string" || outPath === "") {
    throw new Error(`${gen.tool} returned no ${gen.resultKey}`);
  }
  const digest = sha256(await readFile(outPath));
  const entry = m.inputs[key];
  entry.path = outPath;
  entry.source = "generated";
  entry.generatedDigest = digest;
  entry.digest = digest;
  entry.accepted = false;
  entry.approved = false;
  entry.reason = undefined;
  entry.status = inputStatus(spec, entry, digest);
}

/** Move a previous generated copy aside so its name is free again. */
async function setAside(wfDir: string, entry: WorkflowInputEntry): Promise<void> {
  if (!entry.path || !(await exists(entry.path))) return;
  const aside = await uniquePath(join(wfDir, "to-fill"), `${basename(entry.path)}.old`);
  await rename(entry.path, aside);
}

/**
 * Re-check every input on disk: digests, statuses, day-book validation; and
 * generate whatever has become generatable. generateMissing=false skips
 * generation entirely; force keys regenerate even when satisfied.
 */
async function runIntake(
  m: WorkflowManifest,
  ctx: WorkflowToolCtx,
  wfDir: string,
  opts: { generateMissing: boolean; force?: InputKey[] },
): Promise<void> {
  const force = new Set(opts.force ?? []);
  for (const key of Object.keys(WORKFLOW_INPUTS)) {
    const spec = WORKFLOW_INPUTS[key];
    const entry = m.inputs[key];
    if (force.has(key) && spec.generator && !spec.generator.stepOnly) {
      await setAside(wfDir, entry);
      try {
        await generateInput(m, ctx, wfDir, key);
      } catch (e) {
        entry.status = "missing";
        entry.reason = `generation failed: ${errMsg(e)}`;
      }
      continue;
    }
    if (entry.path) {
      const { digest, invalid, reason } = await digestUserFile(m, ctx, key, entry);
      entry.digest = digest;
      if (invalid) {
        entry.status = "invalid";
        entry.reason = invalid;
      } else {
        entry.status = inputStatus(spec, entry, digest);
        entry.reason = entry.status === "missing" ? reason : undefined;
      }
      continue;
    }
    const gen = spec.generator;
    if (gen && !gen.stepOnly) {
      if (gen.args(m.params, (k) => m.inputs[k]?.path, join(wfDir, "to-fill")) === undefined) {
        if (!opts.generateMissing) continue;
        const waiting = (gen.needs ?? []).filter((k) => !m.inputs[k]?.path);
        entry.reason =
          waiting.length > 0
            ? `waiting for: ${waiting.join(", ")}`
            : undefined;
        continue;
      }
      if (!opts.generateMissing) continue;
      try {
        await generateInput(m, ctx, wfDir, key);
      } catch (e) {
        entry.status = "missing";
        entry.reason = `generation failed: ${errMsg(e)}`;
      }
    }
  }
}

export function registerWorkflowTools(register: ToolRegistrar, ctx: WorkflowToolCtx): void {
  const { session } = ctx;

  register(
    "tb_audit_workflow_start",
    "Start a tax-audit workflow for one company and period: create the workflow folder under " +
      "audit-workflows/, check every input, generate the missing templates into to-fill/ and return " +
      "the intake table. Pass PATHS in inputs - never file contents. The folder is the workflow's " +
      "only state; status and run read it back from disk.",
    {
      company: z.string().describe("Company name as in Tally"),
      fromDate: z.string().describe("Period start, YYYYMMDD"),
      toDate: z.string().describe("Period end, YYYYMMDD"),
      asOnDate: z.string().optional().describe("As-on date for the review lenses; defaults to today, YYYYMMDD"),
      inputs: z.record(z.string()).optional().describe(
        "Map of input key to PATH: " + Object.keys(WORKFLOW_INPUTS).join(", "),
      ),
      steps: z.array(z.string()).optional().describe(
        "Step ids to include; default all: " + WORKFLOW_STEPS.map((s) => s.id).join(", "),
      ),
      excludeSteps: z.array(z.string()).optional().describe("Step ids to skip entirely"),
    },
    async (args) => {
      try {
        const selectedSteps = resolveSteps(args);
        for (const k of Object.keys(args.inputs ?? {})) validKeys([k], "inputs");
        const params: WorkflowParams = {
          company: args.company,
          fromDate: args.fromDate,
          toDate: args.toDate,
          asOnDate: args.asOnDate ?? todayYmd(),
        };
        const base = `${slug(args.company)}-${args.fromDate}-${args.toDate}-${stamp()}`;
        let wfDir = join(wfRoot(ctx.cfg), base);
        for (let n = 2; (await exists(wfDir)); n++) wfDir = join(wfRoot(ctx.cfg), `${base}-${n}`);
        await mkdir(wfRoot(ctx.cfg), { recursive: true });
        await mkdir(wfDir);
        await mkdir(join(wfDir, "to-fill"));

        const tallyReachable = await ctx
          .call("tb_list_companies", {})
          .then(() => true)
          .catch(() => false);

        const initial: Record<InputKey, WorkflowInputEntry> = {};
        for (const [k, v] of Object.entries(args.inputs ?? {})) {
          initial[k] = { status: "missing", path: resolve(String(v)), source: "user" };
        }
        const m = newManifest(params, initial, selectedSteps, basename(wfDir));
        m.tallyReachable = tallyReachable;
        await runIntake(m, ctx, wfDir, { generateMissing: true });
        await saveManifest(wfDir, m);
        await ctx.audit(
          "tb_audit_workflow_start",
          {
            workflowId: m.workflowId,
            inputs: Object.keys(args.inputs ?? {}),
            steps: selectedSteps,
          },
          Object.values(m.inputs).filter((e) => e.path).length,
          0,
        );
        return JSON.stringify(workflowView(m, wfDir), null, 2);
      } catch (e) {
        throw scrubbed(e, session);
      }
    },
  );

  register(
    "tb_audit_workflow_status",
    "Report a tax-audit workflow's intake table, or list every workflow when no id is given. " +
      "Re-checks the files on disk (a filled generated file reads 'filled'), generates whatever has " +
      "become generatable, and applies patches: setInputs (key to PATH), accept, approve (the GST " +
      "working sheet only — set only when the user has explicitly approved the working-sheet totals; " +
      "never infer approval) and regenerate (a fresh generated copy).",
    {
      workflowId: z.string().optional().describe("The workflow folder name; omit to list all workflows"),
      setInputs: z.record(z.string()).optional().describe("Map of input key to PATH to add or replace"),
      accept: z.array(z.string()).optional().describe("Input keys to mark accepted (checked, no more edits)"),
      approve: z.array(z.string()).optional().describe(
        "Input keys to approve; only the GST working sheet is approvable, and only on the operator's explicit sign-off",
      ),
      regenerate: z.array(z.string()).optional().describe("Input keys to regenerate fresh into to-fill/"),
    },
    async (args) => {
      try {
        if (args.workflowId === undefined) {
          const root = wfRoot(ctx.cfg);
          const workflows: Array<Record<string, unknown>> = [];
          let names: string[] = [];
          try {
            names = (await readdir(root, { withFileTypes: true }))
              .filter((d) => d.isDirectory())
              .map((d) => d.name)
              .sort();
          } catch {
            names = [];
          }
          for (const name of names) {
            try {
              const m = await loadManifest(join(root, name));
              workflows.push({
                workflowId: name,
                company: m.params.company,
                fromDate: m.params.fromDate,
                toDate: m.params.toDate,
                steps: stepRows(m).length
                  ? {
                      done: m.selectedSteps.filter((id) => m.steps[id]?.status === "done").length,
                      pending: m.selectedSteps.filter((id) => (m.steps[id]?.status ?? "pending") === "pending").length,
                      needsInput: m.selectedSteps.filter((id) => m.steps[id]?.status === "needs-input").length,
                    }
                  : undefined,
                nextAction: nextAction(m),
              });
            } catch {
              workflows.push({ workflowId: name, note: "no readable workflow.json" });
            }
          }
          await ctx.audit("tb_audit_workflow_status", { list: true }, workflows.length, 0);
          return JSON.stringify({ workflows }, null, 2);
        }

        const wfDir = join(wfRoot(ctx.cfg), args.workflowId);
        let m: WorkflowManifest;
        try {
          m = await loadManifest(wfDir);
        } catch {
          throw new Error(
            `no workflow '${args.workflowId}' under ${wfRoot(ctx.cfg)} — call tb_audit_workflow_status without an id to list them`,
          );
        }

        const setKeys = Object.keys(args.setInputs ?? {});
        for (const k of validKeys(setKeys, "setInputs")) {
          m.inputs[k] = {
            status: "missing",
            path: resolve(String((args.setInputs as Record<string, unknown>)[k])),
            source: "user",
          };
        }
        await runIntake(m, ctx, wfDir, { generateMissing: true });

        for (const k of validKeys(args.accept, "accept")) {
          m.inputs[k].accepted = true;
          m.inputs[k].status = inputStatus(WORKFLOW_INPUTS[k], m.inputs[k], m.inputs[k].digest);
        }
        for (const k of validKeys(args.approve, "approve")) {
          const spec = WORKFLOW_INPUTS[k];
          if (!spec.approvable) {
            throw new Error(`refused: '${k}' cannot be approved — only ${spec.label ?? ""} inputs marked approvable (the GST working sheet) take approval`);
          }
          const st = m.inputs[k].status;
          if (st !== "present" && st !== "filled") {
            throw new Error(`refused: '${k}' is ${st}; fill the sheet (or supply your own) before approving it`);
          }
          m.inputs[k].approved = true;
          m.inputs[k].status = inputStatus(spec, m.inputs[k], m.inputs[k].digest);
        }
        const regenKeys = validKeys(args.regenerate, "regenerate");
        if (regenKeys.length) {
          await runIntake(m, ctx, wfDir, { generateMissing: false, force: regenKeys });
        }

        await saveManifest(wfDir, m);
        await ctx.audit(
          "tb_audit_workflow_status",
          {
            workflowId: m.workflowId,
            ...(setKeys.length ? { setInputs: setKeys } : {}),
            ...(args.accept?.length ? { accept: args.accept } : {}),
            ...(args.approve?.length ? { approve: args.approve } : {}),
            ...(regenKeys.length ? { regenerate: regenKeys } : {}),
          },
          Object.values(m.inputs).filter((e) => e.path).length,
          0,
        );
        return JSON.stringify(workflowView(m, wfDir), null, 2);
      } catch (e) {
        throw scrubbed(e, session);
      }
    },
  );
}
