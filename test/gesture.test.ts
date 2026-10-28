/**
 * Specification of the pinch / pan / wheel gesture on the page surface.
 *
 * The live gesture drives a CSS transform on the canvas (instant), and
 * when it settles — last pointer lifted, or the wheel went quiet — the
 * page is re-rendered ONCE at the new zoom and the transform is dropped.
 * Pan is a position, not a magnification: it survives a settle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setPdfRuntimeForTest } from "@0k/pdfjs-legacy-runtime";
import { PDF_VIEWER_WHEEL_SETTLE_MS, mountPdfViewer } from "../src/index";
import { flush, installFakeRuntime, mountHost, pinBox, stubCanvasContext } from "./fakeRuntime";

beforeEach(() => {
  stubCanvasContext();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  __setPdfRuntimeForTest(null);
});

function surfaceOf(host: HTMLElement): HTMLElement {
  const el = host.querySelector<HTMLElement>(".pdf-viewer-surface");
  if (!el) throw new Error("no surface");
  return el;
}
function resetOf(host: HTMLElement): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>(".pdf-viewer-reset");
  if (!el) throw new Error("no reset control");
  return el;
}
function canvasOf(host: HTMLElement): HTMLCanvasElement {
  const el = host.querySelector<HTMLCanvasElement>(".pdf-viewer-canvas");
  if (!el) throw new Error("no canvas");
  return el;
}

function pointer(type: string, id: number, x: number, y: number, extra: PointerEventInit = {}): PointerEvent {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0, ...extra }) as PointerEvent;
  Object.defineProperty(event, "pointerId", { value: id });
  Object.defineProperty(event, "pointerType", { value: extra.pointerType ?? "touch" });
  return event;
}

async function mountGesture() {
  const ctrl = installFakeRuntime({ pageWidth: 100, pageHeight: 140 });
  const host = mountHost();
  pinBox(host, 400, 1000);
  const owner = mountPdfViewer(host, { url: "a.pdf" });
  const surface = surfaceOf(host);
  pinBox(surface, 400, 1000);
  (surface as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = () => undefined;
  await flush();
  return { ctrl, host, owner, surface };
}

describe("drag", () => {
  it("pans with a CSS translate and does not re-render", async () => {
    const { ctrl, host, surface } = await mountGesture();
    surface.dispatchEvent(pointer("pointerdown", 1, 10, 10));
    surface.dispatchEvent(pointer("pointermove", 1, 40, 25));
    expect(canvasOf(host).style.transform).toContain("translate(30px, 15px)");
    expect(surface.classList.contains("pdf-viewer-surface--panning")).toBe(true);
    surface.dispatchEvent(pointer("pointerup", 1, 40, 25));
    await flush();
    expect(ctrl.renderCalls).toBe(1);
    expect(surface.classList.contains("pdf-viewer-surface--panning")).toBe(false);
    expect(resetOf(host).hidden).toBe(false);
  });

  it("ignores non-primary mouse buttons", async () => {
    const { host, surface } = await mountGesture();
    surface.dispatchEvent(pointer("pointerdown", 1, 10, 10, { button: 2, pointerType: "mouse" }));
    surface.dispatchEvent(pointer("pointermove", 1, 40, 25, { pointerType: "mouse" }));
    expect(canvasOf(host).style.transform).not.toContain("translate(30px");
  });
});

describe("pinch", () => {
  it("announces pinch zoom only at settle", async () => {
    const { host, owner, surface } = await mountGesture();
    const readout = host.querySelector(".pdf-viewer-zoom")!;
    const observer = new MutationObserver(() => undefined);
    observer.observe(readout, { childList: true });
    surface.dispatchEvent(pointer("pointerdown", 1, 100, 100));
    surface.dispatchEvent(pointer("pointerdown", 2, 200, 100));
    surface.dispatchEvent(pointer("pointermove", 2, 250, 100));
    surface.dispatchEvent(pointer("pointermove", 2, 300, 100));
    expect(readout.textContent).toBe("100%");
    expect(observer.takeRecords()).toHaveLength(0);
    surface.dispatchEvent(pointer("pointerup", 2, 300, 100));
    surface.dispatchEvent(pointer("pointerup", 1, 100, 100));
    expect(readout.textContent).toBe("200%");
    expect(observer.takeRecords()).toHaveLength(1);
    await flush();
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
    await owner.destroy();
  });

  it("scales by the finger-distance ratio during the gesture, then re-renders once at settle", async () => {
    const { ctrl, host, surface } = await mountGesture();
    surface.dispatchEvent(pointer("pointerdown", 1, 100, 100));
    surface.dispatchEvent(pointer("pointerdown", 2, 200, 100)); // distance 100
    surface.dispatchEvent(pointer("pointermove", 2, 300, 100)); // distance 200 → ×2
    expect(canvasOf(host).style.transform).toContain("scale(2)");
    expect(ctrl.renderCalls).toBe(1);

    surface.dispatchEvent(pointer("pointerup", 2, 300, 100));
    surface.dispatchEvent(pointer("pointerup", 1, 100, 100));
    expect(host.querySelector(".pdf-viewer-zoom")?.textContent).toBe("200%");
    await flush();
    expect(ctrl.renderCalls).toBe(2);
    expect(ctrl.renderScales[1]).toBe(8); // fit 4 × zoom 2
    expect(canvasOf(host).style.transform).toContain("scale(1)");
  });

  it("re-seats the pan on the surviving finger so the page does not jump", async () => {
    const { host, surface } = await mountGesture();
    surface.dispatchEvent(pointer("pointerdown", 1, 100, 100));
    surface.dispatchEvent(pointer("pointerdown", 2, 200, 100));
    surface.dispatchEvent(pointer("pointerup", 1, 100, 100));
    surface.dispatchEvent(pointer("pointermove", 2, 210, 105));
    expect(canvasOf(host).style.transform).toContain("translate(10px, 5px)");
  });
});

describe("wheel", () => {
  it.each([0, 10])("settles wheel zoom once when interrupted by a pointer drag of %s pixels", async (drag) => {
    const { ctrl, host, owner, surface } = await mountGesture();
    surface.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    surface.dispatchEvent(pointer("pointerdown", 1, 100, 100));
    if (drag) surface.dispatchEvent(pointer("pointermove", 1, 100 + drag, 100));
    surface.dispatchEvent(pointer("pointerup", 1, 100 + drag, 100));
    await flush();
    expect(ctrl.renderCalls).toBe(2);
    expect(ctrl.renderScales[1]).toBeCloseTo(4 / 0.9);
    expect(host.querySelector(".pdf-viewer-zoom")?.textContent).toBe("111%");
    expect(canvasOf(host).style.transform).toContain("scale(1)");
    vi.advanceTimersByTime(PDF_VIEWER_WHEEL_SETTLE_MS + 1);
    await flush();
    expect(ctrl.renderCalls).toBe(2);
    await owner.destroy();
  });

  it.each([1, -1])("scales by wheel distance independently of event splitting (%s)", async (direction) => {
    const whole = await mountGesture();
    whole.surface.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 * direction }));
    const expected = whole.owner.state().zoom;
    await whole.owner.destroy();
    const split = await mountGesture();
    for (let i = 0; i < 10; i++) {
      split.surface.dispatchEvent(new WheelEvent("wheel", { deltaY: 10 * direction }));
    }
    expect(split.owner.state().zoom).toBeCloseTo(expected, 10);
    await split.owner.destroy();
  });

  it.each([
    { deltaMode: 0, deltaY: 100 },
    { deltaMode: 1, deltaY: 6.25 },
    { deltaMode: 2, deltaY: 0.1 },
  ])("normalizes wheel units for deltaMode $deltaMode", async ({ deltaMode, deltaY }) => {
    const { owner, surface } = await mountGesture();
    surface.dispatchEvent(new WheelEvent("wheel", { deltaMode, deltaY }));
    expect(owner.state().zoom).toBeCloseTo(0.9, 10);
    await owner.destroy();
  });

  it("announces wheel zoom only after quiet", async () => {
    const { host, owner, surface } = await mountGesture();
    const readout = host.querySelector(".pdf-viewer-zoom")!;
    surface.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    vi.advanceTimersByTime(PDF_VIEWER_WHEEL_SETTLE_MS - 1);
    surface.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    expect(readout.textContent).toBe("100%");
    vi.advanceTimersByTime(PDF_VIEWER_WHEEL_SETTLE_MS - 1);
    expect(readout.textContent).toBe("100%");
    vi.advanceTimersByTime(1);
    expect(readout.textContent).toBe("123%");
    await flush();
    await owner.destroy();
  });

  it("announces button zoom immediately", async () => {
    const { host, owner } = await mountGesture();
    host.querySelector<HTMLButtonElement>(".pdf-viewer-zoom-in")!.click();
    expect(host.querySelector(".pdf-viewer-zoom")?.textContent).toBe("125%");
    await owner.destroy();
  });

  it("previews wheel zoom and re-renders once after a quiet period", async () => {
    const { ctrl, host, surface } = await mountGesture();
    surface.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    surface.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    expect(canvasOf(host).style.transform).toMatch(/scale\(1\.\d+\)/);
    expect(ctrl.renderCalls).toBe(1);
    vi.advanceTimersByTime(PDF_VIEWER_WHEEL_SETTLE_MS + 1);
    await flush();
    expect(ctrl.renderCalls).toBe(2);
  });

  it("prevents the browser's own page zoom", async () => {
    const { surface } = await mountGesture();
    const event = new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
    surface.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("scroll interaction (in-flow readers)", () => {
  async function mountScroll() {
    const ctrl = installFakeRuntime({ pageWidth: 100, pageHeight: 140 });
    const host = mountHost();
    pinBox(host, 400, 1000);
    mountPdfViewer(host, { url: "a.pdf", interaction: "scroll" });
    const surface = surfaceOf(host);
    pinBox(surface, 400, 1000);
    await flush();
    return { ctrl, host, surface };
  }

  it("lets the browser scroll: native overflow, pan gestures allowed, pinch-zoom kept for the viewer", async () => {
    const { surface } = await mountScroll();
    expect(surface.classList.contains("pdf-viewer-surface--scroll")).toBe(true);
    expect(surface.classList.contains("pdf-viewer-surface--gestures")).toBe(false);
  });

  it("a one-finger drag never moves the page by transform", async () => {
    const { host, surface } = await mountScroll();
    surface.dispatchEvent(pointer("pointerdown", 1, 10, 10));
    surface.dispatchEvent(pointer("pointermove", 1, 40, 25));
    surface.dispatchEvent(pointer("pointerup", 1, 40, 25));
    expect(canvasOf(host).style.transform).not.toContain("translate(30px");
    expect(resetOf(host).hidden).toBe(true);
  });

  it("a pinch still zooms, and settles into one re-render", async () => {
    const { ctrl, host, surface } = await mountScroll();
    surface.dispatchEvent(pointer("pointerdown", 1, 100, 100));
    surface.dispatchEvent(pointer("pointerdown", 2, 200, 100));
    surface.dispatchEvent(pointer("pointermove", 2, 300, 100));
    expect(canvasOf(host).style.transform).toContain("scale(2)");
    surface.dispatchEvent(pointer("pointerup", 2, 300, 100));
    surface.dispatchEvent(pointer("pointerup", 1, 100, 100));
    await flush();
    expect(ctrl.renderCalls).toBe(2);
    expect(resetOf(host).hidden).toBe(true);
  });

  it("leaves a bare wheel to scroll; Ctrl/⌘+wheel (and touchpad pinch) zooms", async () => {
    const { host, surface } = await mountScroll();
    const bare = new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
    surface.dispatchEvent(bare);
    expect(bare.defaultPrevented).toBe(false);
    expect(host.querySelector(".pdf-viewer-zoom")?.textContent).toBe("100%");
    const ctrlWheel = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    surface.dispatchEvent(ctrlWheel);
    expect(ctrlWheel.defaultPrevented).toBe(true);
    expect(canvasOf(host).style.transform).not.toContain("scale(1)");
  });
});

describe("reset", () => {
  it("double-click and the reset control restore zoom and pan", async () => {
    const { host, surface } = await mountGesture();
    surface.dispatchEvent(pointer("pointerdown", 1, 10, 10));
    surface.dispatchEvent(pointer("pointermove", 1, 40, 25));
    surface.dispatchEvent(pointer("pointerup", 1, 40, 25));
    await flush();
    resetOf(host).click();
    await flush();
    expect(canvasOf(host).style.transform).toContain("translate(0px, 0px)");
    expect(resetOf(host).hidden).toBe(true);

    surface.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    surface.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await flush();
    expect(host.querySelector(".pdf-viewer-zoom")?.textContent).toBe("100%");
  });
});

describe("gesture opt-out", () => {
  it("interaction: none leaves the surface inert and hides the reset control", async () => {
    installFakeRuntime({ pageWidth: 100, pageHeight: 140 });
    const host = mountHost();
    pinBox(host, 400, 1000);
    mountPdfViewer(host, { url: "a.pdf", interaction: "none" });
    const surface = surfaceOf(host);
    await flush();
    surface.dispatchEvent(pointer("pointerdown", 1, 10, 10));
    surface.dispatchEvent(pointer("pointermove", 1, 40, 25));
    expect(canvasOf(host).style.transform).toBe("");
    expect(surface.classList.contains("pdf-viewer-surface--gestures")).toBe(false);
    expect(resetOf(host).hidden).toBe(true);
  });
});
