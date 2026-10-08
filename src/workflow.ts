import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, mkdir, readdir, rename, readFile, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ToolRegistrar, ToolsConfig } from "./index.js";
import type { Session } from "./review.js";
import { maskKnownNames, scrubSecrets } from "./mask.js";
import { loadDayBookText, readDayBook } from "./tds-daybook.js";
import {
  WORKFLOW_INPUTS,
  WORKFLOW_STEPS,
  stepById,
  stepDirName,
  type InputKey,
  type WorkflowParams,
  type WorkflowStep,
} from "./workflow-registry.js";
import {
  fingerprint,
  inputStatus,
  loadManifest,
  newManifest,
  planPass,
  saveManifest,
  satisfied,
  stepReadiness,
  type WorkflowInputEntry,
  type WorkflowManifest,
  type WorkflowPass,
  type WorkflowStepState,
} from "./workflow-state.js";
import {
  assertInside,
  autoNarrative,
  copyNoClobber,
  countFindings,
  listDir,
  renderIndex,
  renderLatestIndex,
  summaryJson,
  uniquePath,
  workflowFindingsCsv,
  writeTextFile,
  type LatestStepSource,
  type WorkflowCsvFinding,
} from "./workflow-package.js";
import type { StepCtx } from "./workflow-registry.js";

/**
 * The tax-audit workflow tools: tb_audit_workflow_start,
 * tb_audit_workflow_status, tb_audit_workflow_export_daybook and
 * tb_audit_workflow_run. The workflow folder is
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

/** Reason strings reach the model too: same scrubbers as errors. */
const scrubReason = (msg: string, session: Session): string =>
  scrubSecrets(maskKnownNames(msg, session.vault));

const wfRoot = (cfg: ToolsConfig): string => join(cfg.reportDir, "audit-workflows");

/** Everything scripts/export-daybook.mjs needs on one command line. */
export interface DayBookExportSpec {
  script: string;
  upstream: string;
  company: string;
  from: string;
  to: string;
  out: string;
}

export type SpawnDayBookExport = (spec: DayBookExportSpec) => Promise<{ code: number; stderr: string }>;

/** The first .js argument is the upstream server's entry script (its dist/index.js). */
export function resolveUpstreamScript(args: string[]): string | undefined {
  return args.find((a) => a.toLowerCase().endsWith(".js"));
}

const EXPORT_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_KEEP = 8000;

/**
 * Run scripts/export-daybook.mjs as its own child process: a whole-FY export
 * is far too large for the MCP stdio transport (the AGENTS.md 26AS sharp edge),
 * and one child process keeps the tool inside its own timeout budget. A
 * timeout or a non-zero exit is a normal failed return, never a thrown error.
 */
const defaultSpawnDayBookExport: SpawnDayBookExport = (spec) =>
  new Promise((resolveDone, rejectDone) => {
    const child = spawn(
      process.execPath,
      [spec.script, spec.upstream, spec.company, spec.from, spec.to, spec.out],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += (stderr ? "\n" : "") + `day-book export timed out after ${Math.round(EXPORT_TIMEOUT_MS / 60000)} minutes`;
    }, EXPORT_TIMEOUT_MS);
    child.stdout.resume();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > STDERR_KEEP) stderr = stderr.slice(-STDERR_KEEP);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      rejectDone(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveDone({ code: code ?? -1, stderr: stderr.trim() });
    });
  });

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
      return { digest, invalid: `day book failed validation: ${scrubReason(errMsg(e), ctx.session)}` };
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
  if (key === "gstWorkingSheet") {
    // The working-sheet step packages these findings into its pass folder
    // without regenerating; the tool result is already masked.
    const ws: WorkflowStepState = m.steps.gst_working_sheet ?? { status: "pending" };
    m.steps.gst_working_sheet = ws;
    ws.gstWorksheetFindings = JSON.stringify(
      Array.isArray((parsed as { findings?: unknown }).findings)
        ? (parsed as { findings: unknown[] }).findings
        : [],
    );
  }
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
        entry.reason = `generation failed: ${scrubReason(errMsg(e), ctx.session)}`;
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
        entry.reason = `generation failed: ${scrubReason(errMsg(e), ctx.session)}`;
      }
    }
  }
}

/** Absolute-looking strings anywhere in a parsed tool result. */
const ABS_PATH = /^(\/|[A-Za-z]:\\)/;

function jsonPathStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && ABS_PATH.test(value) && value.length < 1024) out.push(value);
    return out;
  }
  if (depth > 6) return out;
  if (Array.isArray(value)) {
    for (const v of value) jsonPathStrings(v, out, depth + 1);
    return out;
  }
  for (const v of Object.values(value)) jsonPathStrings(v, out, depth + 1);
  return out;
}

