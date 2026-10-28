/**
 * A controllable fake of `@0k/pdfjs-legacy-runtime` so no real dynamic
 * import, worker or canvas rasterisation runs under jsdom.
 *
 * The fake document deliberately has NO `destroy`: a stray
 * `doc.destroy()` throws, surfacing a second teardown path instead of
 * silently masking it.
 */
import { vi } from "vitest";
import {
  __setPdfRuntimeForTest,
  type PdfDocument,
  type PdfLoadingTask,
  type PdfPage,
  type PdfRenderTask,
  type PdfRuntime,
  type PdfViewport,
} from "@0k/pdfjs-legacy-runtime";

export type GetDocumentParams = Parameters<PdfRuntime["getDocument"]>[0];

export interface FakeWorker {
  destroyed: boolean;
  destroySettled: boolean;
  releaseLoad: () => void;
}

export interface FakeRuntime {
  runtime: PdfRuntime;
  getDocumentParams: GetDocumentParams[];
  renderCalls: number;
  /** Scales handed to `getViewport` on the RENDER path, in order. */
  renderScales: number[];
  cancelCalls: number;
  cleanupCalls: number;
  destroyTaskCalls: number;
  workers: FakeWorker[];
  liveWorkers: number;
  maxLiveWorkers: number;
  hangLoad: boolean;
  hangRuntime: boolean;
  releaseRuntime: () => void;
  failLoadWith: string | null;
  failRenderWith: string | null;
  numPages: number;
  /** Natural page size at scale 1. */
  pageWidth: number;
  pageHeight: number;
  /** When set, `render()` never settles until `releaseRender()` is called. */
  hangRender: boolean;
  releaseRender: () => void;
  /** When set, `destroy()` never settles until `releaseDestroy()` is called. */
  hangDestroy: boolean;
  releaseDestroy: () => void;
  /** When set, the FIRST `getPage` blocks until `releaseGetPage()`. */
  hangFirstGetPage: boolean;
  releaseGetPage: () => void;
}

export function makeFakeRuntime(over: Partial<FakeRuntime> = {}): FakeRuntime {
  const ctrl: FakeRuntime = {
    runtime: null as unknown as PdfRuntime,
    getDocumentParams: [],
    renderCalls: 0,
    renderScales: [],
    cancelCalls: 0,
    cleanupCalls: 0,
    destroyTaskCalls: 0,
    workers: [],
    liveWorkers: 0,
    maxLiveWorkers: 0,
    hangLoad: false,
    hangRuntime: false,
    releaseRuntime: () => undefined,
    failLoadWith: null,
    failRenderWith: null,
    numPages: 3,
    pageWidth: 100,
    pageHeight: 140,
    hangRender: false,
    releaseRender: () => undefined,
    hangDestroy: false,
    releaseDestroy: () => undefined,
    hangFirstGetPage: false,
    releaseGetPage: () => undefined,
    ...over,
  };

  const makePage = (): PdfPage => {
    let lastScale = 1;
    return {
      getViewport: ({ scale }: { scale: number }): PdfViewport => {
        lastScale = scale;
        return { width: ctrl.pageWidth * scale, height: ctrl.pageHeight * scale };
      },
      render: (): PdfRenderTask => {
        ctrl.renderCalls += 1;
        ctrl.renderScales.push(lastScale);
        let reject: ((e: unknown) => void) | null = null;
        let resolve: (() => void) | null = null;
        const promise = new Promise<void>((res, rej) => {
          resolve = res;
          reject = rej;
          if (ctrl.failRenderWith) rej(new Error(ctrl.failRenderWith));
          else if (!ctrl.hangRender) res();
        });
        if (ctrl.hangRender) ctrl.releaseRender = () => resolve?.();
        void promise.catch(() => undefined);
        return {
          promise,
          cancel: () => {
            ctrl.cancelCalls += 1;
            reject?.(Object.assign(new Error("cancelled"), { name: "RenderingCancelledException" }));
          },
        };
      },
      cleanup: () => {
        ctrl.cleanupCalls += 1;
      },
    };
  };

  let firstGetPage = true;
  const makeDoc = (): PdfDocument => {
    const pages = new Map<number, PdfPage>();
    return {
      numPages: ctrl.numPages,
      getPage: async (number: number) => {
        if (ctrl.hangFirstGetPage && firstGetPage) {
          firstGetPage = false;
          await new Promise<void>((res) => {
            ctrl.releaseGetPage = res;
          });
        }
        let page = pages.get(number);
        if (!page) {
          page = makePage();
          pages.set(number, page);
        }
        return page;
      },
    };
  };

  ctrl.runtime = {
    getDocument: (params: GetDocumentParams): PdfLoadingTask => {
      ctrl.getDocumentParams.push(params);
      ctrl.liveWorkers += 1;
      ctrl.maxLiveWorkers = Math.max(ctrl.maxLiveWorkers, ctrl.liveWorkers);
      let releaseLoad = () => undefined;
      const worker: FakeWorker = {
        destroyed: false,
        destroySettled: false,
        releaseLoad: () => releaseLoad(),
      };
      ctrl.workers.push(worker);
      const failure = ctrl.failLoadWith;
      const promise = new Promise<PdfDocument>((resolve, reject) => {
        releaseLoad = () => {
          if (worker.destroyed) reject(new Error("Worker was destroyed"));
          else if (failure) reject(new Error(failure));
          else resolve(makeDoc());
        };
        if (!ctrl.hangLoad) releaseLoad();
      });
      void promise.catch(() => undefined);
      let destruction: Promise<void> | null = null;
      return {
        promise,
        destroy: () => {
          if (destruction) return destruction;
          ctrl.destroyTaskCalls += 1;
          worker.destroyed = true;
          destruction = new Promise<void>((res) => {
            const settle = () => {
              if (worker.destroySettled) return;
              worker.destroySettled = true;
              ctrl.liveWorkers -= 1;
              res();
            };
            if (ctrl.hangDestroy) ctrl.releaseDestroy = settle;
            else settle();
          });
          return destruction;
        },
      };
    },
  };
  return ctrl;
}

export function installFakeRuntime(over: Partial<FakeRuntime> = {}): FakeRuntime {
  const ctrl = makeFakeRuntime(over);
  __setPdfRuntimeForTest(ctrl.hangRuntime ? new Promise<PdfRuntime>((resolve) => {
    ctrl.releaseRuntime = () => resolve(ctrl.runtime);
  }) : ctrl.runtime);
  return ctrl;
}

/** Flush microtasks so awaited chains settle. */
export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** jsdom canvases have no 2D context; give them a recording stub. */
export function stubCanvasContext(): { drawImage: ReturnType<typeof vi.fn> } {
  const ctx = { drawImage: vi.fn() };
  (HTMLCanvasElement.prototype as unknown as { getContext: () => object }).getContext =
    () => ctx;
  return ctx;
}

/** Pin a controlled layout box on an element (jsdom lays nothing out). */
export function pinBox(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: height, configurable: true });
  el.getBoundingClientRect = () =>
    ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {} }) as DOMRect;
}

export function mountHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}
