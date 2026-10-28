import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function typecheck(options: string) {
  const root = resolve(import.meta.dirname, "..");
  const configPath = join(root, "tsconfig.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root, {}, configPath);
  const directory = mkdtempSync(join(tmpdir(), "pdf-viewer-types-"));
  try {
    const file = join(directory, "host.ts");
    writeFileSync(file, `import type { PdfViewerOptions } from ${JSON.stringify(join(root, "src/index"))};
      const options: PdfViewerOptions = ${options};`);
    const program = ts.createProgram([file], parsed.options);
    return ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Each case compiles a TypeScript program; allow for a loaded machine.
describe("host option types", { timeout: 60_000 }, () => {
  it("rejects an explicitly undefined optional state callback", () => {
    expect(typecheck('{url:"a.pdf", onStateChange:undefined}')).toContain(2375);
  });

  it("accepts omitted options and explicitly undefined label overrides", () => {
    expect(typecheck('{url:"a.pdf", labels:{previous:undefined, failed:undefined}}')).toEqual([]);
  });
});
