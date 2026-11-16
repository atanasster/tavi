/**
 * robots.txt, as Tavi honours it:
 * the group for the reader's own agent if one names it, else the agent's
 * first word's (`tavi` for `tavi-jobs`), else `*`; the longest matching
 * `Allow` or `Disallow` decides, `Allow` on a tie; `*` and a final `$` as
 * Google reads them. A path no rule names is allowed.
 */
export const ROBOTS_AGENT = "tavi";

interface Rule {
  readonly allow: boolean;
  readonly pattern: string;
}

function groups(text: string): Map<string, Rule[]> {
  const byAgent = new Map<string, Rule[]>();
  let agents: string[] = [];
  let open = false;
  for (const raw of text.split(/\r?\n/).slice(0, 5_000)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      // A user-agent line after rules starts a new group.
      if (open) agents = [];
      open = false;
      agents.push(value.toLowerCase());
      for (const agent of agents) if (!byAgent.has(agent)) byAgent.set(agent, []);
    } else if (field === "allow" || field === "disallow") {
      open = true;
      if (field === "disallow" && value === "") continue;
      for (const agent of agents) byAgent.get(agent)?.push({ allow: field === "allow", pattern: value.slice(0, 500) });
    }
  }
  return byAgent;
}

/** Whether `pattern` (with `*` and a final `$`) matches the start of `path`, in linear time. */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = parts[0] ?? "";
  if (!path.startsWith(first)) return false;
  if (parts.length === 1) return !anchored || path === first;
  let at = first.length;
  for (const part of parts.slice(1, anchored ? -1 : undefined)) {
    const found = path.indexOf(part, at);
    if (found === -1) return false;
    at = found + part.length;
  }
  if (!anchored) return true;
  const last = parts.at(-1) ?? "";
  return path.endsWith(last) && path.length - last.length >= at;
}

/** Whether robots.txt `text` lets Tavi read `path` (with its query). */
export function robotsAllows(text: string, path: string, agent = ROBOTS_AGENT): boolean {
  const all = groups(text);
  const name = agent.toLowerCase();
  const rules = all.get(name) ?? all.get(name.split("-")[0] ?? name) ?? all.get("*") ?? [];
  let best: Rule | undefined;
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    if (best === undefined || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow))
      best = rule;
  }
  return best?.allow ?? true;
}
