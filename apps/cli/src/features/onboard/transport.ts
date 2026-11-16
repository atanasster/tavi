import {
  HEARTBEAT_PRODUCTION_OPTIONS,
  TaviError,
  type CredentialsPayload,
  type HeartbeatPayload,
  type IdeasPayload,
  type MemoryPayload,
  type ModelsPayload,
  type OnboardingPayload,
  type SearchPayload,
  type WorkspaceSettingsPayload,
} from "@tavi/contracts";
import { BUILTIN_CHANNELS, createBuiltinOnboardingProvider } from "../plugins/catalog.js";
import { BUILTIN_ONBOARDING_PROVIDER_ID, OnboardingProviderRegistry } from "@tavi/agent-host/onboarding-host";
import { ModelConfigService, type DatabaseClient } from "@tavi/runtime";

import { credentialsCommand, modelsCommand, searchCommand, type ConfigDependencies } from "../../server/config-commands.js";
import { memorySettingsReader, openMemoryService, workspaceSettingsCommand } from "../../server/workspace-settings-commands.js";
import { heartbeatCommand } from "../heartbeat/owner.js";
import { ideasCommand } from "../ideas/owner.js";
import { memoryCommand } from "../memory/owner.js";
import { createLocalCredentialStore, credentialsEncrypted, serializeCredentialAction } from "../credentials/store.js";
import { EARLIER_CHAT_KINDS } from "../tasks/notices.js";
import { answerOf, type OnboardCommand, type OnboardTransport } from "./attached-transport.js";
import { onboardingCommand } from "./owner.js";
import { liveOnboardingFacts, onboardingModelTarget, serviceState, type OnboardingFactSources } from "./facts.js";
import { providerCredentialRevision } from "../models/credential-revision.js";
import { chatGptAwareResolver, revisionValue } from "./chatgpt.js";
import { chatGptPreviewEnabled } from "./previews.js";

export { attachedTransport, type OnboardTransport } from "./attached-transport.js";

/**
 * The data directory opened by this process (no owner runs): the commands as
 * the owner runs them, with this process's credential store. Verify runs
 * `models test` in-process, as offline `tavi models test` does.
 */
