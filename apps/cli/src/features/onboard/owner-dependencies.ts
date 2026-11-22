import { localeOf, type ConnectableApp } from "@tavi/contracts";

import { appsOwnerCommand, operatorActor } from "../../server/config-commands.js";
import { channelDescriptors } from "../channels/catalog.js";
import { VIDEO_ENGINE_PLUGIN_ID } from "../plugins/catalog.js";
import { EARLIER_CHAT_KINDS } from "../tasks/notices.js";
import type { TaviRuntime } from "../../runtime/types.js";
import type { OnboardingCommandDependencies } from "./owner.js";
import { liveOnboardingFacts, onboardingModelTarget, serviceState, type OnboardingFactSources } from "./facts.js";
import { credentialsEncrypted } from "../credentials/store.js";
import { chatGptPreviewEnabled } from "./previews.js";

/**
 * What `onboarding` needs from a composed owner: live facts from each family's own services, the Ideas census, and
 * the flows installed — for the IPC command and for `tavi doctor`. Only this
 * owner's own environment can say it runs as a service.
 */
export function ownerOnboardingDependencies(
  runtime: TaviRuntime,
  extras: {
    readonly fromBridge?: boolean;
    readonly config?: OnboardingCommandDependencies["config"];
    readonly launchedWithModel?: boolean;
  } = {},
): OnboardingCommandDependencies {
  const repositories = runtime.store.asPort().repositories;
  const principalOf = (workspaceId: string) => runtime.access.resolveWorkspace(workspaceId)?.principalId;
  // The channels installed now: each built-in one only while its plugin runs, a plugin's withdrawn when its plugin stops.
  const channelKinds = () => channelDescriptors().map((descriptor) => descriptor.providerId);
  const apps = async (workspaceId: string): Promise<readonly ConnectableApp[]> => {
    const answer = await appsOwnerCommand(runtime, { action: "list", workspaceId }, operatorActor(false));
    return answer.ok ? (answer.result as { readonly apps: readonly ConnectableApp[] }).apps : [];
  };
  const sources = (workspaceId: string): OnboardingFactSources => ({
    repositories,
    modelConfig: runtime.store.services.modelConfig,
    credentialRevision: runtime.onboarding.credentialRevision,
    credentialStored: async (reference) => (await runtime.resolveSecret(reference)) !== null,
    principalOf,
    apps,
    externalSearch: runtime.externalSearchIds,
    ...(extras.launchedWithModel === true ? { launchedWithModel: true } : {}),
    channelKinds,
    startedTurn: async (workspace) => {
      const principalId = principalOf(workspace);
      return (
        principalId !== undefined &&
        (await runtime.store.listTaskSessions({ workspaceId: workspace, principalId, chatKinds: [...EARLIER_CHAT_KINDS], limit: 1 })).rows
          .length > 0
      );
    },
    service: async () => {
      const label = (await repositories.onboarding.steps(workspaceId)).find((step) => step.kind === "service")?.createdRef;
      return await serviceState({
        platform: process.platform,
        dataDirectory: runtime.dataDirectory,
        ownerIsService: process.env["TAVI_SERVICE"] === "1",
        ...(label === undefined ? {} : { label }),
      });
    },
    voice: async () => {
      // Off with the video plugin: its decoder is what turns a voice message into audio a transcriber reads.
      if ((await runtime.plugins.registry.disabledBuiltins()).has(VIDEO_ENGINE_PLUGIN_ID))
        return {
          supported: false,
          unsupported: { key: "onboarding.voice.pluginOff", params: { plugin: VIDEO_ENGINE_PLUGIN_ID } },
          ready: false,
          missing: [],
        };
      const { supported, ready, missing } = await runtime.voiceSetup.status();
      return supported
        ? { supported, ready, missing }
        : { supported, unsupported: { key: "onboarding.voice.unsupportedPlatform" }, ready, missing };
    },
    now: () => new Date(runtime.clock.now()),
  });
  return {
    repositories,
    principalOf,
    providers: runtime.onboarding.providers,
    census: runtime.ideas.census,
    channelKinds,
    appIds: async (workspaceId) => (await apps(workspaceId)).filter((app) => app.source.kind !== "channel").map((app) => app.appId),
    facts: async (workspaceId) => await liveOnboardingFacts(sources(workspaceId), workspaceId),
    target: async (connectionId, model) => await onboardingModelTarget(sources("default"), connectionId, model),
    now: () => new Date(runtime.clock.now()),
    locale: async (workspaceId) => localeOf((await repositories.workspaceSettings.get(workspaceId)).settings),
    fromBridge: extras.fromBridge === true,
    // The owner's own environment: a service's holds only TAVI_SERVICE.
    detection: { env: process.env, fetch: globalThis.fetch, service: process.env["TAVI_SERVICE"] === "1" },
    ...(extras.config === undefined ? {} : { config: extras.config }),
    verifyGate: runtime.onboarding.verifyGate,
    signIns: runtime.onboarding.signIns,
    ...(chatGptPreviewEnabled()
      ? {
          chatGpt: {
            signIns: runtime.onboarding.chatGptSignIns,
            encrypted: () => credentialsEncrypted(runtime.dataDirectory),
            kept: () => runtime.onboarding.keptChatGpt(),
          },
        }
      : {}),
  };
}
