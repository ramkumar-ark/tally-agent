import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EMPTY_OVERRIDES } from "../src/classify.js";
import { loadOverrides, loadWrongGroup } from "../src/overrides.js";
import { EMPTY_WRONG_GROUP } from "../src/types.js";

function file(body: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "tally-agent-overrides-")), "overrides.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

describe("loadWrongGroup", () => {
  it("yields no tuning when the file is missing or has no wrongGroup key", () => {
    expect(loadWrongGroup("/definitely/not/here/overrides.json")).toEqual(EMPTY_WRONG_GROUP);
    expect(loadWrongGroup(file({ forceMaskLedgers: [] }))).toEqual(EMPTY_WRONG_GROUP);
  });

  it("keeps the ignore list as written and canonicalises keywords", () => {
    const path = file({
      wrongGroup: {
        ignoreLedgers: ["Orchid Medical Expenses"],
        keywords: { expense: [" Hospitality "], neutral: ["REIMBURSABLE"] },
      },
    });
    expect(loadWrongGroup(path)).toEqual({
      ignoreLedgers: ["Orchid Medical Expenses"],
      keywords: { expense: ["hospitality"], neutral: ["reimbursable"] },
    });
  });

  it("throws on an unknown keyword list", () => {
    expect(() => loadWrongGroup(file({ wrongGroup: { keywords: { asset: ["plant"] } } }))).toThrow(
      'overrides: wrongGroup.keywords has an unknown list "asset"',
    );
  });

  it("throws on a keyword that could never match one name token, without echoing it", () => {
    expect(() => loadWrongGroup(file({ wrongGroup: { keywords: { expense: ["guest house"] } } }))).toThrow(
      /^overrides: every wrongGroup\.keywords\.expense entry must be one word of letters and digits$/,
    );
  });

  it("throws on malformed JSON, as loadOverrides does", () => {
    expect(() => loadWrongGroup(file("{ not json"))).toThrow();
  });

  it("reads the shipped config/overrides.json, which loadOverrides still reads unchanged", () => {
    const shipped = fileURLToPath(new URL("../config/overrides.json", import.meta.url));
    expect(loadWrongGroup(shipped)).toEqual({
      ignoreLedgers: [],
      keywords: { expense: [], income: [], party: [], bank: [], capital: [], loan: [], neutral: [] },
    });
    expect(loadOverrides(shipped)).toEqual(EMPTY_OVERRIDES);
  });
});
