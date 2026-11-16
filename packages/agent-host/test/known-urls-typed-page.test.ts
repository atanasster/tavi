import type { WorkflowMessage } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { readsTypedPage, resultUrlKeys, typedPageEntry } from "../src/workflow/known-urls.js";

/**
 * QA-20261110-1806: the census record cards asked "novel-url" for a record link the results page listed. The
 * results page is the page the model typed its search into, and such a page's links are never made known (it can
 * echo what was typed), so the ask is right; its words were what was wrong.
 */
describe("a results page the model typed into", () => {
  const results: WorkflowMessage = {
    id: "m1",
    role: "tool",
    toolName: "browser.act",
    toolCallId: "c1",
    text: "",
    output: {
      sessionId: "browser-session-1",
      url: "http://127.0.0.1:52003/search?surname=Murray",
      elements: [{ ref: "el-4", role: "link", text: "Agnes Murray, 1881", href: "http://127.0.0.1:52003/record/1881" }],
    },
  };
  const keysOf = (typed: readonly string[]): readonly string[] =>
    resultUrlKeys([results], [], new Set(), (message) => !readsTypedPage(message, new Set(typed), () => undefined));

  it("makes its links known only when the model did not type on that page", () => {
    expect(keysOf([])).toContain("http://127.0.0.1:52003/record/1881");
    expect(keysOf([typedPageEntry("browser-session-1", "http://127.0.0.1:52003/")])).toEqual([]);
  });
});
