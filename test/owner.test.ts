import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setPdfRuntimeForTest, type PdfLoadingTask } from "@0k/pdfjs-legacy-runtime";
import { mountPdfViewer } from "../src/index";
import { flush, installFakeRuntime, makeFakeRuntime, mountHost, stubCanvasContext } from "./fakeRuntime";

beforeEach(stubCanvasContext);
afterEach(() => {
  __setPdfRuntimeForTest(null);
  vi.restoreAllMocks();
});

/** Exercise proxy receivers even for frozen objects, using extensible shells. */
function deepProxy<T>(value: T, cache = new WeakMap<object, object>()): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  const source = value as object;
  const existing = cache.get(source);
  if (existing) return existing as T;
  const get = (_target: object, key: PropertyKey, receiver: unknown): unknown => {
    const item: unknown = Reflect.get(source, key, receiver);
    // Promise methods require their original native receiver, unlike host methods.
    if (value instanceof Promise && typeof item === "function") return deepProxy(item.bind(value), cache);
    return deepProxy(item, cache);
  };
  const proxy = typeof value === "function"
    ? new Proxy(function (this: unknown, ...args: unknown[]) {
      return deepProxy(Reflect.apply(value, this, args), cache);
    }, { get })
    : new Proxy({}, { get });
  cache.set(source, proxy);
  return proxy as T;
}

class GuardedTask implements PdfLoadingTask {
  #task: PdfLoadingTask;
  destroyCalls = 0;
  constructor(task: PdfLoadingTask) { this.#task = task; }
  get promise() { return this.#task.promise; }
  destroy(): Promise<void> {
    this.destroyCalls += 1;
    return this.#task.destroy();
  }
}

describe("owner boundary", () => {
  it("returns a frozen plain facade without owned object state", async () => {
    installFakeRuntime();
    const host = mountHost();
    const owner = mountPdfViewer(host, { url: "a.pdf" });
    try {
      expect(Object.isFrozen(owner)).toBe(true);
      expect(Object.getPrototypeOf(owner)).toBe(Object.prototype);
      expect(Object.values(owner).every((value) => typeof value === "function")).toBe(true);
      expect(owner.host).toBe(host);
    } finally {
      await owner.destroy();
    }
  });

  it("keeps PDF handles private through deep host proxies and destroys each task once", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctrl = makeFakeRuntime();
    const tasks: GuardedTask[] = [];
    __setPdfRuntimeForTest({ getDocument: (params) => {
      const task = new GuardedTask(ctrl.runtime.getDocument(params));
      tasks.push(task);
      return task;
    } });
    const host = mountHost();
    const owner = deepProxy(mountPdfViewer(host, { url: "a.pdf" }));
    await flush();
    expect(() => owner.setZoom(1.25)).not.toThrow();
    await flush();
    owner.next();
    await flush();
    expect(owner.state().page).toBe(2);
    await owner.reload();
    expect(owner.state().status).toBe("ready");
    expect(owner.state().page).toBe(1);
    await owner.destroy();
    await owner.destroy();
    expect(tasks.map((task) => task.destroyCalls)).toEqual([1, 1]);
    expect(ctrl.destroyTaskCalls).toBe(2);
    expect(logged).not.toHaveBeenCalled();
    expect(host.querySelector(".pdf-viewer")).toBeNull();
  });
});
