// Manual regression check for the rule "nothing scrolls" (dev only; not part of the build).
//
// It opens every screen of the app one after the other (whole planet, all plan tabs, every
// pop-up, walk-through, the whole walk, summary, report, replay) and asks the app's own
// overflowReport() after each step. A screen whose content does not fit its box is a bug.
//
// How to use, with `npm run dev` running and the app open (add ?nointro to skip the animation):
//   const { tour } = await import("/dev/ui-tour.js");
//   await tour();            // -> { views: 74, bad: [] }   (bad must be empty)
//   await tour({ planOnly: true });   // only the plan screens (quicker)
// Run it for both zones (#z1 and #z2) and at several window sizes, for example
// 1280x800, 1024x560, 800x725, 600x720 and 500x600.
//
// The tour drives the app through window.__baramger (dev hook) and by clicking the real
// buttons with element.click(). It needs the tab to be in front: a background tab gets no
// animation frames, so the map and the route flights would not run.

export async function tour({ planOnly = false } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const B = window.__baramger;
  if (!B) throw new Error("window.__baramger is missing: run the dev server (npm run dev)");
  const bad = [];
  const seen = [];
  const check = (name) => {
    seen.push(name);
    const o = B.overflowReport();
    if (o.length) bad.push(`${name} -> ${o.join(" ; ")}`);
  };
  const click = async (sel, wait = 60) => {
    const el = $(sel);
    if (!el) throw new Error(`the tour cannot find ${sel} (after "${seen[seen.length - 1]}")`);
    el.click();
    await sleep(wait);
  };
  const tab = (k) => click(`#panel [data-tab="${k}"]`);
  const closePop = async () => {
    $("#pop-close")?.click();
    await sleep(40);
  };
  // the control box on the map: open for the whole tour (every screen is checked with it open)
  const press = async (kind) => {
    const b = $(`#ctl [data-nudge="${kind}"]`);
    if (!b || b.disabled) return;
    b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 7 }));
    b.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7 }));
    await sleep(30);
  };
  const controls = async (name) => {
    if ($("#ctl-toggle")?.getAttribute("aria-expanded") !== "true") await click("#ctl-toggle");
    check(`${name} + controls`);
    for (const k of ["forward", "in", "turnRight", "tiltUp"]) await press(k);
    check(`${name} + controls, view moved`);
    if ($("#ctl-follow")) {
      const sel = $("#ctl-follow");
      const last = sel.options[sel.options.length - 1];
      sel.value = last.value; // the last astronaut: the close follow camera
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(60);
      check(`${name} + controls, following ${last.text}`);
      for (const k of ["in", "turnLeft", "tiltDown"]) await press(k); // around the astronaut: the follow goes on
      check(`${name} + controls, following ${last.text}, view turned`);
      sel.value = "-1"; // back to the whole crew
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(40);
    }
    if ($('#ctl [data-ctlspeed="1"]:not(:disabled)')) {
      await click('#ctl [data-ctlspeed="1"]', 40);
      await click('#ctl [data-ctlspeed="-1"]', 40);
      check(`${name} + controls, speed`);
    }
    await click('#ctl [data-nudge="follow"]', 80);
  };
  // ---- the Ask tab (mission assistant). Sample answers are put in by hand: no AI is called.
  // The longest answer the Worker lets through (900 characters), the longest question (300), many values.
  const askTour = async () => {
    const A = B.askUi;
    const keep = { items: A.items.slice(), idx: A.idx, busy: A.busy, draft: A.draft };
    await tab("ask");
    check("ask tab, examples");
    const words = "The route bends north of the direct line because the straight path crosses about 40 m of ground steeper than 25 degrees, which the safety rules forbid on foot.";
    const longText = `${words} ${words} ${words} ${words} ${words}`.slice(0, 900) + " …";
    const answer = (over) => ({
      ok: true, kind: "answer", text: longText, provider: "OpenRouter", model: "openai/gpt-oss-120b",
      sources: [{ id: "R1", name: "JPL Mars Trek" }, { id: "R2", name: "USGS" }, { id: "S4", name: "MEDA" }, { id: "S7", name: "NOAA" }, { id: "PLAN", name: "Your plan" }],
      facts: Array.from({ length: 14 }, (_, i) => ({ label: `Air at 14:00 (median, sols 1210–1218) ${i + 1}`, value: "−49 °C, and a long value that does not fit on one line", ref: i % 2 ? "S4" : "PLAN" })),
      tools: ["get_plan", "get_terrain_at"], skipped: [{ provider: "Gemini (Google)", why: "busy (rate limit)" }, { provider: "Groq", why: "too slow (timeout)" }], ms: 6400, ...over,
    });
    const longQ = "Why does the route go around the ridge between the habitat and the Cheyava Falls rock instead of going straight, and how much longer is it? ".repeat(3).slice(0, 300);
    A.items.length = 0;
    A.items.push({ q: longQ, res: answer({}) }, { q: longQ, res: null });
    A.idx = 1;
    A.busy = true;
    A.draft = "x".repeat(300);
    B.renderPanel();
    await sleep(40);
    check("ask tab, waiting for an answer, longest question typed");
    A.busy = false;
    A.items[1].res = answer({});
    B.renderPanel();
    await sleep(40);
    check("ask tab, longest answer after a fallback");
    { // a tall window shows all of it; otherwise it must be faded, with "Read all"
      const el = $("#ask-a");
      if (el.scrollHeight > el.clientHeight + 1 && !el.classList.contains("clipped")) bad.push("ask tab: the longest answer is cut without the fade");
    }
    // about 110 words must fit without the fade
    A.items[1].res = answer({ text: longText.slice(0, 640) });
    B.renderPanel();
    await sleep(40);
    if ($("#ask-a.clipped")) bad.push(`ask tab: a 640-character answer does not fit (${$("#ask-a").clientHeight} px for ${$("#ask-a").scrollHeight} px)`);
    A.items[1].res = answer({});
    B.renderPanel();
    await sleep(40);
    await click("#ask-more");
    check("ask pop-up, the longest answer");
    await click('#popup [data-askview="values"]');
    check("ask pop-up, values");
    while ($('#popup .pager button[data-dir="1"]:not(:disabled)')) {
      await click('#popup .pager button[data-dir="1"]', 50);
      check("ask pop-up, next page of values");
    }
    await closePop();
    await click('#panel [data-askpage="-1"]');
    check("ask tab, earlier question");
    A.items[1].res = { ok: false, error: "unavailable", message: "The assistant isn't available right now. Try again in a minute." };
    A.idx = 1;
    B.renderPanel();
    await sleep(40);
    check("ask tab, no answer");
    A.items[1].res = answer({ kind: "off_topic", text: "I can only help with this walk, this walk zone and its mission data.", sources: [], facts: [], skipped: [] });
    B.renderPanel();
    await sleep(40);
    check("ask tab, off topic");
    // no internet: the tab says so, the field and buttons are off
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    window.dispatchEvent(new Event("offline"));
    await sleep(40);
    check("ask tab, offline");
    if (!$("#panel .ask .note") || !$("#ask-q").disabled) bad.push("ask tab: no offline message, or the field is still on");
    delete navigator.onLine;
    window.dispatchEvent(new Event("online"));
    await sleep(40);
    Object.assign(A, { busy: keep.busy, draft: keep.draft, idx: keep.idx });
    A.items.length = 0;
    A.items.push(...keep.items);
    B.renderPanel();
    await sleep(20);
  };
  const until = async (test, ms = 15000) => {
    const t0 = Date.now();
    while (!test() && Date.now() - t0 < ms) await sleep(50);
    if (!test()) throw new Error(`the tour waited too long (after "${seen[seen.length - 1]}")`);
  };

  // ---- whole planet, then into the zone whose package is loaded
  if (B.state.view !== "globe") {
    B.toGlobe();
    await sleep(200);
  }
  check("globe panel");
  await controls("globe");
  // the two looks of the whole-planet map (height colours, natural colour), when the package has both
  const look = B.state.baseStyle; // the tour puts the crew's own choice back afterwards
  for (const b of [...document.querySelectorAll("#panel [data-base]")]) {
    await click(`#panel [data-base="${b.dataset.base}"]`);
    check(`globe panel, Mars colours: ${b.dataset.base}`);
  }
  if ($(`#panel [data-base="${look}"]`)) await click(`#panel [data-base="${look}"]`);
  B.enterZone(location.hash.replace("#", "") || "z2");
  await until(() => B.state.view === "site", 60000); // the zone waits for its height grids (loaded in the background)
  await sleep(300);

  // ---- plan: every tab and pop-up, before and after a route
  for (const k of ["goal", "layers", "stops", "route", "conditions", "safety", "ask"]) {
    await tab(k);
    check(`plan tab ${k} (no route)`);
  }
  await tab("layers");
  await click('#panel input[data-layer="geology"]', 80);
  check("layers with rock types on");
  await click('#panel input[data-layer="geology"]', 40);
  await click('#panel [data-dtab="sources"]');
  check("data pop-up: sources");
  while ($('#popup .pager button[data-dir="1"]:not(:disabled)')) {
    await click('#popup .pager button[data-dir="1"]', 50);
    check("data pop-up: sources, next page");
  }
  await click('#popup [data-dtab="checks"]');
  check("data pop-up: checks");
  while ($('#popup .pager button[data-dir="1"]:not(:disabled)')) {
    await click('#popup .pager button[data-dir="1"]', 50);
    check("data pop-up: checks, next page");
  }
  await click('#popup [data-dtab="values"]');
  check("data pop-up: values");
  while ($('#popup .pager button[data-dir="1"]:not(:disabled)')) {
    await click('#popup .pager button[data-dir="1"]', 50);
    check("data pop-up: values, next page");
  }
  await closePop();
  await tab("stops");
  for (const b of [...document.querySelectorAll("#panel [data-open]")]) {
    await click(`#panel [data-open="${b.dataset.open}"]`, 80);
    check(`stop pop-up ${b.dataset.open}`);
    await closePop();
  }
  await click("#find-route", 200);
  await until(() => !!B.state.plan);
  await sleep(200);
  check("route tab with route");
  await click("#open-legs");
  check("legs pop-up");
  await closePop();
  await tab("safety");
  check("safety tab with checks");
  for (const c of [...document.querySelectorAll("#panel [data-check]")]) {
    c.click();
    await sleep(30);
    check(`safety detail ${c.dataset.check}`);
  }
  await askTour();
  await tab("conditions");
  check("weather tab with route");
  await tab("stops");
  check("stops tab with route");
  await tab("goal");
  check("goal tab with route");

  if (planOnly) return { views: seen.length, bad }; // the plan screens only (a quicker check)

  // ---- walk-through
  await tab("route");
  await click("#walkthrough", 300);
  check("walk-through start");
  await controls("walk-through");
  {
    const slider = $("#ctl-time");
    slider.value = String(Math.round(Number(slider.max) / 3));
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(60);
    if (Math.abs(B.preview.D - Number(slider.value)) > 1) bad.push("walk-through: the time slider did not move the crew");
    check("walk-through, time slider moved");
    slider.value = "0";
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(40);
  }
  for (let i = 0; i < 400 && B.preview.stopIdx < 0; i++) B.step(0.25);
  B.renderPanel();
  await sleep(80);
  check("walk-through at a stop");
  await click("#pv-exit", 100);

  // ---- the walk: every tab, every stop, late warnings, photos, notes
  await click("#approve", 80);
  check("plan approved footer");
  await sleep(500); // the app ignores a click on the button that has just appeared (double-click guard)
  await click("#go-walk", 300);
  check("walk: now (walking)");
  await controls("walk");
  {
    const before = B.walkUi.w.clockMin;
    const slider = $("#ctl-time");
    slider.value = String(Math.round(before + 3));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(60);
    if (B.walkUi.w.clockMin < before + 2.9) bad.push("walk: the time slider did not run the walk forward");
    slider.value = String(Math.round(before - 30));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(60);
    if (B.walkUi.w.clockMin < before + 2.9) bad.push("walk: the time slider ran the walk back");
    check("walk: time slider");
  }
  await click('#panel [data-wtab="progress"]');
  check("walk: progress");
  await click('#panel [data-wtab="notes"]');
  check("walk: notes");
  const note = $("#w-note");
  note.value = "Dark spots also on the next boulder, same size as before";
  note.dispatchEvent(new Event("input", { bubbles: true }));
  await click("#w-pin");
  note.value = "Come back with the close-up camera";
  note.dispatchEvent(new Event("input", { bubbles: true }));
  await click("#w-idea");
  check("walk: notes with 2 notes");
  // five notes in all: the walk summary then needs its notes pager (the tightest case in zone Z1)
  for (const text of ["Loose sand on the east side", "Wind picked up for a minute", "Good spot for the next sample"]) {
    $("#w-note").value = text;
    $("#w-note").dispatchEvent(new Event("input", { bubbles: true }));
    await click("#w-pin");
  }
  check("walk: notes with 5 notes");
  await click('#panel [data-wtab="now"]');
  let guard = 0;
  const atStop = () => B.walkUi.w.phase === "at_stop";
  while (!atStop() && B.walkUi.w.phase !== "done" && guard++ < 60) {
    await click("#w-jump", 50);
    check(`walk: now after jump ${guard}`);
  }
  check("walk: at stop 1");
  let stopN = 0;
  while (B.walkUi.w.phase !== "done" && guard++ < 400) {
    if (atStop()) {
      stopN++;
      if (stopN === 2) {
        // stay much longer, so the "running late" and "walk limit" warnings show up
        for (let i = 0; i < 5; i++) $("#w-stay").click();
        await sleep(40);
        for (let j = 0; j < 80 && !/Running late|walk limit/.test($("#panel").innerText); j++) {
          B.walkUi.playing = true;
          B.step(1);
          B.renderPanel();
        }
        B.walkUi.playing = false;
        await sleep(40);
        check("walk: at stop, running late");
        if ($("#more-alerts")) {
          await click("#more-alerts", 50);
          check("warnings pop-up");
          await closePop();
        }
      }
      for (const box of document.querySelectorAll("#panel input[data-task]")) if (!box.checked) box.click();
      await sleep(30);
      check(`walk: at stop ${stopN}, tasks ticked`);
      const photo = $("#panel .photo");
      if (photo && stopN === 1) {
        photo.click();
        await sleep(150);
        check("photo viewer");
        await click("#lb-close");
      }
      await click("#w-leave", 40);
    } else {
      await click("#w-jump", 40);
      check(`walk: now (walking) ${guard}`);
    }
  }
  check("walk: summary");

  // ---- report, replay, back to the plan
  await click("#send-report", 100);
  const modal = $("#modal .modal-inner");
  if (modal && (modal.scrollHeight > modal.clientHeight + 1 || modal.getBoundingClientRect().bottom > innerHeight + 1)) bad.push("report window does not fit");
  seen.push("report window");
  await click("#modal-close");
  await click("#replay", 200);
  check("replay: what happened");
  await controls("replay");
  while ($('#panel .pager button[data-dir="1"]:not(:disabled)')) {
    await click('#panel .pager button[data-dir="1"]', 40);
    check("replay: what happened, next page");
  }
  await click('#panel [data-rtab="table"]');
  check("replay: plan and reality");
  await click("#w-back", 150);
  await tab("stops");
  check("plan after the walk: stops with ideas");
  if ($("#open-ideas")) {
    await click("#open-ideas");
    check("ideas pop-up");
    await closePop();
  }

  // ---- known places that are not stops any more
  for (let i = 0; i < 3; i++) {
    const remove = $("#panel [data-remove]");
    if (remove) {
      remove.click();
      await sleep(60);
    }
  }
  check("stops tab with 3 stops removed");
  if ($("#open-places")) {
    await click("#open-places");
    check("known places pop-up");
    const place = $("#popup [data-place-open]");
    if (place) {
      place.click();
      await sleep(80);
      check("place pop-up");
    }
    await closePop();
  }
  if ($("#ctl-toggle")?.getAttribute("aria-expanded") === "true") await click("#ctl-toggle"); // closed again, as at the start
  return { views: seen.length, bad };
}
