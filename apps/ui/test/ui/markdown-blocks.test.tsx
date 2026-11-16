// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Markdown, markdownReady } from "../../src/ui/Markdown.js";
import { splitBlocks } from "../../src/ui/MarkdownBody.js";
import { mount } from "../support/dom.js";
import { prefixes, STATIC_FIXTURES, STREAMED_FIXTURES } from "./markdown-fixtures.js";

/**
 * An answer drawn block by block is the page the single pass drew. The
 * expected HTML (`markdown-blocks.html.json`) was captured from the
 * single-pass renderer before the split, for every fixture and for every
 * prefix of the streamed ones. KaTeX's own class names follow the pinned
 * katex (0.19 prefixed `base`, `strut` and `sizing` with `katex-`).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every `<ReactMarkdown>` render, by the text it parsed. */
const parsed = vi.hoisted(() => ({ sources: [] as string[] }));
vi.mock("react-markdown", async (original) => {
  const actual = await original<typeof import("react-markdown")>();
  const Counted = (options: Parameters<typeof actual.default>[0]) => {
    parsed.sources.push(typeof options.children === "string" ? options.children : "");
    return actual.default(options);
  };
  return { ...actual, default: Counted };
});

const expected = JSON.parse(readFileSync(`${import.meta.dirname}/markdown-blocks.html.json`, "utf8")) as {
  readonly static: Readonly<Record<string, string>>;
  readonly streamed: Readonly<Record<string, readonly string[]>>;
};

const roots: { root: Root; host: HTMLElement }[] = [];
afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

/** A root to render into again and again, as a stream does. */
function streamRoot(): { readonly host: HTMLElement; readonly render: (node: ReactNode) => Promise<void> } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push({ root, host });
  return { host, render: async (node) => act(async () => root.render(node)) };
}

describe("an answer drawn block by block", () => {
  beforeAll(() => markdownReady);

  it("has a captured page for every fixture", () => {
    expect(Object.keys(expected.static).sort()).toEqual(Object.keys(STATIC_FIXTURES).sort());
    for (const [name, text] of Object.entries(STREAMED_FIXTURES)) expect(expected.streamed[name]?.length, name).toBe(prefixes(text).length);
  });

  for (const [name, text] of Object.entries(STATIC_FIXTURES)) {
    it(`draws "${name}" as the single pass did`, async () => {
      const page = await mount(<Markdown text={text} />);
      expect(page.innerHTML).toBe(expected.static[name]);
    });
  }

  for (const [name, text] of Object.entries(STREAMED_FIXTURES)) {
    it(`draws "${name}" as the single pass did at every point of its stream`, async () => {
      const { host, render } = streamRoot();
      for (const [step, prefix] of prefixes(text).entries()) {
        await render(<Markdown text={prefix} />);
        expect(host.innerHTML, `after ${JSON.stringify(prefix)}`).toBe(expected.streamed[name]?.[step]);
      }
    });
  }

  it("splits where a block can stand alone, and nowhere a construct spans", () => {
    expect(splitBlocks("# A\n\npara\n\n- x\n\n- y\n\nend")).toEqual(["# A\n\n", "para\n\n- x\n\n- y\n\n", "end"]);
    expect(splitBlocks("```\na\n\nb\n```\n\nc")).toEqual(["```\na\n\nb\n```\n\n", "c"]);
    expect(splitBlocks("$$\na\n\nb\n$$\n\nc")).toEqual(["$$\na\n\nb\n$$\n\n", "c"]);
    expect(splitBlocks("```\nopen\n\nstill")).toEqual(["```\nopen\n\nstill"]);
    expect(splitBlocks("See [a][x].\n\n[x]: https://example.com")).toHaveLength(1);
    expect(splitBlocks("A[^1].\n\n[^1]: note")).toHaveLength(1);
    expect(splitBlocks("<!--\n\n-->\n\nb")).toHaveLength(1);
    expect(splitBlocks("\n\nlead\n\nnext")).toEqual(["\n\nlead\n\n", "next"]);
  });

  it("re-parses only the block a streamed delta lands in", async () => {
    const head = "# Report\n\n## Notes\n\n```ts\nconst a = 1;\n```\n\n## Notes\n\n";
    const { host, render } = streamRoot();
    await render(<Markdown text={`${head}tail`} />);
    parsed.sources.length = 0;
    await render(<Markdown text={`${head}tail grows`} />);
    expect(parsed.sources).toEqual(["tail grows"]);
    expect([...host.querySelectorAll("h2")].map((heading) => heading.id)).toEqual(["notes", "notes-1"]);
  });

  it("renumbers later headings when an earlier block changes", async () => {
    const { host, render } = streamRoot();
    await render(<Markdown text={"intro\n\n## Notes\n\nmore"} />);
    await render(<Markdown text={"## Notes\n\n## Notes\n\nmore"} />);
    expect([...host.querySelectorAll("h2")].map((heading) => heading.id)).toEqual(["notes", "notes-1"]);
    await render(<Markdown text={"## Other\n\n## Notes\n\nmore"} />);
    expect([...host.querySelectorAll("h2")].map((heading) => heading.id)).toEqual(["other", "notes"]);
  });
});
