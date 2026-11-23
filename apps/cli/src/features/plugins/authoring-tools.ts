import { z } from "zod";

import type { InvocationContext } from "@tavi/contracts";
import type { PluginFileCheck, ToolRegistry } from "@tavi/runtime";

import { cardWords } from "../approvals/card-words.js";
import { PLUGIN_AUTHORING_GUIDE, PLUGIN_AUTHORING_GUIDE_VERSION } from "./authoring-guide.js";
import { validatePlugin, type ValidateOptions } from "./validate.js";

/**
 * The built-in plugin-authoring skill, as two tools
 * for Tavi's own agent: `plugins.authoring_guide` reads the skill — how to
 * write a plugin, test it and hand it over — and `plugins.validate` checks a
 * folder it wrote in its chat's working folder or an attached folder, as
 * `tavi plugins validate` does.
 * Neither installs anything: that stays the operator's.
 */
export interface AuthoringToolOptions {
  /**
   * Resolves a path in the calling chat's working folder or an attached one
   * (`fsRootResolver`), from the call's own context.
   */
  readonly resolve: (path: string, context: InvocationContext) => string;
  readonly validate?: ValidateOptions;
  /**
   * What `fs.read` refuses of each file the check reads, from the call's own
   * context (`folderFileCheck`): a protected path, a hard-linked file in a
   * managed folder.
   */
  readonly checkFile?: (context: InvocationContext) => PluginFileCheck;
}

const GuideSchema = z.strictObject({});
const ValidateSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(4_096)
    .describe("The plugin's folder: relative to your working folder, or absolute in it or in an attached folder"),
});

export function registerAuthoringTools(registry: ToolRegistry, options: AuthoringToolOptions): void {
  registry.register({
    id: "plugins.authoring_guide",
    sink: "none",
    version: "1.0.0",
    description:
      "Read this before writing a Tavi plugin or mod (a hook into the turn, a slash command, a status line, a tool): the manifest and module format, the hook events and their answers, a test to write, and how to hand it to the person to install.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: GuideSchema,
    handler: async () => ({ version: PLUGIN_AUTHORING_GUIDE_VERSION, guide: PLUGIN_AUTHORING_GUIDE }),
  });
  const resolve = options.resolve;
  // One at a time: each runs a plugin's code in the sandbox for up to 10 s.
  let running: Promise<unknown> = Promise.resolve();
  registry.register({
    id: "plugins.validate",
    sink: "persist",
    version: "1.0.0",
    description:
      "Check a plugin folder in your working folder or an attached folder as install would, without installing it; on macOS also run its register in a sandbox (no network, no writes) and compare what it adds with its manifest. Returns problems (errors to fix), warnings, and what register added.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: ValidateSchema,
    // It runs the folder's code: a turn holding untrusted content is asked first, once only,
    // as a chat-started one is refused it by the messaging profile.
    assess: (input, context) => {
      const t = cardWords(context);
      const parsed = ValidateSchema.safeParse(input);
      return {
        subjects: [],
        risk: "low",
        reasons: [t("approval.reason.plugin.validate")],
        askWhenTainted: true,
        display: {
          title: (parsed.success
            ? t("approval.card.plugin.validate", { path: parsed.data.path })
            : t("approval.card.plugin.validateAny")
          ).slice(0, 300),
        },
      };
    },
    handler: async ({ input, context, signal }) => {
      const parsed = ValidateSchema.parse(input);
      const folder = resolve(parsed.path, context);
      // A call whose turn was cancelled while it waited runs nothing.
      const turn = running.then(() => {
        signal.throwIfAborted();
        return validatePlugin(folder, {
          ...options.validate,
          ...(options.checkFile === undefined ? {} : { checkFile: options.checkFile(context) }),
        });
      });
      // Ordering only: the work's own failure reaches its caller through the promise it was handed.
      running = turn.catch(() => undefined);
      const report = await turn;
      // Off macOS `register` is not run: the answer says what was checked, so "valid" is never read as more.
      return {
        ...report,
        folder,
        valid: report.problems.length === 0,
        checked: report.registered === undefined ? "manifest only" : "manifest and register",
      };
    },
  });
}
