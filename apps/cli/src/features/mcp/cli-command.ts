import { emitJson, jsonText } from "../../cli/output.js";
import { EXIT, reportCommandFailure } from "../../cli/exit.js";
import {
  type PluginsPayload,
  type PluginView,
  MCP_PLUGIN_PREFIX,
  mcpBlockLines,
  type McpPayload,
  TaviErrorCodeSchema,
  TaviError,
  DEFAULT_WORKSPACE_ID,
} from "@tavi/contracts";
import { PluginRegistry } from "@tavi/runtime";
import { BUILTIN_PLUGINS } from "../plugins/catalog.js";
import { runPluginAction } from "../plugins/actions.js";
import { terminalText } from "../../shared/terminal-text.js";
import type { McpCommandOptions } from "./parse.js";
import { writeMcpPluginDirectory } from "./add.js";
import { otherWayInRefusal, otherWaysIn } from "./presets/index.js";
import { runMcpLogin } from "./login-client.js";
import { registryOf, reviewText, runMcpAction, serverListText, type McpServerList, type McpAnswer } from "./actions.js";
import { MCP_REGISTRY_SETTING, type RegistryEntry } from "./registry.js";
import { readServerLog } from "./logs.js";
import { npmResolver, planMcpImport, pypiResolver, type McpImportPlan } from "./import.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { definedOnly } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";
import { join, resolve } from "node:path";
import { connectOwnerOrReport } from "../../cli/owner-connection.js";
import { type CliIo, readStdinLine } from "../../cli/io.js";
import { configOnOwner } from "../../cli/owner.js";
import { withStorePreservingOwnership } from "../../cli/store.js";
import { offlineMcpContext } from "./offline-context.js";

/** The registry address the owner searches: asked of a running owner (which holds the data directory), read from it otherwise. */
async function registryUrlOf(dataDirectory: string, io: CliIo): Promise<string | undefined> {
  let url: string | undefined;
  const onOwner = await configOnOwner(dataDirectory, "mcp", io, {
    label: "tavi mcp add",
    mutates: false,
    build: () => ({ action: "registry", reset: false }),
    render: (result) => {
      url = (result as { readonly registry: { readonly url: string } }).registry.url;
      return EXIT.ok;
    },
  });
  if (onOwner === undefined)
    return await withStorePreservingOwnership(dataDirectory, async (store) => await store.getMeta(MCP_REGISTRY_SETTING));
  if (onOwner !== EXIT.ok || url === undefined) throw new TaviError("UNAVAILABLE", "the running owner did not name its MCP Registry");
  return url;
}

/** A page of the MCP Registry as `tavi mcp search` prints it: each entry, its labels, and the `add` for each way in. */
function discoverText(discover: { readonly registry: string; readonly entries: readonly RegistryEntry[]; readonly next?: string }): string {
  if (discover.entries.length === 0) return `no server found in ${discover.registry}\n`;
  const lines = discover.entries.flatMap((entry) => [
    `${entry.name} ${entry.version}${entry.title === undefined ? "" : ` — ${entry.title}`} [${entry.labels.join(", ") || "not installable"}]`,
    ...(entry.description === "" ? [] : [`  ${entry.description}`]),
    ...entry.options.map(
      (option) =>
        `  tavi mcp add ${entry.slug} --registry ${entry.name}@${entry.version} --option ${option.key}   # ${option.summary}${option.credentials.length + option.settings.length === 0 ? "" : `; then set ${[...option.settings, ...option.credentials].join(", ")}`}`,
    ),
    ...entry.unsupported.map((why) => `  not added: ${why}`),
  ]);
  return `${lines.join("\n")}\n${discover.next === undefined ? "" : `more: tavi mcp search … --cursor ${discover.next}\n`}The registry's listings are their publishers' words, not a reason to trust a server: each is probed and reviewed when added.\n`;
}

/**
 * `tavi mcp …`: `add` writes the server's plugin
 * directory and installs it as a proposed version, as `tavi plugins install`
 * does, then probes it unless told not to; the other actions are the `mcp`
 * family, answered by the running owner when there is one and on the data
 * directory otherwise.
 */
