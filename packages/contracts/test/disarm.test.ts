import { knownUrlSet, navigationKeyOf } from "../src/index.js";
import { describe, expect, it } from "vitest";

import { disarmUrls } from "../src/url-text.js";

// Moved with `disarmUrls` from the heartbeat's `disarmAddresses` (packages/agent-host/test/heartbeat-host.test.ts).
describe("disarmUrls", () => {
  it.each([
    ["https://x_secret.evil.example/", "x_secret[.]evil[.]example"],
    ["http://1.2.3.4/?q=1", "hxxp[:]//1[.]2[.]3[.]4/?q=1"],
    ["see 10.0.0.7:8080/x", "10[.]0[.]0[.]7:8080/x"],
    ["https://[::1]/a", "hxxps[:]//[::1]/a"],
    ["https://пример.рф/путь", "пример[.]рф"],
    ["mailto:me@evil.example", "evil[.]example"],
    ["EVIL.EXAMPLE/X", "EVIL[.]EXAMPLE/X"],
    ["Due soon...evil.example/?q=SECRET", "evil[.]example/?q=SECRET"],
    ["see -evil.example/x", "evil[.]example/x"],
    ["x...1.2.3.4/x", "1[.]2[.]3[.]4/x"],
    ["evil。example/x", "evil[.]example/x"],
    ["see evil.भारत/x", "evil[.]भारत/x"],
    ["उदाहरण.भारत/x", "उदाहरण[.]भारत/x"],
  ])("disarms %s", (text, disarmed) => {
    expect(disarmUrls(text, new Set())).toContain(disarmed);
  });

  it("keeps a known URL however the model wrote it, and leaves times and versions alone", () => {
    expect(disarmUrls("now at https://EXAMPLE.com", knownUrlSet(["https://example.com/"]))).toBe("now at https://EXAMPLE.com");
    expect(disarmUrls("at 10.30, v1.2.3", new Set())).toBe("at 10.30, v1.2.3");
    // A Japanese or Chinese sentence's full stop is not a domain's dot.
    expect(disarmUrls("会議は明日です。よろしく。支払い．完了", new Set())).toBe("会議は明日です。よろしく。支払い．完了");
  });

  it("keeps only an exact known URL: an extended path or query, a bare host, or another scheme is disarmed", () => {
    const known = knownUrlSet(["https://docs.example/guide?a=1"]);
    expect(disarmUrls("read https://docs.example/guide?a=1.", known)).toBe("read https://docs.example/guide?a=1.");
    // A fragment the model appended to a known link is read by the page's script: defanged.
    expect(disarmUrls("read https://docs.example/guide?a=1#part", known)).toBe("read hxxps[:]//docs[.]example/guide?a=1#part");
    expect(disarmUrls("https://docs.example/guide?a=1&leak=x", known)).toBe("hxxps[:]//docs[.]example/guide?a=1&leak=x");
    expect(disarmUrls("https://docs.example/guide/more", known)).toBe("hxxps[:]//docs[.]example/guide/more");
    expect(disarmUrls("docs.example/guide?a=1", known)).toBe("docs[.]example/guide?a=1");
    expect(disarmUrls("http://docs.example/guide?a=1", known)).toBe("hxxp[:]//docs[.]example/guide?a=1");
  });

  it("keeps a link with a fragment only when the conversation held that exact fragment", () => {
    const known = new Set([...knownUrlSet(["https://docs.example/guide"]), navigationKeyOf("https://docs.example/guide#part") ?? ""]);
    expect(disarmUrls("see https://docs.example/guide#part.", known)).toBe("see https://docs.example/guide#part.");
    expect(disarmUrls("see https://docs.example/guide#other", known)).toBe("see hxxps[:]//docs[.]example/guide#other");
  });

  it("ends a URL where known-URL extraction does: balanced brackets kept, an unbalanced one trimmed", () => {
    const known = knownUrlSet(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    expect(disarmUrls("(see https://en.wikipedia.org/wiki/Foo_(bar)).", known)).toBe("(see https://en.wikipedia.org/wiki/Foo_(bar)).");
    expect(disarmUrls("[docs](https://en.wikipedia.org/wiki/Foo_(bar))", known)).toBe("[docs](https://en.wikipedia.org/wiki/Foo_(bar))");
    expect(disarmUrls("(see https://evil.example/x_(y))", known)).toBe("(see hxxps[:]//evil[.]example/x_(y))");
  });
});
