/**
 * A page's HTML as the text a reader sees: `web_fetch` reads pages without
 * a browser, and sending a model the
 * raw markup — scripts, styles, attributes — cost it many times the words on
 * the page. The text keeps the headings, paragraphs, list items and table rows
 * as lines, each link's destination after its words, and the page's main
 * content when it marks one (`main`, `article`) that holds most of it.
 *
 * One pass over the markup, scanning forward only: a page of up to 8 MiB with
 * unclosed tags or comments takes as long as any other (no regular expression
 * here can backtrack over the page). Not a browser: no script runs, so what a
 * page renders with script is not here — the browser reads that.
 *
 * In contracts so a
 * plugin, which may not import runtime, reads a page as `web_fetch` does. With
 * `dropHidden`, what the page hides from a reader by its own markup — `hidden`,
 * `aria-hidden="true"`, an inline `display:none`, `visibility:hidden`,
 * `opacity:0`, `font-size:0`, or a colour equal to its background — is left
 * out of the text and returned apart, so a caller can say that something was
 * hidden (an instruction written for a model, not for the person).
 */

/** The WHATWG URL constructor, global in Node and browsers alike; this package declares no platform types. */
declare const URL: new (input: string, base?: string) => { readonly href: string };

/** Elements whose content is never text a reader sees. */
const SKIPPED = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "head", "object"]);
/** The site's chrome: left out when the page marks its main content, kept when it does not (a page's pagination, a byline). */
const CHROME = new Set(["nav", "footer"]);
/** Elements that start a new line. */
const BLOCKS = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "aside",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "tr",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "blockquote",
  "pre",
  "br",
  "hr",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
  "form",
  "fieldset",
  "legend",
  "label",
  "option",
  "nav",
  "footer",
  "address",
  "details",
  "summary",
  "caption",
]);
/** Elements with no content, so hiding one hides nothing to skip. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param"]);
/** The start tags that end an element whose end tag HTML lets a page leave out. */
const BLOCK_STARTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);
const IMPLIED_END_BY_START: Readonly<Record<string, ReadonlySet<string>>> = {
  li: new Set(["li"]),
  p: BLOCK_STARTS,
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  tr: new Set(["tr", "tbody", "tfoot"]),
  td: new Set(["td", "th", "tr", "tbody", "tfoot"]),
  th: new Set(["td", "th", "tr", "tbody", "tfoot"]),
  option: new Set(["option", "optgroup"]),
};
/** The end tags of the elements that hold one of those, which end it too. */
const IMPLIED_END_BY_CLOSE: Readonly<Record<string, ReadonlySet<string>>> = {
  li: new Set(["ul", "ol", "menu"]),
  p: new Set([
    "address",
    "article",
    "aside",
    "blockquote",
    "body",
    "dd",
    "details",
    "div",
    "fieldset",
    "figure",
    "footer",
    "form",
    "header",
    "li",
    "main",
    "nav",
    "section",
    "td",
    "th",
  ]),
  dt: new Set(["dl"]),
  dd: new Set(["dl"]),
  tr: new Set(["table", "tbody", "thead", "tfoot"]),
  td: new Set(["tr", "table", "tbody", "thead", "tfoot"]),
  th: new Set(["tr", "table", "tbody", "thead", "tfoot"]),
  option: new Set(["select", "optgroup", "datalist"]),
};

