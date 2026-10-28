/**
 * `@0k/pdf-viewer` — a plain-DOM PDF page viewer over the shared
 * `@0k/pdfjs-legacy-runtime`.
 *
 * Loading, rendering and teardown follow these rules to preserve the
 * visible canvas and bound worker and raster memory on WebView 91:
 *
 * - ⚠ The URL is handed to PDF.js, never a `blob:`. PDF.js then
 *   range-loads the cross-reference table and the current page rather
 *   than the whole file (`disableAutoFetch` + `disableStream`; range left
 *   enabled). A 67 MB scan paints page 1 without downloading page 40.
 * - ⚠ The LOADING TASK is the sole owner of worker/transport teardown.
 *   The runtime's `PdfDocument` has no `destroy`, so `doc.destroy()` is a
 *   compile error rather than a second path to the same worker.
 * - ⚠ Teardown → startup is SERIALIZED. A reload awaits the previous
 *   task's `destroy()` (settled, rejection tolerated) before importing
 *   the runtime or creating a worker; two workers overlapping blanks the
 *   canvas on WebView 91.
 * - ⚠ The DISPLAYED page is never `cleanup()`-ed. Releasing it right
 *   after `render()` resolves can race the first compositor flush and
 *   lose the paint. Only stale, cancelled or errored renders — whose
 *   canvases are discarded anyway — are cleaned up.
 * - ⚠ Rendering happens on a DETACHED canvas and is committed to the
 *   visible one in ONE synchronous step. Resizing a canvas's backing
 *   store clears it; an `await` between that clear and the copy is a
 *   blank frame.
 * - ⚠ The device pixel ratio is CAPPED. Uncapped DPR × 200 % × A4 is a
 *   multi-hundred-megapixel canvas, which OOMs the WebView.
 * - ⚠ Zoom is applied TWICE, deliberately. The live gesture drives a CSS
 *   transform (free); when it settles the page is re-rendered at the new
 *   scale and the transform is dropped. A canvas scaled by CSS is blurred
 *   exactly when the reader zoomed in to read it, but a re-render per
 *   pointer frame is a worker round-trip per finger movement.
 *
 * Hosts own everything else: the URL and its access policy, where the
 * viewer mounts, any collapsed/opened affordance or overlay around it,
 * and translated labels. The viewer is in-flow and fills its host.
 */
import {
  loadPdfRuntime,
  type PdfDocument,
  type PdfLoadingTask,
  type PdfPage,
  type PdfRenderTask,
} from "@0k/pdfjs-legacy-runtime";

/** Class of the viewer root; every style is scoped under it. */
export const PDF_VIEWER_CLASS = "pdf-viewer";

/** Default zoom bounds and toolbar step (a fraction of the fitted size). */
export const PDF_VIEWER_MIN_ZOOM = 0.5;
export const PDF_VIEWER_MAX_ZOOM = 2.0;
export const PDF_VIEWER_ZOOM_STEP = 0.25;
export const PDF_VIEWER_DEFAULT_ZOOM = 1.0;

/**
 * Cap on the effective device pixel ratio used to size the backing
 * canvas. 2 is sharp enough while bounding memory on a 3× phone.
 */
export const PDF_VIEWER_MAX_DPR = 2;

/** Zoom factor for 100 CSS pixels of wheel-down movement. */
export const PDF_VIEWER_WHEEL_FACTOR = 0.9;
const WHEEL_NOTCH_PIXELS = 100;
const WHEEL_LINE_PIXELS = 16;
const RESIZE_SETTLE_MS = 100;

/** Milliseconds of quiet that end a wheel burst — a wheel has no "up". */
export const PDF_VIEWER_WHEEL_SETTLE_MS = 250;

export interface PdfViewerLabels {
  /** `aria-label` of the toolbar. */
  readonly controls: string;
  readonly previous: string;
  readonly next: string;
  readonly zoomOut: string;
  readonly zoomIn: string;
  /** Back to the fitted size (toolbar). */
  readonly zoomReset: string;
  /** Back to the resting view after a gesture (floating control). */
  readonly reset: string;
  readonly retry: string;
  readonly loading: string;
  /** Failure sentence; `%{reason}` is replaced by the error message. */
  readonly failed: string;
}