/** The CLI's own entry, which `remove-all` and `import` run the commands they print through. */
type CliEntry = (argv: readonly string[], io: CliIo) => Promise<number>;

export async function mcpCommand(
  options: McpCommandOptions & { readonly dataDirectory: string },
  io: CliIo,
  main: CliEntry,
): Promise<number> {
  const print = (value: unknown, text: string): void => io.stdout(options.format === "json" ? jsonText(value) : terminalText(text));
  const run = async (payload: McpPayload, label: string, render: (answer: McpAnswer) => number): Promise<number> => {
    const reads =
      payload.action === "show" ||
      payload.action === "list" ||
      payload.action === "search" ||
      (payload.action === "registry" && payload.url === undefined && !payload.reset);
    const onOwner = await configOnOwner(options.dataDirectory, "mcp", io, {
      label,
      mutates: !reads,
      timeoutMs: payload.action === "probe" ? 120_000 : undefined,
      build: () => payload,
      render: (result) => render(result as McpAnswer),
    });
    if (onOwner !== undefined) return onOwner;
    return withStorePreservingOwnership(options.dataDirectory, async (store) =>
      render(await runMcpAction(offlineMcpContext(store, options.dataDirectory), payload, "operator:cli")),
    );
  };
  const renderAnswer = (answer: McpAnswer): number => {
    if ("review" in answer) print(answer.review, reviewText(answer.review));
    else if ("verified" in answer)
      print(
        answer.verified,
        answer.verified.ok
          ? `${answer.verified.pluginId}@${answer.verified.version}: ${String(answer.verified.files)} files as approved (${String(answer.verified.rehashed)} re-hashed)\n`
          : `${answer.verified.pluginId}@${answer.verified.version}: ${answer.verified.problem ?? "not as approved"}\n`,
      );
    else if ("people" in answer)
      print(
        answer.people,
        `${answer.people.pluginId}: other people's chats in ${answer.people.workspaceId} ${answer.people.on ? "are offered its tools, which run with your credentials" : "are not offered its tools"}${answer.people.allowed ? "" : ` (it is not in ${answer.people.workspaceId}'s mcp.servers yet)`}\n`,
      );
    else if ("servers" in answer) print(answer.servers, serverListText(answer.servers));
    else if ("switched" in answer)
      print(
        answer.switched,
        answer.switched.on
          ? "MCP is on: approved, enabled servers' tools are offered\n"
          : "MCP is off: every server stopped and its tools withdrawn\n",
      );
    else if ("added" in answer) print(answer.added, `added ${answer.added.pluginId}@${answer.added.version}\n`);
    else if ("logs" in answer) print(answer.logs, `${answer.logs.lines.join("\n")}\n`);
    else if ("login" in answer) print(answer.login, `sign in at ${answer.login.authorizeUrl}\n`);
    else if ("loginStatus" in answer) print(answer.loginStatus, `${answer.loginStatus.pluginId}: ${answer.loginStatus.state}\n`);
    else if ("loggedOut" in answer)
      print(
        answer.loggedOut,
        !answer.loggedOut.hadGrant
          ? `${answer.loggedOut.pluginId} was not signed in\n`
          : answer.loggedOut.confirmed
            ? `${answer.loggedOut.pluginId} signed out: its sign-in revoked at the server, and forgotten\n`
            : `${answer.loggedOut.pluginId} signed out: its sign-in forgotten here, but the server did not confirm revoking it (revoke Tavi's access in the server's own settings)\n`,
      );
    else if ("line" in answer)
      print(
        answer.line,
        `${answer.line.pluginId}'s tools.search line${answer.line.operator ? "" : " (Tavi's own)"}: ${answer.line.text}\n`,
      );
    else if ("discover" in answer) print(answer.discover, discoverText(answer.discover));
    else if ("registry" in answer)
      print(answer.registry, `MCP Registry: ${answer.registry.url}${answer.registry.official ? " (the official one)" : ""}\n`);
    else if ("finished" in answer) print(answer.finished, `${answer.finished.message}\n`);
    else if ("cancelled" in answer)
      print(answer.cancelled, answer.cancelled.cancelled ? "sign-in cancelled\n" : "that sign-in was not waiting\n");
    else print(answer.rejected, `${answer.rejected.pluginId}@${answer.rejected.version} rejected\n`);
    return "verified" in answer && !answer.verified.ok ? EXIT.taskFailed : EXIT.ok;
  };
  if (options.action === "logs") {
    // The log is a file the owner appends to: read here, owner or not.
    const lines = await readServerLog(options.dataDirectory, options.pluginId, options.lines);
    print({ pluginId: options.pluginId, lines }, lines.length === 0 ? `no log for ${options.pluginId} yet\n` : `${lines.join("\n")}\n`);
    return EXIT.ok;
  }
  if (options.action === "login") {
    // A login comes back to the running owner: through its loopback listener here, or its public address.
    const client = await connectOwnerOrReport(options.dataDirectory, ["mcp"], io, EXIT);
    if (typeof client === "number") return client;
    if (client === undefined) {
      io.stderr("tavi mcp login needs a running owner: start `tavi serve`, then log in\n");
      return EXIT.unavailable;
    }
    try {
      await runMcpLogin(
        options.pluginId,
        async <T>(command: "mcp" | "channels", payload: Readonly<Record<string, unknown>>): Promise<T> => {
          const response = await client.request(command, { ...payload }, prefixedId("mcp-login"), { timeoutMs: 120_000 });
          if (!response.ok)
            throw new TaviError(
              TaviErrorCodeSchema.catch("UNAVAILABLE").parse(response.error?.code),
              response.error?.message ?? "tavi mcp login failed",
            );
          return response.result as T;
        },
        { stdout: (text) => io.stdout(terminalText(text)), stderr: (text) => io.stderr(terminalText(text)) },
        {
          open: options.open,
          format: options.format,
          ...(options.port === undefined ? {} : { port: options.port }),
          ...(options.public === true ? { public: true } : {}),
          ...(options.paste === true ? { paste: (signal: AbortSignal) => readStdinLine(signal) } : {}),
        },
      );
      return EXIT.ok;
    } catch (error) {
      return reportCommandFailure(error, io, "tavi mcp login");
    } finally {
      client.close();
    }
  }
  if (options.action === "remove-all") {
    // Before a downgrade: the commands, or with --yes each server disabled and removed through them.
    try {
      let listed: McpServerList | undefined;
      const code = await run({ action: "list", workspaceId: DEFAULT_WORKSPACE_ID }, "tavi mcp remove-all", (answer) => {
        if ("servers" in answer) listed = answer.servers;
        return EXIT.ok;
      });
      if (code !== EXIT.ok || listed === undefined) return code;
      const at = ["--data-dir", options.dataDirectory, "--format", options.format];
      const commands = listed.servers.flatMap((server) => [
        ...(server.enabled ? [["plugins", "disable", server.pluginId]] : []),
        ["plugins", "remove", server.pluginId],
      ]);
      if (!options.yes) {
        print(
          { commands: commands.map((argv) => `tavi ${argv.join(" ")}`) },
          commands.length === 0
            ? "no MCP servers to remove\n"
            : `${commands.map((argv) => `tavi ${argv.join(" ")}`).join("\n")}\n(run them, or tavi mcp remove-all --yes)\n`,
        );
        return EXIT.ok;
      }
      for (const argv of commands) {
        const removed = await main([...argv, ...at], io);
        if (removed !== EXIT.ok) return removed;
      }
      return EXIT.ok;
    } catch (error) {
      return reportCommandFailure(error, io, "tavi mcp remove-all");
    }
  }
  if (options.action === "import") return mcpImport(options, io, run, main);
  if (options.action === "payload") {
    try {
      return await run(options.payload, `tavi mcp ${options.payload.action}`, renderAnswer);
    } catch (error) {
      return reportCommandFailure(error, io, `tavi mcp ${options.payload.action}`);
    }
  }
  if (!options.probe && options.sandbox !== undefined) {
    io.stderr("tavi mcp add: --nested and --unsandboxed are recorded by the probe; give them to `tavi mcp probe` instead of --no-probe\n");
    return EXIT.usage;
  }
  // A plugins action on the running owner, else on the data directory's store.
  const onPlugins = async (payload: PluginsPayload, mutates: boolean, render: (answer: unknown) => number): Promise<number> =>
    (await configOnOwner(options.dataDirectory, "plugins", io, { label: "tavi mcp add", mutates, build: () => payload, render })) ??
    (await withStorePreservingOwnership(options.dataDirectory, async (store) => {
      const registry = new PluginRegistry({
        client: store,
        directory: join(options.dataDirectory, "plugins"),
        builtins: BUILTIN_PLUGINS,
      });
      return render(await runPluginAction(registry, payload, "operator:cli", undefined));
    }));
  // A preset beside a server its other way in added (Todoist's sign-in or token) is refused before anything is written.
  if (options.form.kind === "preset" && otherWaysIn(options.form.preset).length > 0) {
    const preset = options.form.preset;
    try {
      const checked = await onPlugins({ action: "list" }, false, (answer) => {
        const refused = otherWayInRefusal((answer as { readonly plugins: readonly PluginView[] }).plugins, preset);
        return refused === undefined ? EXIT.ok : reportCommandFailure(refused, io, "tavi mcp add");
      });
      if (checked !== EXIT.ok) return checked;
    } catch (error) {
      return reportCommandFailure(error, io, "tavi mcp add");
    }
  }
  let written: Awaited<ReturnType<typeof writeMcpPluginDirectory>>;
  try {
    written = await writeMcpPluginDirectory(
      {
        slug: options.slug,
        form:
          options.form.kind === "dir" || options.form.kind === "command" || options.form.kind === "mcpb"
            ? { ...options.form, path: resolve(options.form.path) }
            : options.form,
        env: options.env,
        ...(options.secrets === undefined ? {} : { credentials: options.secrets }),
        domains: options.domains,
        read: options.read.map((path) => resolve(path)),
        write: options.write.map((path) => resolve(path)),
        ...definedOnly({
          exposure: options.exposure,
          version: options.version,
          name: options.name,
          description: options.description,
        }),
      },
      {
        dataDirectory: options.dataDirectory,
        // A registry entry is read again from the registry the owner searches: a running owner names it, the data directory otherwise.
        ...(options.form.kind === "registry"
          ? {
              registry: await registryOf({
                registryUrl: { get: () => registryUrlOf(options.dataDirectory, io), set: async () => undefined },
              }),
            }
          : {}),
      },
    );
  } catch (error) {
    return reportCommandFailure(error, io, "tavi mcp add");
  }
  const install: PluginsPayload = { action: "install", path: written.directory };
  const launchLines = written.manifest.mcp === undefined ? [] : mcpBlockLines(written.manifest.mcp).map((line) => `  ${line}`);
  let added: { readonly pluginId: string; readonly version: string; readonly reviewState?: string; readonly created?: boolean } | undefined;
  const renderInstall = (answer: unknown): number => {
    added = (answer as { readonly result: NonNullable<typeof added> }).result;
    const credentials = Object.entries(written.manifest.config)
      .filter(([, field]) => field.type === "credential")
      .map(([name]) => name);
    const values = Object.entries(written.manifest.config)
      .filter(([, field]) => field.type !== "credential")
      .map(([name]) => name);
    print(
      added,
      [
        `added ${added.pluginId}@${added.version} (${added.reviewState ?? "proposed"}${added.created === false ? ", already installed" : ""})`,
        // The probe's review starts with the launch spec: printed here only when no review follows.
        ...(options.probe ? [] : launchLines),
        ...written.notes.map((line) => `  ${line}`),
        ...(credentials.length === 0
          ? []
          : [
              `credentials to set: ${credentials.join(", ")} (\`tavi credentials set plugins.${added.pluginId}.<name>\`, then \`tavi plugins config ${added.pluginId} --set <name>=plugins.${added.pluginId}.<name>\`)`,
            ]),
        ...(values.length === 0
          ? []
          : [`settings to set: ${values.join(", ")} (\`tavi plugins config ${added.pluginId} --set <name>=<value>\`)`]),
      ].join("\n") + "\n",
    );
    return EXIT.ok;
  };
  try {
    const installed = await onPlugins(install, true, renderInstall);
    if (installed !== EXIT.ok || added === undefined) return installed;
  } catch (error) {
    return reportCommandFailure(error, io, "tavi mcp add");
  } finally {
    rmSync(written.directory, { recursive: true, force: true });
  }
  if (!options.probe) {
    io.stdout(terminalText(`not probed: \`tavi mcp probe ${added.pluginId}\` lists its tools for review\n`));
    return EXIT.ok;
  }
  // The probe runs the server's code: in the sandbox state chosen here, and only once its settings are set.
  const probe: McpPayload = {
    action: "probe",
    pluginId: added.pluginId,
    version: added.version,
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
  };
  try {
    return await run(probe, "tavi mcp probe", renderAnswer);
  } catch (error) {
    const failure = TaviError.from(error);
    // No review was printed: the launch spec is said here instead.
    if (launchLines.length > 0) io.stdout(terminalText(`${launchLines.join("\n")}\n`));
    io.stderr(
      terminalText(
        `not probed yet: ${failure.message}\nprobe it with \`tavi mcp probe ${added.pluginId}${options.sandbox === "none" ? " --unsandboxed" : options.sandbox === "nested" ? " --nested" : ""}\` once that is fixed\n`,
      ),
    );
    return EXIT.ok;
  }
}

/** The largest client file `tavi mcp import` reads. */
const MCP_IMPORT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * `tavi mcp import <file>`: each server
 * the file names, proposed through the same commands an operator would type —
 * `tavi mcp add`, `tavi credentials set` from a 0600 file removed at once,
 * `tavi plugins config`, and the probe once nothing is left to set. Nothing is
 * approved; the source file is only read.
 */
async function mcpImport(
  options: Extract<McpCommandOptions, { action: "import" }> & { readonly dataDirectory: string },
  io: CliIo,
  run: (payload: McpPayload, label: string, render: (answer: McpAnswer) => number) => Promise<number>,
  main: CliEntry,
): Promise<number> {
  let plan: McpImportPlan;
  try {
    const path = resolve(options.file);
    if (!existsSync(path) || !statSync(path).isFile()) throw new TaviError("NOT_FOUND", `no file at ${path}`);
    if (statSync(path).size > MCP_IMPORT_MAX_BYTES)
      throw new TaviError("INVALID_INPUT", `${path} is larger than ${String(MCP_IMPORT_MAX_BYTES / 1024 / 1024)} MiB`);
    let listed: McpServerList | undefined;
    const code = await run({ action: "list", workspaceId: DEFAULT_WORKSPACE_ID }, "tavi mcp import", (answer) => {
      if ("servers" in answer) listed = answer.servers;
      return EXIT.ok;
    });
    if (code !== EXIT.ok || listed === undefined) return code;
    const taken = new Set(listed.servers.map((server) => server.pluginId.slice(MCP_PLUGIN_PREFIX.length)));
    plan = await planMcpImport(readFileSync(path, "utf8"), { taken, resolve: npmResolver(), resolvePypi: pypiResolver() });
  } catch (error) {
    return reportCommandFailure(error, io, "tavi mcp import");
  }
  const json = options.format === "json";
  const say = (text: string): void => {
    if (!json) io.stdout(terminalText(text));
  };
  // What is shown never includes a secret's value: only the setting it moved to.
  const shown = (proposal: McpImportPlan["proposals"][number]) => ({
    name: proposal.name,
    pluginId: `${MCP_PLUGIN_PREFIX}${proposal.slug}`,
    add: `tavi mcp add ${proposal.slug} ${proposal.args.join(" ")}`,
    credentials: proposal.secrets.map((secret) => secret.setting),
    toSet: proposal.unset,
    notes: proposal.notes,
  });
  for (const skip of plan.skipped)
    say(`skipped ${skip.name}: ${skip.reason}
`);
  if (options.dryRun) {
    if (json)
      io.stdout(`${JSON.stringify({ proposals: plan.proposals.map(shown), skipped: plan.skipped }, null, 2)}
`);
    for (const proposal of plan.proposals) {
      const view = shown(proposal);
      say(
        [
          `would add ${view.pluginId}: ${view.add}`,
          ...(view.credentials.length === 0 ? [] : [`  secrets moved into credentials: ${view.credentials.join(", ")}`]),
          ...(view.toSet.length === 0 ? [] : [`  to set after: ${view.toSet.join(", ")}`]),
          ...view.notes.map((note) => `  ${note}`),
        ].join("\n") + "\n",
      );
    }
    return EXIT.ok;
  }
  const at = ["--data-dir", options.dataDirectory];
  // In JSON mode each command's own output is held back: the summary below is the answer.
  const quiet: CliIo = json ? { ...io, stdout: () => undefined } : io;
  const added: { readonly name: string; readonly pluginId: string; readonly probed: boolean; readonly toSet: readonly string[] }[] = [];
  const failed: { readonly name: string; readonly step: string }[] = [];
  const staging = join(options.dataDirectory, "mcp", ".import");
  for (const proposal of plan.proposals) {
    const pluginId = `${MCP_PLUGIN_PREFIX}${proposal.slug}`;
    say(`${proposal.name} → ${pluginId}\n`);
    for (const note of proposal.notes) say(`  ${note}\n`);
    if ((await main(["mcp", "add", proposal.slug, "--no-probe", ...at, ...proposal.args], quiet)) !== EXIT.ok) {
      failed.push({ name: proposal.name, step: "add" });
      continue;
    }
    // Each secret goes in through a 0600 file that lives only for its own `credentials set`.
    let stored = true;
    const references: string[] = [];
    for (const secret of proposal.secrets) {
      const reference = `plugins.${pluginId}.${secret.setting}`;
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      const file = join(staging, randomUUID());
      try {
        writeFileSync(file, secret.value, { mode: 0o600, flag: "wx" });
        if ((await main(["credentials", "set", reference, "--file", file, ...at], quiet)) !== EXIT.ok) stored = false;
      } finally {
        rmSync(file, { force: true });
      }
      references.push(`${secret.setting}=${reference}`);
    }
    if (
      !stored ||
      (references.length > 0 &&
        (await main(["plugins", "config", pluginId, ...references.flatMap((pair) => ["--set", pair]), ...at], quiet)) !== EXIT.ok)
    ) {
      failed.push({ name: proposal.name, step: "credentials" });
      continue;
    }
    // A server that still needs a setting, or a login, is probed once that is done.
    const probe = options.probe && proposal.unset.length === 0 && !proposal.args.includes("--oauth");
    const probed = probe && (await main(["mcp", "probe", pluginId, ...at], quiet)) === EXIT.ok;
    if (proposal.unset.length > 0)
      say(`  set ${proposal.unset.join(", ")} with \`tavi plugins config ${pluginId} --set\`, then \`tavi mcp probe ${pluginId}\`\n`);
    added.push({ name: proposal.name, pluginId, probed, toSet: proposal.unset });
  }
  rmSync(staging, { recursive: true, force: true });
  if (json) emitJson(io, { added, failed, skipped: plan.skipped });
  else
    say(
      `${String(added.length)} proposed, ${String(plan.skipped.length)} skipped${failed.length === 0 ? "" : `, ${String(failed.length)} failed (${failed.map((entry) => `${entry.name} at ${entry.step}`).join(", ")})`}; nothing is approved: \`tavi mcp review <id>\`, then \`tavi mcp approve\`\n`,
    );
  return failed.length === 0 ? EXIT.ok : EXIT.taskFailed;
}
