/**
 * A replacement for the built-in ideas provider (docs/IDEAS-PLUGINS.md): a
 * fixed catalogue instead of `tavi.ideasagent`'s ranked one. It offers only
 * what the census says Tavi can do here, skips what the ledger rules out, and
 * cites nothing of the person's (`general` basis), so it asks only for the
 * ledger. Tavi validates, stores, caps and shows what it proposes.
 */

const CATALOGUE = [
  {
    key: "productivity.acme-weekly-review",
    needs: "memory",
    icon: "📋",
    title: "I can run your weekly review",
    label: "Weekly review",
    pitch: "Every Friday, five minutes: what got done, what slipped, what's next.",
    prompt: "Run my weekly review: what got done, what slipped, what's next.",
    recurring: { cadence: "weekly" },
  },
  {
    key: "productivity.acme-standup-reminder",
    needs: "reminders",
    icon: "📅",
    title: "I can remind you before each stand-up",
    label: "Stand-up reminder",
    pitch: "A nudge ten minutes before the ACME stand-up, with yesterday's notes.",
    prompt: "Remind me ten minutes before every weekday stand-up at 9:30.",
  },
  {
    key: "work.acme-industry-news",
    needs: "web",
    icon: "📈",
    title: "I can brief you on the industry's news",
    label: "Industry news",
    pitch: "The three stories that matter to ACME this morning, with links.",
    prompt: "Find this morning's three most important logistics industry stories and summarise each in two lines.",
  },
];

export function createAcmeIdeas() {
  return {
    async generate({ capabilities, ledger, limits, signal }) {
      signal.throwIfAborted();
      const ruledOut = new Set([...(ledger?.dismissedKeys ?? []), ...(ledger?.snoozedKeys ?? []), ...(ledger?.suppressedKeys ?? [])]);
      const muted = new Set(ledger?.mutedCategories ?? []);
      const ideas = CATALOGUE.filter(
        (entry) => capabilities.includes(entry.needs) && !ruledOut.has(entry.key) && !muted.has(entry.key.split(".")[0]),
      )
        .slice(0, limits.maxIdeas)
        .map(({ needs, key, ...rest }, index) => ({
          idea: {
            ...rest,
            key,
            category: key.split(".")[0],
            templateId: key,
            basis: [{ kind: "general", ref: key }],
            uses: [{ capability: needs, approval: false }],
          },
          score: 0.7 - index * 0.1,
        }));
      return { ideas };
    },
    status: () => ({ ready: true }),
  };
}

export function register({ provideIdeas }) {
  provideIdeas(createAcmeIdeas());
}