export const DEFAULT_PDF_VIEWER_LABELS: PdfViewerLabels = {
  controls: "PDF controls",
  previous: "Previous page",
  next: "Next page",
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  zoomReset: "Reset zoom",
  reset: "Reset zoom and pan",
  retry: "Retry",
  loading: "Loading…",
  failed: "Failed to load PDF: %{reason}",
};

/**
 * How the resting (100 %) zoom relates to the surface:
 * - `width`: the page fills the surface width; taller pages scroll.
 *   Right for an in-flow reader in a prose column.
 * - `page`: the whole page fits the surface box (smaller ratio wins).
 *   Right for a full-screen reader, where cropping a scanned page would
 *   hide the margin a stamp or signature sits in.
 */
export type PdfViewerFit = "width" | "page";

export type PdfViewerInteraction = "gestures" | "scroll" | "none";

export type PdfViewerStatus = "loading" | "ready" | "error";

export interface PdfViewerState {
  readonly status: PdfViewerStatus;
  readonly page: number;
  readonly pageCount: number;
  readonly zoom: number;
  readonly error: string | null;
}

export interface PdfViewerOptions {
  /** The document URL, handed verbatim to PDF.js (range-loaded). */
  readonly url: string;
  readonly fit?: PdfViewerFit;
  readonly labels?: { readonly [K in keyof PdfViewerLabels]?: string | undefined };
  readonly zoom?: {
    readonly min?: number;
    readonly max?: number;
    readonly step?: number;
    readonly initial?: number;
  };
  readonly maxDpr?: number;
  /**
   * How the page surface reacts to pointers and the wheel:
   * - `gestures` (default): the surface owns every gesture — drag pans,
   *   pinch and any wheel zoom. Right for a full-screen reader, where
   *   there is nothing else to scroll.
   * - `scroll`: the BROWSER keeps scrolling (one-finger swipe, bare
   *   wheel), so a reader embedded in a scrolling page never traps the
   *   reader's finger; pinch and Ctrl/⌘+wheel (what a touchpad pinch
   *   emits) still zoom the page.
   * - `none`: toolbar only.
   */
  readonly interaction?: PdfViewerInteraction;
  readonly onStateChange?: (state: PdfViewerState) => void;
}

/** The handle a host keeps for the viewer it mounted. */
export interface PdfViewerOwner {
  readonly host: HTMLElement;
  state(): PdfViewerState;
  goTo(page: number): void;
  next(): void;
  previous(): void;
  setZoom(zoom: number): void;
  /** Restore the resting view: zoom 1, no pan. */
  resetView(): void;
  /** Release the current document (if any) and load the URL again. */
  reload(): Promise<void>;
  /**
   * Release the loading task (the worker), remove the viewer DOM and
   * stop listening. Idempotent; safe on a viewer that never loaded.
   */
  destroy(): Promise<void>;
}

interface Bounds {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/**
 * Internal renderer state, never returned to hosts. The public owner is a
 * frozen facade whose closures call this instance with its original receiver,
 * keeping host reactivity proxies away from PDF.js handles.
 */
class Viewer implements PdfViewerOwner {
  readonly host: HTMLElement;
  private readonly options: PdfViewerOptions;
  private readonly labels: PdfViewerLabels;
  private readonly bounds: Bounds;
  private readonly fit: PdfViewerFit;
  private readonly maxDpr: number;

  private readonly root: HTMLElement;
  private readonly surface: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly statusLine: HTMLElement;
  private readonly controls: {
    previous: HTMLButtonElement;
    next: HTMLButtonElement;
    zoomOut: HTMLButtonElement;
    zoomIn: HTMLButtonElement;
    zoomReset: HTMLButtonElement;
    page: HTMLElement;
    zoom: HTMLElement;
    reset: HTMLButtonElement;
  };

