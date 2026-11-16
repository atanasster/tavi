import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PluginManifestSchema, SiteProfileSchema, siteHostMatches, siteWildcardTooWide, type SiteProfile } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { SITE_PROFILES } from "../src/sites.js";

/**
 * places.open's browser site profiles: each reviewed and
 * dated, in its manifest's `sites` block, with its mode and `navigate`.
 */
const root = join(import.meta.dirname, "..");
const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(join(root, "tavi-plugin.json"), "utf8")));
const files = readdirSync(join(root, "sites"))
  .filter((file) => file.endsWith(".json"))
  .sort();
const profiles = new Map<string, SiteProfile>(
  files.map((file) => [file, SiteProfileSchema.parse(JSON.parse(readFileSync(join(root, "sites", file), "utf8")))]),
);
const byId = new Map([...profiles.values()].map((profile) => [profile.id, profile]));

describe("places.open's site profiles", () => {
  it("ships its 22 profiles, every one in the manifest's sites block", () => {
    expect(files).toHaveLength(22);
    expect(manifest.sites).toEqual(files.map((file) => `sites/${file}`));
    expect(new Set(byId.keys()).size).toBe(22);
  });

  it("bundles every shipped profile for availability, so none falls back to a bare link", () => {
    expect(SITE_PROFILES.map((profile) => profile.id).sort()).toEqual([...byId.keys()].sort());
  });

  it("has every profile's terms reviewed within 180 days", () => {
    const today = Date.parse(new Date().toISOString().slice(0, 10));
    for (const profile of profiles.values())
      expect(today - Date.parse(profile.access.reviewedAt), profile.id).toBeLessThanOrEqual(180 * 86_400_000);
  });

  it("gives each its plan mode: navigate false where the terms ban agents, stage where booking widgets allow it, NHS a link only", () => {
    const modes = Object.fromEntries(
      [...byId].map(([id, profile]) => [id, `${profile.access.mode}${profile.access.navigate ? "" : ", navigate false"}`]),
    );
    expect(modes).toEqual({
      "doctolib-fr": "assist-only, navigate false",
      "doctolib-de": "assist-only, navigate false",
      "doctolib-it": "assist-only, navigate false",
      resy: "assist-only, navigate false",
      treatwell: "assist-only, navigate false",
      gasbuddy: "assist-only, navigate false",
      tabelog: "assist-only",
      "naver-place": "assist-only",
      "yandex-maps": "assist-only",
      "kakao-place": "read",
      twogis: "read",
      "doctoralia-es": "stage",
      "doctoralia-mx": "stage",
      "doctoralia-br": "stage",
      znanylekarz: "stage",
      jameda: "stage",
      thefork: "stage",
      planity: "stage",
      opentable: "stage",
      zocdoc: "stage",
      fresha: "stage",
      "nhs-gp": "none",
    });
    // Nothing here is read by a sweep or heartbeat.
    expect([...byId.values()].filter((profile) => profile.access.watchable)).toEqual([]);
  });

  it("stops every stage profile before its final control, and never fills a health or payment field", () => {
    for (const profile of [...byId.values()].filter((each) => each.access.mode === "stage")) {
      expect(profile.stage?.finalStep.labels.length, profile.id).toBeGreaterThan(0);
      expect(profile.stage?.fillable, profile.id).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /medical|symptom|history|insurance|member|card|payment|password|birth|dob|ssn|pesel|cpf|curp|dni|passport|national_id/,
          ),
        ]),
      );
      // Labels only: a selector such as button[type=submit] would stop every form on the host, search and sign-in too.
      expect(profile.stage?.finalStep.selectors, profile.id).toBeUndefined();
    }
    expect(byId.get("opentable")?.stage?.finalStep.labels).toContain("Complete reservation");
    // Places' own vocabulary for what a booking may fill.
    const vocabulary = ["name", "email", "phone", "party_size", "date", "time", "visit_reason", "notes"];
    for (const profile of [...byId.values()].filter((each) => each.stage !== undefined))
      expect(
        profile.stage?.fillable.every((field) => vocabulary.includes(field)),
        profile.id,
      ).toBe(true);
  });

  it("names each platform's own hosts, a wildcard only over its own domain, no host claimed by two profiles", () => {
    const hosts = [...byId.values()].flatMap((profile) => profile.hosts);
    expect(new Set(hosts).size).toBe(hosts.length);
    expect(hosts.filter(siteWildcardTooWide)).toEqual([]);
  });

  it("covers a navigate-false platform's subdomains and apex, so its booking widgets are never opened either", () => {
    expect(byId.get("resy")?.hosts.some((pattern) => siteHostMatches("widgets.resy.com", pattern))).toBe(true);
    expect(byId.get("resy")?.hosts.some((pattern) => siteHostMatches("resy.com", pattern))).toBe(true);
    expect(byId.get("doctolib-fr")?.hosts.some((pattern) => siteHostMatches("partners.doctolib.fr", pattern))).toBe(true);
    expect(byId.get("treatwell")?.hosts.some((pattern) => siteHostMatches("www.treatwell.de", pattern))).toBe(true);
  });
});
