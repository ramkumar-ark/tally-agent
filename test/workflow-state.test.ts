import { describe, expect, it } from "vitest";
import { WORKFLOW_INPUTS, WORKFLOW_STEPS, stepById } from "../src/workflow-registry.js";
import {
  fingerprint,
  inputStatus,
  newManifest,
  planPass,
  saveManifest,
  loadManifest,
  stepReadiness,
} from "../src/workflow-state.js";

const PARAMS = {
  company: "Acme Traders",
  fromDate: "20250401",
  toDate: "20260331",
  asOnDate: "20260331",
};

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function manifestWith(inputs: Record<string, object> = {}, stepState: Record<string, object> = {}) {
  const m = newManifest(PARAMS, undefined, undefined, "wf-1");
  for (const [key, patch] of Object.entries(inputs)) {
    m.inputs[key] = { ...m.inputs[key], ...patch } as (typeof m.inputs)[string];
  }
  for (const [id, patch] of Object.entries(stepState)) {
    m.steps[id] = { ...m.steps[id], ...patch } as (typeof m.steps)[string];
  }
  return m;
}

describe("inputStatus", () => {
  const spec = WORKFLOW_INPUTS.tdsTemplate;

  it("is missing without a path or digest", () => {
    expect(inputStatus(spec, { status: "missing" }, undefined)).toBe("missing");
    expect(inputStatus(spec, { status: "present", path: "/x.xlsx" }, undefined)).toBe("missing");
  });

  it("is invalid on a wrong extension", () => {
    expect(inputStatus(spec, { status: "present", path: "/x.xlsm" }, DIGEST_A)).toBe("invalid");
  });

  it("is generated-unfilled while the digest still equals the generated one", () => {
    expect(
      inputStatus(spec, { status: "generated-unfilled", path: "/x.xlsx", source: "generated", generatedDigest: DIGEST_A }, DIGEST_A),
    ).toBe("generated-unfilled");
  });

  it("becomes filled when the digest changes", () => {
    expect(
      inputStatus(spec, { status: "generated-unfilled", path: "/x.xlsx", source: "generated", generatedDigest: DIGEST_A }, DIGEST_B),
    ).toBe("filled");
  });

  it("shows accepted over filled", () => {
    expect(
      inputStatus(spec, { status: "filled", path: "/x.xlsx", generatedDigest: DIGEST_A, accepted: true }, DIGEST_B),
    ).toBe("accepted");
  });

  it("approves only approvable inputs that left the generated state", () => {
    const sheet = WORKFLOW_INPUTS.gstWorkingSheet;
    expect(
      inputStatus(sheet, { status: "generated-unfilled", path: "/s.xlsx", generatedDigest: DIGEST_A, approved: true }, DIGEST_A),
    ).toBe("generated-unfilled");
    expect(
      inputStatus(sheet, { status: "filled", path: "/s.xlsx", generatedDigest: DIGEST_A, approved: true }, DIGEST_B),
    ).toBe("approved");
    expect(
      inputStatus(spec, { status: "filled", path: "/x.xlsx", generatedDigest: DIGEST_A, approved: true }, DIGEST_B),
    ).toBe("filled");
  });

  it("a user-supplied file with no generated digest is present", () => {
    expect(inputStatus(spec, { status: "present", path: "/x.xlsx" }, DIGEST_A)).toBe("present");
  });
});

describe("stepReadiness", () => {
  it("requires required inputs and ignores optional ones", () => {
    const m = manifestWith({
      dayBook: { status: "present", path: "/d.json", digest: DIGEST_A },
    });
    const tds = stepById("tds")!;
    const r = stepReadiness(tds, m);
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(["tdsTemplate"]);
  });

  it("does not block on the stepOnly notds template", () => {
    const m = manifestWith({
      dayBook: { status: "present", path: "/d.json", digest: DIGEST_A },
      tdsTemplate: { status: "accepted", path: "/t.xlsx", digest: DIGEST_A },
    });
    expect(stepReadiness(stepById("notds")!, m).ready).toBe(true);
  });

  it("accepted and approved count as satisfied", () => {
    const m = manifestWith({
      dayBook: { status: "present", path: "/d.json", digest: DIGEST_A },
      tdsTemplate: { status: "approved", path: "/t.xlsx", digest: DIGEST_A },
    });
    expect(stepReadiness(stepById("tds")!, m).ready).toBe(true);
  });
});

describe("fingerprint", () => {
  it("depends only on params for live steps", () => {
    const m1 = manifestWith({ depreciationFile: { status: "present", path: "/f.json", digest: DIGEST_A } });
    const m2 = manifestWith({ depreciationFile: { status: "missing" } });
    expect(fingerprint(stepById("depreciation")!, m1)).toBe(fingerprint(stepById("depreciation")!, m2));
  });

  it("changes when a declared input's digest or status changes", () => {
    const tds = stepById("tds")!;
    const m1 = manifestWith({ dayBook: { status: "present", path: "/d.json", digest: DIGEST_A } });
    const m2 = manifestWith({ dayBook: { status: "present", path: "/d.json", digest: DIGEST_B } });
    const m3 = manifestWith({ dayBook: { status: "accepted", path: "/d.json", digest: DIGEST_A } });
    expect(fingerprint(tds, m1)).not.toBe(fingerprint(tds, m2));
    expect(fingerprint(tds, m1)).not.toBe(fingerprint(tds, m3));
  });
});

