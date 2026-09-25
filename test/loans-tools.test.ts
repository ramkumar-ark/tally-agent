import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";
import { buildLoansTemplateWorkbook } from "../src/loans-file.js";
import { buildWorkbook } from "../src/xlsx.js";
import { parseLoansTemplate, EMPTY_LOANS_TEMPLATE } from "../src/loans-file.js";
import { CHECK_ORDINAL } from "../src/types.js";
import { makeLoansWinmanFixture } from "./fixtures/winman-fixture.js";

// Synthetic ledgers and figures only: the real operator's loan ledgers, party
// names, PANs and addresses never appear in the repo (captain ruling).

const LEDGERS = [
  { name: "Metro Finance", parent: "Loans (Liability)" },
  { name: "Neighbour Trust", parent: "Loans (Liability)" },
  { name: "Cash", parent: "Cash-in-Hand" },
  { name: "Axis Bank", parent: "Bank Accounts" },
  { name: "Wholesale Client", parent: "Sundry Debtors" },
];
const GROUPS = [
  { name: "Loans (Liability)", parent: "\u0004 Primary" },
  { name: "Cash-in-Hand", parent: "Current Assets" },
  { name: "Bank Accounts", parent: "Current Assets" },
  { name: "Current Assets", parent: "\u0004 Primary" },
  { name: "Sundry Debtors", parent: "Current Assets" },
];
const VOUCHERS = [
  // Neighbour Trust cash acceptance 25,000 — 269SS breach
  {
    date: "2025-04-15", voucherType: "Journal", voucherNumber: "J-1",
    entries: [{ LEDGERNAME: "Cash", AMOUNT: -25000 }, { LEDGERNAME: "Neighbour Trust", AMOUNT: 25000 }],
  },
  // Metro Finance bank repayment 30,000 — no breach
  {
    date: "2026-02-15", voucherType: "Payment", voucherNumber: "P-1",
    entries: [{ LEDGERNAME: "Metro Finance", AMOUNT: -30000 }, { LEDGERNAME: "Axis Bank", AMOUNT: 30000 }],
  },
];
const BUNDLE = {
  tallyAgentExport: true,
  company: "Sample Co",
  groups: GROUPS,
  ledgers: LEDGERS,
  vouchers: VOUCHERS,
};
const PHASE = { fromDate: "20250401", toDate: "20260331" };

const rejectWith = (why: string) => async () => {
  throw new Error(why);
};

async function bundlePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "loans-tools-bundle-"));
  const p = join(dir, "daybook-bundle.json");
  await writeFile(p, JSON.stringify(BUNDLE), "utf8");
  return p;
}

async function templatePath(): Promise<string> {
  const { sheets } = buildLoansTemplateWorkbook(
    LEDGERS.filter((l) => ["Metro Finance", "Neighbour Trust"].includes(l.name)).map((l) => ({ name: l.name })),
    {},
  );
  const dir = await mkdtemp(join(tmpdir(), "loans-tools-template-"));
  const p = join(dir, "loans-template.xlsx");
  await writeFile(p, buildWorkbook(sheets));
  return p;
}

/** A session whose live calls reject (offline day-book runs). */
function offlineHarness() {
  const tools = new Map<string, (args: any) => Promise<string>>();
  const registrar: ToolRegistrar = (name, _d, _s, handler) => tools.set(name, handler);
  const stub = Object.assign(fakeDownstream(), {
    groups: rejectWith("no live tally"),
    ledgers: rejectWith("no live tally"),
  } as never);
  const session = createSession(stub, EMPTY_OVERRIDES);
  const cfg = { reportDir: mkdtempSync(join(tmpdir(), "loans-tools-")), dayBookMaxBytes: 64 * 1_048_576 };
  registerTools(registrar, session, cfg, "20260331T100000Z");
  const auditPath = join(cfg.reportDir, "session-20260331T100000Z.jsonl");
  const audits = (): Array<Record<string, unknown>> =>
    existsSync(auditPath)
      ? readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
  return { tools, session, cfg, audits };
}

describe("loans tool surface", () => {
  it("registers the loans quadruple", () => {
    const { tools } = offlineHarness();
    for (const name of [
      "tb_write_loans_template",
      "tb_loans_review",
      "tb_write_3cd_loans",
      "tb_write_loans_report",
    ]) {
      expect(tools.has(name)).toBe(true);
    }
  });
});