  private status: PdfViewerStatus = "loading";
  private error: string | null = null;
  private page = 1;
  private pageCount = 0;
  /** Live zoom (gesture included), relative to the fitted size. */
  private zoom: number;
  /** The zoom the visible raster was drawn at. */
  private rasterZoom: number;
  private panX = 0;
  private panY = 0;
  private fitScale = 1;
  private fitWidth = 0;
  private fitOuterWidth = 0;
  private fitHeight = 0;
  private scrollbarFit: { outerWidth: number; width: number } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Has a raster of the CURRENT document been committed to the canvas? */
  private painted = false;
  private displayedPage: PdfPage | null = null;

  private alive = true;
  private loadingTask: PdfLoadingTask | null = null;
  private doc: PdfDocument | null = null;
  private renderTask: PdfRenderTask | null = null;
  private renderCanvas: HTMLCanvasElement | null = null;
  private renderGeneration = 0;
  private loadGeneration = 0;
  private pendingDestroy: Promise<void>;
  private readonly taskDestructions = new WeakMap<PdfLoadingTask, Promise<void>>();

  // Gesture state.
  private readonly activePointers = new Map<number, { x: number; y: number }>();
  private panOrigin: { x: number; y: number; panX: number; panY: number } | null = null;
  private pinchOrigin: { distance: number; zoom: number } | null = null;
  private settleFrom: number;
  private wheelTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly interaction: PdfViewerInteraction;

  constructor(host: HTMLElement, options: PdfViewerOptions, pendingDestroy = Promise.resolve()) {
    this.pendingDestroy = pendingDestroy;
    this.host = host;
    this.options = options;
    this.labels = { ...DEFAULT_PDF_VIEWER_LABELS };
    for (const [key, value] of Object.entries(options.labels ?? {})) {
      if (value !== undefined) Object.assign(this.labels, { [key]: value });
    }
    this.bounds = {
      min: options.zoom?.min ?? PDF_VIEWER_MIN_ZOOM,
      max: options.zoom?.max ?? PDF_VIEWER_MAX_ZOOM,
      step: options.zoom?.step ?? PDF_VIEWER_ZOOM_STEP,
    };
    this.fit = options.fit ?? "width";
    this.maxDpr = options.maxDpr ?? PDF_VIEWER_MAX_DPR;
    this.interaction = options.interaction ?? "gestures";
    this.zoom = this.clampZoom(options.zoom?.initial ?? PDF_VIEWER_DEFAULT_ZOOM);
    this.rasterZoom = this.zoom;
    this.settleFrom = this.zoom;

    const built = buildDom(this.labels, this.interaction);
    this.root = built.root;
    this.surface = built.surface;
    this.canvas = built.canvas;
    this.statusLine = built.status;
    this.controls = built.controls;
    host.appendChild(this.root);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(this.surface);
    }

    this.controls.previous.addEventListener("click", () => this.previous());
    this.controls.next.addEventListener("click", () => this.next());
    this.controls.zoomOut.addEventListener("click", () => this.setZoom(this.zoom - this.bounds.step));
    this.controls.zoomIn.addEventListener("click", () => this.setZoom(this.zoom + this.bounds.step));
    this.controls.zoomReset.addEventListener("click", () => this.resetView());
    this.controls.reset.addEventListener("click", () => this.resetView());
    this.statusLine.addEventListener("click", (event) => {
      const target = event.target as Element | null;
      if (target?.closest(".pdf-viewer-retry")) void this.reload();
    });
    if (this.interaction !== "none") {
      this.surface.addEventListener("pointerdown", this.onPointerDown);
      this.surface.addEventListener("pointermove", this.onPointerMove);
      this.surface.addEventListener("pointerup", this.onPointerUp);
      this.surface.addEventListener("pointercancel", this.onPointerUp);
      this.surface.addEventListener("wheel", this.onWheel, { passive: false });
      if (this.interaction === "gestures") this.surface.addEventListener("dblclick", () => this.resetView());
    }

