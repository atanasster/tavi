import { describe, expect, it } from "vitest";

import {
  decideRequest,
  dialedHost,
  granted,
  egressDenyLists,
  hostProcessConfig,
  hostProcessEventOf,
  injectsAt,
  neverDialed,
  privateRefused,
  resolvesInward,
  streamHolds,
  type ArmedCredential,
  type HostProcessRequest,
} from "../src/egress.js";

/** The proxy's request policy, on parsed requests. */

const token: ArmedCredential = { env: "GH_TOKEN", hosts: ["api.github.com"], sentinel: "fake_value_1111" };
const key: ArmedCredential = {
  env: "ACME_KEY",
  hosts: ["api.acme.test"],
  header: "x-api-key",
  sentinel: "fake_value_2222",
  methods: ["GET"],
  pathPrefixes: ["/v1/"],
};

const request = (url: string, headers: Record<string, string> = {}, init: { method?: string; body?: string } = {}) =>
  new Request(url, { method: init.method ?? "GET", headers, ...(init.body === undefined ? {} : { body: init.body }) });

describe("decideRequest", () => {
  it("lets the placeholder through in its own header toward its host, and names it", async () => {
    expect(await decideRequest(request("https://api.github.com/user", { authorization: "Bearer fake_value_1111" }), [token, key])).toEqual({
      action: "allow",
      injected: ["GH_TOKEN"],
    });
  });

  it("refuses a credential header of the command's own toward an inject host (bring your own key)", async () => {
    expect(await decideRequest(request("https://api.github.com/user", { authorization: "Bearer ghp_real" }), [token])).toMatchObject({
      action: "deny",
      reason: expect.stringContaining("not a key of the command's own"),
    });
    expect(
      await decideRequest(request("https://api.github.com/user", { authorization: "Bearer fake_value_1111", "x-api-key": "other" }), [
        token,
      ]),
    ).toMatchObject({ action: "deny" });
  });

  it("refuses the placeholder in the URL, another header or the body toward its host", async () => {
    expect(await decideRequest(request("https://api.github.com/search?q=fake_value_1111"), [token])).toMatchObject({
      action: "deny",
      reason: expect.stringContaining("URL"),
    });
    expect(await decideRequest(request("https://api.github.com/", { "x-echo": "fake_value_1111" }), [token])).toMatchObject({
      action: "deny",
      reason: expect.stringContaining("x-echo"),
    });
    expect(
      await decideRequest(
        request(
          "https://api.github.com/gists",
          { authorization: "Bearer fake_value_1111" },
          { method: "POST", body: '{"note":"fake_value_1111"}' },
        ),
        [token],
      ),
    ).toMatchObject({ action: "deny", reason: expect.stringContaining("body") });
  });

  it("holds a credential's methods and path prefixes", async () => {
    expect(await decideRequest(request("https://api.acme.test:8443/v1/items", { "x-api-key": "fake_value_2222" }), [key])).toEqual({
      action: "allow",
      injected: ["ACME_KEY"],
    });
    expect(
      await decideRequest(request("https://api.acme.test:8443/v1/items", { "x-api-key": "fake_value_2222" }, { method: "DELETE" }), [key]),
    ).toMatchObject({ action: "deny" });
    expect(await decideRequest(request("https://api.acme.test:8443/admin", { "x-api-key": "fake_value_2222" }), [key])).toMatchObject({
      action: "deny",
    });
  });

  it("refuses an encoded separator or a dot segment in the path of a credential with path prefixes", async () => {
    for (const path of ["/v1/..%2fadmin", "/v1/%2e%2e%2fadmin", "/v1/items%5c..%5cadmin", "/v1/a%2Fb", "/v1/%252e%252e/admin", "/v1/%zz"]) {
      expect(
        await decideRequest(request(`https://api.acme.test:8443${path}`, { "x-api-key": "fake_value_2222" }), [key]),
        path,
      ).toMatchObject({ action: "deny" });
    }
    // A credential without path prefixes is not judged by its path.
    expect(await decideRequest(request("https://api.github.com/a%2Fb", { authorization: "Bearer fake_value_1111" }), [token])).toEqual({
      action: "allow",
      injected: ["GH_TOKEN"],
    });
  });

  it("refuses a GET, HEAD or OPTIONS that declares a body toward a credential's host, which srt forwards substituted but never shows the check", async () => {
    expect(
      await decideRequest(request("https://api.github.com/user", { authorization: "Bearer fake_value_1111", "content-length": "15" }), [
        token,
      ]),
    ).toMatchObject({ action: "deny", reason: expect.stringContaining("with a body") });
    expect(
      await decideRequest(
        request(
          "https://api.github.com/user",
          { authorization: "Bearer fake_value_1111", "transfer-encoding": "chunked" },
          { method: "OPTIONS" },
        ),
        [token],
      ),
    ).toMatchObject({ action: "deny" });
    expect(await decideRequest(request("https://example.org/", { "content-length": "15" }), [token])).toEqual({
      action: "allow",
      injected: [],
    });
  });

  it("names no credential over plain HTTP, where srt puts none in", async () => {
    expect(await decideRequest(request("http://api.github.com/user", { authorization: "Bearer fake_value_1111" }), [token])).toEqual({
      action: "allow",
      injected: [],
    });
  });

  it("lets anything through to a host no credential names: placeholders go out as placeholders", async () => {
    expect(
      await decideRequest(request("https://example.org/?t=fake_value_1111", { authorization: "Bearer fake_value_1111" }), [token]),
    ).toEqual({ action: "allow", injected: [] });
  });
});

