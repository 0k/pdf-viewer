import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";

// Audit emitted viewer code; the runtime owns its dependency compatibility.
const files = [];
function collect(path) {
  if (!existsSync(path)) throw new Error(`${path}: missing (run npm run build first)`);
  if (!statSync(path).isDirectory()) {
    files.push(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) collect(child);
    else if ([".js", ".mjs"].includes(extname(entry.name))) files.push(child);
  }
}
collect("dist");
if (!files.length) throw new Error("No emitted JavaScript found in dist/");

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) throw new Error(`${file}: ${parsed.parseDiagnostics[0].messageText}`);
  let staticBlock = false;
  function visit(node) {
    if (ts.isClassStaticBlockDeclaration(node)) staticBlock = true;
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (staticBlock) throw new Error(`${file}: class static initialization blocks require Chrome 94`);
  const apis = [
    [/\bPromise\.withResolvers\s*\(/, 'Promise.withResolvers'],
    [/\.at\(\s*-?\d/, 'Array/String.prototype.at'],
    [/\bObject\.hasOwn\s*\(/, 'Object.hasOwn'],
    [/\.findLast(Index)?\s*\(/, 'Array.prototype.findLast'],
    [/\bstructuredClone\s*\(/, 'structuredClone'],
    [/\.to(Sorted|Reversed|Spliced)\s*\(/, 'change-array-by-copy'],
  ];
  for (const [pattern, api] of apis) {
    if (pattern.test(source)) throw new Error(`${file}: ${api} requires a browser newer than Chrome 91`);
  }
}
console.log(`Chrome 91 syntax inspection passed for ${files.length} files (dist/)`);
