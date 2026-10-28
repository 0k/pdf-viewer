/**
 * Specification of `mountPdfViewer`: loading, paging, zoom, fit, error /
 * retry and teardown ownership. Gestures live in `gesture.test.ts`,
 * labels / styles / boundary in `contract.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setPdfRuntimeForTest, type PdfRuntime } from "@0k/pdfjs-legacy-runtime";
import {
  PDF_VIEWER_DEFAULT_ZOOM,
  PDF_VIEWER_MAX_ZOOM,
  PDF_VIEWER_MIN_ZOOM,
  PDF_VIEWER_ZOOM_STEP,
  mountPdfViewer,
  type PdfViewerOwner,
} from "../src/index";
import {
  flush,
  installFakeRuntime,
  mountHost,
  pinBox,
  stubCanvasContext,
} from "./fakeRuntime";

let drawn: { drawImage: ReturnType<typeof import("vitest").vi.fn> };

beforeEach(() => {
  drawn = stubCanvasContext();
});

afterEach(() => {
  vi.restoreAllMocks();
  __setPdfRuntimeForTest(null);
});

const q = <T extends Element>(root: ParentNode, sel: string): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
const button = (root: ParentNode, sel: string): HTMLButtonElement => q<HTMLButtonElement>(root, sel);
const text = (root: ParentNode, sel: string): string => q(root, sel).textContent ?? "";

function mountReady(width = 400, height = 300, extra: Parameters<typeof mountPdfViewer>[1] = { url: "api/file?path=a.pdf" }) {
  const host = mountHost();
  pinBox(host, width, height);
  const owner = mountPdfViewer(host, extra);
  pinBox(q<HTMLElement>(host, ".pdf-viewer-surface"), width, height);
  return { host, owner };
}

describe("loading", () => {
  it.each(["ready", "loading", "error"] as const)("isolates host callback failures during %s", async (phase) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctrl = installFakeRuntime({ failLoadWith: phase === "error" ? "PDF failed" : null });
    const callbackError = new Error("host callback failed");
    const { host, owner } = mountReady(400, 300, {
      url: "a.pdf",
      onStateChange: (state) => { if (state.status === phase) throw callbackError; },
    });
    await flush();
    expect(owner.state().status).toBe(phase === "error" ? "error" : "ready");
    expect(owner.state().error).toBe(phase === "error" ? "PDF failed" : null);
    expect(ctrl.destroyTaskCalls).toBe(phase === "error" ? 1 : 0);
    expect(logged).toHaveBeenCalledWith("pdf-viewer: onStateChange failed", callbackError);
    if (phase !== "error") expect(q<HTMLCanvasElement>(host, ".pdf-viewer-canvas").hidden).toBe(false);
    await owner.destroy();
  });

  it("ignores a superseded loading task's late worker-destroyed rejection", async () => {
    const ctrl = installFakeRuntime({ hangLoad: true });
    const { host, owner } = mountReady();
    await flush();
    const first = ctrl.workers[0]!;
    const reloading = owner.reload();
    await flush();
    ctrl.workers[1]!.releaseLoad();
    await reloading;
    first.releaseLoad();
    await flush();
    expect(owner.state().status).toBe("ready");
    expect(text(host, ".pdf-viewer-page")).toBe("1 / 3");
    expect(q<HTMLCanvasElement>(host, ".pdf-viewer-canvas").hidden).toBe(false);
    await owner.destroy();
  });

  it("creates only one live worker when reloaded during the runtime import", async () => {
    const ctrl = installFakeRuntime({ hangRuntime: true });
    const { owner } = mountReady();
    await flush();
    const reloading = owner.reload();
    await flush();
    ctrl.releaseRuntime();
    await reloading;
    await flush();
    expect(ctrl.maxLiveWorkers).toBe(1);
    expect(owner.state().status).toBe("ready");
    await owner.destroy();
  });

  it("hands the URL to PDF.js verbatim with prefetch disabled and range enabled", async () => {
    const ctrl = installFakeRuntime();
    mountReady(400, 300, { url: "api/file?path=a%2Bb.pdf" });
    await flush();
    expect(ctrl.getDocumentParams).toEqual([
      { url: "api/file?path=a%2Bb.pdf", disableAutoFetch: true, disableStream: true },
    ]);
  });

  it("shows the loading status until the first page is committed, then 'n / N' and 100%", async () => {
    const ctrl = installFakeRuntime({ numPages: 3 });
    const { host } = mountReady();
    expect(q(host, ".pdf-viewer-status").getAttribute("data-state")).toBe("loading");
    expect(host.querySelector(".pdf-viewer-canvas")).not.toBeNull();
    await flush();
    expect(q(host, ".pdf-viewer").getAttribute("data-status")).toBe("ready");
    expect(q(host, ".pdf-viewer-status").getAttribute("data-state")).toBeNull();
    expect(text(host, ".pdf-viewer-page")).toBe("1 / 3");
    expect(text(host, ".pdf-viewer-zoom")).toBe("100%");
    expect(ctrl.renderCalls).toBe(1);
    expect(drawn.drawImage).toHaveBeenCalledTimes(1);
  });

  it("keeps the canvas hidden until its first page raster is committed", async () => {
    const ctrl = installFakeRuntime({ hangRender: true });
    const { host } = mountReady();
    await flush();
    // The document is ready (navigation allowed) but nothing is painted:
    // an unhidden canvas here would be a blank default-sized box.
    expect(q(host, ".pdf-viewer").getAttribute("data-status")).toBe("ready");
    expect(q<HTMLCanvasElement>(host, ".pdf-viewer-canvas").hidden).toBe(true);
    ctrl.releaseRender();
    await flush();
    expect(q<HTMLCanvasElement>(host, ".pdf-viewer-canvas").hidden).toBe(false);
    expect(q(host, ".pdf-viewer").getAttribute("data-painted")).toBe("1");
  });

  it("reports state transitions to the host", async () => {
    installFakeRuntime({ numPages: 2 });
    const seen: string[] = [];
    mountReady(400, 300, {
      url: "a.pdf",
      onStateChange: (s) => seen.push(`${s.status}:${s.page}/${s.pageCount}`),
    });
    await flush();
    expect(seen[0]).toBe("loading:1/0");
    expect(seen[seen.length - 1]).toBe("ready:1/2");
  });
});

describe("fit", () => {
  it.each(["width", "page"] as const)("corrects %s fit once when committing changes the available width", async (fit) => {
    const ctrl = installFakeRuntime();
    const { host, owner } = mountReady(400, 1000, { url: "a.pdf", fit });
    const surface = q<HTMLElement>(host, ".pdf-viewer-surface");
    Object.defineProperty(surface, "clientWidth", { configurable: true, get: () =>
      drawn.drawImage.mock.calls.length === 1 ? 385 : 400,
    });
    await flush(16);
    expect(ctrl.renderCalls).toBe(2);
    expect(q<HTMLCanvasElement>(host, ".pdf-viewer-canvas").style.width).toBe("385px");
    await flush(16);
    expect(ctrl.renderCalls).toBe(2);
    await owner.destroy();
  });

  it.each([
    { fit: "width", height: 1000, width: "398px", pageHeight: "557px" },
    { fit: "page", height: 280, width: "198px", pageHeight: "278px" },
  ] as const)("fits the canvas border box in the content box for $fit", async ({ fit, height, width, pageHeight }) => {
    installFakeRuntime({ pageWidth: 100, pageHeight: 140 });
    const { host, owner } = mountReady(400, height, { url: "a.pdf", fit });
    const surface = q<HTMLElement>(host, ".pdf-viewer-surface");
    surface.getBoundingClientRect = () => new DOMRect(0, 0, 440, height + 40);
    const canvas = q<HTMLCanvasElement>(host, ".pdf-viewer-canvas");
    canvas.style.border = "1px solid black";
    await flush();
    expect(canvas.style.width).toBe(width);
    expect(canvas.style.height).toBe(pageHeight);
    await owner.destroy();
  });

  it("fit-to-width: at 100% the canvas CSS width equals the surface width", async () => {
    installFakeRuntime({ pageWidth: 100, pageHeight: 140 });
    const { host } = mountReady(400, 1000);
    await flush();
    const canvas = q<HTMLCanvasElement>(host, ".pdf-viewer-canvas");
    expect(canvas.style.width).toBe("400px");
    expect(canvas.style.height).toBe("560px");
  });

  it("fit-to-page: the whole page fits the surface box (smaller ratio wins)", async () => {
    installFakeRuntime({ pageWidth: 100, pageHeight: 140 });
    const { host } = mountReady(400, 280, { url: "a.pdf", fit: "page" });
    await flush();
    const canvas = q<HTMLCanvasElement>(host, ".pdf-viewer-canvas");
    // min(400/100, 280/140) = 2
    expect(canvas.style.width).toBe("200px");
    expect(canvas.style.height).toBe("280px");
  });

  it("falls back to the natural size when the surface has no box yet", async () => {
    installFakeRuntime({ pageWidth: 100, pageHeight: 140 });
    const { host } = mountReady(0, 0);
    await flush();
    expect(q<HTMLCanvasElement>(host, ".pdf-viewer-canvas").style.width).toBe("100px");
  });

  it("renders at device pixel ratio, capped by maxDpr", async () => {
    const ctrl = installFakeRuntime({ pageWidth: 100, pageHeight: 140 });
    Object.defineProperty(window, "devicePixelRatio", { value: 3, configurable: true });
    const { host } = mountReady(100, 1000, { url: "a.pdf", maxDpr: 2 });
    await flush();
    const canvas = q<HTMLCanvasElement>(host, ".pdf-viewer-canvas");
    expect(canvas.width).toBe(200);
    expect(canvas.style.width).toBe("100px");
    expect(ctrl.renderScales).toEqual([1]);
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
  });
});

describe("paging", () => {
  it("disables previous on the first page and next on the last", async () => {
    installFakeRuntime({ numPages: 2 });
    const { host } = mountReady();
    await flush();
    expect(button(host, ".pdf-viewer-previous").disabled).toBe(true);
    expect(button(host, ".pdf-viewer-next").disabled).toBe(false);
    button(host, ".pdf-viewer-next").click();
    await flush();
    expect(text(host, ".pdf-viewer-page")).toBe("2 / 2");
    expect(button(host, ".pdf-viewer-next").disabled).toBe(true);
    expect(button(host, ".pdf-viewer-previous").disabled).toBe(false);
  });

  it("owner.goTo clamps to the page range and re-renders only on change", async () => {
    const ctrl = installFakeRuntime({ numPages: 3 });
    const { host, owner } = mountReady();
    await flush();
    owner.goTo(9);
    await flush();
    expect(text(host, ".pdf-viewer-page")).toBe("3 / 3");
    expect(ctrl.renderCalls).toBe(2);
    owner.goTo(3);
    await flush();
    expect(ctrl.renderCalls).toBe(2);
  });

  it("cancels an unsettled render when the page changes", async () => {
    const ctrl = installFakeRuntime({ numPages: 3, hangRender: true });
    const { host } = mountReady();
    await flush();
    expect(ctrl.renderCalls).toBe(1);
    button(host, ".pdf-viewer-next").click();
    await flush();
    expect(ctrl.cancelCalls).toBe(1);
    expect(ctrl.renderCalls).toBe(2);
  });

  it("never cleans up the displayed page, but cleans up a stale one", async () => {
    const ctrl = installFakeRuntime({ numPages: 3, hangFirstGetPage: true });
    const { host } = mountReady();
    await flush();
    // First render is parked in getPage; a page change makes it stale.
    button(host, ".pdf-viewer-next").click();
    await flush();
    expect(ctrl.cleanupCalls).toBe(0);
    ctrl.releaseGetPage();
    await flush();
    expect(ctrl.cleanupCalls).toBe(1);
    expect(text(host, ".pdf-viewer-page")).toBe("2 / 3");
    expect(ctrl.renderCalls).toBe(1);
  });
});

describe("zoom", () => {
  it("preserves the displayed cached page when zoom renders are superseded", async () => {
    const ctrl = installFakeRuntime();
    const { host, owner } = mountReady();
    await flush();
    expect(drawn.drawImage).toHaveBeenCalledTimes(1);
    ctrl.hangRender = true;
    owner.setZoom(1.25);
    await flush();
    owner.setZoom(1.5);
    await flush();
    expect(ctrl.cancelCalls).toBe(1);
    expect(ctrl.cleanupCalls).toBe(0);
    expect(q<HTMLCanvasElement>(host, ".pdf-viewer-canvas").hidden).toBe(false);
    ctrl.releaseRender();
    await flush();
    expect(drawn.drawImage).toHaveBeenCalledTimes(2);
    expect(ctrl.cleanupCalls).toBe(0);
    await owner.destroy();
  });

  it("steps in, clamps at max, resets, steps out and clamps at min", async () => {
    installFakeRuntime();
    const { host } = mountReady();
    await flush();
    const zoom = () => text(host, ".pdf-viewer-zoom");
    button(host, ".pdf-viewer-zoom-in").click();
    await flush();
    expect(zoom()).toBe(`${Math.round((PDF_VIEWER_DEFAULT_ZOOM + PDF_VIEWER_ZOOM_STEP) * 100)}%`);
    for (let i = 0; i < 10; i++) {
      button(host, ".pdf-viewer-zoom-in").click();
      await flush();
    }
    expect(zoom()).toBe(`${PDF_VIEWER_MAX_ZOOM * 100}%`);
    expect(button(host, ".pdf-viewer-zoom-in").disabled).toBe(true);
    button(host, ".pdf-viewer-zoom-reset").click();
    await flush();
    expect(zoom()).toBe("100%");
    for (let i = 0; i < 10; i++) {
      button(host, ".pdf-viewer-zoom-out").click();
      await flush();
    }
    expect(zoom()).toBe(`${PDF_VIEWER_MIN_ZOOM * 100}%`);
    expect(button(host, ".pdf-viewer-zoom-out").disabled).toBe(true);
  });

  it("re-renders at the new scale and grows the canvas beyond the surface", async () => {
    const ctrl = installFakeRuntime({ pageWidth: 100, pageHeight: 140 });
    const { host } = mountReady(400, 1000);
    await flush();
    for (let i = 0; i < 4; i++) {
      button(host, ".pdf-viewer-zoom-in").click();
      await flush();
    }
    expect(text(host, ".pdf-viewer-zoom")).toBe("200%");
    expect(q<HTMLCanvasElement>(host, ".pdf-viewer-canvas").style.width).toBe("800px");
    expect(ctrl.renderScales[ctrl.renderScales.length - 1]).toBe(8);
  });

  it("honours host zoom bounds", async () => {
    installFakeRuntime();
    const { host, owner } = mountReady(400, 300, { url: "a.pdf", zoom: { min: 0.4, max: 8 } });
    await flush();
    owner.setZoom(100);
    await flush();
    expect(text(host, ".pdf-viewer-zoom")).toBe("800%");
    owner.setZoom(0);
    await flush();
    expect(text(host, ".pdf-viewer-zoom")).toBe("40%");
  });
});

describe("error and retry", () => {
  it("renders dollar sequences in error reasons verbatim", async () => {
    installFakeRuntime({ failLoadWith: "bad $& and $1" });
    const { host, owner } = mountReady();
    await flush();
    expect(text(host, ".pdf-viewer-error")).toBe("Failed to load PDF: bad $& and $1");
    await owner.destroy();
  });

  it("shows the failure with a retry that recovers, releasing the failed task first", async () => {
    const ctrl = installFakeRuntime({ failLoadWith: "boom" });
    const { host } = mountReady();
    await flush();
    const status = q(host, ".pdf-viewer-status");
    expect(status.getAttribute("data-state")).toBe("error");
    expect(status.textContent).toContain("boom");
    expect(ctrl.destroyTaskCalls).toBe(1);
    expect(button(host, ".pdf-viewer-next").disabled).toBe(true);

    ctrl.failLoadWith = null;
    button(host, ".pdf-viewer-retry").click();
    await flush();
    expect(q(host, ".pdf-viewer").getAttribute("data-status")).toBe("ready");
    expect(ctrl.getDocumentParams.length).toBe(2);
  });

  it("a render failure is an error too, and is not swallowed", async () => {
    const ctrl = installFakeRuntime({ failRenderWith: "cannot paint" });
    const { host } = mountReady();
    await flush();
    expect(q(host, ".pdf-viewer-status").getAttribute("data-state")).toBe("error");
    expect(q(host, ".pdf-viewer-status").textContent).toContain("cannot paint");
    expect(ctrl.destroyTaskCalls).toBe(1);
  });
});

describe("teardown", () => {
  it.each([false, true])("releases canvas storage on destroy with a pending render: %s", async (pending) => {
    const ctrl = installFakeRuntime();
    const { host, owner } = mountReady();
    await flush();
    const canvas = q<HTMLCanvasElement>(host, ".pdf-viewer-canvas");
    const committed = drawn.drawImage.mock.calls[0]?.[0];
    expect(committed).toBeInstanceOf(HTMLCanvasElement);
    const created = vi.spyOn(document, "createElement");
    ctrl.hangRender = pending;
    owner.setZoom(1.25);
    await flush();
    const offscreen = created.mock.results.find((result) => result.value instanceof HTMLCanvasElement)?.value;
    expect(offscreen).toBeInstanceOf(HTMLCanvasElement);
    await owner.destroy();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(committed.width).toBe(0);
    expect(committed.height).toBe(0);
    expect(offscreen.width).toBe(0);
    expect(offscreen.height).toBe(0);
    ctrl.releaseRender();
    await flush();
    expect(canvas.width).toBe(0);
  });

  it("waits for teardown across two consecutive reloads", async () => {
    const ctrl = installFakeRuntime({ hangDestroy: true });
    const { owner } = mountReady();
    await flush();
    const first = owner.reload();
    await flush();
    const second = owner.reload();
    await flush();
    expect(ctrl.getDocumentParams).toHaveLength(1);
    ctrl.releaseDestroy();
    await Promise.all([first, second]);
    expect(ctrl.getDocumentParams).toHaveLength(2);
    expect(ctrl.maxLiveWorkers).toBe(1);
    ctrl.hangDestroy = false;
    await owner.destroy();
  });

  it("waits for the replaced viewer's teardown before starting its worker", async () => {
    const ctrl = installFakeRuntime({ hangDestroy: true });
    const { host, owner: first } = mountReady();
    await flush();
    const second = mountPdfViewer(host, { url: "b.pdf" });
    await flush();
    expect(ctrl.getDocumentParams).toHaveLength(1);
    expect(host.querySelectorAll(".pdf-viewer")).toHaveLength(1);
    ctrl.releaseDestroy();
    await flush();
    expect(ctrl.getDocumentParams.map((params) => params.url)).toEqual(["api/file?path=a.pdf", "b.pdf"]);
    expect(ctrl.maxLiveWorkers).toBe(1);
    await first.destroy();
    expect(second.state().status).toBe("ready");
    ctrl.hangDestroy = false;
    await second.destroy();
  });

  it("destroy() destroys ONLY the loading task, once, removes the DOM, and is idempotent", async () => {
    const ctrl = installFakeRuntime();
    const { host, owner } = mountReady();
    await flush();
    await owner.destroy();
    expect(ctrl.destroyTaskCalls).toBe(1);
    expect(host.querySelector(".pdf-viewer")).toBeNull();
    await owner.destroy();
    expect(ctrl.destroyTaskCalls).toBe(1);
  });

  it("destroy() on a never-loaded viewer is safe", async () => {
    let resolveRuntime!: (r: PdfRuntime) => void;
    __setPdfRuntimeForTest(new Promise<PdfRuntime>((res) => { resolveRuntime = res; }));
    const ctrl = installFakeRuntime();
    __setPdfRuntimeForTest(new Promise<PdfRuntime>((res) => { resolveRuntime = res; }));
    const { owner } = mountReady();
    await flush();
    expect(ctrl.getDocumentParams.length).toBe(0);
    await owner.destroy();
    resolveRuntime(ctrl.runtime);
    await flush();
    // The import resolved AFTER teardown: no document may be loaded.
    expect(ctrl.getDocumentParams.length).toBe(0);
    expect(ctrl.destroyTaskCalls).toBe(0);
  });

  it("reload() awaits the previous task's destroy before creating a new one", async () => {
    const ctrl = installFakeRuntime({ hangDestroy: true });
    const { owner } = mountReady();
    await flush();
    expect(ctrl.getDocumentParams.length).toBe(1);
    const reloading = owner.reload();
    await flush();
    expect(ctrl.destroyTaskCalls).toBe(1);
    expect(ctrl.getDocumentParams.length).toBe(1);
    ctrl.releaseDestroy();
    await reloading;
    await flush();
    expect(ctrl.getDocumentParams.length).toBe(2);
  });

  it("destroy() while a reload is parked on the previous destroy aborts the reload", async () => {
    const ctrl = installFakeRuntime({ hangDestroy: true });
    const { owner } = mountReady();
    await flush();
    void owner.reload();
    await flush();
    void owner.destroy();
    ctrl.releaseDestroy();
    await flush();
    expect(ctrl.getDocumentParams.length).toBe(1);
  });

  it("mounting twice on one host replaces the previous viewer and releases its task", async () => {
    const ctrl = installFakeRuntime();
    const host = mountHost();
    pinBox(host, 400, 300);
    mountPdfViewer(host, { url: "a.pdf" });
    await flush();
    const second: PdfViewerOwner = mountPdfViewer(host, { url: "b.pdf" });
    await flush();
    expect(ctrl.destroyTaskCalls).toBe(1);
    expect(host.querySelectorAll(".pdf-viewer").length).toBe(1);
    expect(ctrl.getDocumentParams.map((p) => p.url)).toEqual(["a.pdf", "b.pdf"]);
    await second.destroy();
  });
});
