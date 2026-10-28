# @0k/pdf-viewer

Plain TypeScript DOM PDF page viewer. The package owns the toolbar, the
page canvas, paging, zoom, pinch/pan gestures, fit policy, error/retry, accessible controls, scoped styles and single-owner teardown.
Hosts own the PDF URL and its access policy, where the viewer mounts, the
collapsed/opened affordance around it, and translated labels.

The PDF.js compatibility policy (the exact `pdfjs-dist` pin, the legacy build,
worker wiring, retry-on-rejected-import, single-owner teardown type) is OWNED
by `@0k/pdfjs-legacy-runtime`, consumed here as an exact peer dependency.

## Rules

- Keep the package free of Vue and of host fetching; the host passes a URL,
  PDF.js range-loads it. Never wrap bytes in a `blob:` URL here.
- Never import `pdfjs-dist` directly; only `@0k/pdfjs-legacy-runtime`.
- The loading task is the SOLE owner of worker/transport teardown. Never call
  a document-level `destroy` (the runtime type makes it a compile error).
- Never `cleanup()` the page currently displayed; only stale, cancelled or
  errored renders. Android WebView 91 blanks the canvas otherwise.
- Serialize teardown → startup: a reload awaits the previous loading task's
  `destroy()` before creating a new worker.
- Render off-screen and commit to the visible canvas in one synchronous step,
  so resizing the backing store never exposes a blank frame.
- Cap the device pixel ratio used for the backing canvas (memory on phones).
- Keep visible labels configurable with English defaults.
- Scope every style under the viewer root and expose host theme variables.
- A returned owner handle acts only on the viewer it mounted; `destroy()` is
  idempotent and safe on a never-loaded viewer.
- Preserve Chrome 91 compatibility (no `static {}` blocks, no
  `Promise.withResolvers`): `tsc` targets ES2020; emitted code is audited by
  `npm run check:chrome91`.
- Strict `tsc` (`strict`, `noUncheckedIndexedAccess`) is the static check; do not add a separate TypeScript linter.
- Write specification tests first and run `npm run check` before a release.

## Delivery

Published to npm as `@0k/pdf-viewer` with `pkg`, from a git tag; the version
comes from the tag (`package.json` carries `%%version%%`).  Never bump the
version to try a change: an unreleased change is tried in a host through an
uncommitted local override (`npm link <path-to-checkout>` there), never
committed into the host.
