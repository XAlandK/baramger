// @vitest-environment jsdom
// morph() is the fix for the flickering walk buttons: the panel is redrawn several times a
// second, and morph() must change only what differs, so buttons, photos and inputs stay the
// same DOM nodes (hover, focus and clicks survive).
import { beforeEach, describe, expect, it } from "vitest";
import { morph } from "../src/morph";

let host: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
});

describe("morph: nodes that stay the same are kept", () => {
  it("keeps a button when only its text changes", () => {
    morph(host, `<p>08:45</p><button id="w-play" class="primary">Play</button>`);
    const button = host.querySelector("#w-play")!;
    const clock = host.querySelector("p")!;
    morph(host, `<p>08:46</p><button id="w-play" class="primary">Pause</button>`);
    expect(host.querySelector("#w-play")).toBe(button);
    expect(host.querySelector("p")).toBe(clock);
    expect(button.textContent).toBe("Pause");
    expect(clock.textContent).toBe("08:46");
  });

  it("keeps a click listener that was added to a kept node", () => {
    morph(host, `<button id="go">Go</button>`);
    let clicks = 0;
    host.querySelector("#go")!.addEventListener("click", () => clicks++);
    morph(host, `<button id="go" class="on">Go now</button>`);
    (host.querySelector("#go") as HTMLButtonElement).click();
    expect(clicks).toBe(1);
  });

  it("keeps photos (same data-key) while the text around them changes", () => {
    const strip = (label: string) => `<div class="strip"><figure data-key="a"><img src="a.jpg" alt="a"></figure><figure data-key="b"><img src="b.jpg" alt="b"></figure></div><p>${label}</p>`;
    morph(host, strip("1 of 30 min"));
    const images = [...host.querySelectorAll("img")];
    morph(host, strip("2 of 30 min"));
    expect([...host.querySelectorAll("img")]).toEqual(images);
    expect(host.querySelector("p")!.textContent).toBe("2 of 30 min");
  });

  it("does nothing at all when the HTML is the same", () => {
    const html = `<ul><li class="a">one</li><li>two</li></ul>`;
    morph(host, html);
    let changes = 0;
    const observer = new MutationObserver((list) => (changes += list.length));
    observer.observe(host, { childList: true, subtree: true, attributes: true, characterData: true });
    morph(host, html);
    changes += observer.takeRecords().length;
    observer.disconnect();
    expect(changes).toBe(0);
  });
});

describe("morph: what differs is changed", () => {
  it("adds, changes and removes attributes", () => {
    morph(host, `<button id="b" class="on" disabled title="old">x</button>`);
    morph(host, `<button id="b" class="off" aria-pressed="true">x</button>`);
    const b = host.querySelector("#b") as HTMLButtonElement;
    expect(b.className).toBe("off");
    expect(b.disabled).toBe(false);
    expect(b.hasAttribute("title")).toBe(false);
    expect(b.getAttribute("aria-pressed")).toBe("true");
  });

  it("adds new nodes at the end and removes nodes that are gone", () => {
    morph(host, `<li>a</li><li>b</li>`);
    morph(host, `<li>a</li><li>b</li><li>c</li>`);
    expect(host.children.length).toBe(3);
    morph(host, `<li>a</li>`);
    expect(host.children.length).toBe(1);
    expect(host.textContent).toBe("a");
  });

  it("replaces a node when the tag, the id or the data-key is different", () => {
    morph(host, `<button id="w-skip">Skip next stop</button><section data-key="nav">walking</section><p>x</p>`);
    const [skip, section, para] = [...host.children];
    morph(host, `<button id="w-stay">Stay 10 more</button><section data-key="at-stop-1">at stop</section><div>x</div>`);
    expect(host.children[0]).not.toBe(skip); // another button must not inherit the old one's state
    expect(host.children[1]).not.toBe(section);
    expect(host.children[2]).not.toBe(para);
    expect(host.children[0].id).toBe("w-stay");
    expect(host.children[2].tagName).toBe("DIV");
  });

  it("makes the whole subtree match, however deep", () => {
    morph(host, `<div class="card"><h2>Next</h2><p><b>1.21 km</b> · about 30 min</p></div>`);
    morph(host, `<div class="card"><h2>At stop 1</h2><p><b>0 m</b> · arrived</p><small>new</small></div>`);
    expect(host.innerHTML).toBe(`<div class="card"><h2>At stop 1</h2><p><b>0 m</b> · arrived</p><small>new</small></div>`);
  });
});