    this.sync();
    void this.load();
  }

  // ---- public handle ----------------------------------------------------

  state(): PdfViewerState {
    return {
      status: this.status,
      page: this.page,
      pageCount: this.pageCount,
      zoom: this.zoom,
      error: this.error,
    };
  }

  goTo(page: number): void {
    if (this.status !== "ready" || this.pageCount === 0) return;
    const target = Math.min(this.pageCount, Math.max(1, Math.floor(page)));
    if (target === this.page) return;
    this.page = target;
    this.sync();
    void this.paint();
  }

  next(): void {
    this.goTo(this.page + 1);
  }

  previous(): void {
    this.goTo(this.page - 1);
  }

  setZoom(zoom: number): void {
    if (this.status !== "ready") return;
    const clamped = this.clampZoom(zoom);
    if (Math.abs(clamped - this.zoom) < 1e-9) return;
    this.zoom = clamped;
    this.settleFrom = clamped;
    this.sync();
    void this.paint();
  }

  resetView(): void {
    if (this.status !== "ready") return;
    const changedZoom = Math.abs(this.zoom - PDF_VIEWER_DEFAULT_ZOOM) >= 1e-9;
    this.zoom = this.clampZoom(PDF_VIEWER_DEFAULT_ZOOM);
    this.settleFrom = this.zoom;
    this.panX = 0;
    this.panY = 0;
    this.sync();
    if (changedZoom) void this.paint();
    else this.applyTransform();
  }

  async reload(): Promise<void> {
    if (!this.alive) return;
    await this.load();
  }

  async destroy(): Promise<void> {
    if (!this.alive) return this.pendingDestroy;
    this.alive = false;
    this.loadGeneration += 1;
    if (this.wheelTimer !== null) clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    this.root.remove();
    const teardown = this.releaseDocument();
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.displayedPage = null;
    this.painted = false;
    await teardown;
  }

  // ---- lifecycle --------------------------------------------------------

  private clampZoom(value: number): number {
    return Math.min(this.bounds.max, Math.max(this.bounds.min, value));
  }

  private emit(): void {
    try {
      this.options.onStateChange?.(this.state());
    } catch (reason) {
      console.error("pdf-viewer: onStateChange failed", reason);
    }
  }

  private cancelActiveRender(): void {
    const task = this.renderTask;
    this.renderTask = null;
    this.renderGeneration += 1;
    try {
      task?.cancel();
    } catch {
      // Cancelling an already-settled render throws in some builds.
    } finally {
      if (this.renderCanvas) this.discardRenderCanvas(this.renderCanvas);
    }
  }

  /**
   * Release the PDF.js handles: cancel the active render, destroy the
   * loading task. Leaves the DOM alone (the retry path keeps its
   * scaffold). The destroy promise is retained so `load` can await it.
   */
  private releaseDocument(): Promise<void> {
    this.cancelActiveRender();
    const task = this.loadingTask;
    this.loadingTask = null;
    this.doc = null;
    if (task) this.destroyTask(task);
    return this.pendingDestroy;
  }

  private destroyTask(task: PdfLoadingTask): void {
    if (this.taskDestructions.has(task)) return;
    const destruction = task.destroy()
      .catch((reason) => console.error("pdf-viewer: task.destroy failed", reason));
    this.taskDestructions.set(task, destruction);
    this.pendingDestroy = Promise.all([this.pendingDestroy, destruction]).then(() => undefined);
  }