describe("the helpers", () => {
  it("finds a needle split across chunks", async () => {
    const chunks = ["abc fake_va", "lue_1", "111 xyz"].map((chunk) => new TextEncoder().encode(chunk));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    expect(await streamHolds(stream, ["fake_value_1111"])).toBe(true);
    expect(await streamHolds(null, ["x"])).toBe(false);
  });

  it("matches exact hosts and srt's grant patterns", () => {
    expect(injectsAt(token, "API.github.com")).toBe(true);
    expect(injectsAt(token, "evil.api.github.com")).toBe(false);
    expect(granted(["*.example.com"], "a.example.com", 443)).toBe(true);
    expect(granted(["*.example.com"], "example.com.evil.test", 443)).toBe(false);
  });
});

describe("neverDialed", () => {
  it("refuses this host and link-local addresses whatever a grant says, and nothing else", () => {
    for (const host of [
      "localhost",
      "LOCALHOST.",
      "app.localhost",
      "127.0.0.1",
      "127.8.9.10",
      "0.0.0.0",
      "::1",
      "[::1]",
      "169.254.169.254",
      "fe80::1",
      "::ffff:127.0.0.1",
      "metadata.google.internal",
    ])
      expect(neverDialed(host), host).toBe(true);
    for (const host of ["example.org", "10.0.0.5", "192.168.1.1", "localhost.example.com", "2001:db8::1"])
      expect(
        neverDialed(host, () => []),
        host,
      ).toBe(false);
  });

  it("refuses every spelling srt canonicalizes to loopback, the unspecified address or metadata before it dials", () => {
    const spellings = [
      "::ffff:7f00:1",
      "127.1",
      "2130706433",
      "0x7f.0.0.1",
      "0177.0.0.1",
      "0:0:0:0:0:0:0:1",
      "0",
      "::ffff:a9fe:a9fe",
      "2852039166",
      "[::ffff:127.0.0.1]",
      "0.0.0.0.",
      "::",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
    ];
    for (const host of spellings)
      expect(
        neverDialed(host, () => []),
        host,
      ).toBe(true);
  });

  it("refuses cloud metadata addresses outside link-local space", () => {
    for (const host of ["169.254.169.254", "fd00:ec2::254", "168.63.129.16", "100.100.100.200"])
      expect(
        neverDialed(host, () => []),
        host,
      ).toBe(true);
  });

  it("refuses every address literal when this host's addresses cannot be listed, and still dials a name", () => {
    for (const host of ["10.0.0.5", "192.168.1.1", "2001:db8::1"])
      expect(
        neverDialed(host, () => undefined),
        host,
      ).toBe(true);
    expect(neverDialed("example.org", () => undefined)).toBe(false);
  });

  it("refuses this host's own interface addresses, however spelled", () => {
    expect(
      neverDialed("192.168.7.20", () => ["192.168.7.20"]),
      "dotted",
    ).toBe(true);
    expect(
      neverDialed("3232237332", () => ["192.168.7.20"]),
      "a number",
    ).toBe(true);
    expect(
      neverDialed("192.168.7.21", () => ["192.168.7.20"]),
      "a neighbour",
    ).toBe(false);
  });

  it("refuses a host srt cannot canonicalize", () => {
    expect(neverDialed("exa mple.org", () => [])).toBe(true);
  });
});

