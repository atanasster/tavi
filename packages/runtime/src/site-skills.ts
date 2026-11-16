import { siteSkillFor, type SiteSkill, type SiteSkillRegistryPort } from "@tavi/contracts";

/**
 * The site skills of the running plugins: what the browser tools read. The
 * entries named in `first` are searched before the rest, in that order, and
 * the rest in the order they were added; within that, a skill for the page's
 * path still comes before one for its whole host.
 */
export class SiteSkillRegistry implements SiteSkillRegistryPort {
  readonly #byPlugin = new Map<string, readonly SiteSkill[]>();
  readonly #first: readonly string[];

  constructor(options: { readonly first?: readonly string[] } = {}) {
    this.#first = options.first ?? [];
  }

  add(pluginId: string, skills: readonly SiteSkill[]): () => void {
    const own = Object.freeze([...skills]);
    this.#byPlugin.set(pluginId, own);
    return () => {
      if (this.#byPlugin.get(pluginId) === own) this.#byPlugin.delete(pluginId);
    };
  }

  skillFor(url: string): SiteSkill | undefined {
    const ahead = this.#first.flatMap((pluginId) => this.#byPlugin.get(pluginId) ?? []);
    const rest = [...this.#byPlugin].flatMap(([pluginId, skills]) => (this.#first.includes(pluginId) ? [] : skills));
    return siteSkillFor([...ahead, ...rest], url);
  }
}