function progressOf(m: WorkflowManifest, pass: WorkflowPass) {
  const counts = { done: 0, partial: 0, failed: 0, needsInput: 0, remaining: 0, carried: 0, needsTally: 0 };
  for (const id of pass.plan) {
    const st = m.steps[id]?.status ?? "pending";
    if (st === "done") counts.done++;
    else if (st === "partial") counts.partial++;
    else if (st === "failed") counts.failed++;
    else if (st === "needs-input") counts.needsInput++;
    else counts.remaining++;
  }
  for (const r of pass.recorded ?? []) {
    if (r.state === "needs-input") counts.needsInput++;
    else if (r.state === "needs-tally") counts.needsTally++;
    else if (r.state === "carried") counts.carried++;
  }
  return counts;
}

/** Done steps the pass does not re-run still get their outputs, copied in. */
async function carryForward(
  m: WorkflowManifest,
  passDir: string,
  pass: WorkflowPass,
): Promise<void> {
  for (const r of pass.recorded ?? []) {
    if (r.state !== "carried") continue;
    const step = stepById(r.id);
    if (!step) continue;
    const index = WORKFLOW_STEPS.findIndex((s) => s.id === r.id);
    const stepDir = join(passDir, stepDirName(step, index));
    await mkdir(stepDir);
    const copied: string[] = [];
    for (const o of m.steps[r.id]?.outputs ?? []) {
      if (await exists(o)) copied.push(await copyNoClobber(o, stepDir));
    }
    const st: WorkflowStepState = m.steps[r.id] ?? { status: "done" };
    m.steps[r.id] = { ...st, outputs: copied, lastPass: pass.dir };
  }
}

/**
 * The pass's input snapshot: every used .xlsx/.json input except the huge
 * or privacy-sensitive ones (day book, 26AS export, Winman TDS summary),
 * plus inputs.json recording every key's path, digest and status.
 */
async function snapshotInputs(m: WorkflowManifest, passDir: string): Promise<void> {
  const inputsDir = join(passDir, "inputs");
  await mkdir(inputsDir);
  const record: Record<string, { path: string; digest: string | null; status: string }> = {};
  for (const [key, e] of Object.entries(m.inputs)) {
    if (!e.path) continue;
    record[key] = { path: e.path, digest: e.digest ?? null, status: e.status };
    if (key === "dayBook" || key === "as26Export" || key === "winmanTdsSummary") continue;
    const ext = extname(e.path).toLowerCase();
    if ((ext === ".xlsx" || ext === ".json") && (await exists(e.path))) {
      await copyNoClobber(e.path, inputsDir);
    }
  }
  await writeTextFile(join(inputsDir, "inputs.json"), JSON.stringify(record, null, 2));
}

/** LATEST.txt names the pass folder in play, from the moment that folder opens. */
async function markLatest(wfDir: string, passDir: string): Promise<void> {
  await writeTextFile(join(wfDir, "LATEST.txt"), `${passDir}\n`);
}

/** INDEX.md, summary.json for the pass; LATEST.txt for that same pass folder. */
async function writeArtifacts(
  m: WorkflowManifest,
  wfDir: string,
  pass: WorkflowPass,
): Promise<void> {
  const dir = join(wfDir, pass.dir);
  await writeTextFile(join(dir, "INDEX.md"), renderIndex(m, pass.n));
  await writeTextFile(join(dir, "summary.json"), JSON.stringify(summaryJson(m, pass.n), null, 2));
  await markLatest(wfDir, pass.dir);
  await saveManifest(wfDir, m);
  // The newest copy of every step's outputs is rebuilt when a pass closes —
  // the moment there is a new pass folder to take it from.
  if (pass.closedAt !== undefined) await rebuildLatest(wfDir, m);
}

/** The derived `latest/` folder: real copies (the captain opens them from Windows), never symlinks. */
const LATEST_DIR = "latest";
const LATEST_STAGING = "latest.build";
const LATEST_OLD = "latest.old";

/** `03-tds`, plus the `03-tds (2)` names uniquePath hands out when the plain one is taken. */
function stepFolderPattern(dirName: string): RegExp {
  return new RegExp(`^${dirName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: \\(\\d+\\))?$`);
}

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? await countFiles(join(dir, e.name)) : 1;
  }
  return n;
}

/**
 * The named step's folders inside one pass that hold files (an empty folder is
 * a needs-input step that never produced anything there), the ones the
 * manifest's own outputs point into first — that is how `03-tds (2)` wins over
 * an abandoned `03-tds`.
 */
