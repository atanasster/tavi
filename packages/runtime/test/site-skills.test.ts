import { describe, expect, it } from "vitest";

import { SiteSkillRegistry } from "../src/site-skills.js";

const skill = (id: string, hosts: readonly string[], path?: RegExp) => ({
  id,
  name: id,
  hosts,
  notes: `${id} notes`,
  ...(path === undefined ? {} : { path }),
});

describe("SiteSkillRegistry", () => {
  it("answers the skill a registered plugin gave for a URL, the most specific first, until it is taken out", () => {
    const registry = new SiteSkillRegistry();
    expect(registry.skillFor("https://www.example.com/")).toBeUndefined();
    const remove = registry.add("acme.sites", [skill("example", ["example.com"]), skill("example-maps", ["example.com"], /^\/maps(\/|$)/)]);
    expect(registry.skillFor("https://www.example.com/")?.id).toBe("example");
    expect(registry.skillFor("https://www.example.com/maps/x")?.id).toBe("example-maps");
    expect(registry.skillFor("https://notexample.com/")).toBeUndefined();
    expect(registry.skillFor("not a url")).toBeUndefined();
    remove();
    expect(registry.skillFor("https://www.example.com/")).toBeUndefined();
  });

  it("keeps a plugin's newer skills when its older removal runs late", () => {
    const registry = new SiteSkillRegistry();
    const removeOld = registry.add("acme.sites", [skill("old", ["example.com"])]);
    registry.add("acme.sites", [skill("new", ["example.com"])]);
    removeOld();
    expect(registry.skillFor("https://example.com/")?.id).toBe("new");
  });

  it("searches the entries named first before the rest, however late they were added", () => {
    const registry = new SiteSkillRegistry({ first: ["@site-notes"] });
    registry.add("tavi.siteskills", [skill("booking", ["booking.com"]), skill("maps", ["example.com"], /^\/maps(\/|$)/)]);
    registry.add("@site-notes", [skill("my-booking", ["booking.com"]), skill("my-example", ["example.com"])]);
    expect(registry.skillFor("https://www.booking.com/")?.id).toBe("my-booking");
    // A skill for the path is still taken before one for the whole host.
    expect(registry.skillFor("https://example.com/maps")?.id).toBe("maps");
    expect(registry.skillFor("https://example.com/")?.id).toBe("my-example");
  });
});
