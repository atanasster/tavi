import { emitError, emitJson } from "./output.js";
import { EXIT, configRefusalExit, ownerRefusalExit } from "./exit.js";
import { type IpcPayload, TaviError, type ExpectTarget } from "@tavi/contracts";
import { terminalText } from "../shared/terminal-text.js";
import type { IpcClient, IpcClientResponse, DatabaseClient } from "@tavi/runtime";
import { errorMessage } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";
import { connectLiveOwner, connectOwnerOrReport } from "./owner-connection.js";
import type { CliIo } from "./io.js";
import { withStorePreservingOwnership } from "./store.js";

/**
 * Ask a live owner to run a command.
 *
 * Returns `undefined` **only** when no owner is running, which is the single case
 * where opening the data directory directly is legitimate. If an owner is
 * present but cannot be reached, this throws: falling back would make this
 * process a second SQLite writer against a live owner, and the owner must be the directory's only writer.
 */
export async function attachToOwner(
  dataDirectory: string,
  command: string,
  payload: unknown,
  io: CliIo,
  /**
   * How to read the owner's answer, for a command whose result carries a verdict
   * rather than only data. Omitted by every command whose success is its exit 0.
   */
  interpret?: (result: unknown) => number,
  /** The exit for a refusal code this command reads differently from the default mapping. */
  refused?: (code: string | undefined) => number | undefined,
  /** How the answer is written, for a command with a text form; omitted, it is printed as JSON. */
  print?: (result: unknown) => void,
): Promise<number | undefined> {
  // Throws a typed `UNAVAILABLE` for an owner that is present but unusable:
  // never a fallback to the database it holds.
  const client = await connectLiveOwner(dataDirectory, [command]);
  if (client === undefined) return undefined;
  try {
    const response = await client.request(command, payload, `cli-${process.pid}-${Date.now()}`);
    if (!response.ok) {
      io.stderr(`${command} failed: ${response.error?.code}: ${response.error?.message}\n`);
      const own = refused?.(response.error?.code);
      if (own !== undefined) return own;
      return ownerRefusalExit(response.error?.code);
    }
    if (print === undefined) emitJson(io, response.result);
    else print(response.result);
    return interpret === undefined ? EXIT.ok : interpret(response.result);
  } finally {
    client.close();
  }
}

/**
 * The flags a decision cannot carry to a live owner, which keys a decision by
 * its round and resumes the task with its own credentials: refused rather than
 * ignored, since each changes what the offline command would do.
 */
export function ownerRefusesDecisionFlags(
  options: { readonly dataDirectory: string; readonly operationKey?: string; readonly apiKeyFile?: string },
  io: CliIo,
): number | undefined {
  const owned = [
    ...(options.operationKey === undefined ? [] : ["--operation-key"]),
    ...(options.apiKeyFile === undefined ? [] : ["--api-key-file"]),
  ];
  if (owned.length === 0) return undefined;
  io.stderr(
    `An owner is serving ${options.dataDirectory}: a decision on it is keyed by its round, and the task resumes with the ` +
      `owner's credentials, so ${owned.join(" and ")} cannot apply. Omit ${owned.length === 1 ? "it" : "them"}, or stop ` +
      "`tavi serve` to decide offline.\n",
  );
  return EXIT.usage;
}

/** `--connection/--model`, carried to an owner as an assertion of the target the resume runs on. */
export function expectTargetOf(options: { readonly connectionId?: string; readonly model?: string }): { expectTarget?: ExpectTarget } {
  if (options.connectionId === undefined && options.model === undefined) return {};
  return {
    expectTarget: {
      ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
      ...(options.model === undefined ? {} : { model: options.model }),
    },
  };
}

/** A configuration answer can outlast the transport's 5 s: a probe has its own 10 s deadline, and a fire waits for its admission. */
export const CONFIG_TIMEOUT_MS = 30_000;

/** How one command family is sent to a live owner, and its answer read. */
interface OwnerHandlers<C extends OwnerFamily> {
  /** The command as the operator typed it, for the messages: `tavi schedules run-now`, not the IPC action. */
  readonly label: string;
  /** Whether the action writes: a lost answer to a write may still have been applied. */
  readonly mutates: boolean;
  /** Timeout in milliseconds (default: CONFIG_TIMEOUT_MS). */
  readonly timeoutMs?: number | undefined;
  /**
   * The payload to send — or an exit, when the caller refused before sending.
   *
   * Receives the connected client so a family that must read before it writes
   * (`system-prompt`'s compare-and-set revision) can do so on the same
   * connection. Families that need nothing from it simply ignore the argument.
   */
  readonly build: (client: IpcClient) => Promise<IpcPayload<C> | number> | IpcPayload<C> | number;
  readonly render: (result: unknown, client: IpcClient) => Promise<number> | number;
  readonly codes?: Readonly<Record<string, number>>;
  /**
   * How the owner's refusal is reported, when a family reports it as its
   * offline command does rather than as the message alone: the line to print,
   * and the exit.
   */
  readonly refusal?: (
    code: string | undefined,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) => { readonly line: string; readonly exit: number };
  /** Further commands the rendering sends: a fire is followed on its task's stream. */
  readonly follows?: readonly string[];
}

