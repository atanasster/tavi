import { jsonText } from "../../cli/output.js";
import { EXIT, reportCommandFailure } from "../../cli/exit.js";
import { terminalText } from "../../shared/terminal-text.js";
import { appsAnswerText } from "./text.js";
import type { AppsCommandOptions, AppsConnectCommandOptions, AppsTestCommandOptions } from "./parse.js";
import { type AppsPayload, TaviErrorCodeSchema, TaviError, MCP_PRESET_IDS, type ConnectableApp } from "@tavi/contracts";
import { runMcpLogin } from "../mcp/login-client.js";
import { CLIENT_FILE_MAX } from "./oauth-clients.js";
import { noSuchAccount } from "./accounts.js";
import { readFile } from "node:fs/promises";
import { prefixedId } from "@tavi/node-kit";
import { connectOwnerOrReport } from "../../cli/owner-connection.js";
import { type CliIo, readStdinLine } from "../../cli/io.js";
import { configOnOwner } from "../../cli/owner.js";

/**
 * `tavi apps …`: Connected apps through
 * the running owner. Connecting an MCP account is `tavi mcp login`'s own
 * sign-in (`runAppsAccountCommand`).
 */
export async function appsCli(options: AppsCommandOptions & { readonly dataDirectory: string }, io: CliIo): Promise<number> {
  const print = (value: unknown, text: string): void => io.stdout(options.format === "json" ? jsonText(value) : terminalText(text));
  const noOwner = (label: string): number => {
    io.stderr(`${label} needs a running owner: start \`tavi serve\`\n`);
    return EXIT.unavailable;
  };
  const send = async (payload: AppsPayload, label: string, render: (result: unknown) => number): Promise<number> => {
    const reads = payload.action === "list" || payload.action === "show" || payload.action === "catalog" || payload.action === "activity";
    const answered = await configOnOwner(options.dataDirectory, "apps", io, {
      label,
      mutates: !reads,
      timeoutMs: payload.action === "add" ? 300_000 : undefined,
      build: () => payload,
      render,
    });
    return answered ?? noOwner(label);
  };
  if (options.action === "payload") {
    let sent = options.payload;
    // `tavi apps client`: the secret comes from its file, read here, never from an argument.
    if (options.secretFile !== undefined && sent.action === "configure") {
      let secret: string;
      try {
        secret = (await readFile(options.secretFile, "utf8")).trim();
      } catch (error) {
        return reportCommandFailure(error, io, "tavi apps client");
      }
      if (secret === "")
        return reportCommandFailure(new TaviError("INVALID_INPUT", `${options.secretFile} is empty`), io, "tavi apps client");
      sent = { ...sent, values: { ...sent.values, clientSecret: secret } };
    }
    // `tavi apps client --file`: the client file is read here and sent whole; the owner reads its id and secret.
    if (options.clientFile !== undefined && sent.action === "configure") {
      let file: string;
      try {
        file = await readFile(options.clientFile, "utf8");
      } catch (error) {
        return reportCommandFailure(error, io, "tavi apps client");
      }
      if (file.trim() === "")
        return reportCommandFailure(new TaviError("INVALID_INPUT", `${options.clientFile} is empty`), io, "tavi apps client");
      if (file.length > CLIENT_FILE_MAX)
        return reportCommandFailure(
          new TaviError("INVALID_INPUT", `${options.clientFile} is too large to be a client file`),
          io,
          "tavi apps client",
        );
      sent = { ...sent, clientFile: file };
    }
    return await send(sent, `tavi apps ${sent.action === "configure" ? "client" : sent.action}`, (result) => {
      print(result, appsAddedText(options.payload, result, { ...(options.needsYou === true ? { needsYou: true } : {}) }));
      return EXIT.ok;
    });
  }
  // `test` and `connect` find the account from the app first.
  const label = `tavi apps ${options.action}`;
  const client = await connectOwnerOrReport(options.dataDirectory, ["apps"], io, EXIT);
  if (typeof client === "number") return client;
  if (client === undefined) return noOwner(label);
  const ask: AppsAsk = async <T>(
    command: "apps" | "mcp" | "channels",
    payload: Readonly<Record<string, unknown>>,
    timeoutMs = 120_000,
  ): Promise<T> => {
    const response = await client.request(command, { ...payload }, prefixedId("apps"), { timeoutMs });
    if (!response.ok)
      throw new TaviError(
        TaviErrorCodeSchema.catch("UNAVAILABLE").parse(response.error?.code),
        response.error?.message ?? `${label} failed`,
      );
    return response.result as T;
  };
  const out = { stdout: (text: string) => io.stdout(terminalText(text)), stderr: (text: string) => io.stderr(terminalText(text)) };
  try {
    await runAppsAccountCommand(options, ask, {
      io: out,
      login: (pluginId, asking, signIn) =>
        runMcpLogin(pluginId, asking, out, {
          open: signIn.open,
          format: signIn.format,
          ...(signIn.port === undefined ? {} : { port: signIn.port }),
          ...(signIn.public === true ? { public: true } : {}),
          ...(signIn.paste === true ? { paste: (signal: AbortSignal) => readStdinLine(signal) } : {}),
        }),
    });
    return EXIT.ok;
  } catch (error) {
    // As the owner's answers to the other actions: a refusal is a usage error, an app or account it cannot find unavailable.
    const failure = TaviError.from(error);
    io.stderr(`${label}: ${failure.code}: ${failure.message}\n`);
    return failure.code === "INVALID_INPUT" || failure.code === "UNSUPPORTED" || failure.code === "CONFLICT"
      ? EXIT.usage
      : EXIT.unavailable;
  } finally {
    client.close();
  }
}

