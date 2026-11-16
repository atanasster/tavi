/**
 * Skills in postings and profiles: an alias dictionary,
 * read over a posting's text as words in one pass. A skill under a
 * requirements heading ("Requirements", "Must have", "Anforderungen",
 * "Profil recherché"…) is required; one under "Nice to have" is not. Visible
 * keyword stuffing counts each skill once.
 */
export interface SkillEntry {
  readonly id: string;
  readonly label: string;
  /** Other ways a posting writes it; an alias in `exact` matches only as written, case and all ("Go", "R"). */
  readonly aliases: readonly string[];
  readonly exact?: readonly string[];
}

export interface SkillDictionary {
  readonly version: string;
  /** What the dictionary was built from, and the notices its sources ask for. */
  readonly attribution: readonly string[];
  readonly skills: readonly SkillEntry[];
}

export interface FoundSkill {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
}

interface Alias {
  readonly tokens: readonly string[];
  readonly entry: SkillEntry;
  readonly exact: boolean;
}

export interface SkillIndex {
  /** A label as the dictionary's skill, when it knows it. */
  lookup(label: string): SkillEntry | undefined;
  /** Every skill `text` names, once each, required when it is under a requirements heading. */
  extract(text: string): FoundSkill[];
}

/** Words as the dictionary compares them: lower-cased, accents dropped, `c++`, `c#`, `node.js` and `.net` kept whole. */
export function skillTokens(text: string, keepCase = false): string[] {
  const folded = text.normalize("NFKD").replace(/\p{M}/gu, "");
  const words = (keepCase ? folded : folded.toLowerCase()).match(/[\p{L}\p{N}][\p{L}\p{N}+#.]*|\.[\p{L}][\p{L}\p{N}]*/gu) ?? [];
  return words.map((word) => word.replace(/\.+$/, "")).filter((word) => word !== "");
}

/** Words as written, with `-` and `&` compounds kept whole, for the aliases matched only as written. */
function compoundTokens(text: string): string[] {
  return (
    text
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .match(/[\p{L}\p{N}][\p{L}\p{N}+#.&-]*|\.[\p{L}][\p{L}\p{N}]*/gu) ?? []
  )
    .map((word) => word.replace(/[.-]+$/, ""))
    .filter((word) => word !== "");
}

const REQUIRED_HEADING =
  /^(requirements?|required|must[- ]haves?|what you('|’)ll need|what we('|’)re looking for|you have|your profile|qualifications?|minimum qualifications|basic qualifications|who you are|skills|anforderungen|dein profil|ihr profil|was du mitbringst|profil recherch[ée]|exigences|requisitos|vereisten|wat wij vragen|krav|kvalifikationer)(?![\p{L}\p{N}])/iu;
const OPTIONAL_HEADING =
  /^(nice[- ]to[- ]haves?|bonus( points)?|preferred( qualifications)?|plus|it('|’)s a plus|wünschenswert|von vorteil|atouts|deseable|pluspunten|meriterande)(?![\p{L}\p{N}])/iu;
/** Another heading ends a requirements section. Headings end where no letter follows, accents included ("recherché"). */
const OTHER_HEADING =
  /^(about (us|the (role|team|company))|what you('|’)ll do|responsibilities|benefits|what we offer|perks|wir bieten|deine aufgaben|vos missions|ce que nous offrons)(?![\p{L}\p{N}])/iu;

/** An index over `dictionary`'s aliases, by first word. */
export function createSkillIndex(dictionary: SkillDictionary): SkillIndex {
  const byFirst = new Map<string, Alias[]>();
  const byLabel = new Map<string, SkillEntry>();
  const add = (text: string, entry: SkillEntry, exact: boolean): void => {
    const tokens = exact ? compoundTokens(text) : skillTokens(text);
    const first = tokens[0];
    if (first === undefined) return;
    const list = byFirst.get(first) ?? [];
    list.push({ tokens, entry, exact });
    byFirst.set(first, list);
  };
  // The first entry to claim a label or alias keeps it, for `lookup` and `extract` alike: a merged dictionary's
  // second "Python" never splits a profile's Python from a posting's.
  const claimed = new Set<string>();
  const claim = (text: string): boolean => {
    const key = skillTokens(text).join(" ");
    if (key === "" || claimed.has(key)) return false;
    claimed.add(key);
    return true;
  };
  for (const raw of dictionary.skills) {
    if (raw.id.length > 80) continue;
    const entry: SkillEntry = { ...raw, label: raw.label.slice(0, 80) };
    if (!claim(entry.label)) continue;
    byLabel.set(skillTokens(entry.label).join(" "), entry);
    // A label also written in `exact` ("Go") is matched only as written, never as a word ("let's go").
    const exactOnly = new Set((entry.exact ?? []).map((alias) => alias.toLowerCase()));
    for (const [index, alias] of [entry.label, ...entry.aliases].entries()) {
      // The label was claimed above; an alias another entry claimed first stays that entry's.
      if (index > 0 && !claim(alias)) continue;
      // One letter matches only as written: lower-cased, it is any lone letter.
      if (!exactOnly.has(alias.toLowerCase()) && skillTokens(alias).join(" ").length > 1) add(alias, entry, false);
      byLabel.set(skillTokens(alias).join(" "), entry);
    }
    for (const alias of entry.exact ?? []) add(alias, entry, true);
  }
  // Longest alias first, so "google cloud platform" wins over "google cloud".
  for (const list of byFirst.values()) list.sort((a, b) => b.tokens.length - a.tokens.length);

  const extract = (text: string): FoundSkill[] => {
    const found = new Map<string, FoundSkill>();
    const keep = (alias: Alias, required: boolean): void => {
      const known = found.get(alias.entry.id);
      // Once each; required if any mention is.
      if (known === undefined || (!known.required && required))
        found.set(alias.entry.id, { id: alias.entry.id, label: alias.entry.label, required: required || known?.required === true });
    };
    const scan = (tokens: readonly string[], exact: boolean, required: boolean): void => {
      for (let index = 0; index < tokens.length; index += 1) {
        const alias = byFirst
          .get(tokens[index] ?? "")
          ?.find((each) => each.exact === exact && each.tokens.every((token, offset) => tokens[index + offset] === token));
        if (alias !== undefined) keep(alias, required);
      }
    };
    let required = false;
    for (const line of text.split(/\n+/)) {
      // A heading is a short line of its own, never a bullet ("- You have five years…").
      const bullet = /^\s*([-*•·–]|\d+[.)])\s/.test(line);
      const heading = line
        .replace(/^[\s#*]+/, "")
        .replace(/:\s*$/, "")
        .trim();
      if (!bullet && heading.length <= 60) {
        if (REQUIRED_HEADING.test(heading)) required = true;
        else if (OPTIONAL_HEADING.test(heading) || OTHER_HEADING.test(heading)) required = false;
      }
      // As written, compounds whole: "Go-to-Market", "R&D" and "C-suite" are not Go, R or C.
      scan(compoundTokens(line), true, required);
      scan(skillTokens(line), false, required);
    }
    return [...found.values()].slice(0, 64);
  };

  return { lookup: (label) => byLabel.get(skillTokens(label).join(" ")), extract };
}
