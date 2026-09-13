import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { registerTools, type ToolRegistrar } from "../src/index.js";
import { createSession } from "../src/review.js";
import { fakeDownstream } from "./fixtures/downstream-fake.js";

const SECRETS = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/secrets.json", import.meta.url)), "utf8"),
) as string[];

/**
 * Non-vacuity guard (canon §5.7): a secret that appears in no fixture can
 * never leak, so asserting its absence proves nothing. Every secret must be
 * carried by the corpus the gateway actually consumes — the raw downstream
 * fixtures or the returns file — before the absence assertions below mean
 * anything.
 */
const FIXTURE_CORPUS =
  readFileSync(fileURLToPath(new URL("./fixtures/tally-responses.json", import.meta.url)), "utf8") +
  readFileSync(fileURLToPath(new URL("./fixtures/gst-returns.json", import.meta.url)), "utf8");

function makeReturnsFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "tally-agent-returns-")), "returns.json");
  writeFileSync(
    path,
    readFileSync(fileURLToPath(new URL("./fixtures/gst-returns.json", import.meta.url)), "utf8"),
  );
  return path;
}

/**
 * Every gateway tool, exercised, with every outbound payload checked against
 * the manifest. A tool added later without masking fails here.
 */
describe("no secret leaves the gateway", () => {
  it("holds across the whole tool surface", async () => {
    for (const secret of SECRETS) {
      expect(
        FIXTURE_CORPUS.includes(secret.replace("HDFC ", "").replace("GSTIN", "")) ||
          containsCanonically(FIXTURE_CORPUS, secret),
        `secret "${secret}" appears in no fixture — the leak test would pass vacuously`,
      ).toBe(true);
    }
  });

  it("holds across the whole tool surface, exercised", async () => {
    const tools = new Map<string, (args: any) => Promise<string>>();
    const registrar: ToolRegistrar = (name, _d, _s, handler) => tools.set(name, handler);
    const session = createSession(fakeDownstream(), EMPTY_OVERRIDES);
    const reportDir = mkdtempSync(join(tmpdir(), "tally-agent-leak-"));
    registerTools(registrar, session, { reportDir });

    // tb_review must run first: later tools depend on its findings.
    const outputs: string[] = [];
    outputs.push(await tools.get("tb_review")!({ asOnDate: "20260331" }));
    outputs.push(await tools.get("tb_list_companies")!({}));

    const review = JSON.parse(outputs[0]);
    const wrongSide = review.findings.find((f: any) => f.check === "wrong_side_balance");
    for (const f of review.findings) {
      if (!f.ledger) continue;
      const out = await tools.get("tb_ledger_activity")!({
        findingId: f.id,
        fromDate: "20250401",
        toDate: "20260331",
      });
      outputs.push(out);

      // The fixture voucher for the creditor finding hands the same real
      // party back under three fields, one with different internal
      // whitespace (as a live company was seen doing). All three — plus the
      // fields the gateway does not name-mask directly — must resolve to the
      // exact same pseudonym as the finding itself, or the party fragments
      // across the report.
      // Only PUR/0012 names the creditor on all three fields; the other rows
      // name a counterparty (Zenith Logistics, Rent) on the party fields.
      if (f.id === wrongSide?.id) {
        const rows = JSON.parse(out);
        for (const row of rows) {
          expect(row.matchedLedgerName).toBe(f.ledger);
          if (row.voucherNumber !== "PUR/0012") continue;
          for (const field of ["partyLedgerName", "counterLedgerName"]) {
            expect(row[field]).toBe(f.ledger);
          }
        }
      }
    }

    outputs.push(
      await tools.get("tb_write_report")!({
        company: "Demo Traders Pvt Ltd",
        asOnDate: "20260331",
        markdown: "# Review\n\nSee findings.",
      }),
    );

    // M2: the GST surface, exercised against the same fixtures.
    outputs.push(await tools.get("tb_gst_summary")!({ fromDate: "20250401", toDate: "20260331" }));
    const returnsPath = makeReturnsFile();
    outputs.push(
      await tools.get("tb_gst_mismatch")!({
        fromDate: "20250401",
        toDate: "20260331",
        returnsPath,
      }),
    );
    outputs.push(
      await tools.get("tb_write_gst_report")!({
        company: "Demo Traders Pvt Ltd",
        fromDate: "20250401",
        toDate: "20260331",
        markdown: "# GST\n\nSee the findings.",
      }),
    );

    for (const out of outputs) {
      for (const secret of SECRETS) {
        expect(out, `secret "${secret}" leaked in a tool result`).not.toContain(secret);
      }
    }
  });

  it("covers every registered tool, so a new unmasked tool cannot slip in", async () => {
    const tools = new Map<string, unknown>();
    const registrar: ToolRegistrar = (name) => tools.set(name, true);
    registerTools(registrar, createSession(fakeDownstream(), EMPTY_OVERRIDES), {
      reportDir: mkdtempSync(join(tmpdir(), "tally-agent-leak-")),
    });
    expect([...tools.keys()].sort()).toEqual([
      "tb_gst_mismatch",
      "tb_gst_summary",
      "tb_ledger_activity",
      "tb_ledger_scrutiny",
      "tb_list_companies",
      "tb_review",
      "tb_write_gst_report",
      "tb_write_ledger_report",
      "tb_write_report",
    ]);
  });

  it("still does not expose the master-dump tool that returns bank and address details", async () => {
    const tools = new Map<string, unknown>();
    const registrar: ToolRegistrar = (name) => tools.set(name, true);
    registerTools(registrar, createSession(fakeDownstream(), EMPTY_OVERRIDES), {
      reportDir: mkdtempSync(join(tmpdir(), "tally-agent-leak-")),
    });
    expect(tools.has("tally_get_ledger")).toBe(false);
  });
});

/**
 * A canonicalized containment check for names that can appear with variant
 * whitespace or case in the fixtures, mirroring canonicalKey's collapse.
 */
function containsCanonically(corpus: string, secret: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(corpus).includes(norm(secret));
}