/** An answer in words; an add that switched a server's way in says so first, since its old sign-in or key is gone. */
export function appsAddedText(payload: AppsPayload, result: unknown, options: { readonly needsYou?: boolean } = {}): string {
  const text = appsAnswerText(payload, result, options);
  const switched = (result as { readonly added?: { readonly switched?: { readonly from: string; readonly pluginIds: readonly string[] } } })
    .added?.switched;
  return switched === undefined
    ? text
    : `switched ${switched.pluginIds.join(", ")} from ${switched.from}: its old way in was removed; review its tools again once it is set up\n${text}`;
}

/** The owner, as `tavi apps connect` and `test` ask it; `channels` carries a sign-in's callback back (`runMcpLogin`). */
export type AppsAsk = <T>(
  command: "apps" | "mcp" | "channels",
  payload: Readonly<Record<string, unknown>>,
  timeoutMs?: number,
) => Promise<T>;

export interface AppsAccountDeps {
  readonly io: { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void };
  /** An MCP account's sign-in, as `tavi mcp login` runs it. */
  readonly login: (
    pluginId: string,
    ask: AppsAsk,
    options: {
      readonly open: boolean;
      readonly format: "text" | "json";
      readonly port?: number;
      readonly public?: boolean;
      readonly paste?: boolean;
    },
  ) => Promise<void>;
}

/**
 * `tavi apps connect` and `test`: the account found from the app first. A
 * sign-in is `tavi mcp login`'s own; `--add-account` adds the preset's next
 * account, then signs that one in the same way.
 */
export async function runAppsAccountCommand(
  options: AppsConnectCommandOptions | AppsTestCommandOptions,
  ask: AppsAsk,
  deps: AppsAccountDeps,
): Promise<void> {
  const print = (value: unknown, text: string): void => deps.io.stdout(options.format === "json" ? jsonText(value) : text);
  const { app } = await ask<{ readonly app: ConnectableApp }>("apps", {
    action: "show",
    appId: options.appId,
    workspaceId: options.workspaceId,
  });
  const account =
    options.accountId === undefined ? app.accounts[0] : app.accounts.find((candidate) => candidate.accountId === options.accountId);
  if (options.action === "test") {
    if (account === undefined)
      throw options.accountId === undefined
        ? new TaviError("NOT_FOUND", `${app.name} has no account yet: tavi apps connect ${app.appId}`)
        : noSuchAccount(app, options.accountId);
    const { tested } = await ask<{ readonly tested: { readonly accountId: string; readonly keyChecked?: boolean } }>(
      "apps",
      { action: "test", appId: app.appId, accountId: account.accountId, workspaceId: options.workspaceId },
      180_000,
    );
    const who = account.identity ?? account.label;
    print(
      tested,
      tested.keyChecked === false
        ? `${who} listed its tools; ${app.name} lists them without checking the key, so a wrong key shows only when a tool is first used\n`
        : `${who} answered\n`,
    );
    return;
  }
  if (app.source.kind === "channel")
    throw new TaviError("UNSUPPORTED", `${app.name} is a channel: connect it with \`tavi channels connect\``);
  if (app.auth.kind !== "oauth")
    throw new TaviError("UNSUPPORTED", `${app.name} has no sign-in; its settings are set with \`tavi plugins config\``);
  const signIn = {
    open: options.open,
    format: options.format,
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.public ? { public: true } : {}),
    ...(options.paste ? { paste: true } : {}),
  };
  if (!options.addAccount) {
    if (account === undefined)
      throw options.accountId === undefined
        ? new TaviError("NOT_FOUND", `${app.name} has no account`)
        : noSuchAccount(app, options.accountId);
    await deps.login(account.accountId, ask, signIn);
    return;
  }
  const preset = app.source.preset;
  if (preset === undefined || !(MCP_PRESET_IDS as readonly string[]).includes(preset))
    throw new TaviError(
      "UNSUPPORTED",
      `${app.name} is not a preset: another account of it is added as another server, with \`tavi mcp add\``,
    );
  const { added } = await ask<{ readonly added: { readonly pluginId: string } }>(
    "apps",
    { action: "add", entry: { kind: "preset", id: preset }, workspaceId: options.workspaceId },
    300_000,
  );
  try {
    await deps.login(added.pluginId, ask, signIn);
  } catch (error) {
    // The new account stays, not signed in: said, with both ways on.
    deps.io.stderr(
      `${added.pluginId} was added but is not signed in: sign in with \`tavi apps connect ${app.appId} --account ${added.pluginId}\`, or remove it with \`tavi apps disconnect ${app.appId} --account ${added.pluginId} --remove\`\n`,
    );
    throw error;
  }
}
