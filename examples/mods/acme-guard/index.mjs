// docs/MODS.md, Example 3: the guide's code, installed and driven by apps/cli/test/plugins/example-mods.test.ts.
const DANGEROUS = [
  [/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, "deletes files recursively"],
  [/\bgit\s+reset\s+--hard\b/i, "discards uncommitted work"],
  [/\bgit\s+clean\s+-[a-z]*f/i, "deletes untracked files"],
  [/\bdrop\s+(table|database)\b/i, "drops database objects"],
  [/\bmkfs\b/i, "formats a disk"],
];

export default {
  register({ hooks }) {
    hooks.on("tool.check", { tools: ["sandbox.run"] }, async (e, next) => {
      const verdict = await next(e);
      const command = [e.input?.command, ...(e.input?.args ?? [])].join(" ");
      const hit = DANGEROUS.find(([pattern]) => pattern.test(command));
      if (hit === undefined) return verdict;
      // A schedule approves asks for the tools it allows: where nobody can answer, refuse.
      if (!e.envelope.attended) return { decision: "deny", reason: `This command ${hit[1]}, and nobody can approve it in this run.` };
      return { decision: "ask", reason: `This command ${hit[1]}.` };
    });
  },
};
