import { siteSkillOfNote, type SiteSkillRegistryPort } from "@tavi/contracts";
import { SITE_SKILLS, SITE_SKILLS_PLUGIN_ID } from "@tavi/plugin-site-skills";
import type { EnabledSiteNote } from "./site-notes.js";

export { SITE_SKILLS_PLUGIN_ID };

/**
 * The registry's entry for the plugins' and the operator's site notes, apart
 * from any plugin's own. The owner's registry searches it first, so a note the
 * operator turned on is taken before a built-in skill for the same host.
 */
export const SITE_NOTES_ENTRY = "@site-notes";

/**
 * Where the owner puts the built-in site skills (`tavi.siteskills`) in the
 * registry the browser tools read. This module alone names
 * `@tavi/plugin-site-skills`; the function returned takes them out again.
 */
export function addBuiltinSiteSkills(registry: SiteSkillRegistryPort): () => void {
  return registry.add(SITE_SKILLS_PLUGIN_ID, SITE_SKILLS);
}

/**
 * Puts the site notes the operator turned on in the same registry, in place
 * of the ones there before, each framed as reference notes from whoever wrote
 * it. The site switch's reads call it when the notes change, so a note turned on or off
 * shows from the next navigation.
 */
export function showSiteNotes(registry: SiteSkillRegistryPort, notes: readonly EnabledSiteNote[]): () => void {
  return registry.add(
    SITE_NOTES_ENTRY,
    notes.map(({ from, note }) => siteSkillOfNote(note, from)),
  );
}
