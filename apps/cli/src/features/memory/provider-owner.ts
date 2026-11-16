import {
  BUILTIN_MEMORY_PROVIDER_ID,
  MEMORY_PROVIDER_DISCLOSURE_REASON,
  TaviError,
  describeMemoryDeclaration,
  effectiveMemorySettings,
  memoryPersonalDisclosure,
  withMemoryEgress,
  withMemoryProvider,
  type MemoryEgressField,
  type MemoryPayload,
  type MemoryProviderAnswer,
  type MemoryProviderInfo,
  type MemorySettings,
  type WorkspaceSettingsRepositoryPort,
} from "@tavi/contracts";

import type { MemoryProviderSync } from "./provider-sync.js";
import { readMemoryProviderStatus, type InstalledMemoryProvider, type MemoryProviderRegistry } from "./providers.js";

/**
 * `tavi memory set-provider` and `tavi memory egress`: the workspace's memory provider and what it may
 * receive. Only these change `memory.provider` and `memory.providerEgress`
 * (the `workspace-settings` write refuses them), because each shows what it
 * sends first: choosing an external provider, or turning a switch on, is
 * `APPROVAL_REQUIRED` with the disclosure until it is confirmed. Choosing
 * another provider turns its egress off again (as the heartbeat's).
 *
 * Owner-only: what is installed is the owner's to know, and each change
 * sends the providers what it calls for before it answers (a `full` sync
 * when `records` turns on, removals when `records` or `personal` turns off).
 */
export interface MemoryProviderCommandDependencies {
  readonly settings: WorkspaceSettingsRepositoryPort;
  readonly providers: Pick<MemoryProviderRegistry, "choice" | "get" | "list">;
  readonly sync: Pick<MemoryProviderSync, "fullSync" | "egressNarrowed" | "pendingRemovals">;
  /** Who writes: `operator:cli`, `operator:ui`. */
  readonly actor: string;
  readonly now: () => string;
}

type ProviderPayload = Extract<MemoryPayload, { readonly action: "provider" | "set-provider" | "egress" }>;

const FIELD_TEXT: Record<MemoryEgressField, string> = {
  records: "approved memories of this workspace (never sensitive ones; personal memory only with its own switch), now and as they change",
  conversation: "what you say: each recall's query and the chat spans it drafts proposals from",
  personal: "",
};

/** What turning one switch on sends, for the selected provider. */
function memoryEgressDisclosure(installed: Pick<InstalledMemoryProvider, "id" | "declaration">, field: MemoryEgressField): string {
  const what =
    field === "personal" ? memoryPersonalDisclosure(installed.id) : `Turning ${field} on sends ${installed.id} your ${FIELD_TEXT[field]}.`;
  return `${describeMemoryDeclaration(installed.declaration)} ${what}`;
}

/** What choosing an external provider means: its declaration, and that it receives nothing until a switch is on. */
function memoryProviderDisclosure(installed: Pick<InstalledMemoryProvider, "id" | "declaration">): string {
  return `${describeMemoryDeclaration(installed.declaration)} Every switch starts off: tavi memory egress records|conversation|personal on turns each on, after saying what it sends.`;
}

function info(installed: InstalledMemoryProvider): MemoryProviderInfo {
  // Guarded as doctor reads it: a null answer, a throwing getter or a promise is "not ready", never a failed answer after a committed write.
  const status = readMemoryProviderStatus(installed.provider);
  return {
    id: installed.id,
    kind: installed.kind,
    index: installed.declaration.index,
    capabilities: [...installed.declaration.capabilities],
    receives: [...installed.declaration.receives],
    ...(installed.kind === "plugin" ? { disclosure: describeMemoryDeclaration(installed.declaration) } : {}),
    ...(status === undefined ? {} : { ready: status.ready }),
    ...(status?.indexed === undefined ? {} : { indexed: status.indexed }),
  };
}

export async function memoryProviderAnswer(
  deps: Pick<MemoryProviderCommandDependencies, "settings" | "providers" | "sync">,
  workspaceId: string,
  note?: string,
): Promise<MemoryProviderAnswer> {
  const record = await deps.settings.get(workspaceId);
  const choice = await deps.providers.choice(workspaceId);
  return {
    workspaceId,
    revision: record.revision,
    selected: choice.chosen,
    serving: choice.provider?.id ?? "none",
    ...(choice.fallback === undefined ? {} : { fallback: choice.fallback }),
    egress: choice.egress,
    personalDisclosure: memoryPersonalDisclosure(choice.chosen),
    providers: deps.providers.list().map(info).slice(0, 64),
    pendingRemovals: await deps.sync.pendingRemovals(),
    ...(note === undefined ? {} : { note }),
  };
}

