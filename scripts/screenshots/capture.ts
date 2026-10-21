// Takes the README screenshots (Servers and Usage) from the built UI, fed with the made-up data in demo-data.ts,
// and puts each one in a macOS window frame (window-frame.html). No hub runs and nothing real is shown.
//   npm run screenshots
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { chromium, type Page } from "playwright";
import { NOW, snapshot, usage } from "./demo-data.ts";

const root = join(import.meta.dirname, "..", "..");
const dist = join(root, "packages", "ui", "dist");
const outDir = join(root, "screenshots");
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

// The window the app has on screen, in points; the images are taken at 2x.
const WIDTH = 1183;
const HEIGHT = 792;
const SCALE = 2;
const TITLE = "MCP Hub";

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon" };

/** Serves the built UI (with the single-page fallback) on a free port. */
async function serveUi(): Promise<{ url: string; close: () => void }> {
  const index = readFileSync(join(dist, "index.html"));
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    try {
      const file = readFileSync(join(dist, path));
      res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" }).end(file);
    } catch {
      res.writeHead(200, { "Content-Type": "text/html" }).end(index);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

const snap = snapshot(version);

/** The UI asks the hub for its state over a live event stream and a few requests; answer them all from the demo data. */
async function fakeHub(page: Page): Promise<void> {
  await page.addInitScript((state) => {
    sessionStorage.setItem("mcp-hub-token", "demo");
    localStorage.setItem("mcp-hub-theme", "dark");
    class FakeEventSource {
      private listeners = new Map<string, Array<(e: MessageEvent) => void>>();
      onerror: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.listeners.get("state")?.forEach((l) => l(new MessageEvent("state", { data: JSON.stringify(state) }))), 0);
      }
      addEventListener(type: string, fn: (e: MessageEvent) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
      }
      close() {}
    }
    (window as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  }, snap);
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/state") return json(snap);
    if (path === "/api/usage") return json(usage());
    console.warn(`Unexpected request to ${path}; answering with an empty object`);
    return json({});
  });
}

/** Wraps a UI screenshot in the macOS window frame and returns the framed PNG (transparent around the window). */
async function frame(page: Page, shot: Buffer): Promise<Buffer> {
  const html = readFileSync(join(import.meta.dirname, "window-frame.html"), "utf8")
    .replaceAll("{{WIDTH}}", String(WIDTH))
    .replaceAll("{{HEIGHT}}", String(HEIGHT))
    .replaceAll("{{TITLE}}", TITLE)
    .replaceAll("{{IMAGE}}", `data:image/png;base64,${shot.toString("base64")}`);
  await page.setContent(html);
  await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete));
  return page.locator(".stage").screenshot({ omitBackground: true });
}

const ui = await serveUi();
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: SCALE,
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
  });
  await context.clock.setFixedTime(NOW);
  const app = await context.newPage();
  await fakeHub(app);
  const framer = await context.newPage();

  const take = async (file: string) => {
    await app.locator("main").evaluate((el) => { el.scrollTop = 0; });
    const png = await frame(framer, await app.screenshot({ animations: "disabled" }));
    writeFileSync(join(outDir, file), png);
    console.log(`wrote screenshots/${file}`);
  };

  await app.goto(`${ui.url}/#/servers`);
  await app.getByRole("heading", { name: "Servers", level: 1 }).waitFor();
  await app.getByRole("heading", { name: "Snuffy" }).waitFor();
  await take("MCP Hub - Servers.png");

  await app.goto(`${ui.url}/#/usage`);
  await app.getByText("Data over time").waitFor();
  await app.getByRole("tab", { name: "Requests", exact: true }).click();
  await app.getByText("Requests over time").waitFor();
  // The chart animates in.
  await app.waitForTimeout(1500);
  await take("MCP Hub - Usage.png");
} finally {
  await browser.close();
  ui.close();
}
