// Update a DOM subtree to match new HTML, keeping every node that stays the same.
//
// The panel used to be rebuilt with innerHTML several times a second while a walk played.
// That destroyed and re-created every button and photo under the pointer: hover and pressed
// states reset (flicker), clicks got lost, and photos blinked. morph() changes only the text
// and attributes that differ, so buttons, inputs and images keep their identity.

/** Make `target`'s children match `html`. Nodes are matched by position, tag, id and data-key. */
export function morph(target: Element, html: string): void {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  syncChildren(target, tpl.content);
}

function sameKind(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== Node.ELEMENT_NODE) return true;
  const x = a as Element;
  const y = b as Element;
  return x.tagName === y.tagName && x.id === y.id && x.getAttribute("data-key") === y.getAttribute("data-key");
}

function syncChildren(a: Node, b: Node): void {
  let ac = a.firstChild;
  let bc = b.firstChild;
  while (bc) {
    const bNext = bc.nextSibling;
    if (!ac) {
      a.appendChild(bc);
    } else if (sameKind(ac, bc)) {
      syncNode(ac, bc);
      ac = ac.nextSibling;
    } else {
      const aNext = ac.nextSibling;
      a.replaceChild(bc, ac);
      ac = aNext;
    }
    bc = bNext;
  }
  while (ac) {
    const next = ac.nextSibling;
    a.removeChild(ac);
    ac = next;
  }
}

function syncNode(a: Node, b: Node): void {
  if (a.nodeType !== Node.ELEMENT_NODE) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  const x = a as Element;
  const y = b as Element;
  // data-keep: other code owns this node while it is on screen (the chart's hover line), so a
  // redraw must not reset it.
  if (x.hasAttribute("data-keep") && y.hasAttribute("data-keep")) return;
  for (const attr of Array.from(x.attributes)) if (!y.hasAttribute(attr.name)) x.removeAttribute(attr.name);
  for (const attr of Array.from(y.attributes)) if (x.getAttribute(attr.name) !== attr.value) x.setAttribute(attr.name, attr.value);

  // Form controls: the attribute is only the starting value, so sync the live value too,
  // but never while the user is typing in or dragging that control.
  const live = document.activeElement === x;
  if (x instanceof HTMLInputElement) {
    if (x.type === "checkbox" || x.type === "radio") {
      const checked = y.hasAttribute("checked");
      if (x.checked !== checked) x.checked = checked;
    } else if (!live) {
      const v = y.getAttribute("value") ?? "";
      if (x.value !== v) x.value = v;
    }
    return;
  }
  if (x instanceof HTMLTextAreaElement) {
    const v = (y as HTMLTextAreaElement).value;
    if (!live && x.value !== v) x.value = v;
    return;
  }
  syncChildren(x, y);
  if (x instanceof HTMLSelectElement && !live) {
    const sel = y.querySelector("option[selected]") as HTMLOptionElement | null;
    if (sel && x.value !== sel.value) x.value = sel.value;
  }
}
