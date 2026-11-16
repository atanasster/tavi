import { createContext, Fragment, memo, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isKnownNavigation } from "@tavi/contracts";
import ReactMarkdown, { defaultUrlTransform, type Components, type Options, type UrlTransform } from "react-markdown";
import katex from "katex";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

import { useCopied } from "../hooks/page.js";
import { Confirm } from "./Confirm.js";
import { IconButton } from "./IconButton.js";
import { prefersReducedMotion } from "../lib/motion.js";

/**
 * How an answer's text is drawn: Markdown, the way the model writes it.
 *
 * - **GFM**: tables, task lists, strikethrough, autolinks; a single newline
 *   stays a line break, as the old `pre-wrap` paragraph kept it.
 * - **Math** in `$$…$$` through KaTeX, displayed when it is a paragraph of
 *   its own and inline in a sentence; a lone `$` is a price, not a formula,
 *   but a pair around a backslash command (`$\times 10$`) is one.
 * - **Code** highlighted by language, with a copy button.
 *
 * What it leaves out, and why: raw HTML in the text stays text (an answer
 * quotes pages, and a quoted `<script>` must not run in the canvas), but for a
 * bare `<br>` in a table cell, the one way GFM has to break a line there; Mermaid
 * draws with inline `<style>`, which the canvas CSP (`style-src 'self'`)
 * refuses, so a diagram is its source in a code block; and an image from
 * another host is a link, because `img-src` admits only the canvas itself.
 *
 * In a turn that read untrusted content (`tainted`), a link that is not one
 * the conversation holds exactly (`knownUrls`, compared as `disarmUrls` does)
 * names its real host beside its label (a `mailto:`, `xmpp:` or `irc:` link, its
 * scheme and target), and asks before it opens: text a page planted could
 * otherwise carry the conversation to its own host in a click. A yes covers
 * that exact address, not its host, so a later link there still asks.
 *
 * Loaded on its own (see `Markdown.tsx`): the parser, highlighter and KaTeX
 * are most of a megabyte the first paint does not need.
 */
export default function MarkdownBody({ text, tainted = false, knownUrls }: MarkdownProps) {
  const blocks = splitBlocks(text);
  const memory = useRef<BlockMemory>(null);
  memory.current ??= { blocks: [], prefixes: [], next: 0, slugs: new Map() };
  const prefixes = prefixVersions(memory.current, blocks);
  const slugs = memory.current.slugs;
  // Forget the headings of blocks that are gone, once what replaced them is on the page.
  useEffect(() => {
    const kept = new Set(blocks);
    for (const source of slugs.keys()) if (!kept.has(source)) slugs.delete(source);
  });
  // Read by the links alone (`MarkdownLink`), so a change re-parses no block; always provided, so the tree keeps its shape.
  const links = useMemo((): LinkPolicy | undefined => {
    if (!tainted) return undefined;
    return { known: new Set(knownUrls ?? []) };
  }, [tainted, knownUrls]);
  return (
    <LinkPolicyContext.Provider value={links}>
      <div className="markdown">
        {blocks.map((source, index) => (
          // One tree joins its top-level blocks with a newline; the blocks are joined the same way.
          <Fragment key={index}>
            {index > 0 ? "\n" : null}
            <MarkdownBlock source={source} blocks={blocks} index={index} prefix={prefixes[index] ?? 0} slugs={slugs} />
          </Fragment>
        ))}
      </div>
    </LinkPolicyContext.Provider>
  );
}

/** What the canvas hands the renderer for one answer. */
export type MarkdownProps = {
  readonly text: string;
  /** The turn read untrusted content: a novel link names its host and asks before it opens. */
  readonly tainted?: boolean | undefined;
  /** The URLs the tainted conversation holds (URL keys): a link to exactly one of them is not novel. */
  readonly knownUrls?: readonly string[] | undefined;
};

/** A tainted answer's known URLs; `undefined` in a clean one, where every link opens as written. */
type LinkPolicy = { readonly known: ReadonlySet<string> };
const LinkPolicyContext = createContext<LinkPolicy | undefined>(undefined);

