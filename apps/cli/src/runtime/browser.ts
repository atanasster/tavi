import { SiteSkillRegistry, ToolRegistry, pinnedFetch, readPluginSiteProfiles, ownerStagingDirectory } from "@tavi/runtime";
import { setTimeout as sleepFor } from "node:timers/promises";
import {
  type ChromiumSandboxMode,
  type HostFileIdentity,
  type InvocationContext,
  browserDownloadMaxMiB,
  browserSessionIdleMinutes,
  effectiveNoThumbnailHosts,
  type TaskFindingRepositoryPort,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { join } from "node:path";
import { createFolderPromotion } from "../features/folders/promotion.js";
import { createEgressCheck, listedAddresses } from "../features/browser/address-guard.js";
import { createOwnerBrowser, createOwnerLiveSource, ownerBrowserIdentity, ownerBrowserInstalled } from "../features/browser/host.js";
import { folderFileReader, folderFileTaint } from "../features/folders/fs-tools.js";
import { WORKLOAD_DEFAULTS, ownerDenyRead } from "../features/sandbox/host.js";
import { APPS_SITES_SETTING, parseSites, type SitesOn } from "../features/apps/sharing.js";
import {
  type SitePluginSource,
  createRobotsReader,
  createSitePolicy,
  enabledSiteProfiles,
  keepingFindings,
} from "../features/browser/site-policy.js";
import { SITE_NOTES_DIRECTORY, enabledSiteNotes, type EnabledSiteNote } from "../features/browser/site-notes.js";
import { SITE_NOTES_ENTRY, showSiteNotes } from "../features/browser/site-skills-host.js";
import { browserDisplay, browserProfileDirectory } from "../features/browser/profile.js";
import { createRecipeRecorder } from "../features/browser/site-recipes.js";
import { registerBrowserTools } from "../features/sandbox/tools.js";
import type { BrowserBoundary } from "./types.js";
import type { SandboxContext } from "./sandbox.js";

/** The browser and its live view, site recipes and policy, the file tools' options, and the browser tools. */
export function composeBrowser(composed: SandboxContext) {
  const { clock, confinement, folderSpace, late, limits, logger, options, overrides, persistencePort, store } = composed;
  // The live browser view: nothing
  // streams until someone watches, and nothing streamed is kept.
  const liveSource =
    overrides.liveOverride ??
    createOwnerLiveSource({
      onError: (error) => logger.warn("live browser view failed", { error: errorMessage(error) }),
    });
  // Chromium confined on Linux: headless, unless the operator switched the sandbox off. Chromium cannot start
  // inside srt on macOS, where its own sandbox is the boundary; a headed window on Linux runs as before.
  const confineBrowser = process.platform === "linux" && browserDisplay() === "headless" && options.sandboxPinnedOff !== true;
  let browserMode: ChromiumSandboxMode | undefined;
  const browserBoundary = (): BrowserBoundary => {
    const display = browserDisplay();
    if (!confineBrowser) {
      const why =
        process.platform === "darwin"
          ? "Chromium cannot start inside srt on macOS; Chromium's own sandbox is the boundary"
          : process.platform === "win32"
            ? "Chromium's own sandbox is the boundary, as on macOS; names resolve only through Tavi's proxy, and Windows sign-in is never offered to a site"
            : process.platform !== "linux"
              ? "the browser is confined only on Linux"
              : display === "headed"
                ? "a headed window (TAVI_BROWSER_HEADED=1) runs outside srt, with Chromium's own sandbox where the host allows it"
                : "the sandbox is switched off; Chromium's own sandbox is the boundary where the host allows it";
      return { display, confined: false, why };
    }
    const cap = WORKLOAD_DEFAULTS.browser.memoryBytes;
    const aggregate = limits.capabilities().aggregateMemoryBytes;
    return {
      display,
      confined: true,
      chromiumSandbox: browserMode ?? "chosen at the first launch",
      memory: { capBytes: cap, ...(aggregate === undefined ? {} : { aggregateBytes: aggregate, fits: aggregate >= cap }) },
    };
  };
  const allowedHostsOption = options.browserAllowedHosts === undefined ? {} : { allowedHosts: options.browserAllowedHosts };
  const linuxChromium = process.env["TAVI_BROWSER_LINUX_CHROMIUM"];
  if (
    confineBrowser &&
    linuxChromium !== undefined &&
    linuxChromium !== "" &&
    linuxChromium !== "headless-shell" &&
    linuxChromium !== "auto"
  )
    logger.warn("TAVI_BROWSER_LINUX_CHROMIUM is neither auto nor headless-shell, and is ignored", { value: linuxChromium });
  const browserSettings = async (workspaceId: string) => {
    try {
      return (await persistencePort.repositories.workspaceSettings.get(workspaceId)).settings;
    } catch (error) {
      logger.warn("the browser could not read its workspace settings; it keeps its defaults", { workspaceId, error: errorMessage(error) });
      throw error;
    }
  };
  // Which frames a session may read is the browser tools' decision, known once they are registered below; none until then.
  let frameHostAllowed: (frameOrigin: string, pageUrl: string, sessionId: string) => boolean = () => false;
  const browser =
    overrides.browserOverride ??
    createOwnerBrowser({
      // A profile per workspace, the operator's locale and zone, and a browser that says it is Chrome.
      display: browserDisplay(),
      ...(confineBrowser
        ? {
            confinement: {
              confinement,
              limits,
              // srt reads by deny list on Linux: every folder the owner gives a chat is denied to the browser too.
              denyRead: ownerDenyRead(options),
              scratchDirectory: join(options.dataDirectory, "browser-scratch"),
              ...(options.sandboxNested === true ? { nested: true } : {}),
              // `TAVI_BROWSER_LINUX_CHROMIUM=headless-shell`: Playwright's headless shell only.
              ...(linuxChromium === "headless-shell" ? { chromium: "headless-shell" as const } : {}),
              // The private network is held off at srt's proxy, but for the addresses the operator opened.
              privateAddresses: { except: listedAddresses(options.browserAllowedHosts ?? []) },
              onMode: (mode, failures) => {
                browserMode = mode;
                // A weaker Chromium sandbox than the full one is said where an operator looks: nothing weakens quietly.
                if (mode === "full") logger.info("the browser runs confined", { chromiumSandbox: mode });
                else
                  logger.warn(
                    `the browser runs confined with Chromium's ${mode === "none" ? "sandbox off (srt alone)" : "seccomp layer only"}`,
                    { chromiumSandbox: mode, strongerFailed: failures },
                  );
              },
            },
          }
        : {}),
      identity: ownerBrowserIdentity(),
      profileDirectory: (workspaceId) => browserProfileDirectory(options.dataDirectory, workspaceId),
      onWarning: (message) => logger.warn(message),
      stagingDirectory: ownerStagingDirectory(),
      live: liveSource,
      artifacts: persistencePort.repositories.artifacts,
      pdf: () => late.pdfService,
      // Browser history and card thumbnails.
      history: persistencePort.repositories.browserHistory,
      now: () => clock.now(),
      noThumbnailHosts: async (workspaceId) =>
        effectiveNoThumbnailHosts((await persistencePort.repositories.workspaceSettings.get(workspaceId)).settings),
      // The workspace's `browser.sessionIdleMinutes` and `browser.downloadMaxMiB`: a settings read that fails is said, and the
      // browser keeps its default.
      sessionIdleMinutes: async (workspaceId) => browserSessionIdleMinutes(await browserSettings(workspaceId)),
      downloadMaxMiB: async (workspaceId) => browserDownloadMaxMiB(await browserSettings(workspaceId)),
      onHistoryError: (error) => logger.warn("browser history write failed", { error: errorMessage(error) }),
      isFrameHostAllowed: (frameOrigin, pageUrl, _workspaceId, sessionId) => frameHostAllowed(frameOrigin, pageUrl, sessionId),
      // Every connection the browser makes held to the address rule the tools hold a navigation to: through an egress
      // proxy of its own, which connects only to the address it checked. A confined browser's only way out is srt's
      // proxy, which holds it to the same rule (`privateAddresses` above).
      ...(confineBrowser
        ? {}
        : {
            egress: createEgressCheck(allowedHostsOption),
            onEgressRefused: (refusal: { readonly host: string; readonly reason: string }) =>
              logger.warn("the browser refused a connection to this machine or a private network", {
                host: refusal.host,
                reason: refusal.reason,
              }),
          }),
    });
  // What led to results on each site, learned and shown again.
  const recipes = createRecipeRecorder(
    persistencePort.repositories.siteRecipes,
    () => clock.now(),
    (error) => logger.warn("site recipe read or write failed", { error: errorMessage(error) }),
  );
  // The file tools' options, shared with
  // what sends a folder file out: an upload or a channel send by `path` reads
  // it as `fs.read` would, and puts it as an artifact approved by the call's
  // own approval.
  const fsToolOptions = {
    dataDirectory: options.dataDirectory,
    readOnlyPaths: options.devPlugins ?? [],
    space: folderSpace,
    // What a tainted call writes into its chat's folder taints whoever reads it.
    markFolderTainted: (context: InvocationContext) => late.chatFolders.markTainted(context.workspaceId, context.runId, context.chatTaskId),
    hostWrites: {
      record: (context: InvocationContext, path: string, sha256: string, from?: { readonly taskId?: string }, file?: HostFileIdentity) =>
        late.chatFolders.recordTaintedWrite(context.workspaceId, context.runId, context.chatTaskId, path, sha256, from, file),
      writerOf: (workspaceId: string, path: string, sha256: string, file?: HostFileIdentity) =>
        late.chatFolders.taintedWriteOf(workspaceId, path, sha256, file),
    },
    taintedFoldersNow: (context: InvocationContext) =>
      late.chatFolders.taintedFoldersNow(context.workspaceId, context.runId, context.chatTaskId),
  };
  const folderPromotion = createFolderPromotion({
    read: folderFileReader(fsToolOptions),
    taintOf: folderFileTaint(fsToolOptions),
    artifacts: persistencePort.repositories.artifacts,
    space: folderSpace,
  });
  // The site profiles the operator turned on: a running, approved plugin's, read
  // from its verified snapshot once a version, switched on in Connected apps ("Sites this app may browse").
  // The plugins withdrawn since they loaded: none until the external plugins load, far below, after the profiles' first read.
  late.withdrawnPlugins = (): ReadonlySet<string> => new Set<string>();
  const sitePlugins = (): SitePluginSource[] =>
    late.resolvedPlugins.flatMap((plugin) =>
      plugin.ok
        ? [
            {
              pluginId: plugin.record.pluginId,
              version: plugin.record.version,
              directory: plugin.directory,
              manifest: plugin.record.manifest,
            },
          ]
        : [],
    );
  // The site skills the running plugins registered (`tavi.siteskills`' at its start), read at each observation;
  // with them, the plugins' and the operator's site notes, read with the same switch as the profiles,
  // and searched first: a note turned on is taken before a built-in skill for the same host.
  const siteSkills = new SiteSkillRegistry({ first: [SITE_NOTES_ENTRY] });
  const siteNotes = enabledSiteNotes({
    plugins: sitePlugins,
    withdrawn: () => late.withdrawnPlugins(),
    operatorDirectory: join(options.dataDirectory, SITE_NOTES_DIRECTORY),
  });
  // The notes follow the switch the profiles are read with, so one turned on or off shows from the next lookup;
  // the registry is changed only when the notes did (an unchanged note is the same object, from the readers' caches).
  let shownNotes: readonly EnabledSiteNote[] = [];
  const updateSiteNotes = (on: SitesOn): void => {
    const notes = siteNotes(on);
    if (
      notes.length === shownNotes.length &&
      notes.every((entry, index) => entry.from === shownNotes[index]?.from && entry.note === shownNotes[index]?.note)
    )
      return;
    shownNotes = notes;
    showSiteNotes(siteSkills, notes);
  };
  const sitePolicy = createSitePolicy({
    profiles: enabledSiteProfiles({
      plugins: sitePlugins,
      withdrawn: () => late.withdrawnPlugins(),
      sitesOn: async () => {
        const on = parseSites(await store.getMeta(APPS_SITES_SETTING));
        updateSiteNotes(on);
        return on;
      },
      read: readPluginSiteProfiles,
    }),
    usage: persistencePort.repositories.siteUsage,
    // Pinned: the site's name is dialed only at a public address it resolved to.
    robots: createRobotsReader(pinnedFetch()),
    now: () => Date.parse(clock.now()),
    sleep: (ms, signal) => sleepFor(ms, undefined, { signal }),
  });
  const keptFindings: TaskFindingRepositoryPort = keepingFindings(persistencePort.repositories.findings, sitePolicy);
  // Staged: published by `tavi.browser` once composition knows it is enabled (`runtime/plugins.ts`).
  const browserToolStage = new ToolRegistry();
  const browserTools = registerBrowserTools(browserToolStage, browser, {
    recipes,
    siteSkills,
    promotion: folderPromotion,
    sites: sitePolicy,
    ...(options.browserAllowedHosts === undefined ? {} : { allowedHosts: options.browserAllowedHosts }),
    ...(overrides.liveViewServed === true ? { handoff: true } : {}),
  });
  frameHostAllowed = browserTools.frameHostAllowed;
  // The real browser's tools are offered only while its Chromium is installed; a browser handed in (tests) always is.
  const browserOffered = overrides.browserOverride === undefined ? ownerBrowserInstalled() : undefined;
  // Typed by its port, which a declaration can name: the repository's own interface is not exported.
  const ports: { readonly keptFindings: TaskFindingRepositoryPort } = { keptFindings };
  return {
    browser,
    browserBoundary,
    browserOffered,
    browserTools,
    browserToolStage,
    folderPromotion,
    fsToolOptions,
    ...ports,
    liveSource,
    recipes,
    siteSkills,
    sitePolicy,
  };
}

export type BrowserContext = SandboxContext & ReturnType<typeof composeBrowser>;