/** Elements that join their words with their neighbours'. */
const INLINE = new Set([
  "b",
  "i",
  "em",
  "strong",
  "span",
  "small",
  "sup",
  "sub",
  "u",
  "code",
  "abbr",
  "time",
  "mark",
  "bdi",
  "bdo",
  "s",
  "q",
  "cite",
  "kbd",
  "var",
  "wbr",
  "font",
  "a",
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  times: "×",
  rarr: "→",
  larr: "←",
  uarr: "↑",
  darr: "↓",
  deg: "°",
  plusmn: "±",
  frac12: "½",
  sect: "§",
  para: "¶",
};

/** `text` with its entities decoded; one it cannot decode (an unknown name, a number past Unicode) is kept as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]{1,8}|#\d{1,9}|[a-zA-Z][a-zA-Z0-9]{1,15});/g, (whole, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** A tag's attributes by lower-cased name, read past its name; a quoted value is skipped whole, so words inside it are never names. */
function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let index = tag.startsWith("/") ? 1 : 0;
  while (index < tag.length && !/[\s/>]/.test(tag[index] ?? "")) index += 1;
  while (index < tag.length) {
    while (index < tag.length && /[\s/]/.test(tag[index] ?? "")) index += 1;
    const nameStart = index;
    while (index < tag.length && !/[\s=/>]/.test(tag[index] ?? "")) index += 1;
    if (index === nameStart) {
      index += 1;
      continue;
    }
    const name = tag.slice(nameStart, index).toLowerCase();
    while (index < tag.length && /\s/.test(tag[index] ?? "")) index += 1;
    let value = "";
    if (tag[index] === "=") {
      index += 1;
      while (index < tag.length && /\s/.test(tag[index] ?? "")) index += 1;
      const quote = tag[index];
      if (quote === '"' || quote === "'") {
        const close = tag.indexOf(quote, index + 1);
        const valueEnd = close === -1 ? tag.length : close;
        value = tag.slice(index + 1, valueEnd);
        index = valueEnd + 1;
      } else {
        const valueStart = index;
        while (index < tag.length && !/[\s>]/.test(tag[index] ?? "")) index += 1;
        value = tag.slice(valueStart, index);
      }
    }
    if (!attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

/** An attribute's value in a tag's source: `href="x"`, `href='x'`, `href=x`. */
function attribute(tag: string, name: string): string | undefined {
  return attributesOf(tag).get(name);
}

/** One declaration's value in an inline style, lower-cased with its spaces removed. */
function declaration(style: string, property: string): string | undefined {
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon !== -1 && part.slice(0, colon).trim() === property)
      return part
        .slice(colon + 1)
        .replace(/!important/g, "")
        .replace(/\s+/g, "");
  }
  return undefined;
}

/** Whether an element's own markup hides it from a reader. */
function hidesItself(tag: string): boolean {
  const attributes = attributesOf(tag);
  if (attributes.has("hidden")) return true;
  if ((attributes.get("aria-hidden") ?? "").trim().toLowerCase() === "true") return true;
  const style = decodeEntities(attributes.get("style") ?? "").toLowerCase();
  if (style === "") return false;
  if (declaration(style, "display") === "none" || declaration(style, "visibility") === "hidden") return true;
  if (/^(0+(\.0*)?|\.0+)$/.test(declaration(style, "opacity") ?? "1")) return true;
  if (/^(0+(\.0*)?|\.0+)(px|em|rem|pt|%)?$/.test(declaration(style, "font-size") ?? "1")) return true;
  const color = declaration(style, "color");
  const background = declaration(style, "background-color") ?? declaration(style, "background");
  return color !== undefined && color !== "" && color === background;
}

export interface HtmlToTextOptions {
  /** Links are made absolute against it. */
  readonly base?: string;
  /** Leave out what the page's own markup hides, and return it as `hiddenText`. */
  readonly dropHidden?: boolean;
}

export interface HtmlText {
  readonly text: string;
  /** What `dropHidden` left out, as text; empty without it. */
  readonly hiddenText: string;
}

/** `html` as readable text: one block a line, links as `words (url)`, absolute against `base`. */
export function htmlToText(html: string, base?: string | HtmlToTextOptions): string {
  return htmlToTextDetailed(html, typeof base === "string" ? { base } : (base ?? {})).text;
}

/** `htmlToText`, with what `dropHidden` left out. */
export function htmlToTextDetailed(html: string, options: HtmlToTextOptions = {}): HtmlText {
  const { base, dropHidden = false } = options;
  const lower = html.toLowerCase();
  // Left out only when there is a main content to read instead.
  const marksMain = lower.includes("<main") || lower.includes("<article");
  const all: string[] = [];
  const main: string[] = [];
  let mainDepth = 0;
  const hidden: string[] = [];
  // The hidden element being skipped, and how deep its own name nests inside it.
  let hiding: { readonly name: string; depth: number } | undefined;
  let link: { readonly href: string; readonly start: number } | undefined;
  const emit = (piece: string): void => {
    if (hiding !== undefined) {
      hidden.push(piece);
      return;
    }
    all.push(piece);
    if (mainDepth > 0) main.push(piece);
  };
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    const textEnd = open === -1 ? html.length : open;
    if (textEnd > index) emit(decodeEntities(html.slice(index, textEnd)).replace(/\s+/g, " "));
    if (open === -1) break;
    // A comment, to its end; unclosed, the rest of the page.
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    // A `<` that never closes is text, as a browser reads it.
    if (close === -1) {
      emit(html.slice(open).replace(/\s+/g, " "));
      break;
    }
    const tag = html.slice(open + 1, close);
    const closing = tag.startsWith("/");
    let nameEnd = closing ? 1 : 0;
    while (nameEnd < tag.length && /[a-zA-Z0-9-]/.test(tag[nameEnd] ?? "")) nameEnd += 1;
    const name = tag.slice(closing ? 1 : 0, nameEnd).toLowerCase();
    index = close + 1;
    if (name === "") {
      // `<!doctype>`, `<?xml?>`, a stray `<`: nothing to read.
      if (!tag.startsWith("!") && !tag.startsWith("?")) emit(`<${tag}>`);
      continue;
    }
    if (!closing && (SKIPPED.has(name) || (marksMain && CHROME.has(name)))) {
      // Its content, to its own closing tag; unclosed, the rest of the page.
      const end = lower.indexOf(`</${name}`, index);
      // A template is markup the page never shows: what it holds is hidden text.
      if (dropHidden && name === "template")
        hidden.push("\n", htmlToTextDetailed(html.slice(index, end === -1 ? html.length : end)).text, "\n");
      if (end === -1) break;
      const after = html.indexOf(">", end);
      index = after === -1 ? html.length : after + 1;
      continue;
    }
    // An element whose end tag was left out ends where the next one starts, or where its parent ends;
    // that tag is then the page's own, read as any other.
    if (
      hiding !== undefined &&
      hiding.depth === 1 &&
      (closing ? IMPLIED_END_BY_CLOSE[hiding.name]?.has(name) : IMPLIED_END_BY_START[hiding.name]?.has(name)) === true
    )
      hiding = undefined;
    if (hiding !== undefined) {
      if (name === hiding.name && !tag.endsWith("/")) hiding.depth += closing ? -1 : 1;
      emit(BLOCKS.has(name) ? "\n" : " ");
      if (hiding.depth === 0) hiding = undefined;
      continue;
    }
    if (dropHidden && !closing && !VOID.has(name) && !tag.endsWith("/") && hidesItself(tag)) {
      hiding = { name, depth: 1 };
      emit("\n");
      continue;
    }
    if (name === "main" || name === "article") mainDepth = Math.max(0, mainDepth + (closing ? -1 : 1));
    if (name === "a") {
      if (!closing) {
        const href = attribute(tag, "href");
        link = href === undefined ? undefined : { href: decodeEntities(href), start: all.length };
      } else if (link !== undefined) {
        const words = all.slice(link.start).join("").trim();
        let target: string | undefined;
        try {
          target = new URL(link.href, base).href;
        } catch {
          target = undefined;
        }
        if (words !== "" && target !== undefined && /^https?:\/\//i.test(target)) emit(` (${target})`);
        link = undefined;
      }
      continue;
    }
    if (name === "li" && !closing) emit("\n- ");
    else if ((name === "td" || name === "th") && closing) emit(" | ");
    else if (BLOCKS.has(name)) emit("\n");
    else if (!INLINE.has(name)) emit(" ");
  }
  const tidy = (pieces: readonly string[]): string =>
    pieces
      .join("")
      .split("\n")
      .map((line) => line.replace(/[ \t ]+/g, " ").trim())
      .filter((line) => line !== "")
      .join("\n");
  const whole = tidy(all);
  const content = tidy(main);
  return { text: content.length >= whole.length / 4 && content !== "" ? content : whole, hiddenText: tidy(hidden) };
}