/**
 * The exact addresses a person chose to open from a tainted turn on this page:
 * asked once each. Not once per host: a later link to a host already opened
 * can carry what the chat holds in its path or query, and asks again.
 */
const openedUrls = new Set<string>();

/** A novel link of a tainted answer: what its note and question name it by, and the address a yes opens. */
type NovelLink = { readonly label: string; readonly web: boolean; readonly url: string };

/**
 * A link a tainted answer holds that is novel — an http(s) URL on another
 * origin than the canvas's that is not known, named by its real host, or one in
 * any other scheme the renderer keeps (`mailto:`, `xmpp:`, `irc:`), named by its
 * scheme and target — or `undefined` for one that opens without asking.
 */
function novelLink(href: string, links: LinkPolicy | undefined): NovelLink | undefined {
  if (links === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { label: clipLabel(url.href, 80), web: false, url: url.href };
  if (url.origin === window.location.origin || isKnownNavigation(url.href, links.known)) return undefined;
  return { label: url.hostname, web: true, url: url.href };
}

/**
 * Whether a novel link's text already shows all its note would: a `mailto:`
 * whose text is its address (an autolinked email), so the note is dropped.
 */
function saysItsTarget(novel: NovelLink, children: ReactNode): boolean {
  if (novel.web || !novel.url.startsWith("mailto:")) return false;
  const text = childText(children).trim();
  let target: string;
  try {
    target = decodeURIComponent(novel.url.slice("mailto:".length));
  } catch {
    return false;
  }
  return text !== "" && text === target;
}

function childText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(childText).join("");
  return "";
}

