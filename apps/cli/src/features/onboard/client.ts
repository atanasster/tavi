import { emitJson, jsonText } from "../../cli/output.js";
import { EXIT, configRefusalExit } from "../../cli/exit.js";
import type { OnboardCommandOptions } from "./parse.js";
import { terminalText } from "../../shared/terminal-text.js";
import { wordsOfSettingsAnswer } from "../../shared/terminal-words.js";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { TaviError, type OnboardingProviderAnswer, type OnboardingResetAnswer, type OnboardingStatus } from "@tavi/contracts";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { definedOnly, plural } from "@tavi/contracts/util";
import { ONBOARD_EXIT, checklistCount, runOnboard, stepLine } from "./flow.js";
import { createLinePrompter, wantsPlainPrompts, type Prompter } from "./prompter.js";
import type { OnboardTransport } from "./attached-transport.js";
import { withOnboardTransport } from "./first-run.js";
import { defaultStepSystem, userScopeRunner, type StepSystem } from "./steps.js";
import { ONBOARD_SHARED_HOST_REMEDY, signInWithOpenRouterHere, type OpenRouterEndpoints } from "./openrouter.js";
import { describeImport, findImports, runImport, type ImportFiles } from "./import.js";
import { chatGptCredentialOf, chatGptHostId, signInWithChatGpt, type ChatGptEndpoints } from "./chatgpt.js";
import { oauthSharedHostNote, openAuthorizationUrl } from "../oauth/core.js";
import { homedir } from "node:os";
import { createLocalCredentialStore, credentialsEncrypted } from "../credentials/store.js";
import type { CliIo } from "../../cli/io.js";
import { ownerWorkspacePrincipal } from "../../cli/owner.js";
import type { ResolvedDataDirectory } from "../../cli/store.js";

export interface OnboardIo {
  readonly input?: NodeJS.ReadableStream;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The service step's platform, paths and user-scope runner, and the pairing wait (tests: a temporary HOME, no launchctl). */
  readonly system?: (dataDirectory: string) => StepSystem;
  /** OpenRouter's sign-in endpoints and the browser opener (tests: a stub authorization server). */
  readonly openRouter?: { readonly endpoints?: OpenRouterEndpoints; readonly open?: (url: string) => boolean | Promise<boolean> };
  /** Where `tavi onboard import` looks (tests: a temporary home). */
  readonly importFiles?: ImportFiles;
  /** Sign in with ChatGPT's endpoints, opener and loopback port (tests: a stub authorization server). */
  readonly chatGpt?: {
    readonly endpoints?: ChatGptEndpoints;
    readonly open?: (url: string) => boolean | Promise<boolean>;
    readonly port?: number;
  };
}

/** `text` as one POSIX shell word: single-quoted, so nothing in it expands when the line is pasted. */
function shellQuoted(text: string): string {
  return `'${text.replace(/'/gu, "'\\''")}'`;
}

/**
 * `tavi onboard` and `tavi setup`: on a
 * live owner every write goes over IPC, as `tavi models` does; with none, the
 * directory is opened here and the same commands run in-process. Exit codes:
 * 0 no required step open, 3 one open, 4 an owner needed, 130 cancelled.
 */
