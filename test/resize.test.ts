import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setPdfRuntimeForTest } from "@0k/pdfjs-legacy-runtime";
import { mountPdfViewer, type PdfViewerFit } from "../src/index";
import { flush, installFakeRuntime, mountHost, pinBox, stubCanvasContext } from "./fakeRuntime";

beforeEach(() => {
  stubCanvasContext();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __setPdfRuntimeForTest(null);
});

function installResizeObserver() {
  const instances: Observer[] = [];
  class Observer implements ResizeObserver {
    readonly observe = vi.fn();
    readonly unobserve = vi.fn();
    readonly disconnect = vi.fn();
    constructor(private readonly callback: ResizeObserverCallback) { instances.push(this); }
    notify() { this.callback([], this); }
  }
  vi.stubGlobal("ResizeObserver", Observer);
  return instances;
}

function mount(fit: PdfViewerFit = "width") {
  const host = mountHost();
  const owner = mountPdfViewer(host, { url: "a.pdf", fit });
  const surface = host.querySelector<HTMLElement>(".pdf-viewer-surface")!;
  const canvas = host.querySelector<HTMLCanvasElement>("canvas")!;
  pinBox(surface, 400, 600);
  return { owner, surface, canvas };
}

describe("surface resize", () => {
  it.each(["scroll", "none"] as const)("keeps the narrower scrollbar-band fit stable in %s mode", async (interaction) => {
    const observers = installResizeObserver();
    const ctrl = installFakeRuntime({ pageWidth: 100, pageHeight: 61 });
    const host = mountHost();
    const owner = mountPdfViewer(host, { url: "band.pdf", interaction });
    const surface = host.querySelector<HTMLElement>(".pdf-viewer-surface")!;
    const canvas = host.querySelector<HTMLCanvasElement>("canvas")!;
    canvas.style.border = "1px solid black";
    let outerWidth = 400;
    pinBox(surface, 400, 240);
    Object.defineProperty(surface, "offsetWidth", { configurable: true, get: () => outerWidth });
    Object.defineProperty(surface, "clientWidth", { configurable: true, get: () =>
      outerWidth - ((Number.parseFloat(canvas.style.height) || 0) + 2 > 240 ? 15 : 0),
    });
    await flush(16);
    const observer = observers[0]!;
    for (let sample = 0; sample < 15; sample++) {
      observer.notify();
      vi.advanceTimersByTime(100);
      await flush(16);
    }
    expect(ctrl.renderCalls).toBe(2);
    expect(canvas.style.width).toBe("383px");
    outerWidth = 300;
    observer.notify();
    vi.advanceTimersByTime(100);
    await flush(16);
    expect(canvas.style.width).toBe("298px");
    outerWidth = 400;
    observer.notify();
    vi.advanceTimersByTime(100);
    await flush(16);
    expect(canvas.style.width).toBe("383px");
    expect(ctrl.renderCalls).toBe(5);
    for (let sample = 0; sample < 15; sample++) {
      observer.notify();
      vi.advanceTimersByTime(100);
      await flush(16);
    }
    expect(ctrl.renderCalls).toBe(5);
    await owner.destroy();
  });

  it.each(["width", "page"] as const)("debounces %s refitting when the surface shrinks and grows", async (fit) => {
    const observers = installResizeObserver();
    const ctrl = installFakeRuntime();
    const { owner, surface, canvas } = mount(fit);
    await flush();
    expect(observers).toHaveLength(1);
    const observer = observers[0]!;
    expect(observer.observe).toHaveBeenCalledWith(surface);
    pinBox(surface, 350, 600);
    observer.notify();
    pinBox(surface, 300, 600);
    observer.notify();
    vi.advanceTimersByTime(99);
    expect(ctrl.renderCalls).toBe(1);
    vi.advanceTimersByTime(1);
    await flush();
    expect(ctrl.renderCalls).toBe(2);
    expect(canvas.style.width).toBe("300px");
    pinBox(surface, 500, 1000);
    observer.notify();
    vi.advanceTimersByTime(100);
    await flush();
    expect(canvas.style.width).toBe("500px");
    observer.notify();
    vi.advanceTimersByTime(100);
    await flush();
    expect(ctrl.renderCalls).toBe(3);
    await owner.destroy();
  });

  it.each(["width", "page"] as const)("treats height as fit-relevant only for page fitting (%s)", async (fit) => {
    const observers = installResizeObserver();
    const ctrl = installFakeRuntime();
    const { owner, surface } = mount(fit);
    await flush();
    expect(observers).toHaveLength(1);
    pinBox(surface, 400, 280);
    observers[0]!.notify();
    vi.advanceTimersByTime(100);
    await flush();
    expect(ctrl.renderCalls).toBe(fit === "page" ? 2 : 1);
    await owner.destroy();
  });

  it("ignores loading notifications and disconnects pending work on destroy", async () => {
    const observers = installResizeObserver();
    const ctrl = installFakeRuntime({ hangLoad: true });
    const { owner, surface, canvas } = mount();
    await flush();
    expect(observers).toHaveLength(1);
    const observer = observers[0]!;
    pinBox(surface, 300, 600);
    observer.notify();
    vi.advanceTimersByTime(100);
    expect(ctrl.renderCalls).toBe(0);
    ctrl.workers[0]!.releaseLoad();
    await flush();
    expect(canvas.style.width).toBe("300px");
    pinBox(surface, 200, 600);
    observer.notify();
    await owner.destroy();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    observer.notify();
    vi.advanceTimersByTime(100);
    await flush();
    expect(ctrl.renderCalls).toBe(1);
  });
});
