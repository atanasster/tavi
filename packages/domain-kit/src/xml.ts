import { decodeEntities } from "@tavi/contracts";

/**
 * A small XML reader for feeds and sitemaps (jobs: Personio's XML, Workday's
 * `siteMap.xml`; trends: RSS, Atom and arXiv's answers), shared by the domain
 * plugins so none bundles an XML dependency. One pass,
 * forward only, no regular expression over the document: a malformed or
 * hostile feed takes as long as any other of its size. Not a validator: an
 * unmatched closing tag closes up to the nearest element of its name, and
 * one with none open is ignored.
 */
export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: XmlElement[];
  /** The element's own text, CDATA included, entities decoded; its children's text is theirs. */
  text: string;
}

/** The most elements one document may hold; past it reading stops with an error. */
export const XML_MAX_ELEMENTS = 200_000;
/** The most tags, opening and closing, one document may hold. */
const XML_MAX_TAGS = 2 * XML_MAX_ELEMENTS;

/** Where the tag opened at `open` ends: its `>`, a `>` inside a quoted value not counted; -1 when it never does. */
function tagEnd(xml: string, open: number): number {
  let quote: string | undefined;
  for (let index = open + 1; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return -1;
}

const isNameChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}_:.-]/u.test(char);
const isSpace = (char: string | undefined): boolean => char === " " || char === "\t" || char === "\n" || char === "\r";

function attributesOf(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let index = 0;
  while (index < source.length) {
    while (isSpace(source[index]) || source[index] === "/") index += 1;
    const start = index;
    while (isNameChar(source[index])) index += 1;
    if (index === start) {
      index += 1;
      continue;
    }
    const name = source.slice(start, index);
    while (isSpace(source[index])) index += 1;
    if (source[index] !== "=") continue;
    index += 1;
    while (isSpace(source[index])) index += 1;
    const quote = source[index];
    if (quote !== '"' && quote !== "'") continue;
    const end = source.indexOf(quote, index + 1);
    const valueEnd = end === -1 ? source.length : end;
    if (!(name in attributes)) attributes[name] = decodeEntities(source.slice(index + 1, valueEnd));
    index = valueEnd + 1;
  }
  return attributes;
}

/** The document as a tree under a `#document` root. */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "#document", attributes: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  // How many of each name are open: a close with none open is ignored at once, without a search.
  const open = new Map<string, number>();
  let elements = 0;
  let tags = 0;
  let index = 0;
  const current = (): XmlElement => stack.at(-1) ?? root;
  while (index < xml.length) {
    const start = xml.indexOf("<", index);
    const textEnd = start === -1 ? xml.length : start;
    if (textEnd > index) current().text += decodeEntities(xml.slice(index, textEnd));
    if (start === -1) break;
    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      index = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      const end = xml.indexOf("]]>", start + 9);
      current().text += xml.slice(start + 9, end === -1 ? xml.length : end);
      index = end === -1 ? xml.length : end + 3;
      continue;
    }
    // A doctype's internal subset holds `>`s of its own: it ends at `]>`.
    if (xml.startsWith("<!DOCTYPE", start)) {
      const bracket = xml.indexOf("[", start);
      const plain = xml.indexOf(">", start);
      const end = bracket !== -1 && (plain === -1 || bracket < plain) ? xml.indexOf("]>", bracket) : plain;
      index = end === -1 ? xml.length : end + (bracket !== -1 && (plain === -1 || bracket < plain) ? 2 : 1);
      continue;
    }
    const close = tagEnd(xml, start);
    if (close === -1) break;
    const tag = xml.slice(start + 1, close);
    index = close + 1;
    // A declaration or a processing instruction: nothing to read.
    if (tag.startsWith("?") || tag.startsWith("!")) continue;
    tags += 1;
    if (tags > XML_MAX_TAGS) throw new Error(`the document has more than ${String(XML_MAX_TAGS)} tags`);
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if ((open.get(name) ?? 0) === 0) continue;
      // Each element popped is gone for good, so every close together costs at most the elements opened.
      for (let popped = stack.pop(); popped !== undefined && popped !== root; popped = stack.pop()) {
        open.set(popped.name, (open.get(popped.name) ?? 1) - 1);
        if (popped.name === name) break;
      }
      continue;
    }
    let nameEnd = 0;
    while (isNameChar(tag[nameEnd])) nameEnd += 1;
    if (nameEnd === 0) {
      current().text += decodeEntities(`<${tag}>`);
      continue;
    }
    elements += 1;
    if (elements > XML_MAX_ELEMENTS) throw new Error(`the document has more than ${String(XML_MAX_ELEMENTS)} elements`);
    const selfClosing = tag.endsWith("/");
    const element: XmlElement = {
      name: tag.slice(0, nameEnd),
      attributes: attributesOf(tag.slice(nameEnd, selfClosing ? -1 : undefined)),
      children: [],
      text: "",
    };
    current().children.push(element);
    if (!selfClosing) {
      stack.push(element);
      open.set(element.name, (open.get(element.name) ?? 0) + 1);
    }
  }
  return root;
}

/** The first child named `name`, ignoring a namespace prefix on either side. */
export function childOf(element: XmlElement | undefined, name: string): XmlElement | undefined {
  return element?.children.find((child) => localName(child.name) === localName(name));
}

/** Every child named `name`. */
export function childrenOf(element: XmlElement | undefined, name: string): XmlElement[] {
  return element?.children.filter((child) => localName(child.name) === localName(name)) ?? [];
}

/** The trimmed text of the first child named `name`, or of `element` itself. */
export function textOf(element: XmlElement | undefined, name?: string): string | undefined {
  const target = name === undefined ? element : childOf(element, name);
  const text = target?.text.trim();
  return text === undefined || text === "" ? undefined : text;
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}