async function stepFoldersOf(
  passDir: string,
  pattern: RegExp,
  preferred: ReadonlySet<string>,
): Promise<string[]> {
  const entries = await readdir(passDir, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !pattern.test(e.name)) continue;
    const full = resolve(join(passDir, e.name));
    if ((await listDir(full)).length === 0) continue;
    out.push(full);
  }
  out.sort((a, b) => Number(preferred.has(b)) - Number(preferred.has(a)) || b.localeCompare(a));
  return out;
}

/**
 * Rebuild `<workflow dir>/latest/`: for each step, a real copy of its output
 * folder from the most recent pass folder that produced one (a step that only
 * ever ran in an older pass keeps its files), plus a README naming that pass.
 * The folder is built in `latest.build/` and swapped in, so a failed copy
 * never leaves a half-empty `latest/` — the rebuild fails visibly instead.
 * Pass folders and operator inputs are only ever read here: `latest/` is
 * derived output.
 */
export async function rebuildLatest(
  wfDir: string,
  m: WorkflowManifest,
): Promise<LatestStepSource[]> {
  const passesNewestFirst = [...m.passes].reverse();
  const sources: LatestStepSource[] = [];
  const picks: Array<{ source: LatestStepSource; from: string }> = [];
  for (const [index, step] of WORKFLOW_STEPS.entries()) {
    const dirName = stepDirName(step, index);
    const source: LatestStepSource = { id: step.id, title: step.title, dirName, fromPass: null, files: 0 };
    sources.push(source);
    const preferred = new Set((m.steps[step.id]?.outputs ?? []).map((o) => resolve(dirname(o))));
    const pattern = stepFolderPattern(dirName);
    for (const p of passesNewestFirst) {
      const [folder] = await stepFoldersOf(join(wfDir, p.dir), pattern, preferred);
      if (!folder) continue;
      source.fromPass = p.dir;
      picks.push({ source, from: folder });
      break;
    }
  }

  const staging = join(wfDir, LATEST_STAGING);
  const latestDir = join(wfDir, LATEST_DIR);
  const previous = join(wfDir, LATEST_OLD);
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(staging, { recursive: true });
    for (const { source, from } of picks) {
      const dest = join(staging, source.dirName);
      await cp(from, dest, { recursive: true, dereference: true });
      source.files = await countFiles(dest);
    }
    await writeTextFile(join(staging, "README.md"), renderLatestIndex(sources));
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw new Error(`latest/ rebuild failed: ${errMsg(e)}`);
  }

  await rm(previous, { recursive: true, force: true });
  let hadPrevious = false;
  if (await exists(latestDir)) {
    await rename(latestDir, previous);
    hadPrevious = true;
  }
  try {
    await rename(staging, latestDir);
  } catch (e) {
    if (hadPrevious) await rename(previous, latestDir).catch(() => undefined);
    await rm(staging, { recursive: true, force: true });
    throw new Error(`latest/ rebuild failed: ${errMsg(e)}`);
  }
  if (hadPrevious) await rm(previous, { recursive: true, force: true });
  return sources;
}