/**
 * A configuration command on a live owner — or `undefined`
 * when none serves the directory, so the caller opens it directly.
 *
 * `build` returns the payload, or the exit of a refusal it reported (a flag the
 * owner cannot honour). The owner's refusal is reported with its own message
 * and the exit the offline command gives it; `codes` names the refusals a
 * family reads differently from `configRefusalExit`.
 */
export async function configOnOwner<C extends OwnerFamily>(
  dataDirectory: string,
  command: C,
  io: CliIo,
  handlers: OwnerHandlers<C>,
): Promise<number | undefined> {
  const client = await connectOwnerOrReport(dataDirectory, [command, ...(handlers.follows ?? [])], io, EXIT);
  if (client === undefined || typeof client === "number") return client;
  // Own keys only: the code is the owner's, and must not resolve `constructor`.
  const exitFor = (code: string | undefined): number =>
    (code !== undefined && handlers.codes !== undefined && Object.hasOwn(handlers.codes, code) ? handlers.codes[code] : undefined) ??
    configRefusalExit(code);
  const what = handlers.label;
  const unknownOutcome = handlers.mutates ? "; the owner may still have applied it — check before running it again" : "";
  try {
    let payload: IpcPayload<C> | number;
    try {
      payload = await handlers.build(client);
    } catch (error) {
      const failure = TaviError.from(error);
      emitError(io, failure.message);
      return exitFor(failure.code);
    }
    if (typeof payload === "number") return payload;
    let response: IpcClientResponse;
    try {
      response = await client.request(command, payload, prefixedId(command), { timeoutMs: handlers.timeoutMs ?? CONFIG_TIMEOUT_MS });
    } catch (error) {
      io.stderr(`${what}: ${errorMessage(error)}${unknownOutcome}\n`);
      return EXIT.unavailable;
    }
    if (!response.ok) {
      if (response.error?.code === "DISCONNECTED") {
        io.stderr(`${what}: the owner closed the connection before answering${unknownOutcome}\n`);
        return EXIT.unavailable;
      }
      // The owner's words reach a terminal: its control characters are removed.
      const message = terminalText(response.error?.message ?? `${what} failed`);
      if (handlers.refusal !== undefined) {
        const reported = handlers.refusal(response.error?.code, message, response.error?.details);
        emitError(io, reported.line);
        return reported.exit;
      }
      emitError(io, message);
      return exitFor(response.error?.code);
    }
    return await handlers.render(response.result, client);
  } finally {
    client.close();
  }
}

/**
 * A command family on a live owner, or, with none serving the directory, on
 * the directory itself: `offline` runs on the store, opened without taking the
 * directory from an owner that is still starting, and a failure there is
 * reported by `failed`.
 */
export async function runFamily<C extends OwnerFamily>(
  dataDirectory: string,
  command: C,
  io: CliIo,
  family: OwnerHandlers<C> & {
    readonly offline: (store: DatabaseClient) => Promise<number>;
    readonly failed: (error: unknown) => number;
  },
): Promise<number> {
  const onOwner = await configOnOwner(dataDirectory, command, io, family);
  if (onOwner !== undefined) return onOwner;
  try {
    return await withStorePreservingOwnership(dataDirectory, family.offline);
  } catch (error) {
    return family.failed(error);
  }
}

/** The command families a configuration command sends to a live owner. */
type OwnerFamily =
  | "models"
  | "credentials"
  | "agents"
  | "projects"
  | "reports"
  | "schedules"
  | "search"
  | "system-prompt"
  | "workspace-settings"
  | "artifacts"
  | "plugins"
  | "mcp"
  | "apps"
  | "permissions"
  | "memory"
  | "reminders"
  | "ideas"
  | "heartbeat"
  | "browser"
  | "chat-context"
  | "reset-instance";

/**
 * An action with no IPC counterpart, under a live owner: refused with the
 * reason, where the direct path would only fail on the ownership lock.
 * `undefined` when no owner serves the directory.
 */
export async function refuseOfflineOnly(dataDirectory: string, what: string, why: string, io: CliIo): Promise<number | undefined> {
  const client = await connectOwnerOrReport(dataDirectory, [], io, EXIT);
  if (client === undefined || typeof client === "number") return client;
  client.close();
  io.stderr(`\`${what}\` is not available on a live owner: ${why}. Stop \`tavi serve\` to run it.\n`);
  return EXIT.alreadyOwned;
}

/**
 * How a config command reports a refusal: the JSON error object on stdout for
 * `--format json`, the message on stderr otherwise, and the refusal's exit code.
 */
export function configFailureReporter(format: string, io: CliIo): (error: unknown) => number {
  return (error) => {
    const failure = TaviError.from(error);
    if (format === "json") {
      emitJson(io, { ok: false, error: { code: failure.code, message: failure.message } });
    } else {
      io.stderr(`${terminalText(failure.message)}\n`);
    }
    return configRefusalExit(failure.code);
  };
}

/** The workspace `tavi serve` composes, and the principal it serves: the owner's only workspace. */
export const OWNER_WORKSPACE = { workspaceId: "default", principalId: "operator" } as const;

/**
 * The principal the owner resolves for `workspaceId` (its `workspacePrincipal`,
 * `access.resolveWorkspace`), for a command run on the data directory with no
 * owner: the served principal in the owner's workspace, nobody elsewhere.
 */
export function ownerWorkspacePrincipal(workspaceId: string): string | undefined {
  return workspaceId === OWNER_WORKSPACE.workspaceId ? OWNER_WORKSPACE.principalId : undefined;
}
