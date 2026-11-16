import { SiteProfileSchema, siteHostMatches, type SiteProfile } from "@tavi/contracts";

import arbeitsagentur from "../sites/arbeitsagentur.json" with { type: "json" };
import francetravail from "../sites/francetravail.json" with { type: "json" };
import indeed from "../sites/indeed.json" with { type: "json" };
import linkedin from "../sites/linkedin-jobs.json" with { type: "json" };
import mycareersfuture from "../sites/mycareersfuture.json" with { type: "json" };

/**
 * The plugin's own board profiles, the files its manifest's
 * `sites` names, as `ingest` reads them: the hosts Tavi reads for the chat
 * only, whose postings are not kept but for the one the person saves.
 */
const BOARD_PROFILES: readonly SiteProfile[] = [linkedin, indeed, arbeitsagentur, mycareersfuture, francetravail].map((profile) =>
  SiteProfileSchema.parse(profile),
);

/** Whether `host` is on a profile Tavi reads for the chat only: `assist-only`, or one it never browses. */
export function readOnlyHost(host: string): boolean {
  return BOARD_PROFILES.some(
    (profile) =>
      (profile.access.mode === "assist-only" || !profile.access.navigate) &&
      profile.hosts.some((pattern) => siteHostMatches(host, pattern)),
  );
}