export async function memoryProviderCommand(
  deps: MemoryProviderCommandDependencies,
  workspaceId: string,
  payload: ProviderPayload,
): Promise<MemoryProviderAnswer> {
  if (payload.action === "provider") return await memoryProviderAnswer(deps, workspaceId);
  const current = await deps.settings.get(workspaceId);
  const section = current.settings.memory;
  const before = effectiveMemorySettings(section);
  const write = async (next: MemorySettings): Promise<void> => {
    const { memory: _memory, ...rest } = current.settings;
    await deps.settings.set({
      workspaceId,
      settings: Object.keys(next).length === 0 ? rest : { ...rest, memory: next },
      expectedRevision: payload.expectedRevision ?? current.revision,
      actor: deps.actor,
      now: deps.now(),
    });
  };
  const confirm = (disclosure: string): void => {
    if (payload.confirmed === true) return;
    throw new TaviError("APPROVAL_REQUIRED", `${disclosure} Confirm to go on.`, {
      details: { reason: MEMORY_PROVIDER_DISCLOSURE_REASON, disclosure },
    });
  };

  if (payload.action === "set-provider") {
    const providerId = payload.providerId === "builtin" ? BUILTIN_MEMORY_PROVIDER_ID : payload.providerId;
    if (providerId !== BUILTIN_MEMORY_PROVIDER_ID) {
      const installed = deps.providers.get(providerId);
      // A provider that is not installed here (a typo, one not approved or not enabled) is refused rather than saved to fall back from.
      if (installed === undefined || installed.kind !== "plugin") {
        const choices = deps.providers
          .list()
          .filter((entry) => entry.kind === "plugin")
          .map((entry) => entry.id);
        throw new TaviError("INVALID_INPUT", `No memory provider ${providerId} is installed here (${[...choices, "builtin"].join(", ")})`, {
          details: { providerId },
        });
      }
      if (before.provider !== providerId) confirm(memoryProviderDisclosure(installed));
    }
    if (before.provider === providerId) return await memoryProviderAnswer(deps, workspaceId);
    await write(withMemoryProvider(section, providerId));
    // A new provider is sent its index (when records are on: never, as egress starts off); the old one nothing more.
    await deps.sync.fullSync(providerId);
    const old = before.provider === BUILTIN_MEMORY_PROVIDER_ID ? undefined : before.provider;
    return await memoryProviderAnswer(
      deps,
      workspaceId,
      old === undefined ? undefined : `${old} is sent nothing more; whatever index of its own it kept is the plugin's to clear.`,
    );
  }

  // `egress`: only for the selected external provider, and only what it declares it receives.
  if (before.provider === BUILTIN_MEMORY_PROVIDER_ID) {
    throw new TaviError(
      "INVALID_INPUT",
      "The built-in memory provider receives nothing: select an external one first (tavi memory set-provider <id>)",
      { details: { field: payload.field } },
    );
  }
  const installed = deps.providers.get(before.provider);
  const declared = payload.field === "conversation" ? "conversation" : "records";
  if (payload.on) {
    // Not running here: what it declares cannot be read, so nothing is turned on for it.
    if (installed === undefined)
      throw new TaviError(
        "INVALID_INPUT",
        `The memory provider ${before.provider} is not running here; turn its switches on where it runs`,
        { details: { field: payload.field } },
      );
    if (!installed.declaration.receives.includes(declared))
      throw new TaviError("INVALID_INPUT", `The memory provider ${before.provider} does not ask to receive ${declared}`, {
        details: { field: payload.field },
      });
  }
  const next = withMemoryEgress(section, payload.field, payload.on);
  const after = effectiveMemorySettings(next);
  const widened =
    (payload.field === "records" && after.providerEgress.records && !before.providerEgress.records) ||
    (payload.field === "conversation" && after.providerEgress.conversation && !before.providerEgress.conversation) ||
    (payload.field === "personal" && after.providerEgress.includePersonal && !before.providerEgress.includePersonal);
  if (widened && installed !== undefined) confirm(memoryEgressDisclosure(installed, payload.field));
  await write(next);
  const narrowed =
    (before.providerEgress.records && !after.providerEgress.records) ||
    (before.providerEgress.includePersonal && !after.providerEgress.includePersonal);
  // Records it may no longer hold leave its index now (`egress-off`); records it may now hold are sent whole.
  if (narrowed) await deps.sync.egressNarrowed(workspaceId, before.provider, before);
  else if (widened && payload.field !== "conversation") await deps.sync.fullSync(before.provider);
  return await memoryProviderAnswer(deps, workspaceId);
}
