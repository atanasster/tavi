import { describe, expect, it } from "vitest";

import { isLoopbackHostname } from "../src/index.js";

describe("isLoopbackHostname", () => {
  it("takes all of 127.0.0.0/8, ::1, localhost, and the IPv4-mapped forms URL writes", () => {
    for (const host of ["127.0.0.1", "127.255.0.9", "localhost", "LOCALHOST", "[::1]", "::1", "[::ffff:127.0.0.1]"])
      expect(isLoopbackHostname(host), host).toBe(true);
    // URL turns the mapped dotted form into hex groups.
    expect(isLoopbackHostname(new URL("http://[::ffff:127.0.0.1]/").hostname)).toBe(true);
    expect(isLoopbackHostname(new URL("http://[::ffff:127.9.9.9]/").hostname)).toBe(true);
  });

  it("refuses every other host, a mapped one outside 127/8 too", () => {
    for (const host of ["128.0.0.1", "10.0.0.1", "example.com", "localhost.example", "[::2]", "::ffff:10.0.0.1"])
      expect(isLoopbackHostname(host), host).toBe(false);
    expect(isLoopbackHostname(new URL("http://[::ffff:10.0.0.1]/").hostname)).toBe(false);
  });
});
