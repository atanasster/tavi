import { describe, expect, it } from "vitest";

import { SANDBOX_DOMAIN_PRESETS, expandSandboxDomains, normalizeSandboxDomain, normalizeSandboxGrant } from "../src/sandbox.js";

/** The domains `sandbox.run` may reach, as the operator grants them. */
describe("normalizeSandboxDomain", () => {
  it("keeps names, subdomain patterns and canonical dotted addresses, with a port", () => {
    expect(normalizeSandboxDomain("PyPI.org.")).toBe("pypi.org");
    expect(normalizeSandboxDomain("*.pythonhosted.org")).toBe("*.pythonhosted.org");
    expect(normalizeSandboxDomain("api.example.com:443")).toBe("api.example.com:443");
    expect(normalizeSandboxDomain("10.0.0.5:8080")).toBe("10.0.0.5:8080");
    expect(normalizeSandboxDomain("192.168.1.20")).toBe("192.168.1.20");
    expect(normalizeSandboxDomain("1password.com")).toBe("1password.com");
  });

  it("refuses an address spelled any other way, which the proxy would dial as another", () => {
    for (const value of [
      "127.1",
      "127.1:8080",
      "2130706433",
      "0x7f.0.0.1",
      "0177.0.0.1",
      "0",
      "2852039166",
      "10.0.0.05",
      "10.0.0.256",
      "1.2.3",
      "*.1.2.3.4",
      "example.0x10",
      "example.123",
    ]) {
      expect(normalizeSandboxDomain(value), value).toBeUndefined();
    }
  });

  it("refuses this host, the unspecified address, link-local and metadata addresses, which no grant reaches", () => {
    for (const value of [
      "127.0.0.1",
      "127.8.9.10:80",
      "0.0.0.0",
      "169.254.169.254",
      "168.63.129.16",
      "100.100.100.200",
      "localhost",
      "app.localhost",
    ]) {
      expect(normalizeSandboxDomain(value), value).toBeUndefined();
    }
  });

  it("takes @registries as one grant for the package registries, and never a host anyone can upload text to", () => {
    expect(normalizeSandboxGrant(" @Registries ")).toBe("@registries");
    expect(normalizeSandboxGrant("@nothing")).toBeUndefined();
    // Only sandbox.run's grants take a preset: a worker's domains or a credential's host never do.
    expect(normalizeSandboxDomain("@registries")).toBeUndefined();
    const expanded = expandSandboxDomains(["@registries", "api.example.com"]);
    expect(expanded).toEqual(
      expect.arrayContaining(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "api.example.com"]),
    );
    expect(expanded).not.toContain("@registries");
    expect(expanded).not.toContain("github.com");
    expect(expanded).not.toContain("raw.githubusercontent.com");
    // General file storage is no registry: anyone's bucket is reachable there.
    expect(expanded).not.toContain("storage.googleapis.com");
    expect(expanded).not.toContain("dl.google.com");
    for (const domain of SANDBOX_DOMAIN_PRESETS["@registries"] ?? []) expect(normalizeSandboxDomain(domain), domain).toBe(domain);
  });
});