export function offlineTransport(
  store: DatabaseClient,
  options: { readonly dataDirectory: string; readonly principalOf: (workspaceId: string) => string | undefined; readonly now?: () => Date },
): OnboardTransport {
  const now = options.now ?? (() => new Date());
  const repositories = store.asPort().repositories;
  const modelConfig = new ModelConfigService(store.asPort());
  const credentials = createLocalCredentialStore(options.dataDirectory);
  // Onboarding's probes: unreadable reads as unset, so a step reports the credential missing rather than failing outright.
  const readSecret = async (reference: string) => await credentials.getSecret(reference).catch(() => null);
  // A model call or discovery on a ChatGPT sign-in sends its access token, renewed and stored when near expiry.
  const modelCredential = chatGptAwareResolver(readSecret, async (reference, value) => await credentials.setSecret(reference, value), {
    serialize: async (work) => await serializeCredentialAction(options.dataDirectory, work),
  });
  const revision = providerCredentialRevision(options.dataDirectory);
  const config: ConfigDependencies = {
    modelConfig,
    repositories,
    dataDirectory: options.dataDirectory,
    videoStatus: async () => ({}),
    target: { source: "placeholder", connectionId: "default", model: "default", workspaceId: "default" },
    startupProviders: [],
    readSecret,
    modelCredential,
    now,
  };
  // As an owner would start: the built-in flow and the channels only while their plugins are enabled. A plugin's
  // flow runs only in an owner, so offline it falls back to the built-in, and the status says so (`flowFallback`).
  let enabled = new Map<string, boolean>();
  const readEnabled = async () => {
    enabled = new Map((await repositories.plugins.listSettings()).settings.map((setting) => [setting.pluginId, setting.enabled]));
  };
  const on = (pluginId: string) => enabled.get(pluginId) !== false;
  const providers = new OnboardingProviderRegistry();
  let uninstallBuiltin: (() => void) | undefined;
  const channelKinds = () => BUILTIN_CHANNELS.filter((channel) => on(channel.pluginId)).map((channel) => channel.descriptor.providerId);
  const sources = (workspaceId: string): OnboardingFactSources => ({
    repositories,
    modelConfig,
    credentialRevision: async (reference) => await revision(reference, revisionValue(await readSecret(reference))),
    credentialStored: async (reference) => (await readSecret(reference)) !== null,
    principalOf: options.principalOf,
    channelKinds,
    startedTurn: async (workspace) => {
      const principalId = options.principalOf(workspace);
      return (
        principalId !== undefined &&
        (await store.listTaskSessions({ workspaceId: workspace, principalId, chatKinds: [...EARLIER_CHAT_KINDS], limit: 1 })).rows.length >
          0
      );
    },
    service: async () => {
      const label = (await repositories.onboarding.steps(workspaceId)).find((step) => step.kind === "service")?.createdRef;
      // Only an owner's own environment says it runs as a service: offline, the unit file alone.
      return await serviceState({
        platform: process.platform,
        dataDirectory: options.dataDirectory,
        ownerIsService: false,
        ...(label === undefined ? {} : { label }),
      });
    },
    now,
  });
  const onboarding = async (payload: OnboardingPayload) => {
    await readEnabled();
    if (on(BUILTIN_ONBOARDING_PROVIDER_ID))
      uninstallBuiltin ??= providers.install(BUILTIN_ONBOARDING_PROVIDER_ID, {
        provider: createBuiltinOnboardingProvider(),
        kind: "builtin",
      });
    else {
      uninstallBuiltin?.();
      uninstallBuiltin = undefined;
    }
    return await onboardingCommand(
      {
        repositories,
        principalOf: options.principalOf,
        providers,
        // Offline no tool is registered: the census is what an owner takes.
        census: async () => [],
        channelKinds,
        appIds: async () => [],
        facts: async (workspaceId) => await liveOnboardingFacts(sources(workspaceId), workspaceId),
        target: async (connectionId, model) => await onboardingModelTarget(sources("default"), connectionId, model),
        now,
        config: {
          credentials: async (payload) => await credentialsCommand(config, payload),
          models: async (payload) => await modelsCommand(config, payload),
        },
        // The terminal signs in itself and hands the record over; the canvas's loopback sign-ins are an owner's.
        ...(chatGptPreviewEnabled() ? { chatGpt: { encrypted: () => credentialsEncrypted(options.dataDirectory) } } : {}),
        // This process's own environment and local servers, as the terminal sees them: the Ollama recommendation applies offline too.
        detection: { env: process.env, fetch: globalThis.fetch },
      },
      payload,
    );
  };
  return {
    attached: false,
    request: async <T>(command: OnboardCommand, payload: unknown): Promise<T> => {
      switch (command) {
        case "onboarding":
          return answerOf<T>(await onboarding(payload as OnboardingPayload));
        case "models":
          return answerOf<T>(await modelsCommand(config, payload as ModelsPayload));
        case "credentials":
          return answerOf<T>(await credentialsCommand(config, payload as CredentialsPayload));
        case "workspace-settings":
          return answerOf<T>(await workspaceSettingsCommand(config, payload as WorkspaceSettingsPayload));
        case "search":
          return answerOf<T>(await searchCommand(config, payload as SearchPayload));
        case "memory": {
          const port = store.asPort();
          return answerOf<T>(
            await memoryCommand(
              {
                memory: openMemoryService(port, memorySettingsReader(repositories.workspaceSettings)),
                repositories,
                principalOf: options.principalOf,
                fromBridge: false,
                now,
              },
              payload as MemoryPayload,
            ),
          );
        }
        case "heartbeat":
          return answerOf<T>(
            await heartbeatCommand(
              {
                repositories,
                principalOf: options.principalOf,
                options: HEARTBEAT_PRODUCTION_OPTIONS,
                providers: () => [],
                host: () => undefined,
                author: "cli",
                now,
              },
              payload as HeartbeatPayload,
            ),
          );
        case "ideas":
          return answerOf<T>(await ideasCommand({ repositories, principalOf: options.principalOf, now }, payload as IdeasPayload));
        case "channels":
          throw new TaviError("UNAVAILABLE", "a channel needs a running owner: start `tavi serve`, then run this again");
      }
    },
  } as OnboardTransport;
}