describe("planPass", () => {
  const readyManifest = () =>
    manifestWith(
      {
        dayBook: { status: "present", path: "/d.json", digest: DIGEST_A },
        tdsTemplate: { status: "accepted", path: "/t.xlsx", digest: DIGEST_A },
        pfEsiTemplate: { status: "accepted", path: "/p.xlsx", digest: DIGEST_A },
        gst44Template: { status: "present", path: "/g44.xlsx", digest: DIGEST_A },
        gstWorkingSheet: { status: "approved", path: "/ws.xlsx", digest: DIGEST_A },
      },
      {},
    );

  it("plans ready steps in registry order and records needs-input for the rest", () => {
    const m = readyManifest();
    m.selectedSteps = ["gst44", "tds", "as26", "pf_esi"];
    const { plan, recorded } = planPass(m);
    expect(plan).toEqual(["gst44", "tds", "pf_esi"]);
    expect(recorded).toEqual([
      { id: "as26", state: "needs-input", missing: ["as26Export", "as26Map"] },
    ]);
  });

  it("holds live steps while Tally is unreachable and releases them when reachable", () => {
    const m = readyManifest();
    m.selectedSteps = ["depreciation"];
    m.tallyReachable = false;
    expect(planPass(m).plan).toEqual([]);
    expect(planPass(m).recorded).toEqual([{ id: "depreciation", state: "needs-tally" }]);
    m.tallyReachable = true;
    expect(planPass(m).plan).toEqual(["depreciation"]);
  });

  it("skips done steps with an unchanged fingerprint and carries them", () => {
    const m = readyManifest();
    m.selectedSteps = ["pf_esi"];
    m.tallyReachable = true;
    const fp = fingerprint(stepById("pf_esi")!, m);
    m.steps.pf_esi = { status: "done", fingerprint: fp, lastPass: "pass-01-x", outputs: [] };
    const { plan, recorded } = planPass(m);
    expect(plan).toEqual([]);
    expect(recorded).toEqual([{ id: "pf_esi", state: "carried", carriedFrom: "pass-01-x" }]);
  });

  it("re-runs a done step when its fingerprint changed", () => {
    const m = readyManifest();
    m.selectedSteps = ["pf_esi"];
    m.tallyReachable = true;
    m.steps.pf_esi = { status: "done", fingerprint: "stale", lastPass: "pass-01-x", outputs: [] };
    expect(planPass(m).plan).toEqual(["pf_esi"]);
  });

  it("re-runs a done step named in rerun", () => {
    const m = readyManifest();
    m.selectedSteps = ["pf_esi"];
    m.tallyReachable = true;
    const fp = fingerprint(stepById("pf_esi")!, m);
    m.steps.pf_esi = { status: "done", fingerprint: fp, lastPass: "pass-01-x", outputs: [] };
    expect(planPass(m, { rerun: ["pf_esi"] }).plan).toEqual(["pf_esi"]);
  });

  it("re-runs partial steps with a changed fingerprint but carries same-fingerprint partials", () => {
    const m = readyManifest();
    m.selectedSteps = ["tds"];
    const fp = fingerprint(stepById("tds")!, m);
    m.steps.tds = { status: "partial", fingerprint: fp, lastPass: "pass-01-x", outputs: [] };
    expect(planPass(m).recorded[0].state).toBe("carried");
    m.inputs.tdsTemplate = { status: "filled", path: "/t.xlsx", digest: DIGEST_B, generatedDigest: DIGEST_A };
    expect(planPass(m).plan).toEqual(["tds"]);
  });

  it("orders after-prerequisites first within the plan", () => {
    const m = readyManifest();
    m.selectedSteps = ["dep3cd", "depreciation"];
    m.tallyReachable = true;
    m.inputs.dep3cdTemplate = { status: "accepted", path: "/d3.xlsx", digest: DIGEST_A };
    expect(planPass(m).plan).toEqual(["depreciation", "dep3cd"]);
  });

  it("reuses an open pass number and opens the next one when all are closed", () => {
    const m = readyManifest();
    m.selectedSteps = ["pf_esi"];
    expect(planPass(m).n).toBe(1);
    m.passes.push({ n: 1, dir: "pass-01-x", startedAt: "x", plan: [] });
    expect(planPass(m).n).toBe(1);
    expect(planPass(m).reopened).toBe(true);
    m.passes[0].closedAt = "later";
    expect(planPass(m).n).toBe(2);
    expect(planPass(m).reopened).toBe(false);
  });
});

describe("manifest persistence", () => {
  it("round-trips through save/load with tmp+rename", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "wf-man-"));
    const m = newManifest(PARAMS, undefined, ["pf_esi"], "wf-9");
    await saveManifest(dir, m);
    const loaded = await loadManifest(dir);
    expect(loaded.workflowId).toBe("wf-9");
    expect(loaded.selectedSteps).toEqual(["pf_esi"]);
    expect(loaded.inputs.dayBook.status).toBe("missing");
    expect(loaded.steps.loans.status).toBe("skipped");
  });
});

describe("WORKFLOW_STEPS wiring", () => {
  it("keeps the notds step after tds and the depreciation dependants after depreciation", () => {
    expect(stepById("notds")?.after).toEqual(["tds"]);
    expect(stepById("dep3cd")?.after).toEqual(["depreciation"]);
    expect(stepById("fa_register")?.after).toEqual(["depreciation"]);
    expect(stepById("gst44")?.after).toEqual(["gst_working_sheet"]);
  });
});