export async function onboardCliCommand(
  options: ResolvedDataDirectory<OnboardCommandOptions>,
  io: CliIo,
  extras: OnboardIo,
): Promise<number> {
  const env = extras.env ?? process.env;
  const json = options.format === "json";
  const headless = options.nonInteractive === true;
  const input = extras.input ?? process.stdin;
  const plain = wantsPlainPrompts(env, { ...(options.plain === undefined ? {} : { plain: options.plain }), isTty: io.isTty });
  // A headless or JSON run says its lines on stderr, so stdout holds the answer alone.
  const lines = (text: string) => (json ? io.stderr(text) : io.stdout(text));
  // Ink is loaded for an interactive terminal alone, from `tavi chat`'s own chunk: no other run pays for React.
  const makePrompter = async (): Promise<Prompter> =>
    headless || plain || json || extras.input !== undefined
      ? createLinePrompter({ input: headless ? Readable.from([]) : input, write: lines })
      : (await import("../../tui/index.js")).createInkPrompter({ stdin: process.stdin, stdout: process.stdout });
  const readStdin = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks).toString("utf8");
  };
  const run = async (transport: OnboardTransport): Promise<number> => {
    // The workspace's language, as the owner (or the data directory) holds it; English when it cannot be read.
    const words = async (): Promise<CoreT> =>
      wordsOfSettingsAnswer(
        await transport.request("workspace-settings", { action: "get", workspaceId: options.workspaceId }).catch(() => undefined),
      );
    /** A prompter speaking the workspace's language from its first question. */
    const wordedPrompter = async (): Promise<Prompter> => {
      const prompter = await makePrompter();
      prompter.useWords?.(await words());
      return prompter;
    };
    switch (options.action) {
      case "status": {
        const status = await transport.request<OnboardingStatus>("onboarding", {
          action: "status",
          workspaceId: options.workspaceId,
          surface: "cli",
        });
        if (json) emitJson(io, status);
        else {
          const t = await words();
          io.stdout(
            `${t("cli.onboard.setup", { count: checklistCount(status, t) })}\n${status.steps.map((step) => stepLine(step, t)).join("\n")}\n${status.complete ? "" : `\n${t("cli.onboard.modelOpen")}\n`}`,
          );
        }
        return status.complete ? ONBOARD_EXIT.ok : ONBOARD_EXIT.open;
      }
      case "provider": {
        const answer = await transport.request<OnboardingProviderAnswer>("onboarding", {
          action: "provider",
          ...(options.provider === undefined ? {} : { id: options.provider }),
        });
        io.stdout(
          json
            ? jsonText(answer)
            : `${answer.providers.map((provider) => `${provider.id === answer.providerId ? "*" : " "} ${provider.id} (${provider.kind})`).join("\n") || "No onboarding flow is installed: tavi onboard status still answers."}\n`,
        );
        return EXIT.ok;
      }
      case "import": {
        // Another agent's files, read here: its home is this user's, whichever owner answers.
        const files = extras.importFiles ?? {
          home: homedir(),
          env,
          readText: async (path: string) => await readFile(path, "utf8").catch(() => undefined),
        };
        const found = await findImports(files, options.importFrom);
        if (found.length === 0) {
          if (json) io.stdout(`${JSON.stringify({ found: [] })}\n`);
          else
            io.stdout(
              `No ${options.importFrom === undefined ? "OpenClaw or Hermes" : options.importFrom === "openclaw" ? "OpenClaw" : "Hermes"} install was found.\n`,
            );
          return EXIT.ok;
        }
        for (const one of found) lines(`${describeImport(one.finding).join("\n")}\n`);
        if (options.dryRun === true) {
          if (json) emitJson(io, { found: found.map((one) => one.finding) });
          else io.stdout("Dry run: nothing was changed.\n");
          return EXIT.ok;
        }
        const anySecret = found.some((one) => one.secrets.size > 0);
        let secrets = options.withSecrets === true;
        if (!secrets && anySecret && !json && (io.isTty || extras.input !== undefined)) {
          const prompter = await wordedPrompter();
          try {
            const bot = found.some((one) => one.secrets.has("telegram"));
            const keys = found.some((one) => [...one.secrets.keys()].some((name) => name !== "telegram"));
            const t = prompter.words?.() ?? (await words());
            const what = t(keys && bot ? "cli.onboard.import.keysAndToken" : bot ? "cli.onboard.import.token" : "cli.onboard.import.keys");
            secrets = await prompter.confirm({ label: t("cli.onboard.import.copy", { what }), default: false });
          } finally {
            prompter.close();
          }
        }
        const outcomes = [];
        for (const one of found)
          outcomes.push({
            source: one.finding.source,
            ...(await runImport(transport, one, { workspaceId: options.workspaceId, secrets }, (line) => lines(`${line}\n`))),
          });
        if (json) emitJson(io, { found: found.map((one) => one.finding), imported: outcomes });
        return EXIT.ok;
      }
      case "reset": {
        const answer = await transport.request<OnboardingResetAnswer>("onboarding", { action: "reset", workspaceId: options.workspaceId });
        io.stdout(
          json
            ? `${JSON.stringify(answer)}\n`
            : `Cleared ${plural(answer.cleared, "skipped or seen step")} and the dismissed checklist. Models, keys and connections are untouched.\n`,
        );
        return EXIT.ok;
      }
      case "onboard":
      case "setup": {
        const prompter = await wordedPrompter();
        try {
          const system = extras.system?.(options.dataDirectory) ?? defaultStepSystem(options.dataDirectory, userScopeRunner);
          // Over SSH, `--paste` takes the address the browser landed on; the listener here waits as well.
          const signInWithOpenRouter = () =>
            signInWithOpenRouterHere({
              say: (text) => prompter.say(text),
              ...(options.paste === true
                ? {
                    paste: async (signal: AbortSignal) =>
                      await prompter.text({ label: (prompter.words?.() ?? coreEnglish)("cli.onboard.ask.landedOn"), signal }),
                  }
                : {}),
              ...(extras.fetch === undefined ? {} : { fetch: extras.fetch }),
              ...(extras.openRouter?.endpoints === undefined ? {} : { endpoints: extras.openRouter.endpoints }),
              ...(extras.openRouter?.open === undefined ? {} : { open: extras.openRouter.open }),
            });
          // Sign in with ChatGPT in this process: kept only in an encrypted store, so that is asked first.
          const signInWithChatGptHere = async (): Promise<string> => {
            if (!credentialsEncrypted(options.dataDirectory))
              throw new TaviError(
                "NOT_CONFIGURED",
                "A ChatGPT sign-in is kept only in an encrypted credential store: run tavi credentials encrypt, then choose ChatGPT again.",
              );
            // Signed in before: the same registration and account again (OpenAI's returning sign-in).
            const kept = chatGptCredentialOf(
              (await createLocalCredentialStore(options.dataDirectory)
                .getSecret("chatgpt")
                .catch(() => null)) ?? "",
            );
            const credential = await signInWithChatGpt({
              hostId: await chatGptHostId(options.dataDirectory),
              ...(kept === undefined ? {} : { returning: kept }),
              open: async (url) => {
                if (!(await (extras.chatGpt?.open ?? openAuthorizationUrl)(url)))
                  prompter.say(`Open this address in a browser on this computer: ${url}`);
                else if (extras.chatGpt?.open === undefined) {
                  const note = oauthSharedHostNote(ONBOARD_SHARED_HOST_REMEDY);
                  if (note !== undefined) prompter.say(note.trimEnd());
                }
              },
              ...(extras.fetch === undefined ? {} : { fetch: extras.fetch }),
              ...(extras.chatGpt?.endpoints === undefined ? {} : { endpoints: extras.chatGpt.endpoints }),
              ...(extras.chatGpt?.port === undefined ? {} : { port: extras.chatGpt.port }),
            });
            return JSON.stringify(credential);
          };
          const outcome = await runOnboard(
            {
              transport,
              prompter,
              env,
              fetch: extras.fetch ?? globalThis.fetch,
              readFile: async (path) => await readFile(path, "utf8"),
              readStdin,
              system,
              signInWithOpenRouter,
              signInWithChatGpt: signInWithChatGptHere,
              ...(extras.sleep === undefined ? {} : { sleep: extras.sleep }),
            },
            {
              mode: options.action,
              workspaceId: options.workspaceId,
              ...(options.step === undefined ? {} : { step: options.step }),
              ...(headless
                ? {
                    headless: {
                      preset: options.preset ?? "openrouter",
                      ...(options.preset === undefined ? {} : { presetGiven: true }),
                      ...(options.keyFile === undefined ? {} : { keyFile: options.keyFile }),
                      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
                      ...(options.keyStdin === true ? { keyStdin: true } : {}),
                      ...definedOnly({
                        model: options.model,
                        fastModel: options.fastModel,
                        name: options.name,
                        timezone: options.timezone,
                        activeHours: options.activeHours,
                        search: options.search,
                        searchKeyFile: options.searchKeyFile,
                        searchUrl: options.searchUrl,
                        channelSecrets: options.channelSecrets,
                      }),
                    },
                  }
                : {}),
            },
          );
          if (json) {
            io.stdout(
              `${JSON.stringify(
                {
                  exit: outcome.exit,
                  ...definedOnly({
                    missing: outcome.missing,
                    next: outcome.next,
                    ignored: outcome.ignored,
                    status: outcome.status,
                  }),
                },
                null,
                2,
              )}\n`,
            );
          } else if (outcome.next !== undefined) lines(`Next: ${outcome.next}\n`);
          // The prompt chosen opens a new chat with it in the composer, unsent — on an owner, which a chat needs.
          if (outcome.draft !== undefined && outcome.exit !== ONBOARD_EXIT.cancelled) {
            if (
              transport.attached &&
              io.isTty &&
              process.stdin.isTTY === true &&
              process.stdout.isTTY === true &&
              extras.input === undefined
            ) {
              prompter.close();
              process.env["NODE_ENV"] = "production";
              const { runChat } = await import("../../tui/index.js");
              const chatExit = await runChat(
                {
                  dataDirectory: options.dataDirectory,
                  workspaceId: options.workspaceId,
                  principalId: ownerWorkspacePrincipal(options.workspaceId) ?? "operator",
                  draft: outcome.draft,
                },
                { stdout: process.stdout, stdin: process.stdin, stderr: io.stderr },
                { ok: EXIT.ok, usage: EXIT.usage, unavailable: EXIT.unavailable, detached: EXIT.detached },
              );
              return outcome.exit === ONBOARD_EXIT.ok ? chatExit : outcome.exit;
            }
            lines(
              `${transport.attached ? "" : "Start `tavi serve`, then "}start it with: tavi chat --draft ${shellQuoted(outcome.draft)}\n`,
            );
          }
          return outcome.exit;
        } finally {
          prompter.close();
        }
      }
    }
  };
  try {
    return await withOnboardTransport(options.dataDirectory, ["onboarding", "models", "credentials"], run);
  } catch (error) {
    const failure = TaviError.from(error);
    // Under --json the refusal is JSON too, on stdout, as every other answer is.
    if (json) emitJson(io, { ok: false, error: { code: failure.code, message: failure.message } });
    else io.stderr(`tavi ${options.action === "setup" ? "setup" : "onboard"}: ${terminalText(failure.message)}\n`);
    return failure.code === "UNAVAILABLE" ? EXIT.unavailable : configRefusalExit(failure.code);
  }
}