describe("dialedHost", () => {
  it("is the host srt dials, so a grant matches what is reached", () => {
    expect(dialedHost("127.1")).toBe("127.0.0.1");
    expect(dialedHost("Example.ORG.")).toBe("example.org");
    expect(dialedHost("::ffff:a9fe:a9fe")).toBe("169.254.169.254");
    expect(granted(["10.0.0.5"], dialedHost("0xa.0.0.5") ?? "", 80)).toBe(true);
  });
});

describe("privateRefused", () => {
  it("refuses a private, unique-local or CGNAT address by number, in any spelling, unless the operator listed it", () => {
    for (const host of [
      "10.1.2.3",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.254",
      "100.64.0.1",
      "fd00::1",
      "[fc00::2]",
      "::ffff:10.0.0.1",
      "0xa.1",
      "10.1",
    ])
      expect(privateRefused(host, 80, []), host).toBe(true);
    for (const host of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "example.com", "2606:4700::1111"])
      expect(privateRefused(host, 80, []), host).toBe(false);
    expect(privateRefused("192.168.1.20", 80, ["192.168.1.20"])).toBe(false);
    expect(privateRefused("10.0.0.5", 8080, ["10.0.0.5:8080"])).toBe(false);
    expect(privateRefused("10.0.0.5", 80, ["10.0.0.5:8080"])).toBe(true);
  });
});

describe("the host process's fd-3 events", () => {
  it("takes each event of the right shape as it is", () => {
    const events = [
      { type: "request", host: "api.example.com", port: 443, allowed: true },
      { type: "violation", line: "deny network-outbound" },
      { type: "inject", host: "api.github.com", port: 443, credentials: ["GH_TOKEN"] },
      { type: "exit", code: 0, signal: null },
      { type: "exit", code: null, signal: "SIGTERM" },
      { type: "error", message: "could not spawn" },
      { type: "error", message: "refused", profileError: "bwrap: ..." },
    ];
    for (const event of events) expect(hostProcessEventOf(event)).toBe(event);
  });

  it("drops a line that is not an event", () => {
    const lines: unknown[] = [
      null,
      42,
      "exit",
      [],
      {},
      { type: "unknown" },
      { type: "request", host: "api.example.com", port: "443", allowed: true },
      { type: "request", host: "api.example.com", port: 443 },
      { type: "violation" },
      { type: "inject", host: "api.github.com", port: 443, credentials: [1] },
      { type: "inject", host: "api.github.com", port: 443 },
      { type: "exit", code: "0", signal: null },
      { type: "exit", code: 0 },
      { type: "error" },
      { type: "error", message: "refused", profileError: 7 },
    ];
    for (const line of lines) expect(hostProcessEventOf(line), JSON.stringify(line)).toBeUndefined();
  });
});