export function registerWorkflowTools(
  register: ToolRegistrar,
  ctx: WorkflowToolCtx,
  opts: { spawnDayBookExport?: SpawnDayBookExport } = {},
): void {
  const { session } = ctx;
  const spawnExport = opts.spawnDayBookExport ?? defaultSpawnDayBookExport;

  /** workflowId -> the TDS-step fingerprint this process holds a review for. */
  const tdsCache = new Map<string, string>();

  const noteScrub = (msg: string): string => scrubSecrets(maskKnownNames(msg, session.vault));

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
      "become generatable, applies patches: setInputs (key to PATH), accept, approve (the GST " +
      "working sheet only — set only when the user has explicitly approved the working-sheet totals; " +
      "never infer approval) and regenerate (a fresh generated copy). With an id it also rebuilds " +
      "the workflow's latest/ folder (the newest copy of every step's outputs), so one status call " +
      "populates it for a workflow created before that folder existed.",
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
          const st = inputStatus(WORKFLOW_INPUTS[k], m.inputs[k], m.inputs[k].digest);
          // Accepting the generated file AS IS is a valid operator decision
          // (an empty PF/ESI template needs no edits) — accepted overrides.
          m.inputs[k].status = st === "generated-unfilled" ? "accepted" : st;
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
        // One status call is enough to populate latest/ for a workflow created
        // before it existed (or whose last pass closed long ago).
        const latest = await rebuildLatest(wfDir, m);
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
        return JSON.stringify(
          { ...workflowView(m, wfDir), latest: { dir: join(wfDir, LATEST_DIR), steps: latest } },
          null,
          2,
        );
      } catch (e) {
        throw scrubbed(e, session);
      }
    },
  );

  register(
    "tb_audit_workflow_export_daybook",
    "Export the day book for a tax-audit workflow's company and period into the workflow folder " +
      "(runs scripts/export-daybook.mjs as its own child process against the same upstream Tally " +
      "server the gateway is configured with, then validates the file). Skipped when the operator " +
      "supplied a day-book path — a user-supplied day book always wins; an earlier export of this " +
      "tool's own is moved aside and replaced. Call this when the intake table " +
      "shows the day book missing and Tally is reachable.",
    {
      workflowId: z.string().describe("The workflow folder name"),
    },
    async (args) => {
      try {
        const wfDir = join(wfRoot(ctx.cfg), args.workflowId);
        let m: WorkflowManifest;
        try {
          m = await loadManifest(wfDir);
        } catch {
          throw new Error(
            `no workflow '${args.workflowId}' under ${wfRoot(ctx.cfg)} — call tb_audit_workflow_status without an id to list them`,
          );
        }
        const entry = m.inputs.dayBook;
        // Only a USER-supplied path wins: a previous export of our own is
        // replaceable (Tally data moved on), moved aside, never clobbered.
        if (entry.path !== undefined && entry.source !== "generated") {
          const note = satisfied("dayBook", m)
            ? "day book already supplied — nothing exported"
            : `day book path is set but not usable (${entry.status}) — fix it or set a good path with tb_audit_workflow_status`;
          await ctx.audit("tb_audit_workflow_export_daybook", { workflowId: m.workflowId }, 0, 0);
          return JSON.stringify({ ...workflowView(m, wfDir), exported: false, note }, null, 2);
        }
        const upstream = resolveUpstreamScript(ctx.cfg.downstreamArgs ?? []);
        if (upstream === undefined) {
          entry.reason =
            "cannot export the day book: the upstream Tally MCP server path is not configured — " +
            "point TALLY_MCP_ARGS at the upstream's dist/index.js, or run scripts/export-daybook.mjs " +
            "yourself and set the path with tb_audit_workflow_status";
          await saveManifest(wfDir, m);
          await ctx.audit("tb_audit_workflow_export_daybook", { workflowId: m.workflowId }, 0, 0);
          return JSON.stringify({ ...workflowView(m, wfDir), exported: false }, null, 2);
        }
        const script = fileURLToPath(new URL("../scripts/export-daybook.mjs", import.meta.url));
        const out = join(wfDir, "daybook.json");
        if (await exists(out)) {
          const aside = await uniquePath(wfDir, "daybook.json.old");
          await rename(out, aside);
        }
        let run: { code: number; stderr: string };
        try {
          run = await spawnExport({
            script,
            upstream,
            company: m.params.company,
            from: m.params.fromDate,
            to: m.params.toDate,
            out,
          });
        } catch (e) {
          entry.reason = `day-book export failed: ${scrubReason(errMsg(e), ctx.session)}`;
          await saveManifest(wfDir, m);
          await ctx.audit("tb_audit_workflow_export_daybook", { workflowId: m.workflowId }, 0, 0);
          return JSON.stringify({ ...workflowView(m, wfDir), exported: false }, null, 2);
        }
        if (run.code !== 0) {
          const tail = run.stderr
            ? run.stderr.split("\n").slice(-3).join("\n")
            : `exit ${run.code}`;
          entry.reason = `day-book export failed: ${scrubReason(tail, ctx.session)}`;
          await saveManifest(wfDir, m);
          await ctx.audit("tb_audit_workflow_export_daybook", { workflowId: m.workflowId }, 0, 0);
          return JSON.stringify({ ...workflowView(m, wfDir), exported: false }, null, 2);
        }
        try {
          const text = await loadDayBookText(out, ctx.cfg.dayBookMaxBytes);
          readDayBook(text, {
            company: m.params.company,
            fromDate: m.params.fromDate,
            toDate: m.params.toDate,
          });
        } catch (e) {
          entry.reason = `day book failed validation: ${scrubReason(errMsg(e), ctx.session)}`;
          await saveManifest(wfDir, m);
          await ctx.audit("tb_audit_workflow_export_daybook", { workflowId: m.workflowId }, 0, 0);
          return JSON.stringify({ ...workflowView(m, wfDir), exported: false }, null, 2);
        }
        // A fresh export the operator has not touched: no generatedDigest, so
        // the status reads "present", never "generated-unfilled".
        entry.path = out;
        entry.source = "generated";
        entry.digest = sha256(await readFile(out));
        entry.accepted = false;
        entry.approved = false;
        entry.reason = undefined;
        entry.status = inputStatus(WORKFLOW_INPUTS.dayBook, entry, entry.digest);
        await saveManifest(wfDir, m);
        await ctx.audit("tb_audit_workflow_export_daybook", { workflowId: m.workflowId }, 1, 0);
        return JSON.stringify({ ...workflowView(m, wfDir), exported: true }, null, 2);
      } catch (e) {
        throw scrubbed(e, session);
      }
    },
  );

  const indexInRegistry = (id: string): number => WORKFLOW_STEPS.findIndex((s) => s.id === id);

  /** outDir/outPath must sit inside the workflow folder and hold no user input. */
  const guardTargets = async (
    m: WorkflowManifest,
    wfDir: string,
    toolArgs: Record<string, unknown>,
  ): Promise<void> => {
    for (const key of ["outDir", "outPath"]) {
      const t = toolArgs[key];
      if (typeof t !== "string") continue;
      await assertInside(wfDir, t);
      for (const [k, e] of Object.entries(m.inputs)) {
        if (e.source !== "user" || !e.path) continue;
        const rel = relative(resolve(t), e.path);
        if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
          throw new Error(`refusing to write into ${key}: it contains the user input '${k}'`);
        }
      }
    }
  };

  /** Executes one planned step; returns its (already persisted) state. */
  const runStep = async (
    m: WorkflowManifest,
    wfDir: string,
    pass: WorkflowPass,
    id: string,
  ): Promise<WorkflowStepState> => {
    const step = stepById(id)!;
    const passDir = join(wfDir, pass.dir);
    const stepDir = await uniquePath(passDir, stepDirName(step, indexInRegistry(id)));
    await mkdir(stepDir);
    const toFillDir = join(wfDir, "to-fill");
    const state: WorkflowStepState = m.steps[id] ?? { status: "pending" };
    m.steps[id] = state;
    state.status = "running";
    state.runningSince = new Date().toISOString();
    state.runningProcess = ctx.sessionId;
    state.outputs = [];
    state.notes = (state.notes ?? []).filter((n) => n.startsWith("interrupted"));
    state.error = undefined;
    state.findings = undefined;
    await saveManifest(wfDir, m);

    const mkCtx = (last: unknown): StepCtx => ({
      params: m.params,
      path: (k) => m.inputs[k]?.path,
      status: (k) => m.inputs[k]?.status,
      stepDir,
      toFillDir,
      last,
      narrative: (title, result) => autoNarrative(title, result),
    });

    const markStop = (status: WorkflowStepState["status"]): void => {
      state.status = status;
      state.runningProcess = undefined;
      state.runningSince = undefined;
      state.lastPass = pass.dir;
      if (status === "done" || status === "partial") {
        state.fingerprint = fingerprint(step, m);
        if (id === "tds") tdsCache.set(m.workflowId, state.fingerprint);
      }
    };

    const parsedResults: Array<{ tool: string; parsed: unknown }> = [];
    let partial = false;

    if (step.custom === "gst_working_sheet") {
      const entry = m.inputs.gstWorkingSheet;
      if (!entry?.path || !(await exists(entry.path))) {
        state.error = noteScrub(
          "no working sheet present — give a day book and let the workflow generate one, or set it with tb_audit_workflow_status",
        );
        markStop("failed");
        await saveManifest(wfDir, m);
        return state;
      }
      const sheetCopy = await copyNoClobber(entry.path, stepDir);
      let findings: WorkflowCsvFinding[] = [];
      try {
        findings = JSON.parse(state.gstWorksheetFindings ?? "[]") as WorkflowCsvFinding[];
      } catch {
        findings = [];
      }
      const csvPath = join(stepDir, "gst-working-sheet-findings.csv");
      await writeTextFile(csvPath, workflowFindingsCsv(findings, session.vault));
      state.findings = countFindings({ findings });
      state.outputs = [sheetCopy, csvPath];
      state.notes = entry.status === "approved" ? [] : ["awaiting approval"];
      markStop("done");
      await saveManifest(wfDir, m);
      return state;
    }

    if (step.custom === "notds") {
      const templateEntry = m.inputs.notdsTemplate;
      const templateUsable =
        !!templateEntry?.path &&
        (await exists(templateEntry.path)) &&
        templateEntry.status !== "generated-unfilled";
      if (!templateUsable) {
        if (!templateEntry?.path || !(await exists(templateEntry.path))) {
          const raw = await ctx.call("tb_write_notds_template", {
            company: m.params.company,
            outDir: toFillDir,
          });
          const { templatePath } = JSON.parse(raw) as { templatePath: string };
          const digest = sha256(await readFile(templatePath));
          templateEntry.path = templatePath;
          templateEntry.source = "generated";
          templateEntry.generatedDigest = digest;
          templateEntry.digest = digest;
          templateEntry.accepted = false;
          templateEntry.approved = false;
          templateEntry.status = inputStatus(WORKFLOW_INPUTS.notdsTemplate, templateEntry, digest);
        }
        state.outputs = [templateEntry.path as string];
        state.notes = [
          "no-TDS template generated into to-fill — fill it, then call tb_audit_workflow_status (accept notdsTemplate) and run again",
        ];
        markStop("needs-input");
        await saveManifest(wfDir, m);
        return state;
      }
      const tdsFp = fingerprint(stepById("tds")!, m);
      if (tdsCache.get(m.workflowId) !== tdsFp) {
        await ctx.call("tb_tds_review", {
          fromDate: m.params.fromDate,
          toDate: m.params.toDate,
          asOnDate: m.params.asOnDate,
          company: m.params.company,
          templatePath: m.inputs.tdsTemplate?.path,
          winmanPath: m.inputs.winmanTdsSummary?.path,
          dayBookPath: m.inputs.dayBook?.path,
        });
        tdsCache.set(m.workflowId, tdsFp);
        state.notes = [...(state.notes ?? []), "re-ran tb_tds_review (no fresh cache this process)"];
      } else {
        state.notes = [...(state.notes ?? []), "reused this process's TDS review"];
      }
      let review: unknown;
      try {
        review = JSON.parse(await ctx.call("tb_notds_review", { templatePath: templateEntry.path }));
      } catch (e) {
        state.error = noteScrub(errMsg(e));
        markStop("failed");
        await saveManifest(wfDir, m);
        return state;
      }
      parsedResults.push({ tool: "tb_notds_review", parsed: review });
      state.findings = countFindings(review);
      const winmanPath = m.inputs.winmanNotds?.path;
      if (winmanPath) {
        try {
          await ctx.call("tb_write_3cd_notds", { sourcePath: winmanPath, outPath: stepDir });
        } catch (e) {
          state.notes = [...(state.notes ?? []), `error in tb_write_3cd_notds: ${noteScrub(errMsg(e))}`];
          partial = true;
        }
      } else {
        state.notes = [...(state.notes ?? []), "skipped: Winman clause 21(b) workbook not given"];
        partial = true;
      }
      const findingsRows = ((review as { findings?: WorkflowCsvFinding[] }).findings ?? []);
      const csvPath = join(stepDir, "notds-findings.csv");
      await writeTextFile(csvPath, workflowFindingsCsv(findingsRows, session.vault));
      const outs = (await listDir(stepDir)).map((f) => join(stepDir, f));
      state.outputs = outs.sort();
      markStop(partial ? "partial" : "done");
      await saveManifest(wfDir, m);
      return state;
    }

    if (step.custom === "tds_payable") {
      const entry = m.inputs.payableDecisions;
      const usable =
        !!entry?.path && (await exists(entry.path)) && entry.status !== "generated-unfilled";
      if (!usable) {
        if (!entry?.path || !(await exists(entry.path))) {
          const raw = await ctx.call("tb_write_tds_payable_decisions", {
            company: m.params.company,
            outDir: toFillDir,
          });
          const { templatePath } = JSON.parse(raw) as { templatePath: string };
          const digest = sha256(await readFile(templatePath));
          entry.path = templatePath;
          entry.source = "generated";
          entry.generatedDigest = digest;
          entry.digest = digest;
          entry.accepted = false;
          entry.approved = false;
          entry.status = inputStatus(WORKFLOW_INPUTS.payableDecisions, entry, digest);
        }
        state.outputs = [entry.path as string];
        state.notes = [
          "TDS payable decisions workbook generated into to-fill — mark every critical finding Accept or " +
            "Reject, then call tb_audit_workflow_status (accept payableDecisions) and run again",
        ];
        markStop("needs-input");
        await saveManifest(wfDir, m);
        return state;
      }
      // The statement prices the cached run's critical findings, so the TDS
      // review it reads has to be this process's (the decisions workbook is
      // bound to that run's identity and would be refused otherwise).
      const tdsFp = fingerprint(stepById("tds")!, m);
      if (tdsCache.get(m.workflowId) !== tdsFp) {
        await ctx.call("tb_tds_review", {
          fromDate: m.params.fromDate,
          toDate: m.params.toDate,
          asOnDate: m.params.asOnDate,
          company: m.params.company,
          templatePath: m.inputs.tdsTemplate?.path,
          winmanPath: m.inputs.winmanTdsSummary?.path,
          dayBookPath: m.inputs.dayBook?.path,
        });
        tdsCache.set(m.workflowId, tdsFp);
        state.notes = [...(state.notes ?? []), "re-ran tb_tds_review (no fresh cache this process)"];
      } else {
        state.notes = [...(state.notes ?? []), "reused this process's TDS review"];
      }
      // The payment date is the workflow's as-on date: the statement is priced
      // to the day the audit is as at, and a later run re-prices it.
      const toolArgs = {
        decisionsPath: entry.path,
        paymentDate: m.params.asOnDate,
        outDir: stepDir,
      };
      let statement: unknown;
      try {
        await guardTargets(m, wfDir, toolArgs);
        statement = JSON.parse(await ctx.call("tb_tds_payable_statement", toolArgs));
      } catch (e) {
        const msg = errMsg(e);
        // An undecided critical finding is the operator's next action, not a
        // failure: the workbook is on disk and waiting for a decision. Every
        // other fault (a workbook from another run, a bad Decision cell) is a
        // real failure of this step.
        const undecided = /not decided yet/i.test(msg);
        state.error = noteScrub(msg);
        markStop(undecided ? "needs-input" : "failed");
        await saveManifest(wfDir, m);
        return state;
      }
      parsedResults.push({ tool: "tb_tds_payable_statement", parsed: statement });
      const s = statement as {
        critical?: number;
        accepted?: number;
        totals?: { shortfall?: string; interest?: string; payable?: string };
        statementPath?: string;
      };
      state.findings = countFindings(statement);
      state.notes = [
        ...(state.notes ?? []),
        `payable statement: ${s.accepted ?? 0} of ${s.critical ?? 0} critical findings accepted; ` +
          `tax ${s.totals?.shortfall ?? "-"}, interest ${s.totals?.interest ?? "-"}, ` +
          `payable ${s.totals?.payable ?? "-"} as on ${m.params.asOnDate}`,
      ];
      state.outputs = [
        ...(s.statementPath ? [s.statementPath] : []),
        ...(await listDir(stepDir)).map((f) => join(stepDir, f)),
      ].sort();
      markStop("done");
      await saveManifest(wfDir, m);
      return state;
    }

    for (const action of step.actions) {
      const actx = mkCtx(parsedResults[parsedResults.length - 1]?.parsed);
      const verdict = action.when?.(actx) ?? true;
      if (verdict !== true) {
        state.notes = [...(state.notes ?? []), `skipped: ${verdict}`];
        if (action.kind === "fill") partial = true;
        continue;
      }
      const toolArgs = action.args(actx);
      try {
        await guardTargets(m, wfDir, toolArgs);
        const raw = await ctx.call(action.tool, toolArgs);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        parsedResults.push({ tool: action.tool, parsed });
        if (action.kind === "review") state.findings = countFindings(parsed);
      } catch (e) {
        const msg = noteScrub(errMsg(e));
        if (action.kind === "review") {
          state.error = msg;
          markStop("failed");
          await saveManifest(wfDir, m);
          return state;
        }
        state.notes = [...(state.notes ?? []), `error in ${action.tool}: ${msg}`];
        partial = true;
      }
    }

    const outs = (await listDir(stepDir)).map((f) => join(stepDir, f));
    for (const { tool, parsed } of parsedResults) {
      for (const p of jsonPathStrings(parsed)) {
        const rel = relative(stepDir, p);
        if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) continue;
        if (!(await exists(p))) continue;
        const copied = await copyNoClobber(p, stepDir);
        state.notes = [
          ...(state.notes ?? []),
          `${tool} wrote outside the run folder; copied in as ${basename(copied)}`,
        ];
        if (!outs.includes(copied)) outs.push(copied);
      }
    }
    state.outputs = outs.sort();
    markStop(partial ? "partial" : "done");
    await saveManifest(wfDir, m);
    return state;
  };

  register(
    "tb_audit_workflow_run",
    "Run ONE planned step of a tax-audit workflow per call and return the next one. Opens the next " +
      "pass on the first call (carry-forward of done steps, input snapshot), picks the named step or " +
      "the first still-pending one, writes everything into the pass folder, and rewrites INDEX.md and " +
      "summary.json after every step. A review failure fails the step (the pass continues on the next " +
      "call); a report or fill failure leaves the step partial. One step per call keeps each call " +
      "inside the tool timeout.",
    {
      workflowId: z.string().describe("The workflow folder name"),
      step: z.string().optional().describe("A specific planned step id to run now"),
      rerun: z.array(z.string()).optional().describe("Step ids to re-run even when done with an unchanged fingerprint"),
    },
    async (args) => {
      try {
        for (const id of args.rerun ?? []) {
          if (!stepById(id)) throw new Error(`unknown step id '${id}'`);
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
        let pass = m.passes[m.passes.length - 1];
        const open = pass !== undefined && pass.closedAt === undefined;
        if (!open) {
          if (m.selectedSteps.some((id) => stepById(id)?.live)) {
            m.tallyReachable = await ctx
              .call("tb_list_companies", {})
              .then(() => true)
              .catch(() => false);
          }
          const planned = planPass(m, { rerun: args.rerun });
          const dirName = `pass-${String(planned.n).padStart(2, "0")}-${stamp()}`;
          const dir = join(wfDir, dirName);
          await mkdir(dir);
          await markLatest(wfDir, dirName);
          pass = {
            n: planned.n,
            dir: dirName,
            startedAt: new Date().toISOString(),
            plan: planned.plan,
            recorded: planned.recorded,
          };
          m.passes.push(pass);
          await carryForward(m, dir, pass);
          await snapshotInputs(m, dir);
        } else if (args.rerun?.length) {
          for (const id of args.rerun) {
            if (!m.selectedSteps.includes(id)) continue;
            if (!pass.plan.includes(id)) pass.plan.push(id);
            pass.recorded = (pass.recorded ?? []).filter((r) => r.id !== id);
            const st: WorkflowStepState = m.steps[id] ?? { status: "pending" };
            m.steps[id] = st;
            if (st.status === "done" || st.status === "partial" || st.status === "failed") {
              st.status = "pending";
            }
          }
        }
        for (const id of pass.plan) {
          const st = m.steps[id];
          if (st?.status === "running" && st.runningProcess !== ctx.sessionId) {
            st.status = "pending";
            st.notes = [...(st.notes ?? []), "interrupted — re-run"];
            st.outputs = [];
          }
        }
        await saveManifest(wfDir, m);

        if (args.step !== undefined && !pass.plan.includes(args.step)) {
          const rec = (pass.recorded ?? []).find((r) => r.id === args.step);
          throw new Error(
            `step '${args.step}' is not planned for ${pass.dir}` +
              (rec ? ` (recorded: ${rec.state}${rec.missing ? `: ${rec.missing.join(", ")}` : ""})` : ""),
          );
        }
        // A planned step whose stale status comes from an EARLIER pass (or a
        // rerun) is here exactly because something changed: normalize it to
        // pending so it executes and the pass bookkeeping stays honest. A
        // step already executed in THIS pass (lastPass matches) never re-runs.
        const runnable = (id: string): boolean => {
          if ((m.steps[id]?.lastPass ?? undefined) === pass.dir) return false;
          const st = m.steps[id]?.status ?? "pending";
          return st === "pending" || st === "partial" || st === "failed" || st === "running";
        };
        let pendingId = args.step ?? pass.plan.find(runnable);
        if (pendingId !== undefined && args.step === undefined) {
          const st = m.steps[pendingId];
          if (st?.status === "partial" || st?.status === "failed") st.status = "pending";
        }

        if (pendingId === undefined) {
          if (pass.closedAt === undefined) pass.closedAt = new Date().toISOString();
          await writeArtifacts(m, wfDir, pass);
          await ctx.audit(
            "tb_audit_workflow_run",
            { workflowId: m.workflowId, pass: pass.n, closed: true },
            0,
            0,
          );
          return JSON.stringify(
            {
              workflowId: m.workflowId,
              pass: pass.n,
              passClosed: true,
              passDir: join(wfDir, pass.dir),
              progress: progressOf(m, pass),
              step: null,
              next: null,
            },
            null,
            2,
          );
        }

        const stepState = await runStep(m, wfDir, pass, pendingId);
        const stillPending = pass.plan.some(
          (id) => (m.steps[id]?.status ?? "pending") === "pending",
        );
        if (!stillPending) pass.closedAt = new Date().toISOString();
        await writeArtifacts(m, wfDir, pass);
        await ctx.audit(
          "tb_audit_workflow_run",
          { workflowId: m.workflowId, step: pendingId, pass: pass.n },
          (stepState.outputs ?? []).length,
          0,
        );
        return JSON.stringify(
          {
            workflowId: m.workflowId,
            pass: pass.n,
            passDir: join(wfDir, pass.dir),
            step: {
              id: pendingId,
              status: stepState.status,
              ...(stepState.findings ? { findings: stepState.findings } : {}),
              outputs: stepState.outputs ?? [],
              ...(stepState.notes?.length ? { notes: stepState.notes } : {}),
              ...(stepState.error ? { error: stepState.error } : {}),
            },
            progress: progressOf(m, pass),
            passClosed: !stillPending,
            next: stillPending
              ? (pass.plan.find((id) => (m.steps[id]?.status ?? "pending") === "pending") ?? null)
              : null,
          },
          null,
          2,
        );
      } catch (e) {
        throw scrubbed(e, session);
      }
    },
  );
}
