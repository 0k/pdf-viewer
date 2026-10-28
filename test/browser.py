"""Verify the built package with real PDF.js and Chrome; no project writes.

Run with a Python environment providing Playwright and system Chrome.
All host files and bundle output live in a temporary directory.
"""
import functools
import http.server
import json
from pathlib import Path
import subprocess
import tempfile
import threading

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def red_page_pdf(height=140):
    """A synthetic, one-page PDF with a solid red rectangle."""
    stream = f"1 0 0 rg 0 0 100 {height} re f\n".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 {height}] "
        "/Resources << >> /Contents 4 0 R >>".encode(),
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n"
        + stream + b"endstream",
    ]
    data = b"%PDF-1.4\n"
    offsets = [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data += f"{number} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(data)
    data += b"xref\n0 5\n0000000000 65535 f \n"
    for offset in offsets[1:]:
        data += f"{offset:010} 00000 n \n".encode()
    return data + f"trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object):
        pass

    def do_GET(self):
        if self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
        else:
            super().do_GET()


def assert_scroll_reachability(page):
    for mode in ("scroll", "none"):
        page.evaluate("mode => window.remount({interaction:mode})", mode)
        page.wait_for_selector('.pdf-viewer[data-painted="1"]')
        before = page.locator("canvas").evaluate("el => el.style.width")
        page.evaluate("owner.setZoom(2)")
        page.wait_for_function("before => document.querySelector('canvas').style.width !== before", arg=before)
        geometry = page.locator(".pdf-viewer-surface").evaluate("""surface => {
            surface.scrollLeft = 0;
            const canvas = surface.querySelector('canvas').getBoundingClientRect();
            return {scrollWidth:surface.scrollWidth, width:canvas.width,
                    left:canvas.left - surface.getBoundingClientRect().left};
        }""")
        assert geometry["scrollWidth"] >= geometry["width"], (mode, geometry)
        assert abs(geometry["left"]) <= 1, (mode, geometry)
    print("PASS: zoomed pages are fully reachable in scroll and toolbar-only modes")


def assert_fitted_width(page):
    page.evaluate("window.remount({interaction:'scroll'})")
    page.wait_for_selector('.pdf-viewer[data-painted="1"]')
    geometry = page.locator(".pdf-viewer-surface").evaluate("""surface => ({
        available:surface.clientWidth, scrollWidth:surface.scrollWidth,
        canvasWidth:surface.querySelector('canvas').getBoundingClientRect().width
    })""")
    assert geometry["scrollWidth"] == geometry["available"], geometry
    assert geometry["canvasWidth"] == geometry["available"], geometry
    print("PASS: fitted canvas border box fills the available width without overflow")


def assert_gesture_settle_position(page):
    for gesture in ("wheel", "pinch"):
        for direction in (1, -1):
            page.evaluate("zoom => window.remount({interaction:'gestures',zoom:{initial:zoom}})",
                          1 if direction == 1 else 1.5)
            page.wait_for_selector('.pdf-viewer[data-painted="1"]')
            live = page.evaluate("""({gesture,direction}) => {
                const surface = document.querySelector('.pdf-viewer-surface');
                const canvas = surface.querySelector('canvas');
                const pointer = (type,id,x) => surface.dispatchEvent(new PointerEvent(type,
                    {pointerId:id,pointerType:'touch',clientX:x,clientY:100}));
                if (gesture === 'wheel') surface.dispatchEvent(new WheelEvent('wheel',{deltaY:-100*direction}));
                else {
                    pointer('pointerdown',1,100); pointer('pointerdown',2,200);
                    pointer('pointermove',2,direction === 1 ? 250 : 175);
                }
                const rect = canvas.getBoundingClientRect();
                const result = {top:rect.top,left:rect.left,width:canvas.style.width};
                if (gesture === 'pinch') {
                    pointer('pointerup',2,200); pointer('pointerup',1,100);
                }
                return result;
            }""", {"gesture": gesture, "direction": direction})
            page.wait_for_function("width => document.querySelector('canvas').style.width !== width", arg=live["width"])
            settled = page.locator("canvas").bounding_box()
            assert settled is not None
            for axis in ("top", "left"):
                after = settled["y" if axis == "top" else "x"]
                assert abs(live[axis] - after) <= 1, (gesture, direction, axis, live, settled)
    print("PASS: wheel and pinch preserve canvas position at settle in both zoom directions")


def assert_host_resize(page):
    page.evaluate("window.remount({interaction:'scroll'})")
    page.wait_for_function("window.paintCount > 0")
    for width in (300, 400):
        page.evaluate("width => document.getElementById('host').style.width = `${width}px`", width)
        page.wait_for_function("""width => {
            const surface = document.querySelector('.pdf-viewer-surface');
            const canvas = surface.querySelector('canvas').getBoundingClientRect();
            return surface.clientWidth === width && Math.abs(canvas.width - width) < 1
                && surface.scrollWidth <= surface.clientWidth;
        }""", arg=width, timeout=2000)
        assert page.locator("canvas").bounding_box()["width"] == width
    print("PASS: fit follows host shrink and grow")


def assert_classic_scrollbar_fit(playwright, url):
    browser = playwright.chromium.launch(
        channel="chrome", headless=True, ignore_default_args=["--hide-scrollbars"]
    )
    try:
        page = browser.new_page()
        page.goto(url)
        page.wait_for_function("window.paintCount > 0")
        geometry = page.locator(".pdf-viewer-surface").evaluate("""surface => ({
            outer:surface.offsetWidth, available:surface.clientWidth,
            scrollWidth:surface.scrollWidth,
            canvasWidth:surface.querySelector('canvas').getBoundingClientRect().width
        })""")
        assert geometry["available"] < geometry["outer"], geometry
        assert geometry["scrollWidth"] <= geometry["available"], geometry
        assert geometry["canvasWidth"] <= geometry["available"], geometry
        page.evaluate("async () => {await owner.destroy();}")
        print("PASS: first fit accounts for a classic vertical scrollbar", geometry)
        assert_scrollbar_band_stability(page, classic=True)
    finally:
        browser.close()


def assert_scrollbar_band_stability(page, classic=False):
    for mode in ("scroll", "none"):
        page.evaluate("mode => window.remount({url:'./band.pdf',interaction:mode})", mode)
        page.wait_for_function("window.paintCount > 0")
        samples = page.evaluate("""async () => {
            const counts = [window.renderCount];
            const start = performance.now();
            while (performance.now() - start < 1600) {
                await new Promise(resolve => setTimeout(resolve, 100));
                counts.push(window.renderCount);
            }
            const surface = document.querySelector('.pdf-viewer-surface');
            return {counts, milliseconds:performance.now()-start,
                available:surface.clientWidth, scrollWidth:surface.scrollWidth,
                canvasWidth:surface.querySelector('canvas').getBoundingClientRect().width};
        }""")
        print(f"Band stability ({mode}, classic={classic}): {samples}")
        assert samples["milliseconds"] >= 1500, samples
        assert len(set(samples["counts"])) == 1, samples
        assert 1 <= samples["counts"][0] <= 2, samples
        assert samples["scrollWidth"] <= samples["available"], samples
        assert samples["canvasWidth"] <= samples["available"], samples
        page.evaluate("async () => {await owner.destroy();}")


def verify():
    with tempfile.TemporaryDirectory(prefix="pdf-viewer-browser-") as temp:
        host = Path(temp)
        (host / "public").mkdir()
        (host / "public/manual.pdf").write_bytes(red_page_pdf())
        (host / "public/band.pdf").write_bytes(red_page_pdf(61))
        (host / "index.html").write_text(
            '<style>#host {width:400px; --btn-size:100px; --btn-radius:99px}'
            '.pdf-viewer {--pdf-viewer-surface-max-height:240px}</style>'
            '<div id="host"></div><script type="module" src="/main.js"></script>'
        )
        (host / "main.js").write_text(
            f'import {{mountPdfViewer}} from {json.dumps(str(ROOT / "dist/index.js"))};\n'
            f'import {json.dumps(str(ROOT / "dist/style.css"))};\n'
            'const drawImage = CanvasRenderingContext2D.prototype.drawImage;\n'
            'CanvasRenderingContext2D.prototype.drawImage = function (...args) {'
            'if (this.canvas.classList.contains("pdf-viewer-canvas")) window.renderCount++;'
            'return Reflect.apply(drawImage, this, args);};\n'
            'window.remount = (options = {}) => {window.paintCount = 0; window.renderCount = 0; window.owner = mountPdfViewer('
            'document.getElementById("host"), {url:"./manual.pdf", interaction:"scroll", ...options, '
            'onStateChange:state => {if(state.status === "ready") window.paintCount++;}});};\n'
            'window.remount();\n'
        )
        subprocess.run([
            "node", "--input-type=module", "-e",
            "import {build} from './node_modules/vite/dist/node/index.js';"
            "await build({configFile:false,root:process.argv[1],"
            "build:{target:'chrome91'}});", temp,
        ], cwd=ROOT, check=True, timeout=60)
        server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), functools.partial(Handler, directory=str(host / "dist"))
        )
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel="chrome", headless=True)
                try:
                    page = browser.new_page()
                    errors = []
                    requests = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.on("console", lambda message: errors.append(message.text)
                            if message.type == "error" else None)
                    page.on("request", lambda request: requests.append(request.url))
                    page.goto(f"http://127.0.0.1:{server.server_port}")
                    page.wait_for_selector('.pdf-viewer[data-painted="1"]')
                    assert page.locator(".pdf-viewer-page").inner_text() == "1 / 1"
                    assert page.locator(".pdf-viewer-zoom").inner_text() == "100%"
                    assert page.locator(".pdf-viewer-surface").evaluate(
                        "el => getComputedStyle(el).maxHeight"
                    ) == "240px"
                    assert page.locator(".pdf-viewer-zoom-in").evaluate(
                        "el => getComputedStyle(el).borderRadius"
                    ) == "6px"
                    assert page.locator(".pdf-viewer-zoom-in").evaluate(
                        "el => getComputedStyle(el).minWidth"
                    ) == "44px"
                    fitted_width = page.locator("canvas").evaluate("el => parseFloat(el.style.width)")
                    page.evaluate("owner.setZoom(1.25); owner.setZoom(1.5)")
                    page.wait_for_function(
                        "width => parseFloat(document.querySelector('canvas').style.width) === Math.floor(width * 1.5)",
                        arg=fitted_width,
                    )
                    assert page.locator("canvas").evaluate(
                        "el => Array.from(el.getContext('2d').getImageData(10,10,1,1).data)"
                    ) == [255, 0, 0, 255]
                    page.evaluate("async () => {await Promise.all([owner.reload(), owner.reload()]);}")
                    page.wait_for_selector('.pdf-viewer[data-painted="1"]')
                    page.evaluate("window.remount(); window.remount()")
                    page.wait_for_selector('.pdf-viewer[data-painted="1"]')
                    assert page.locator(".pdf-viewer").count() == 1
                    assert any("pdf.worker" in url for url in requests), requests
                    assert_fitted_width(page)
                    assert_host_resize(page)
                    assert_scroll_reachability(page)
                    assert_gesture_settle_position(page)
                    assert_scrollbar_band_stability(page)
                    page.evaluate("async () => {await owner.destroy();}")
                    assert page.locator(".pdf-viewer").count() == 0
                    assert not errors, errors
                    print("PASS: real PDF worker, raster, zoom supersession, reload, replacement, CSS, teardown")
                finally:
                    browser.close()
                assert_classic_scrollbar_fit(playwright, f"http://127.0.0.1:{server.server_port}")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    verify()
