/**
 * Host-facing contracts: labels, scoped styles and the runtime boundary.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setPdfRuntimeForTest } from "@0k/pdfjs-legacy-runtime";
import { DEFAULT_PDF_VIEWER_LABELS, PDF_VIEWER_CLASS, mountPdfViewer } from "../src/index";
import { flush, installFakeRuntime, mountHost, pinBox, stubCanvasContext } from "./fakeRuntime";

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

beforeEach(stubCanvasContext);
afterEach(() => __setPdfRuntimeForTest(null));

describe("labels", () => {
  it("keeps default labels when an override is explicitly undefined", async () => {
    installFakeRuntime({ failLoadWith: "boom" });
    const host = mountHost();
    const owner = mountPdfViewer(host, {
      url: "a.pdf", labels: { failed: undefined, previous: undefined },
    });
    await flush();
    expect(host.querySelector(".pdf-viewer-previous")?.getAttribute("aria-label")).toBe("Previous page");
    expect(host.querySelector(".pdf-viewer-error")?.textContent).toBe("Failed to load PDF: boom");
    expect(host.querySelector(".pdf-viewer-retry")?.textContent).toBe("Retry");
    await owner.destroy();
  });

  it("uses English defaults", async () => {
    installFakeRuntime();
    const host = mountHost();
    pinBox(host, 400, 300);
    mountPdfViewer(host, { url: "a.pdf" });
    await flush();
    expect(DEFAULT_PDF_VIEWER_LABELS.previous).toBe("Previous page");
    expect(host.querySelector(".pdf-viewer-previous")?.getAttribute("aria-label")).toBe("Previous page");
    expect(host.querySelector(".pdf-viewer-toolbar")?.getAttribute("aria-label")).toBe("PDF controls");
    expect(host.querySelector(".pdf-viewer-status")?.textContent).toBe("");
  });

  it("accepts host-provided labels, including the failure and loading sentences", async () => {
    const ctrl = installFakeRuntime({ failLoadWith: "boom" });
    const host = mountHost();
    pinBox(host, 400, 300);
    mountPdfViewer(host, {
      url: "a.pdf",
      labels: {
        controls: "Commandes PDF",
        previous: "Page précédente",
        next: "Page suivante",
        zoomOut: "Réduire",
        zoomIn: "Agrandir",
        zoomReset: "Taille initiale",
        reset: "Réinitialiser la vue",
        retry: "Réessayer",
        loading: "Ouverture…",
        failed: "Impossible d'ouvrir ce document : %{reason}",
      },
    });
    expect(host.querySelector(".pdf-viewer-status")?.textContent).toBe("Ouverture…");
    await flush();
    expect(ctrl.destroyTaskCalls).toBe(1);
    expect(host.querySelector(".pdf-viewer-previous")?.getAttribute("aria-label")).toBe("Page précédente");
    expect(host.querySelector(".pdf-viewer-status .pdf-viewer-error")?.textContent)
      .toBe("Impossible d'ouvrir ce document : boom");
    expect(host.querySelector(".pdf-viewer-retry")?.textContent).toBe("Réessayer");
  });
});

describe("documentation", () => {
  it("exposes a documented opt-in browser verification command", () => {
    const root = resolve(import.meta.dirname, "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts["test:browser"]).toBe("python3 test/browser.py");
    expect(pkg.scripts.check).not.toContain("test:browser");
    expect(readFileSync(join(root, "README.org"), "utf8")).toContain("~npm run test:browser~");
  });

  it("documents the runtime security mitigation and optional Node renderer", () => {
    const readme = readFileSync(resolve(import.meta.dirname, "../README.org"), "utf8");
    expect(readme).toContain("* Security");
    expect(readme).toContain("https://github.com/0k/pdfjs-legacy-runtime#security");
    expect(readme).toContain("CVE-2024-4367");
    expect(readme).toContain("~isEvalSupported: false~");
    expect(readme).toContain("npm install --omit=optional");
    expect(readme).toContain("~overrides~");
  });

  it("references every exported constant, label and theme variable", () => {
    const root = resolve(import.meta.dirname, "..");
    const readme = readFileSync(join(root, "README.org"), "utf8");
    expect(readme).toContain("* Options");
    expect(readme).toContain("* Theming");
    for (const key of Object.keys(DEFAULT_PDF_VIEWER_LABELS)) expect(readme).toContain(`~${key}~`);
    const source = readFileSync(join(root, "src/index.ts"), "utf8");
    for (const match of source.matchAll(/export const (\w+)/g)) {
      expect(readme).toContain(`~${match[1]}~`);
    }
    const css = readFileSync(join(root, "src/style.css"), "utf8");
    for (const match of css.matchAll(/(--pdf-viewer-[\w-]+):/g)) {
      expect(readme).toContain(`~${match[1]}~`);
    }
    expect(readme).toContain("https://example.com/manual.pdf");
    expect(readme).toContain("\nnpm install @0k/pdf-viewer\n");
  });
});

describe("styles", () => {
  it("keeps every rule scoped under the viewer root and exposes theme properties", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../src/style.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(PDF_VIEWER_CLASS).toBe("pdf-viewer");
    for (const name of ["--pdf-viewer-surface", "--pdf-viewer-page-background", "--pdf-viewer-button-size", "--pdf-viewer-error"]) {
      expect(css).toContain(name);
    }
    for (const rule of css.matchAll(/(^|})\s*([^@}][^{]*)\{/g)) {
      for (const selector of required(rule[2], "style rule has no selector").split(",")) {
        expect(selector.trim()).toMatch(/^\.pdf-viewer(?:\b|\[|:|\s|-)/);
      }
    }
  });
});

describe("runtime boundary", () => {
  it("exports ESM and separate CSS without bundling or embedding sources", () => {
    const root = resolve(import.meta.dirname, "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.exports).toEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./style.css": "./dist/style.css",
    });
    expect(pkg.main).toBeUndefined();
    expect(pkg.module).toBeUndefined();
    expect(pkg.types).toBe("./dist/index.d.ts");
    const source = readFileSync(join(root, "src/index.ts"), "utf8");
    expect(source).not.toMatch(/import\s+["'].*\.css["']/);
    const build = JSON.parse(readFileSync(join(root, "tsconfig.build.json"), "utf8"));
    expect(build.compilerOptions.emitDeclarationOnly).not.toBe(true);
    expect(build.compilerOptions.outDir).toBe("dist");
    expect(build.compilerOptions.rootDir).toBe("src");
    expect(build.compilerOptions.sourceMap).not.toBe(true);
    expect(build.compilerOptions.inlineSourceMap).not.toBe(true);
    expect(build.compilerOptions.inlineSources).not.toBe(true);
  });

  it("never imports pdfjs-dist directly", () => {
    const src = resolve(import.meta.dirname, "../src");
    for (const name of readdirSync(src)) {
      const text = readFileSync(join(src, name), "utf8");
      expect(text, name).not.toMatch(/from\s+["']pdfjs-dist/);
      expect(text, name).not.toMatch(/import\(\s*["']pdfjs-dist/);
    }
  });

  it("declares the runtime as an exact peer, not a bundled dependency", () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));
    expect(pkg.peerDependencies["@0k/pdfjs-legacy-runtime"]).toBe("0.2.0");
    expect(pkg.dependencies).toBeUndefined();
  });
});
