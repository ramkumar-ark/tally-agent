import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isEntrypoint, overridesPath } from "../src/index.js";

/**
 * The gateway is started as `node <abs path>/dist/index.js` by the harness.
 * Its self-check used to compare `import.meta.url` against `process.argv[1]`
 * as raw strings. A file URL percent-encodes a space, an argv path does not,
 * so on any install path containing a space the comparison was false, main()
 * never ran, and the process exited 0 with no output — an MCP client sees a
 * server that starts and instantly dies with nothing to diagnose. Every path
 * on the machine this was verified on contains a space.
 */
describe("isEntrypoint", () => {
  const win = "C:\\Software Projects\\tally-agent\\dist\\index.js";
  const winUrl = "file:///C:/Software%20Projects/tally-agent/dist/index.js";

  it("matches a Windows path containing a space against its percent-encoded URL", () => {
    expect(isEntrypoint(winUrl, win)).toBe(true);
  });

  it("matches a Windows path with no space", () => {
    expect(
      isEntrypoint("file:///C:/tally-agent/dist/index.js", "C:\\tally-agent\\dist\\index.js"),
    ).toBe(true);
  });

  it("matches when the drive letter case differs, as Windows treats it", () => {
    expect(isEntrypoint(winUrl, "c:\\Software Projects\\tally-agent\\dist\\index.js")).toBe(
      process.platform === "win32",
    );
  });

  it("does not match a different file", () => {
    expect(isEntrypoint(winUrl, "C:\\Software Projects\\tally-agent\\dist\\other.js")).toBe(false);
  });

  it("is false when the module was imported rather than run", () => {
    expect(isEntrypoint(winUrl, undefined)).toBe(false);
  });

  it("is false rather than throwing on a non-file URL", () => {
    expect(isEntrypoint("https://example.com/index.js", win)).toBe(false);
  });

  // The cases above are written in Windows terms because that is where the
  // bug bites; this one is the same round trip on whatever platform is
  // running, through a directory whose name contains a space.
  it("matches a real file on this platform, in a directory with a space", () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-agent-entry "));
    const file = join(dir, "index.js");
    writeFileSync(file, "", "utf8");
    expect(isEntrypoint(pathToFileURL(file).href, file)).toBe(true);
  });
});

/**
 * The overrides file is the documented escape hatch for a group name the
 * classifier's allowlist has never seen, so it failing open and silent is a
 * masking hazard, not a nicety. `new URL(...).pathname` yields
 * "/C:/..." on Windows, which fs rejects with ENOENT for every Windows
 * install — spaces or not — and loadOverrides swallows that into "no
 * overrides configured".
 */
describe("overridesPath", () => {
  it("resolves to a path fs can open, not a URL pathname", () => {
    const p = overridesPath("file:///C:/Software%20Projects/tally-agent/dist/index.js");
    expect(p).not.toMatch(/^\/[A-Za-z]:/);
    expect(p).not.toContain("%20");
    expect(p.replace(/\\/g, "/")).toBe("C:/Software Projects/tally-agent/config/overrides.json");
  });

  it("resolves the real config file shipped in this repo", () => {
    const p = overridesPath(new URL("../dist/index.js", import.meta.url).href);
    expect(() => readFileSync(p, "utf8")).not.toThrow();
  });
});
