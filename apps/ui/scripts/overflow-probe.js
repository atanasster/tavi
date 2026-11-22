// The overflow probe: run in a page (Playwright's `page.evaluate`, or pasted
// into a browser console), it lists each place where the page's own words do
// not fit. A longer language (Bulgarian, or the stretched `qps` pseudo-locale)
// shows what English hides:
//
// - `spill`: text wider or taller than its box, in a box that clips it or lets
//   it run out, where the box is not a scroll container of its own;
// - `cut`: an ellipsis or a line clamp that is actually cutting, on a label,
//   button, chip, tab, nav item or heading (cutting is meant only for a
//   person's own content: titles, prompts, file names, marked
//   `data-may-truncate`);
// - `wrapped`: a button, chip or tab on two lines where its design is one;
// - `overlap`: two sibling controls whose boxes cross;
// - `sideways`: the whole page scrolls sideways.
//
// It returns `[{ kind, text, selector, detail }]`, and reads nothing but the
// page. Hidden elements, text kept for screen readers only (a 1px box, or one
// parked off-screen like the skip link until it is focused), and elements
// inside one marked `data-probe-skip`, are not measured. A button laid out on
// several lines by design (a tile, a session row: its parts on lines of their
// own) is not "wrapped": only one run of its words broken across lines is.
(() => {
  const findings = [];
  const CONTROL = "button, [role=button], [role=tab], .chip, .badge, nav a, [role=menuitem], label, h1, h2, h3, h4, th";
  const MAY_TRUNCATE = "[data-may-truncate], .file-name, code, pre, input, textarea, select, [contenteditable]";

  const visible = (element) => {
    if (element.closest("[data-probe-skip], [hidden], [aria-hidden=true]")) return false;
    const box = element.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) return false;
    if (box.right <= 0 || box.bottom <= 0 || box.left >= window.innerWidth) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const ownText = (element) =>
    [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join("")
      .trim();
  const text = (element) => (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const selectorOf = (element) => {
    const parts = [];
    for (let at = element; at !== null && at !== document.body && parts.length < 4; at = at.parentElement) {
      const classes = [...at.classList].slice(0, 2).join(".");
      parts.unshift(`${at.tagName.toLowerCase()}${at.id === "" ? "" : `#${at.id}`}${classes === "" ? "" : `.${classes}`}`);
    }
    return parts.join(" > ");
  };
  const scrolls = (style) => /(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`);
  const add = (kind, element, detail) => findings.push({ kind, text: text(element), selector: selectorOf(element), detail });

  for (const element of document.body.querySelectorAll("*")) {
    if (!visible(element) || element.matches(MAY_TRUNCATE) || element.closest(MAY_TRUNCATE)) continue;
    const hasWords = /\p{L}{2}/u.test(ownText(element));
    if (!hasWords) continue;
    const style = getComputedStyle(element);
    const wide = element.scrollWidth > element.clientWidth + 1;
    const tall = element.scrollHeight > element.clientHeight + 1;
    const clamped = style.webkitLineClamp !== "none" && style.webkitLineClamp !== "" && style.webkitLineClamp !== undefined;
    const ellipsis = style.textOverflow === "ellipsis";
    if ((ellipsis && wide) || (clamped && tall)) {
      if (element.matches(CONTROL) || element.closest(CONTROL)) add("cut", element, ellipsis ? "ellipsis" : "line-clamp");
      continue;
    }
    if ((wide || tall) && !scrolls(style) && element.clientWidth > 0) {
      add("spill", element, `${element.scrollWidth}×${element.scrollHeight} in ${element.clientWidth}×${element.clientHeight}`);
    }
  }

  /** How many lines one text node's words fill: its line boxes, told apart by their tops. */
  const linesOf = (node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const tops = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)));
    return tops.size;
  };
  for (const control of document.body.querySelectorAll("button, [role=tab], .chip, .badge")) {
    if (!visible(control) || control.closest(MAY_TRUNCATE)) continue;
    const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
    let lines = 1;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (/\p{L}{2}/u.test(node.textContent ?? "")) lines = Math.max(lines, linesOf(node));
    }
    if (lines > 1) add("wrapped", control, `${lines} lines`);
  }

  for (const parent of document.body.querySelectorAll("*")) {
    const controls = [...parent.children].filter((child) => child.matches("button, a, .chip, .badge, label") && visible(child));
    for (let first = 0; first < controls.length; first += 1) {
      const a = controls[first].getBoundingClientRect();
      for (let second = first + 1; second < controls.length; second += 1) {
        const b = controls[second].getBoundingClientRect();
        const crossX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const crossY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (crossX > 2 && crossY > 2) add("overlap", controls[first], `with ${selectorOf(controls[second])}`);
      }
    }
  }

  if (document.documentElement.scrollWidth > window.innerWidth + 1) {
    // Named by the innermost elements that reach past the window's right edge: what pushes the page wider.
    const past = [...document.body.querySelectorAll("*")].filter(
      (element) => visible(element) && element.getBoundingClientRect().right > window.innerWidth + 1,
    );
    const innermost = past.filter((element) => !past.some((other) => other !== element && element.contains(other))).slice(0, 3);
    findings.push({
      kind: "sideways",
      text: innermost.map(text).join(" | "),
      selector: innermost.map(selectorOf).join(" ; ") || "html",
      detail: `${document.documentElement.scrollWidth} > ${window.innerWidth}`,
    });
  }
  return findings;
})();
