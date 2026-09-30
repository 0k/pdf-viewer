import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function audit(source: string | null) {
  const root = mkdtempSync(join(tmpdir(), "pdf-viewer-chrome91-"));
  try {
    mkdirSync(join(root, "dist"));
    if (source !== null) writeFileSync(join(root, "dist/index.js"), source);
    return spawnSync(process.execPath, [resolve(import.meta.dirname, "../scripts/check-chrome91.mjs")], {
      cwd: root, encoding: "utf8",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("emitted Chrome 91 compatibility", () => {
  it("accepts valid ES2020 browser code", () => {
    const result = audit("export const zoom = options?.zoom ?? 1;");
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["static initialization blocks", "class Viewer { static {} }"],
    ["promise resolvers", "Promise.withResolvers();"],
    ["array indexing", "pages.at(-1);"],
    ["own-property helpers", "Object.hasOwn(page, 'id');"],
    ["reverse array search", "pages.findLast(page => page.ready);"],
    ["structured cloning", "structuredClone(page);"],
    ["copying array methods", "pages.toSorted();"],
    ["invalid JavaScript", "export const = ;"],
  ])("rejects %s", (_feature, source) => {
    const result = audit(source);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dist/index.js");
  });

  it("rejects an empty build output", () => {
    const result = audit(null);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No emitted JavaScript");
  });
});
