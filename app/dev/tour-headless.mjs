// Runs the app's screen tour (app/dev/ui-tour.js) in a headless Chrome at several window sizes.
// Usage (dev server running on :5173, or set BARAMGER_URL=http://localhost:<port>/; macOS Chrome):
//   node app/dev/tour-headless.mjs <empty profile folder> <z1|z2> 1280x800 1024x560 800x725 ...
// It prints one line per window size: {size, zone, out: {views, bad}}; bad must be [].
// First it loads the app once WITH the launch animation (as a visitor does) and prints
// {startup: "ok" | problem, ms, errors}: the animation must end with the panel shown, without
// any script error. (The tour itself skips the animation with ?nointro.) STARTUP_ONLY=1 stops after that check.
// Headless: it never touches the Browser pane or your own Chrome profile.
// TOUR_TIMEOUT_MS (default 240000) is the longest one window size may take; a busy machine needs more.
// TOUR_PLAN_ONLY=1 runs only the plan screens (no walk-through, walk or replay): much quicker.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const [profile, zone, ...sizes] = process.argv.slice(2);
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=9333", "--no-first-run", "--no-default-browser-check",
  "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--window-size=1280,800", "about:blank",
], { stdio: "ignore" });

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:9333/json")).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome did not start");
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const waiting = new Map();
const pageErrors = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === "Runtime.exceptionThrown") pageErrors.push(msg.params.exceptionDetails.exception?.description?.split("\n")[0] ?? msg.params.exceptionDetails.text);
  if (msg.id && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const n = ++id;
  waiting.set(n, resolve);
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expression, timeout = Number(process.env.TOUR_TIMEOUT_MS ?? 240000)) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

await send("Runtime.enable");
const base = process.env.BARAMGER_URL ?? "http://localhost:5173/";
{
  // a visitor's first load: with the launch animation (skipped with the button after a few seconds)
  const [w0, h0] = (sizes[0] ?? "1280x800").split("x").map(Number);
  await send("Emulation.setDeviceMetricsOverride", { width: w0, height: h0, deviceScaleFactor: 1, mobile: false });
  pageErrors.length = 0;
  const t0 = Date.now();
  await send("Page.navigate", { url: `${base}?h=${Date.now()}#${zone}` });
  let state = "";
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    state = await evaluate(`(() => {
      const b = document.body;
      if (!b) return "no body";
      if (b.classList.contains("intro-on")) {
        if (performance.now() > 8000) document.querySelector("#intro button")?.click(); // "Skip intro"
        return "animation";
      }
      return document.querySelector("#panel")?.children.length && !document.querySelector("#map-title").hidden ? "ok" : "no panel";
    })()`).catch(() => "error");
    if (state === "ok") break;
  }
  console.log(JSON.stringify({ startup: state, ms: Date.now() - t0, errors: [...pageErrors] }));
}
if (process.env.STARTUP_ONLY) {
  ws.close();
  chrome.kill();
  process.exit(0);
}
const results = [];
let n = 0;
for (const size of sizes) {
  const [w, h] = size.split("x").map(Number);
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${process.env.BARAMGER_URL ?? "http://localhost:5173/"}?nointro&h=${Date.now()}${n++}#${zone}` });
  // wait for the app's dev hook and the zone list
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    await sleep(500);
    ready = (await evaluate("!!(window.__baramger && window.__baramger.map && document.body.dataset.screen)").catch(() => false)) === true; // an error answer is an object, not true
  }
  await sleep(1500);
  const out = await evaluate(`(async () => {
    const B = window.__baramger;
    const pump = setInterval(() => { try { B.map.viewer.render(); } catch {} }, 40);
    try { const m = await import('/dev/ui-tour.js?v=' + Date.now()); return await m.tour({ planOnly: ${process.env.TOUR_PLAN_ONLY === "1"} }); }
    catch (e) { return { err: String(e) }; }
    finally { clearInterval(pump); }
  })()`);
  results.push({ size, zone, out, inner: await evaluate("[innerWidth, innerHeight]") });
  console.log(JSON.stringify(results[results.length - 1]));
}
ws.close();
chrome.kill();