describe("morph: form controls", () => {
  it("makes a checkbox follow the HTML, also after the user clicked it", () => {
    morph(host, `<input type="checkbox" data-task="photos">`);
    const box = host.querySelector("input")!;
    box.checked = true; // the user ticked it; the app has not stored it
    morph(host, `<input type="checkbox" data-task="photos">`);
    expect(box.checked).toBe(false);
    morph(host, `<input type="checkbox" data-task="photos" checked>`);
    expect(host.querySelector("input")).toBe(box);
    expect(box.checked).toBe(true);
  });

  it("updates a text field that the user is not typing in", () => {
    morph(host, `<input type="text" id="stop-name" value="New stop 1">`);
    morph(host, `<input type="text" id="stop-name" value="Delta edge">`);
    expect((host.querySelector("#stop-name") as HTMLInputElement).value).toBe("Delta edge");
  });

  it("never overwrites the field the user is typing in", () => {
    morph(host, `<input type="text" id="w-note" value="">`);
    const field = host.querySelector("#w-note") as HTMLInputElement;
    field.focus();
    field.value = "Loose sand near the rid"; // typing; the next redraw comes with an older value
    morph(host, `<input type="text" id="w-note" value="Loose sand">`);
    expect(host.querySelector("#w-note")).toBe(field);
    expect(field.value).toBe("Loose sand near the rid");
    expect(document.activeElement).toBe(field);
  });

  it("keeps the text of a textarea while it has the focus, and updates it otherwise", () => {
    morph(host, `<textarea id="stop-note">old</textarea>`);
    const area = host.querySelector("textarea")!;
    morph(host, `<textarea id="stop-note">new</textarea>`);
    expect(area.value).toBe("new");
    area.focus();
    area.value = "typing";
    morph(host, `<textarea id="stop-note">newer</textarea>`);
    expect(area.value).toBe("typing");
  });

  it("selects the option the HTML marks as selected", () => {
    morph(host, `<select id="z"><option value="z1" selected>Z1</option><option value="z2">Z2</option></select>`);
    const select = host.querySelector("select")!;
    expect(select.value).toBe("z1");
    morph(host, `<select id="z"><option value="z1">Z1</option><option value="z2" selected>Z2</option></select>`);
    expect(host.querySelector("select")).toBe(select);
    expect(select.value).toBe("z2");
  });
});

describe("morph: inline SVG (charts, arrows)", () => {
  const arrow = (deg: number) => `<svg class="arrow" viewBox="0 0 40 40"><g transform="rotate(${deg} 20 20)"><path d="M20 4 L31 30 L20 24 L9 30 Z"></path></g></svg>`;

  it("creates real SVG elements and turns the arrow in place", () => {
    morph(host, arrow(99));
    const path = host.querySelector("path")!;
    expect(path.namespaceURI).toBe("http://www.w3.org/2000/svg");
    morph(host, arrow(113));
    expect(host.querySelector("path")).toBe(path);
    expect(host.querySelector("g")!.getAttribute("transform")).toBe("rotate(113 20 20)");
  });
});

describe("morph: nodes owned by other code (data-keep)", () => {
  it("leaves the chart's hover line where the mouse put it", () => {
    const chart = (walked: number) => `<svg viewBox="0 0 100 40"><path d="M0 ${walked} L100 20"></path><line class="c-xh" data-keep x1="0" x2="0" visibility="hidden"></line></svg>`;
    morph(host, chart(10));
    const line = host.querySelector(".c-xh")!;
    line.setAttribute("x1", "42"); // the hover code moves and shows the line
    line.setAttribute("x2", "42");
    line.setAttribute("visibility", "visible");
    morph(host, chart(12)); // the next redraw, 200 ms later
    expect(host.querySelector(".c-xh")).toBe(line);
    expect(line.getAttribute("x1")).toBe("42");
    expect(line.getAttribute("visibility")).toBe("visible");
    expect(host.querySelector("path")!.getAttribute("d")).toBe("M0 12 L100 20"); // the rest still follows
  });
});