function clipLabel(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** A link of an answer: a `#heading` scrolls within it, any other opens in a new tab — a novel one in a tainted turn after asking. */
function MarkdownLink({ href, children }: { readonly href?: string | undefined; readonly children?: ReactNode }) {
  const links = useContext(LinkPolicyContext);
  const [asking, setAsking] = useState(false);
  if (typeof href === "string" && href.startsWith("#")) {
    return (
      <a href={href} onClick={(event) => scrollToHeading(href, event)}>
        {children}
      </a>
    );
  }
  const novel = typeof href === "string" ? novelLink(href, links) : undefined;
  if (novel === undefined || href === undefined) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  const scheme = novel.url.slice(0, novel.url.indexOf(":"));
  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="markdown-link-novel"
        onClick={(event) => {
          if (openedUrls.has(novel.url)) return;
          event.preventDefault();
          setAsking(true);
        }}
        // A middle click opens a new tab without a `click`: it asks too.
        onAuxClick={(event) => {
          if (event.button !== 1 || openedUrls.has(novel.url)) return;
          event.preventDefault();
          setAsking(true);
        }}
      >
        {children}
      </a>
      {saysItsTarget(novel, children) ? null : <span className="markdown-link-host"> ({novel.label})</span>}
      {asking
        ? createPortal(
            <Confirm
              title={novel.web ? `Open ${novel.label}?` : `Open this ${scheme} link?`}
              message={
                novel.web
                  ? `Open ${novel.label} from a turn that read untrusted content? A page the turn read may have written this link to send what the chat holds to that site. It opens ${clipLabel(novel.url, 500)}`
                  : `Open ${clipLabel(novel.url, 500)} from a turn that read untrusted content? A page the turn read may have written this link to send what the chat holds through the app that opens it.`
              }
              action={novel.web ? `Open ${novel.label}` : `Open ${scheme} link`}
              onConfirm={async () => {
                openedUrls.add(novel.url);
                window.open(href, "_blank", "noopener,noreferrer");
              }}
              onClose={() => setAsking(false)}
            />,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * Splitting an answer into blocks, so a streamed delta re-parses only the
 * block it lands in. Each block is drawn by its own `<ReactMarkdown>`, and
 * the blocks sit directly in `.markdown`, so the page is the one tree the
 * whole text would make (`markdown-blocks.test.tsx` holds it to that).
 *
 * A block ends at a blank line followed by an unindented line that is not
 * a list item, outside any fence (``` ``` ```, `~~~`, `$$`). Text that a
 * block cannot parse alone is drawn in one pass: reference-style links and
 * footnotes, which resolve across the whole answer, and the HTML blocks
 * that run across blank lines.
 */
export function splitBlocks(text: string): readonly string[] {
  if (!/\n[ \t]*\n/.test(text) || WHOLE_ANSWER.test(text) || SPANNING_HTML.test(text)) return [text];
  const blocks: string[] = [];
  let start = 0;
  let content = false;
  let blank = false;
  let fence: Fence | undefined;
  /** The content column of the list the lines are in; `null` when a line may or may not have ended it. */
  let list: number | null | undefined;
  /** Whether the last line left a paragraph open, which an unindented line continues lazily; `null` when unsure. */
  let prose: boolean | null = false;
  for (let at = 0; at <= text.length; ) {
    const newline = text.indexOf("\n", at);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(at, end);
    const lineStart = at;
    at = end + 1;
    const empty = /^[ \t]*$/.test(line);
    const indent = columns(line);
    if (fence !== undefined) {
      if (empty) continue;
      if (indent >= fence.floor) {
        if (closes(line, indent, fence)) fence = undefined;
        continue;
      }
      // The list ended, and the fence inside its item with it.
      fence = undefined;
      list = undefined;
      prose = false;
    }
    if (empty) {
      blank = true;
      prose = false;
      continue;
    }
    const marker = listMarker(line);
    if (marker === undefined && indent === 0) {
      if (blank && content) {
        blocks.push(text.slice(start, lineStart));
        start = lineStart;
      }
      if (blank || BLOCK_START.test(line) || prose === false) list = undefined;
      else if (prose === null && list !== undefined) list = null;
    } else if (marker === undefined && blank && typeof list === "number" && indent < list) {
      list = undefined;
    }
    // A marker left of the list's content starts the next item at that level (or a new list); one at or right of it nests.
    if (marker !== undefined && (typeof list !== "number" || indent < list)) list = marker;
    const opened = opens(line, marker, list);
    if (opened === null) return [text];
    prose = paragraphAfter(line, opened !== undefined, blank || prose === null, indent - (typeof list === "number" ? list : 0));
    blank = false;
    content = true;
    fence = opened;
    if (fence !== undefined && fence.floor === 0) list = undefined;
  }
  blocks.push(text.slice(start));
  return blocks;
}

/** An open fence: its character and length, how far a closing line may be indented, and the indent below which a line ends it. */
type Fence = { readonly char: string; readonly size: number; readonly maxIndent: number; readonly floor: number };

/** Reference-style link definitions and footnotes resolve across the whole answer. */
const WHOLE_ANSWER = /^\s{0,3}\[[^\]]+\]:\s*\S|\[\^/m;
/** HTML blocks that end at a closing marker, not at a blank line (script, pre, style, textarea, comments, `<?`, `<!`). */
const SPANNING_HTML = /^[ \t>*+\-\d.)]*<(?:script|pre|style|textarea|!|\?)/im;
/** An unindented line that ends a list it follows without a blank line: a heading, quote or break (a fence, `opens`). */
const BLOCK_START = /^(?:#{1,6}(?:[ \t]|$)|>|(?:[-*_][ \t]*){3,}$)/;
/** A line's indentation and list markers. */
const CONTAINER_PREFIX = /^[ \t]*(?:(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$))*/;
/** A line that is not paragraph text: a heading or setext underline, or a break (a fence, `opens`). */
const NOT_PARAGRAPH = /^(?:#{1,6}(?:[ \t]|$)|(?:[-*_][ \t]*){3,}$|=+[ \t]*$)/;
const LIST_MARKER = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]*)/;
const FENCE_LINE = /^([ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)*)(`{3,}|~{3,}|\${2,})(.*)$/;

/**
 * Whether `line` leaves a paragraph open: not after a fence, heading, quote
 * or break, and unsure (`null`) for a line four past its container that may
 * be indented code (after a blank line, or after a line that may be code).
 */
function paragraphAfter(line: string, fence: boolean, mayBeCode: boolean, relative: number): boolean | null {
  if (fence) return false;
  const body = line.replace(CONTAINER_PREFIX, "");
  if (body.startsWith(">")) return null;
  if (NOT_PARAGRAPH.test(body)) return false;
  return mayBeCode && relative >= 4 ? null : true;
}

/** The column a line's text starts at, counting from `column`, tabs to the next multiple of four. */
function columns(line: string, column = 0): number {
  for (const char of line) {
    if (char === " ") column += 1;
    else if (char === "\t") column += 4 - (column % 4);
    else break;
  }
  return column;
}

/** The content column of a list item's first line, or `undefined` when the line is not one. */
function listMarker(line: string): number | undefined {
  const match = LIST_MARKER.exec(line);
  if (match === null) return undefined;
  const [whole, lead = "", marker = "", gap = ""] = match;
  const rest = line.slice(whole.length);
  if (gap === "" && rest !== "") return undefined;
  const before = columns(lead) + marker.length;
  const spaces = columns(gap, before) - before;
  // Five or more spaces after the marker is an indented block in the item; a bare marker takes one.
  return rest === "" || spaces > 4 ? before + 1 : before + spaces;
}

/**
 * The fence `line` opens, if it opens one where the document (not an
 * indented code block) would see it; `null` when that depends on whether a
 * list ended, which only a full parse knows.
 */
function opens(line: string, marker: number | undefined, list: number | null | undefined): Fence | null | undefined {
  const match = FENCE_LINE.exec(line);
  if (match === null) return undefined;
  const [, prefix = "", run = "", rest = ""] = match;
  const char = run.charAt(0);
  // A backtick fence's info has no backtick, and `$$x$$` on a line of its own is inline math.
  if ((char === "`" || char === "$") && rest.includes(char)) return undefined;
  const at = columns(prefix.replace(/[^\t]/g, " "));
  if (marker !== undefined) return { char, size: run.length, maxIndent: marker + 3, floor: marker };
  if (list === null && at > 0) return null;
  if (typeof list === "number" && at >= list) return { char, size: run.length, maxIndent: list + 3, floor: list };
  if (at <= 3) return { char, size: run.length, maxIndent: 3, floor: 0 };
  return undefined;
}

/** Whether `line` closes `fence`: the same character, at least as many, and nothing after. */
function closes(line: string, indent: number, fence: Fence): boolean {
  if (indent > fence.maxIndent) return false;
  const body = line.trim();
  return body.length >= fence.size && [...body].every((char) => char === fence.char);
}

/** The blocks the last render drew, the version of what came before each, and the heading slugs each block drew. */
type BlockMemory = {
  blocks: readonly string[];
  prefixes: readonly number[];
  next: number;
  readonly slugs: Map<string, readonly string[]>;
};

/**
 * For each block, a number that changes when any block before it changes:
 * the heading ids a block draws depend on the headings above it, so a block
 * whose own text is the same still redraws when its prefix moved.
 */
function prefixVersions(memory: BlockMemory, blocks: readonly string[]): readonly number[] {
  const versions: number[] = [];
  let same = true;
  for (const [index, source] of blocks.entries()) {
    const kept = same ? memory.prefixes[index] : undefined;
    if (kept !== undefined) versions.push(kept);
    else versions.push(memory.next++);
    same = same && memory.blocks[index] === source;
  }
  memory.blocks = blocks;
  memory.prefixes = versions;
  return versions;
}

type BlockProps = {
  readonly source: string;
  readonly blocks: readonly string[];
  readonly index: number;
  readonly prefix: number;
  readonly slugs: Map<string, readonly string[]>;
};

/**
 * One block of an answer, parsed and highlighted on its own, and again only
 * when its text or the blocks before it change. Math and highlighting run
 * only where the block has math or a fence.
 */
const MarkdownBlock = memo(
  function MarkdownBlock({ source, blocks, index, slugs }: BlockProps) {
    const math = source.includes("$$") || source.search(BACKSLASH_MATH) !== -1;
    const code = source.includes("```") || source.includes("~~~");
    let rehype = REHYPE[(math ? 2 : 0) + (code ? 1 : 0)] ?? [];
    if (HEADING_LIKE.test(source)) {
      const offsets = new Map<string, number>();
      for (const before of blocks.slice(0, index)) {
        for (const base of slugs.get(before) ?? []) offsets.set(base, (offsets.get(base) ?? 0) + 1);
      }
      const record = (bases: readonly string[]) => slugs.set(source, bases);
      rehype = [...rehype, [rehypeHeadingIds, { offsets, record }]];
    }
    return (
      <ReactMarkdown remarkPlugins={math ? REMARK_MATH : REMARK} rehypePlugins={rehype} components={components} urlTransform={urlTransform}>
        {source}
      </ReactMarkdown>
    );
  },
  (before, after) => before.source === after.source && before.prefix === after.prefix,
);

/** Exactly a `<br>`: an attribute, which a quoted page may carry, leaves it raw HTML. */
const BARE_BR = /^<br\s*\/?>$/i;

/** A bare `<br>` anywhere in a table cell is a line break; every other raw HTML node stays, to be drawn as text. */
function remarkCellBreaks() {
  const breakIn = (node: MdastNode): void => {
    if (node.type === "html" && BARE_BR.test(node.value ?? "")) node.type = "break";
    node.children?.forEach(breakIn);
  };
  const walk = (node: MdastNode): void => (node.type === "tableCell" ? breakIn(node) : node.children?.forEach(walk));
  return (tree: MdastNode): void => walk(tree);
}

/** A line that could be a heading: any `#`, or a setext underline. */
const HEADING_LIKE = /#|^[ \t>]*(?:=+|-+)[ \t]*$/m;

/**
 * `$…$` around a backslash command, which no price has. Neither `$` touches a
 * word or a number, so `$5 to C:\\temp at $6` stays text.
 */
const BACKSLASH_MATH = /(?<![\w$\\])\$(?=\S)([^$\n]*?\\[a-zA-Z][^$\n]*?)(?<=\S)\$(?![\w$])/g;

/** Whether KaTeX reads it: `$APPDATA\\npm$` is a path, whose `\\npm` it doesn't know. */
function isMath(math: string): boolean {
  try {
    katex.renderToString(math, { throwOnError: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Single-dollar math, which `remark-math` reads all or none of: only
 * `BACKSLASH_MATH` here, never in code, and never where a `\\$` (a `$` by now in
 * the node's text) asked for a dollar.
 */
function remarkBackslashMath() {
  const split = (node: MdastNode, source: string): MdastNode[] => {
    const value = node.value ?? "";
    if (source.slice(node.position?.start.offset, node.position?.end.offset).includes("\\$")) return [node];
    const nodes: MdastNode[] = [];
    let at = 0;
    for (const { 0: whole, 1: math = "", index } of value.matchAll(BACKSLASH_MATH)) {
      if (!isMath(math)) continue;
      if (index > at) nodes.push({ type: "text", value: value.slice(at, index) });
      nodes.push({
        type: "inlineMath",
        value: math,
        data: {
          hName: "code",
          hProperties: { className: ["language-math", "math-inline"] },
          hChildren: [{ type: "text", value: math }],
        },
      });
      at = index + whole.length;
    }
    if (at === 0) return [node];
    if (at < value.length) nodes.push({ type: "text", value: value.slice(at) });
    return nodes;
  };
  const walk = (node: MdastNode, source: string): void => {
    if (node.children === undefined) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return split(child, source);
      walk(child, source);
      return [child];
    });
  };
  return (tree: MdastNode, file: { readonly value: unknown }): void => walk(tree, String(file.value));
}

/** What the plugins here read of a Markdown tree. */
type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: Record<string, unknown>;
  position?: { readonly start: { readonly offset?: number }; readonly end: { readonly offset?: number } };
};

type PluggableList = NonNullable<Options["rehypePlugins"]>;
type Pluggable = PluggableList[number];

const REMARK: PluggableList = [remarkGfm, remarkBreaks, remarkCellBreaks];
const REMARK_MATH: PluggableList = [...REMARK, [remarkMath, { singleDollarTextMath: false }], remarkBackslashMath];
const HIGHLIGHT: Pluggable = [rehypeHighlight, { detect: false }];
const MATH: PluggableList = [
  rehypeLoneMathDisplay,
  [rehypeKatex, { throwOnError: false, errorColor: "hsl(var(--destructive))" }],
  rehypeFormulaFocus,
];
/** The rehype plugins by what a block holds: neither, code, math, both. */
const REHYPE: readonly PluggableList[] = [[], [HIGHLIGHT], MATH, [HIGHLIGHT, ...MATH]];

/** The default keeps only web and mail links; an inline raster image is what `img-src data:` admits. */
const urlTransform: UrlTransform = (url, key, node) =>
  key === "src" && node.tagName === "img" && /^data:image\/(?:png|jpe?g|gif|webp);/i.test(url) ? url : defaultUrlTransform(url);

/** A wide table or code block scrolls sideways, which a keyboard can do only from inside it. */
const KEYBOARD_SCROLLS = { tabIndex: 0 };

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  img: ({ src, alt }) => {
    if (typeof src !== "string" || src === "") return alt !== undefined && alt !== "" ? alt : null;
    if (src.startsWith("data:image/")) return <img src={src} alt={alt ?? ""} />;
    // The CSP would block it and leave a broken-image glyph; a link still gets there.
    return <MarkdownLink href={src}>{alt !== undefined && alt !== "" ? alt : src}</MarkdownLink>;
  },
  table: ({ children }) => (
    <div className="markdown-table" {...KEYBOARD_SCROLLS}>
      <table>{children}</table>
    </div>
  ),
};

/** A fenced block, scrolling sideways, with a copy button in its corner. */
function CodeBlock({ children }: { readonly children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null);
  const { copied, copy } = useCopied();
  return (
    <div className="markdown-code">
      <IconButton
        icon={copied ? "check" : "copy"}
        label="Copy code"
        tooltip={copied ? "Copied" : "Copy code"}
        size="sm"
        className="markdown-code-copy"
        onClick={() => copy(pre.current?.textContent ?? "")}
      />
      <pre ref={pre} {...KEYBOARD_SCROLLS}>
        {children}
      </pre>
    </div>
  );
}

/** A `#heading` link scrolls within its own answer, not the first match on the page. */
function scrollToHeading(href: string, event: MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
  let id = href.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // A malformed escape (`#50%-off`) is looked up as written.
  }
  if (id === "") return;
  const scope = event.currentTarget.closest(".markdown") ?? document;
  scope.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
}

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };

/**
 * GitHub-style ids on h1–h6, so a report's table of contents links work.
 * A block is numbered after the headings of the blocks before it (`offsets`),
 * as one tree of the whole answer would be, and reports its own (`record`).
 */
function rehypeHeadingIds(options?: {
  readonly offsets: ReadonlyMap<string, number>;
  readonly record: (bases: readonly string[]) => void;
}) {
  return (tree: HastNode) => {
    const seen = new Map(options?.offsets);
    const bases: string[] = [];
    const walk = (node: HastNode) => {
      if (node.type === "element" && /^h[1-6]$/.test(node.tagName ?? "") && node.properties?.["id"] === undefined) {
        const base = textOf(node)
          .trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
          .replace(/ /g, "-");
        if (base !== "") {
          const count = seen.get(base) ?? 0;
          seen.set(base, count + 1);
          bases.push(base);
          node.properties = { ...node.properties, id: count === 0 ? base : `${base}-${count}` };
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
    options?.record(bases);
  };
}

/** A displayed formula scrolls sideways, which a keyboard can do only from inside it. */
function rehypeFormulaFocus() {
  const walk = (node: HastNode): void => {
    const classes = node.properties?.["className"];
    if (Array.isArray(classes) && classes.includes("katex-display")) node.properties = { ...node.properties, tabIndex: 0 };
    node.children?.forEach(walk);
  };
  return walk;
}

/** `$$…$$` on a line of its own is a displayed equation, as the model meant, not inline math. */
function rehypeLoneMathDisplay() {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (node.type === "element" && node.tagName === "p") {
        const content = (node.children ?? []).filter((child) => !(child.type === "text" && (child.value ?? "").trim() === ""));
        const only = content.length === 1 ? content[0] : undefined;
        const classes = only?.properties?.["className"];
        if (only?.tagName === "code" && Array.isArray(classes) && classes.includes("math-inline")) {
          only.properties = { ...only.properties, className: classes.map((name) => (name === "math-inline" ? "math-display" : name)) };
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

function textOf(node: HastNode): string {
  return node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textOf).join("");
}
