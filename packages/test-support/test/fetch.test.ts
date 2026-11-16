import { describe, expect, it } from "vitest";

import { fakeFetch } from "../src/index.js";

describe("fakeFetch", () => {
  it("answers each call with the URL as a string, however it was asked for, and the init it was given", async () => {
    const seen: { readonly url: string; readonly method: string | undefined }[] = [];
    const fetch = fakeFetch((url, init) => {
      seen.push({ url, method: init?.method });
      return new Response(url);
    });
    expect(await (await fetch("https://a.test/x")).text()).toBe("https://a.test/x");
    await fetch(new URL("https://a.test/y"), { method: "POST" });
    await fetch(new Request("https://a.test/z"));
    expect(seen).toEqual([
      { url: "https://a.test/x", method: undefined },
      { url: "https://a.test/y", method: "POST" },
      { url: "https://a.test/z", method: undefined },
    ]);
  });
});