describe("check ordinals 19-26 are the loans checks and are stable", () => {
  it("maps the eight loans checks to 19..26 in the allocated order", () => {
    // Hard-coded pairs: NEVER renumber. Captained 2026-09-25 (ordinals 15-18
    // belong to the concurrent clause-44 lane).
    const expected: Array<[string, number]> = [
      ["loans_cash_acceptance", 19],
      ["loans_cash_repayment", 20],
      ["loans_mode_unknown", 21],
      ["loans_269st_receipt", 22],
      ["loans_269st_payment", 23],
      ["loans_splitting_suspect", 24],
      ["loans_max_amount_estimated", 25],
      ["loans_party_unmastered", 26],
    ];
    for (const [check, ordinal] of expected) {
      expect((CHECK_ORDINAL as Record<string, number>)[check]).toBe(ordinal);
    }
    // Landed tables untouched: the trial-balance block 1-8 and the PF/ESI
    // block 9-14, pinned verbatim (the pre-Task-8 renumber history compacted).
    const landed: Array<[string, number]> = [
      ["out_of_balance", 1],
      ["suspense_balance", 2],
      ["negative_cash", 3],
      ["wrong_side_balance", 4],
      ["overdrawn_bank", 5],
      ["ledger_under_primary_group", 6],
      ["dormant_balance", 7],
      ["ledger_in_wrong_group", 8],
      ["pf_esi_unclassified_contribution", 9],
      ["pf_esi_late_deposit", 10],
      ["pf_esi_challan_missing", 11],
      ["pf_esi_challan_unmatched", 12],
      ["pf_esi_amount_mismatch", 13],
      ["pf_esi_due_date_not_working_day", 14],
    ];
    for (const [check, ordinal] of landed) {
      expect(CHECK_ORDINAL[check as keyof typeof CHECK_ORDINAL]).toBe(ordinal);
    }
    // Nothing else sits in CHECK_ORDINAL beyond these fourteen lands and the
    // eight loans pins above (22 total): a newly inserted check — including
    // the clause-44 lane's future 15-18 — must not mint ids silently; pinning
    // the total forces this test to be revisited when CheckId grows.
    expect(Object.keys(CHECK_ORDINAL)).toHaveLength(22);
  });
});

describe("tb_write_loans_template", () => {
  it("writes the blank template into outDir, sourcing ledger names from the day book", async () => {
    const h = offlineHarness();
    const out = await h.tools.get("tb_write_loans_template")!({
      company: "Sample Co",
      outDir: h.cfg.reportDir,
      dayBookPath: await bundlePath(),
    });
    const parsed = JSON.parse(out);
    expect(parsed.templatePath).toMatch(/loans-operator-template-sample-co-\d{8}\.xlsx$/);
    expect(existsSync(parsed.templatePath)).toBe(true);
    expect(parsed.ledgers).toBe(5);
    // The blank generated template parses back to the empty operator shape.
    const parsedTemplate = parseLoansTemplate(readFileSync(parsed.templatePath));
    expect(parsedTemplate.parties).toHaveLength(5);
    expect(parsedTemplate.specifiedSums).toEqual([]);
    // Ledger names never ride the model envelope.
    expect(out).not.toContain("Metro Finance");
    // Audit carries paths only.
    const entry = h.audits().find((e) => e.tool === "tb_write_loans_template");
    expect(entry).toBeDefined();
    const args = entry!.args as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(["company", "dayBookPath", "outDir"]);
  });

  it("prefers the day-book ledger list over live masters", async () => {
    const h = offlineHarness();
    const out = await h.tools.get("tb_write_loans_template")!({
      dayBookPath: await bundlePath(),
    });
    expect(JSON.parse(out).ledgers).toBe(5);
  });
});