describe("a connection through a parent proxy", () => {
  it("is refused when its name resolves here to this host, a metadata address or a private network", async () => {
    const answers = (address: string) => async () => [{ address }];
    expect(await resolvesInward("pypi.org", 443, [], answers("151.101.0.223"))).toBe(false);
    expect(await resolvesInward("rebind.example", 443, [], answers("127.0.0.1"))).toBe(true);
    expect(await resolvesInward("meta.example", 80, [], answers("169.254.169.254"))).toBe(true);
    expect(await resolvesInward("lan.example", 443, [], answers("10.1.2.3"))).toBe(true);
    // A private address the operator opened stays reachable.
    expect(await resolvesInward("lan.example", 443, ["10.1.2.3"], answers("10.1.2.3"))).toBe(false);
    // A name this host cannot resolve is the proxy's to resolve: a host behind one often has no public DNS.
    expect(
      await resolvesInward("gone.example", 443, [], async () => {
        throw new Error("ENOTFOUND");
      }),
    ).toBe(false);
    expect(await resolvesInward("10.0.0.1", 443, [], answers("x"))).toBe(true);
  });
});

describe("the run's proxy config", () => {
  const filter = async () => ({ action: "allow" as const });
  const base: HostProcessRequest = {
    config: { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } },
    grants: ["pypi.org", "files.pythonhosted.org", "api.github.com"],
    line: "true",
    cwd: "/w",
    env: {},
    inheritEnv: false,
  };
  const ca = { caCertPath: "/ca/cert.pem", caKeyPath: "/ca/key.pem" };

  it("holds every request it reads to the host its connection was opened to, and asks for an ambiguous target's refusal", () => {
    const network = hostProcessConfig(base, filter).network;
    expect(network).toMatchObject({ requireHostMatch: true, ambiguousRequestTarget: "refuse", strictAllowlist: false });
    expect(network.tlsTerminate).toBeUndefined();
    expect(network.refuseOpaqueTunnels).toBeUndefined();
  });

  it("terminates only a credential's hosts, and strips the cookies they set", () => {
    const network = hostProcessConfig(
      { ...base, credentials: { entries: [{ env: "GH_TOKEN", hosts: ["api.github.com"] }], secrets: { GH_TOKEN: "x" }, ...ca } },
      filter,
    ).network;
    expect(network.tlsTerminate).toEqual({ ...ca, excludeDomains: ["pypi.org", "files.pythonhosted.org"] });
    expect(network.stripResponseHeaders).toEqual(["set-cookie"]);
    expect(network.refuseOpaqueTunnels).toBeUndefined();
    expect(network.filterRequest).toBe(filter);
  });

  it("inspected, terminates every grant and refuses a tunnel it cannot read", () => {
    const network = hostProcessConfig({ ...base, inspectTls: ca }, filter).network;
    expect(network.tlsTerminate).toEqual({ ...ca, excludeDomains: [] });
    expect(network.refuseOpaqueTunnels).toBe(true);
    expect(network.stripResponseHeaders).toBeUndefined();
    expect(network.requireHostMatch).toBe(true);
  });

  it("inspected with a credential, still keeps the credential host's cookies from the command", () => {
    const network = hostProcessConfig(
      {
        ...base,
        inspectTls: ca,
        credentials: { entries: [{ env: "GH_TOKEN", hosts: ["api.github.com"] }], secrets: { GH_TOKEN: "x" }, ...ca },
      },
      filter,
    ).network;
    expect(network.tlsTerminate).toEqual({ ...ca, excludeDomains: [] });
    expect(network.refuseOpaqueTunnels).toBe(true);
    expect(network.stripResponseHeaders).toEqual(["set-cookie"]);
  });
});

describe("the deny lists", () => {
  it("keeps the shipped reason for each shipped entry an operator's own list holds", () => {
    const lists = egressDenyLists(["example.org"], ["pastebin.com", "internal.example"]);
    expect(lists.deniedDomains).toEqual(["pastebin.com", "internal.example"]);
    expect(lists.deniedDomainReasons).toEqual({ "pastebin.com": expect.stringContaining("paste or file-drop site") });
    expect(egressDenyLists(["example.org"]).deniedDomainReasons?.["webhook.site"]).toContain("paste or file-drop site");
  });
});
