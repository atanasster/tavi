/**
 * Answers whose drawn Markdown must not change when the renderer splits text
 * into blocks (`MarkdownBody.tsx`): every construct that can run across a
 * blank line, and every one that numbers or links across the whole answer.
 * `markdown-blocks.html.json` holds what the single-pass renderer drew for
 * each of them, captured before the split.
 */
export const STATIC_FIXTURES: Readonly<Record<string, string>> = {
  empty: "",
  "one paragraph": "Just one line.",
  "headings, lists and a table":
    "# Meta Muse\n\n## Sources\n\n- **one**\n- *two*\n\n| Key | Title |\n|---|---|\n| S1 | FAZ |\n\nAfter the table.",
  "duplicate headings": "## Notes\n\npara\n\n## Notes\n\n## Notes\n\n# Notes\n\nNotes\n-----\n\n## Other",
  "headings with markup": "## `code` *em*\n\ntext\n\n## code em\n\n## Risks & Mitigations\n\n## Risks & Mitigations",
  "a table of contents": "- [Notes](#notes)\n- [Again](#notes-1)\n\n## Notes\n\nfirst\n\n## Notes\n\nsecond",
  "reference links":
    "See [the docs][d] and [more].\n\nAnother paragraph.\n\n[d]: https://example.com/docs\n[more]: https://example.com/more",
  footnotes: "A claim[^1] and another[^note].\n\nMiddle paragraph.\n\n[^1]: The source.\n[^note]: A second source.",
  "loose bullet list": "- one\n\n- two\n\n  continued\n\n- three\n\nAfter the list.",
  "loose ordered list": "1. first\n\n2. second\n\n3. third\n\n4) other kind",
  "list after a paragraph": "Intro:\n- a\n- b\n\n- c\n\nend",
  "list with a fenced block": "- item\n\n  ```js\n  let a;\n\n  let b;\n  ```\n\n- next\n\nafter",
  "item fence closed by the item's end": "- ```\n  code\n\nPara\n\n```\nx\n\ny\n```\n\nafter",
  "nested list fences": "1. Step\n   ```bash\n   run\n\n   more\n   ```\n   - sub\n     ```\n     a\n\n     b\n     ```\n\nDone\n\n2. Next",
  "fence after a heading after a list": "- a\n# H\n  ```\nx\n\ny\n  ```\n\nz",
  "lazy math line, then an item's fence": "- x\nlazy\n$$E$$\n  ```\nz\n\n  ```\n$$E$$\n\nafter",
  "paragraph after an item's fence, then an indented fence": "1. x\n- a\n- ```\n\tcode\n  ```\npara\n  ```\n- a\n\nb\n\nc",
  "new list, then an indented fence": "- a\n1. x\n     deep\n   cont\n  ```\n2) y\n\npara\n  ```\n\nend",
  "empty list item": "-\n\n  foo\n\nbar",
  "indented code": "Intro\n\n    line one\n\n    line two\n\n\n    line three\n\nAfter",
  "tab-indented code": "para\n\n\tcode\n\n\tmore",
  "fence with blank lines": "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter the code.",
  "tilde fence holding backticks": "~~~~\n```\n\n~~~\n\n~~~~\n\nparagraph",
  "longer fence not closed by a shorter one": "````\na\n\n```\n\nb\n````\n\nc",
  "indented closing fence": "```\nx\n\n   ```\n\ny",
  "top-level indented fence": "  ```\nfoo\n\nbar\n  ```\n\nafter",
  "quoted fence": "> ```\n> a\n\n> b\n> ```\n\nc\n\n```\nd\n\ne\n```",
  "indented code holding a fence": "para\n\n    ```\n\n```\ncode\n\nx\n```\n\nend",
  "unclosed fence": "Text\n\n```py\nx = 1\n\n\ny = 2\n",
  "backtick in a fence's info": "```js`x\n\npara",
  "math block with blank lines": "$$\na = b\n\nc = d\n$$\n\ntext $$x$$ inline\n\n$$E = mc^2$$",
  "math fence closed by a longer run": "$$\na\n\n$$$\n\nb",
  "math meta with a dollar": "$$x$$\n\n$$\ny\n$$\n\nafter",
  "prices without math": "Costs $5\n\nand $10.",
  "separate block quotes": "> a\n\n> b\n\nc",
  "html comment over blank lines": "<!--\n\nhidden\n\n-->\n\npara",
  "script over blank lines": "<script>\n\nalert(1)\n\n</script>\n\nafter",
  "breaks and setext": "Title\n=====\n\npara\n\n---\n\nSub\n---\n\n***",
  "leading and trailing blank lines": "\n\npara one\n\n\n\npara two\n\n",
  "gfm extras": "- [ ] todo\n- [x] done\n\n~~old~~ www.example.com\n\nline\nbreak",
  "images and raw html":
    "![dot](data:image/png;base64,iVBORw0KGgo=)\n\n![chart](https://example.com/c.png)\n\nSee <b>bold</b> [x](javascript:alert(1))",
  "a report": [
    "# Report",
    "",
    "## Summary",
    "",
    "Short summary with `code` and **bold**.",
    "",
    "## Details",
    "",
    "1. Step one",
    "2. Step two",
    "",
    "```bash",
    "echo hello",
    "",
    "echo world",
    "```",
    "",
    "## Summary",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "$$\\sum_i x_i$$",
    "",
    "> Quoted",
    "",
    "## Details",
  ].join("\n"),
};

/**
 * Answers drawn as they stream in: every prefix `STREAM_STEP` characters
 * apart (and the whole) must draw as the single pass drew it, including a
 * fence that spans blocks while it is still open.
 */
export const STREAMED_FIXTURES: Readonly<Record<string, string>> = {
  "a fence across blocks": "Intro paragraph.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n## Notes\n\nDone.\n\n## Notes",
  "a fence in a list": "Steps:\n\n1. Run\n   ```sh\n   a\n\n   b\n   ```\n2. Then\n\nDone.",
  "a list and math": "- one\n\n- two\n\n$$\nx\n\ny\n$$\n\n~~~\n~~~\n\nend `x`",
};

const STREAM_STEP = 3;

/** The prefixes of `text` a stream would show: every `STREAM_STEP` characters, then the whole. */
export function prefixes(text: string): string[] {
  const out: string[] = [];
  for (let end = STREAM_STEP; end < text.length; end += STREAM_STEP) out.push(text.slice(0, end));
  out.push(text);
  return out;
}
