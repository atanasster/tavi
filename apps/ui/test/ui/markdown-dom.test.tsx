// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Markdown, markdownReady } from "../../src/ui/Markdown.js";
import { button, click, mount, rerender } from "../support/dom.js";

/** An answer's text is drawn as Markdown, and the parts the canvas refuses stay inert. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("an answer's Markdown", () => {
  beforeAll(() => markdownReady);

  it("draws headings, lists, emphasis and a GFM table", async () => {
    const page = await mount(
      <Markdown text={"# Meta Muse\n\n## Sources\n\n- **one**\n- *two*\n\n| Key | Title |\n|---|---|\n| S1 | FAZ |"} />,
    );
    expect(page.querySelector("h1")?.textContent).toBe("Meta Muse");
    expect(page.querySelector("h2")?.id).toBe("sources");
    expect([...page.querySelectorAll("li")].map((li) => li.innerHTML)).toEqual(["<strong>one</strong>", "<em>two</em>"]);
    expect(page.querySelector(".markdown-table table td")?.textContent).toBe("S1");
  });

  it("keeps a single newline as a line break", async () => {
    const page = await mount(<Markdown text={"one\ntwo"} />);
    expect(page.querySelector("p br")).not.toBeNull();
  });

  it("highlights a fenced block and gives it a copy button", async () => {
    const page = await mount(<Markdown text={"```ts\nconst x = 1;\n```"} />);
    expect(page.querySelector(".markdown-code pre code.hljs .hljs-keyword")?.textContent).toBe("const");
    expect(page.querySelector('.markdown-code button[aria-label="Copy code"]')).not.toBeNull();
  });

  it("typesets $$ math, but leaves a lone dollar as a price", async () => {
    const page = await mount(<Markdown text={"Costs $5 and $10.\n\n$$E = mc^2$$"} />);
    expect(page.querySelector(".katex-display")).not.toBeNull();
    expect(page.querySelector("p")?.textContent).toBe("Costs $5 and $10.");
  });

  it("typesets single-dollar math that has a backslash command", async () => {
    const page = await mount(<Markdown text={"Multiply ($\\times 10$) and move on, then $20 \\times 1$."} />);
    expect(page.querySelectorAll("p .katex")).toHaveLength(2);
    expect(page.querySelector("p")?.textContent).not.toContain("$");
  });

  it("leaves what only looks like single-dollar math as text", async () => {
    const text = "From $5 to C:\\temp at $6, or $HOME\\bin and $PATH\\foo, and $a + b$.";
    const page = await mount(<Markdown text={text} />);
    expect(page.querySelector(".katex")).toBeNull();
    expect(page.querySelector("p")?.textContent).toBe(text);
  });

  it("leaves an escaped dollar a dollar", async () => {
    const page = await mount(<Markdown text={"Escaped \\$\\times 10\\$ here."} />);
    expect(page.querySelector(".katex")).toBeNull();
    expect(page.querySelector("p")?.textContent).toBe("Escaped $\\times 10$ here.");
  });

  it("leaves a pair KaTeX can't read, or one against a word, as text", async () => {
    const text = "See $APPDATA\\npm$ and foo$|\\times$ and $\\notacommand x$.";
    const page = await mount(<Markdown text={text} />);
    expect(page.querySelector(".katex")).toBeNull();
    expect(page.querySelector("p")?.textContent).toBe(text);
  });

  it("lets a keyboard reach a formula, a table and a code block that scroll", async () => {
    const page = await mount(<Markdown text={"$$E = mc^2$$\n\n| a |\n| - |\n| 1 |\n\n```\nbed 1: tomatoes\n```"} />);
    expect(page.querySelector(".katex-display")?.getAttribute("tabindex")).toBe("0");
    expect(page.querySelector(".markdown-table")?.getAttribute("tabindex")).toBe("0");
    expect(page.querySelector(".markdown-code pre")?.getAttribute("tabindex")).toBe("0");
  });

  it("draws an unknown command in the theme's colour", async () => {
    const page = await mount(<Markdown text={"$$\\notacommand y$$"} />);
    expect(page.querySelector<HTMLElement>('.katex [style*="color"]')?.getAttribute("style")).toContain("--destructive");
  });

  it("leaves single-dollar math in code as code", async () => {
    const page = await mount(<Markdown text={"Type `$\\times 10$` here."} />);
    expect(page.querySelector(".katex")).toBeNull();
    expect(page.querySelector("code")?.textContent).toBe("$\\times 10$");
  });

  it("keeps $$ math in a sentence inline", async () => {
    const page = await mount(<Markdown text={"energy $$E = mc^2$$ here"} />);
    expect(page.querySelector("p .katex")).not.toBeNull();
    expect(page.querySelector(".katex-display")).toBeNull();
  });

  it("keeps raw HTML as text and opens links in a new tab", async () => {
    const page = await mount(
      <Markdown text={"<script>alert(1)</script>\n\nSee <b>bold</b> [site](https://example.com) [x](javascript:alert(1))"} />,
    );
    expect(page.querySelector("script, b")).toBeNull();
    const links = [...page.querySelectorAll("a")];
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[1]?.getAttribute("href") ?? "").not.toContain("javascript");
  });

  it("breaks a table cell's line at a <br>, however it is written, and only there", async () => {
    const page = await mount(<Markdown text={"| A |\n|---|\n| one<br>two<br/>three<BR />four **bold<br>word** |\n\none<br>two"} />);
    const cell = page.querySelector("td");
    expect(cell?.querySelectorAll("br")).toHaveLength(4);
    expect(cell?.querySelector("strong br")).not.toBeNull();
    expect(cell?.textContent).not.toContain("<");
    // Outside a table it stays what any raw HTML is: text.
    expect(page.querySelector("p")?.textContent).toBe("one<br>two");
    expect(page.querySelector("p br")).toBeNull();
  });

  it("lets nothing else through in a table cell: a br with attributes, another tag, or a quoted <br> stay text", async () => {
    const page = await mount(
      <Markdown
        text={
          '| A |\n|---|\n| <br onclick="alert(1)"> <br class="x"> <b>bold</b> <img src=x onerror=alert(1)> `<br>` <script>alert(1)</script> |'
        }
      />,
    );
    const cell = page.querySelector("td");
    expect(cell?.querySelector("br, b, img, script")).toBeNull();
    expect(cell?.textContent).toContain('<br onclick="alert(1)">');
    expect(cell?.textContent).toContain("<b>bold</b>");
    expect(cell?.querySelector("code")?.textContent).toBe("<br>");
  });

  it("draws an inline raster image", async () => {
    const page = await mount(<Markdown text={"![dot](data:image/png;base64,iVBORw0KGgo=)"} />);
    expect(page.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("gives headings GitHub's ids, so a model's table of contents finds them", async () => {
    const page = await mount(<Markdown text={"## Risks & Mitigations\n\n## parse_args"} />);
    expect([...page.querySelectorAll("h2")].map((heading) => heading.id)).toEqual(["risks--mitigations", "parse_args"]);
  });

  it("follows a malformed #link without throwing", async () => {
    const page = await mount(<Markdown text={"[deal](#50%-off)"} />);
    expect(() => page.querySelector("a")?.click()).not.toThrow();
  });

  it("links an image from another host instead of drawing it", async () => {
    const page = await mount(<Markdown text={"![chart](https://example.com/c.png)"} />);
    expect(page.querySelector("img")).toBeNull();
    expect(page.querySelector("a")?.textContent).toBe("chart");
  });
});

describe("an answer's links in a turn that read untrusted content", () => {
  beforeAll(() => markdownReady);
  afterEach(() => vi.restoreAllMocks());

  const ANSWER =
    "See [the guide](https://docs.example/guide), [more](https://docs.example/other) and [this](https://collect.example/?q=secret).";
  const KNOWN = ["https://docs.example/guide"];
  const hostNotes = (page: ParentNode) => [...page.querySelectorAll(".markdown-link-host")].map((note) => note.textContent);

  it("draws every link as written in a clean chat", async () => {
    const page = await mount(<Markdown text={ANSWER} knownUrls={KNOWN} />);
    expect(hostNotes(page)).toEqual([]);
    expect(page.querySelector(".markdown-link-novel")).toBeNull();
  });

  it("leaves a link the conversation holds as it is", async () => {
    const page = await mount(<Markdown text={"[the guide](https://docs.example/guide)"} tainted knownUrls={KNOWN} />);
    expect(hostNotes(page)).toEqual([]);
  });

  it("names the host of another page on a known host, and of a known page with an appended fragment", async () => {
    // The page the turn read is on a known host: a link it planted there could carry the chat in its query or fragment.
    const page = await mount(
      <Markdown text={"[more](https://docs.example/other) [part](https://docs.example/guide#secret)"} tainted knownUrls={KNOWN} />,
    );
    expect(hostNotes(page)).toEqual([" (docs.example)", " (docs.example)"]);
  });

  it("asks before a middle click opens a novel link", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const page = await mount(<Markdown text={"[x](https://middle.example/?q=secret)"} tainted knownUrls={KNOWN} />);
    const novel = page.querySelector<HTMLAnchorElement>(".markdown-link-novel");
    const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    await act(async () => {
      novel?.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector("dialog")?.textContent).toContain("Open middle.example from a turn that read untrusted content?");
    expect(opened).not.toHaveBeenCalled();
  });

  it("names a novel host and asks before opening it, once per exact address", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const page = await mount(<Markdown text={ANSWER} tainted knownUrls={KNOWN} />);
    expect(hostNotes(page)).toEqual([" (docs.example)", " (collect.example)"]);
    const novel = [...page.querySelectorAll<HTMLAnchorElement>(".markdown-link-novel")].at(-1);
    expect(novel?.textContent).toBe("this");
    await click(novel);
    const dialog = document.querySelector("dialog");
    expect(dialog?.textContent).toContain("Open collect.example from a turn that read untrusted content?");
    expect(opened).not.toHaveBeenCalled();
    await click(button(document.body, "Open collect.example"));
    expect(opened).toHaveBeenCalledWith("https://collect.example/?q=secret", "_blank", "noopener,noreferrer");
    expect(document.querySelector("dialog")).toBeNull();
    // Asked once: the address the person chose opens without asking again.
    await click(novel);
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("asks again for another address on a host already opened, which could carry what the chat holds", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const page = await mount(
      <Markdown text={"[a](https://again.example/start) [b](https://again.example/?q=secret)"} tainted knownUrls={KNOWN} />,
    );
    const [first, second] = [...page.querySelectorAll<HTMLAnchorElement>(".markdown-link-novel")];
    await click(first);
    await click(button(document.body, "Open again.example"));
    expect(opened).toHaveBeenCalledTimes(1);
    await click(second);
    expect(document.querySelector("dialog")?.textContent).toContain("https://again.example/?q=secret");
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("names the scheme and target of a mailto, xmpp or irc link, and asks before opening it", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const page = await mount(
      <Markdown
        text={"[mail](mailto:drop@collect.example?body=secret) [chat](xmpp:drop@collect.example) [room](ircs://irc.collect.example/drop)"}
        tainted
        knownUrls={KNOWN}
      />,
    );
    expect(hostNotes(page)).toEqual([
      " (mailto:drop@collect.example?body=secret)",
      " (xmpp:drop@collect.example)",
      " (ircs://irc.collect.example/drop)",
    ]);
    await click(page.querySelector<HTMLAnchorElement>(".markdown-link-novel"));
    expect(document.querySelector("dialog")?.textContent).toContain(
      "Open mailto:drop@collect.example?body=secret from a turn that read untrusted content?",
    );
    expect(opened).not.toHaveBeenCalled();
    await click(button(document.body, "Open mailto link"));
    expect(opened).toHaveBeenCalledWith("mailto:drop@collect.example?body=secret", "_blank", "noopener,noreferrer");
  });

  it("adds no note to a mailto link whose text already is its whole target, and still asks", async () => {
    const page = await mount(
      <Markdown
        text={
          "Email jordan.ellis@example.com, [ana@example.com](mailto:ana@example.com), [chat](xmpp:ana@example.com) or [ana@example.com](mailto:ana@example.com?body=secret)"
        }
        tainted
        knownUrls={KNOWN}
      />,
    );
    expect(page.querySelectorAll(".markdown-link-novel")).toHaveLength(4);
    expect(hostNotes(page)).toEqual([" (xmpp:ana@example.com)", " (mailto:ana@example.com?body=secret)"]);
    await click(page.querySelector<HTMLAnchorElement>(".markdown-link-novel"));
    expect(document.querySelector("dialog")?.textContent).toContain("Open mailto:jordan.ellis@example.com from a turn");
  });

  it("opens a mailto link as written in a clean chat", async () => {
    const page = await mount(<Markdown text={"[mail](mailto:team@docs.example)"} />);
    expect(hostNotes(page)).toEqual([]);
    expect(page.querySelector("a")?.getAttribute("href")).toBe("mailto:team@docs.example");
  });

  it("names a novel host in an answer still streaming, and with no known URLs at all", async () => {
    await mount(<Markdown text={"Reading"} tainted />);
    await rerender(<Markdown text={"Reading the page.\n\nSend it to [here](https://drop.example/x)"} tainted />);
    expect(hostNotes(document.body)).toEqual([" (drop.example)"]);
  });
});