  private async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    let task: PdfLoadingTask | null = null;
    const superseded = () => {
      if (this.alive && generation === this.loadGeneration) return false;
      if (task) this.destroyTask(task);
      return true;
    };
    void this.releaseDocument();
    this.status = "loading";
    this.error = null;
    this.painted = false;
    this.pageCount = 0;
    this.page = 1;
    this.sync();
    this.emit();
    try {
      await this.pendingDestroy;
      if (superseded()) return;
      const runtime = await loadPdfRuntime();
      if (superseded()) return;
      task = runtime.getDocument({
        url: this.options.url,
        disableAutoFetch: true,
        disableStream: true,
      });
      this.loadingTask = task;
      const loaded = await task.promise;
      if (superseded()) return;
      this.doc = loaded;
      this.pageCount = loaded.numPages;
      this.page = 1;
      this.panX = 0;
      this.panY = 0;
      this.status = "ready";
      this.sync();
      await this.paint();
      if (superseded()) return;
    } catch (reason) {
      if (superseded()) return;
      this.fail(reason);
    }
  }

  private fail(reason: unknown): void {
    void this.releaseDocument();
    this.status = "error";
    this.error = reason instanceof Error ? reason.message : String(reason);
    this.sync();
    this.emit();
  }

  private measureFit(pageWidth: number, pageHeight: number): number {
    const surface = window.getComputedStyle(this.surface);
    const canvas = window.getComputedStyle(this.canvas);
    const px = (value: string) => Number.parseFloat(value) || 0;
    this.fitOuterWidth = this.surface.offsetWidth;
    this.fitWidth = this.availableFitWidth();
    this.fitHeight = this.surface.clientHeight;
    const width = this.fitWidth - px(surface.paddingLeft) - px(surface.paddingRight)
      - px(canvas.borderLeftWidth) - px(canvas.borderRightWidth);
    const height = this.fitHeight - px(surface.paddingTop) - px(surface.paddingBottom)
      - px(canvas.borderTopWidth) - px(canvas.borderBottomWidth);
    if (width < 2 || pageWidth <= 0 || pageHeight <= 0) return 1;
    if (this.fit === "page" && height >= 2) {
      return Math.min(width / pageWidth, height / pageHeight);
    }
    return width / pageWidth;
  }

  private fitSizeChanged(): boolean {
    return this.availableFitWidth() !== this.fitWidth
      || (this.fit === "page" && this.surface.clientHeight !== this.fitHeight);
  }

  private availableFitWidth(): number {
    if (this.scrollbarFit && this.surface.offsetWidth !== this.scrollbarFit.outerWidth) {
      this.scrollbarFit = null;
    }
    return this.scrollbarFit
      ? Math.min(this.surface.clientWidth, this.scrollbarFit.width)
      : this.surface.clientWidth;
  }

  private readonly onResize = (): void => {
    if (!this.alive || this.status !== "ready" || !this.fitSizeChanged()) return;
    if (this.resizeTimer !== null) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      if (this.alive && this.status === "ready" && this.fitSizeChanged()) void this.paint();
    }, RESIZE_SETTLE_MS);
  };

  private effectiveDpr(): number {
    const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
    return Math.min(dpr, this.maxDpr);
  }

  /** Render the current page at the current zoom and commit it. */
  private async paint(correctFit = true): Promise<void> {
    const current = this.doc;
    if (!current || !this.alive) return;
    if (correctFit) this.scrollbarFit = null;
    this.cancelActiveRender();
    const generation = this.renderGeneration;

    let pdfPage: PdfPage;
    try {
      pdfPage = await current.getPage(this.page);
    } catch (reason) {
      if (generation !== this.renderGeneration || !this.alive) return;
      this.fail(reason);
      return;
    }
    if (generation !== this.renderGeneration || !this.alive) {
      // A newer render started (page change, zoom settle, reload) while
      // we awaited: this page is never shown, so release it.
      this.cleanupPage(pdfPage);
      return;
    }

    const natural = pdfPage.getViewport({ scale: 1 });
    this.fitScale = this.measureFit(natural.width, natural.height);
    const targetZoom = this.zoom;
    const viewport = pdfPage.getViewport({ scale: this.fitScale * targetZoom });
    const dpr = this.effectiveDpr();

    const rendered = document.createElement("canvas");
    this.renderCanvas = rendered;
    rendered.width = Math.max(1, Math.floor(viewport.width * dpr));
    rendered.height = Math.max(1, Math.floor(viewport.height * dpr));
    const context = rendered.getContext("2d");
    if (!context) {
      this.discardRenderCanvas(rendered);
      this.cleanupPage(pdfPage);
      this.fail(new Error("canvas 2D context unavailable"));
      return;
    }

    const task = pdfPage.render({
      canvasContext: context,
      viewport,
      transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
    });
    this.renderTask = task;
    try {
      await task.promise;
    } catch (reason) {
      this.discardRenderCanvas(rendered);
      this.cleanupPage(pdfPage);
      if (generation !== this.renderGeneration || !this.alive) return;
      this.fail(reason);
      return;
    } finally {
      if (this.renderTask === task) this.renderTask = null;
    }
    if (generation !== this.renderGeneration || !this.alive) {
      this.discardRenderCanvas(rendered);
      this.cleanupPage(pdfPage);
      return;
    }

    const visible = this.canvas.getContext("2d");
    if (!visible) {
      this.discardRenderCanvas(rendered);
      this.cleanupPage(pdfPage);
      this.fail(new Error("visible canvas 2D context unavailable"));
      return;
    }
    // ⚠ One synchronous commit: resizing the visible backing store clears
    // it, so no await may separate that clear from the copy. The
    // displayed page is deliberately NOT cleaned up (see header).
    this.canvas.width = rendered.width;
    this.canvas.height = rendered.height;
    visible.drawImage(rendered, 0, 0);
    this.displayedPage = pdfPage;
    this.discardRenderCanvas(rendered);
    this.canvas.style.width = `${Math.floor(viewport.width)}px`;
    this.canvas.style.height = `${Math.floor(viewport.height)}px`;
    this.rasterZoom = targetZoom;
    this.painted = true;
    this.applyTransform();
    this.sync();
    if (correctFit && this.fitSizeChanged()) {
      const width = this.surface.clientWidth;
      if (this.fit === "width" && this.interaction !== "gestures"
        && width < this.fitWidth && this.surface.offsetWidth === this.fitOuterWidth) {
        // Keep the narrower fixed point if this correction removes the scrollbar.
        // A genuine outer-width change or a new explicit paint releases the hold.
        this.scrollbarFit = { outerWidth: this.fitOuterWidth, width };
      }
      await this.paint(false);
      return;
    }
    this.emit();
  }

  // ---- DOM sync ---------------------------------------------------------

  private discardRenderCanvas(canvas: HTMLCanvasElement): void {
    canvas.width = 0;
    canvas.height = 0;
    if (this.renderCanvas === canvas) this.renderCanvas = null;
  }

  private cleanupPage(page: PdfPage): void {
    if (page !== this.displayedPage) page.cleanup();
  }

  private applyTransform(): void {
    if (this.interaction === "none") return;
    const scale = this.zoom / this.rasterZoom;
    this.canvas.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${scale})`;
    const adjusted = this.panX !== 0 || this.panY !== 0 || Math.abs(this.zoom - PDF_VIEWER_DEFAULT_ZOOM) >= 1e-9;
    // In scroll mode the toolbar's reset covers zoom and there is no pan.
    this.controls.reset.hidden = this.interaction !== "gestures" || !adjusted;
  }

  private sync(): void {
    const { controls } = this;
    const busy = this.status !== "ready";
    this.root.setAttribute("data-status", this.status);
    controls.page.textContent = this.pageCount ? `${this.page} / ${this.pageCount}` : "…";
    const zoomLabel = `${Math.round(this.settleFrom * 100)}%`;
    if (controls.zoom.textContent !== zoomLabel) controls.zoom.textContent = zoomLabel;
    controls.previous.disabled = busy || this.page <= 1;
    controls.next.disabled = busy || this.page >= this.pageCount;
    controls.zoomOut.disabled = busy || this.zoom <= this.bounds.min + 1e-9;
    controls.zoomIn.disabled = busy || this.zoom >= this.bounds.max - 1e-9;
    controls.zoomReset.disabled = busy;
    // Hidden until a raster exists: an unpainted canvas is a blank box
    // that reads as "this document is empty".
    this.canvas.hidden = busy || !this.painted;
    if (this.painted) this.root.setAttribute("data-painted", "1");
    else this.root.removeAttribute("data-painted");
    if (busy) controls.reset.hidden = true;

    this.statusLine.textContent = "";
    if (this.status === "error") {
      const message = el("span", "pdf-viewer-error");
      message.textContent = this.labels.failed.replace("%{reason}", () => this.error ?? "");
      const retry = makeButton("pdf-viewer-retry", this.labels.retry, this.labels.retry);
      this.statusLine.append(message, retry);
      this.statusLine.setAttribute("data-state", "error");
    } else if (this.status === "loading") {
      this.statusLine.textContent = this.labels.loading;
      this.statusLine.setAttribute("data-state", "loading");
    } else {
      this.statusLine.removeAttribute("data-state");
    }
  }

  // ---- gestures ---------------------------------------------------------

  private pinchDistance(): number {
    const [a, b] = [...this.activePointers.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private settle(): void {
    if (this.zoom === this.settleFrom) return;
    this.settleFrom = this.zoom;
    this.sync();
    void this.paint();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.status !== "ready") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      this.surface.setPointerCapture(event.pointerId);
    } catch {
      /* not capturable — events still arrive on the surface */
    }
    if (this.activePointers.size === 1 && this.wheelTimer === null) this.settleFrom = this.zoom;
    // Scroll mode: a single finger belongs to the browser's scrolling.
    if (this.interaction === "scroll" && this.activePointers.size < 2) return;
    if (this.activePointers.size >= 2) {
      // A second finger converts pan into pinch; stop panning so the page
      // does not lurch toward whichever finger arrived first.
      this.panOrigin = null;
      this.surface.classList.remove("pdf-viewer-surface--panning");
      this.pinchOrigin = { distance: this.pinchDistance(), zoom: this.zoom };
      return;
    }
    this.panOrigin = { x: event.clientX, y: event.clientY, panX: this.panX, panY: this.panY };
    this.surface.classList.add("pdf-viewer-surface--panning");
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.activePointers.has(event.pointerId)) return;
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pinchOrigin && this.activePointers.size >= 2) {
      const distance = this.pinchDistance();
      if (distance > 0 && this.pinchOrigin.distance > 0) {
        this.zoom = this.clampZoom(this.pinchOrigin.zoom * (distance / this.pinchOrigin.distance));
        this.applyTransform();
      }
      return;
    }
    if (!this.panOrigin) return;
    this.panX = this.panOrigin.panX + (event.clientX - this.panOrigin.x);
    this.panY = this.panOrigin.panY + (event.clientY - this.panOrigin.y);
    this.applyTransform();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId);
    if (this.activePointers.size < 2) this.pinchOrigin = null;
    if (this.activePointers.size === 1) {
      // One finger lifted after a pinch: resume panning from where the
      // remaining finger is rather than jumping by the gap between them.
      const [remaining] = [...this.activePointers.values()];
      if (remaining && this.interaction === "gestures") {
        this.panOrigin = { x: remaining.x, y: remaining.y, panX: this.panX, panY: this.panY };
        this.surface.classList.add("pdf-viewer-surface--panning");
      }
      return;
    }
    if (this.activePointers.size === 0) {
      this.panOrigin = null;
      this.surface.classList.remove("pdf-viewer-surface--panning");
      this.sync();
      this.settle();
    }
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (this.status !== "ready" || event.deltaY === 0) return;
    if (this.interaction === "scroll" && !event.ctrlKey && !event.metaKey) return;
    // The browser would otherwise zoom the whole page on Ctrl/⌘+wheel;
    // a bare wheel zooms too, since the surface owns its scrolling.
    event.preventDefault();
    if (this.activePointers.size === 0 && this.wheelTimer === null) this.settleFrom = this.zoom;
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PIXELS
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.surface.clientHeight : 1;
    this.zoom = this.clampZoom(this.zoom * Math.pow(
      PDF_VIEWER_WHEEL_FACTOR, event.deltaY * unit / WHEEL_NOTCH_PIXELS,
    ));
    this.applyTransform();
    if (this.wheelTimer !== null) clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => {
      this.wheelTimer = null;
      this.sync();
      this.settle();
    }, PDF_VIEWER_WHEEL_SETTLE_MS);
  };
}

// ---- DOM construction -----------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
}

function makeButton(cls: string, label: string, text: string): HTMLButtonElement {
  const button = el("button", cls);
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = text;
  return button;
}

function buildDom(labels: PdfViewerLabels, interaction: PdfViewerInteraction) {
  const root = el("div", PDF_VIEWER_CLASS);

  const toolbar = el("div", "pdf-viewer-toolbar");
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", labels.controls);
  const previous = makeButton("pdf-viewer-previous", labels.previous, "\u2039");
  const page = el("span", "pdf-viewer-page");
  page.setAttribute("aria-live", "polite");
  const next = makeButton("pdf-viewer-next", labels.next, "\u203A");
  const zoomOut = makeButton("pdf-viewer-zoom-out", labels.zoomOut, "\u2212");
  const zoom = el("span", "pdf-viewer-zoom");
  zoom.setAttribute("aria-live", "polite");
  const zoomReset = makeButton("pdf-viewer-zoom-reset", labels.zoomReset, "\u21BA");
  const zoomIn = makeButton("pdf-viewer-zoom-in", labels.zoomIn, "+");
  const pages = el("span", "pdf-viewer-group");
  pages.append(previous, page, next);
  const zooms = el("span", "pdf-viewer-group");
  zooms.append(zoomOut, zoom, zoomReset, zoomIn);
  toolbar.append(pages, zooms);

  const surface = el("div", "pdf-viewer-surface");
  if (interaction === "gestures") surface.classList.add("pdf-viewer-surface--gestures");
  if (interaction === "scroll") surface.classList.add("pdf-viewer-surface--scroll");
  const canvas = el("canvas", "pdf-viewer-canvas");
  const reset = makeButton("pdf-viewer-reset", labels.reset, "");
  reset.hidden = true;
  reset.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<path d="M2 5.5V2.5h3M14 5.5V2.5h-3M2 10.5v3h3M14 10.5v3h-3" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  reset.addEventListener("pointerdown", (event) => event.stopPropagation());
  reset.addEventListener("dblclick", (event) => event.stopPropagation());
  surface.append(canvas, reset);

  const status = el("div", "pdf-viewer-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  root.append(toolbar, surface, status);
  return {
    root,
    surface,
    canvas,
    status,
    controls: { previous, next, zoomOut, zoomIn, zoomReset, page, zoom, reset },
  };
}

// ---- entry point ----------------------------------------------------------

const viewerOf = new WeakMap<HTMLElement, Viewer>();

/**
 * Mount a viewer into `host` and start loading `options.url`.
 *
 * Mounting twice on one host replaces the previous viewer, releasing its
 * loading task before the replacement starts its worker. The returned
 * owner acts only on the viewer it mounted.
 */
export function mountPdfViewer(host: HTMLElement, options: PdfViewerOptions): PdfViewerOwner {
  const previous = viewerOf.get(host);
  const pendingDestroy = previous?.destroy();
  const viewer = new Viewer(host, options, pendingDestroy);
  viewerOf.set(host, viewer);
  const owner: PdfViewerOwner = {
    get host() { return host; },
    state: () => viewer.state(),
    goTo: (page) => viewer.goTo(page),
    next: () => viewer.next(),
    previous: () => viewer.previous(),
    setZoom: (zoom) => viewer.setZoom(zoom),
    resetView: () => viewer.resetView(),
    reload: () => viewer.reload(),
    destroy: () => viewer.destroy(),
  };
  // Preserve the host accessor without storing enumerable object state.
  Object.defineProperty(owner, "host", { enumerable: false });
  return Object.freeze(owner);
}