describe("tb_loans_review", () => {
  it("runs the books from the day-book file, audits paths only, and returns the masked result", async () => {
    const h = offlineHarness();
    const dp = await bundlePath();
    const tp = await templatePath();
    const out = await h.tools.get("tb_loans_review")!({
      company: "Sample Co",
      ...PHASE,
      dayBookPath: dp,
      templatePath: tp,
    });
    const parsed = JSON.parse(out);
    expect(parsed.mastersSource).toBe("bundle");
    expect(parsed.findings.some((f: { check: string }) => f.check === "loans_cash_acceptance")).toBe(true);
    // Masked output.
    expect(out).not.toContain("Neighbour Trust");
    expect(out).not.toContain("Metro Finance");
    // Audit: paths, dates and the digest — never row values or names.
    const entry = h.audits().find((e) => e.tool === "tb_loans_review")!;
    expect(entry).toBeDefined();
    const args = entry.args as Record<string, unknown>;
    expect(args.templatePath).toBe(tp);
    expect(args.dayBookPath).toBe(dp);
    expect((args.dayBookDigest as string)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(entry)).not.toContain("Neighbour Trust");
    expect(JSON.stringify(entry)).not.toContain("LEDGERNAME");
  });

  it("refuses both channels: a day book AND an explicit live fetch", async () => {
    const h = offlineHarness();
    await expect(
      h.tools.get("tb_loans_review")!({
        ...PHASE,
        dayBookPath: await bundlePath(),
        live: true,
      }),
    ).rejects.toThrow(/or live: true, not both/i);
  });

  it("refuses a missing day-book path", async () => {
    const h = offlineHarness();
    await expect(
      h.tools.get("tb_loans_review")!({
        ...PHASE,
        dayBookPath: join(mkdtempSync(join(tmpdir(), "loans-tools-none-")), "missing.json"),
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("tb_write_3cd_loans", () => {
  it("writes the clause-31/269ST Winman sheets from the cached review, defaulting outPath to the report dir", async () => {
    const h = offlineHarness();
    await h.tools.get("tb_loans_review")!({
      company: "Sample Co",
      ...PHASE,
      dayBookPath: await bundlePath(),
      templatePath: await templatePath(),
    });
    const dir = mkdtempSync(join(tmpdir(), "loans-tools-3cd-"));
    const winmanPath = join(dir, "Loans Deposits.xlsm");
    writeFileSync(winmanPath, makeLoansWinmanFixture());
    const out = await h.tools.get("tb_write_3cd_loans")!({ sourcePath: winmanPath });
    const parsed = JSON.parse(out);
    expect(parsed.outPath).toMatch(/Loans Deposits - filled - \d{8}\.xlsm$/);
    expect(existsSync(parsed.outPath)).toBe(true);
    // The source workbook is never written to.
    expect(readFileSync(winmanPath).toString("base64")).toBe(
      Buffer.from(makeLoansWinmanFixture()).toString("base64"),
    );
    const entry = h.audits().find((e) => e.tool === "tb_write_3cd_loans");
    expect(entry).toBeDefined();
    expect((entry!.args as Record<string, unknown>).sourcePath).toBe(winmanPath);
    expect(JSON.stringify(entry)).not.toContain("Neighbour Trust");
  });

  it("refuses to run with no cached loans review", async () => {
    const h = offlineHarness();
    const dir = mkdtempSync(join(tmpdir(), "loans-tools-3cd-ref-"));
    const winmanPath = join(dir, "Loans Deposits.xlsm");
    writeFileSync(winmanPath, makeLoansWinmanFixture());
    await expect(
      h.tools.get("tb_write_3cd_loans")!({ sourcePath: winmanPath, outPath: dir }),
    ).rejects.toThrow(/run tb_loans_review first/i);
  });
});

describe("tb_write_loans_report", () => {
  it("refuses to run with no cached loans review", async () => {
    const h = offlineHarness();
    await expect(
      h.tools.get("tb_write_loans_report")!({ company: "Sample Co" }),
    ).rejects.toThrow(/run tb_loans_review first/i);
  });

  it("writes the workbook from the cached review (period keyed file name)", async () => {
    const h = offlineHarness();
    await h.tools.get("tb_loans_review")!({
      ...PHASE,
      dayBookPath: await bundlePath(),
    });
    const out = await h.tools.get("tb_write_loans_report")!({ company: "Sample Co" });
    const parsed = JSON.parse(out);
    expect(parsed.workbookPath).toMatch(/loans-review-sample-co-20250401-20260331\.xlsx$/);
    expect(existsSync(parsed.workbookPath)).toBe(true);
  });
});

describe("blank template honesty", () => {
  it("the generated template without a ledger list still parses as EMPTY_LOANS_TEMPLATE", async () => {
    const { sheets } = buildLoansTemplateWorkbook([], {});
    const buf = buildWorkbook(sheets);
    expect(parseLoansTemplate(buf)).toEqual(EMPTY_LOANS_TEMPLATE);
  });
});
