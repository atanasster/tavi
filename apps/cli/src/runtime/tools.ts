import { connectionLocality } from "@tavi/agent-host/task-summarizer";
import { BROWSER_ENGINE_PLUGIN_ID, DESKTOP_PLUGIN_ID, PDF_ENGINE_PLUGIN_ID, VIDEO_ENGINE_PLUGIN_ID } from "../features/plugins/catalog.js";
import { modelReadsImages } from "@tavi/agent-host/models";
import { readAgentTree } from "../features/agents/tree.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  flightSearchOn,
  pdfToolsOn,
  videoToolsOn,
  googleFlightsOn,
  browserVisionEngineOf,
  presetOf,
  type PdfEnginePort,
  type VideoDecoderPort,
  type ModelTarget,
  type InvocationContext,
} from "@tavi/contracts";
import { HeartbeatReports, registerHeartbeatFetchTool, registerHeartbeatReportTool } from "../features/heartbeat/turns.js";
import { folderFileReader, folderFileTaint, folderFileWriter, fsRootResolver, registerFsTools } from "../features/folders/fs-tools.js";
import { htmlToText, publicFetch } from "@tavi/runtime";
import { memoryActorFrom } from "../features/memory/tools.js";
import { createPdfEngine, pdfOcrAssets } from "../features/pdf/host.js";
import {
  createVideoAnalyzers,
  createVideoDecoder,
  loadVideoPoseAddOn,
  loadVideoTranscribeAddOn,
  resolveVideoMcpTools,
  findWhisperCli,
  reloadableAnalyzers,
  transcribeSetupNote,
  videoBuiltins,
  videoFfmpeg,
  videoPoseEngine,
  type ReloadableAnalyzers,
  type VideoAnalyzers,
} from "../features/video/host.js";
import { createVoiceSetup } from "../features/video/voice-setup.js";
import { attendedVideoOrigin, registerVideoTools } from "../features/video/tools.js";
import { registerAudioTools } from "../features/video/audio.js";
import { pdfPasswordRef, registerPdfTools } from "../features/pdf/tools.js";
import { registerBrowserExtractTool, type BrowserExtractOptions } from "../features/browser/extract.js";
import { registerBrowserFindTool } from "../features/browser/find.js";
import { registerBrowserVisionTool } from "../features/browser/vision.js";
import { BROWSER_WORKER_AGENT_ID } from "../features/agents/builtin.js";
import { registerFindingsTools } from "../features/tools/findings.js";
import { FLIGHTS_PLUGIN_ID, registerOwnerFlightsTools } from "../features/flights/host.js";
import { utilityTarget, visionTarget } from "../features/browser/models.js";
import {
  DESKTOP_STOPPED_NOTICE,
  createDesktopWorkspaces,
  createOwnerDesktopBridge,
  requireDesktopHelper,
} from "../features/desktop/host.js";
import { registerDesktopTools } from "../features/desktop/tools.js";
import type { ChannelsContext } from "./channels.js";

/** The model's tools for pages, findings, flights, files, PDFs and video. */
export async function composeTools(composed: ChannelsContext) {
  const {
    browser,
    browserOffered,
    browserTools,
    chatIsLocal,
    clock,
    confinement,
    disabledBuiltins,
    fsToolOptions,
    keptFindings,
    late,
    limits,
    mcpHost,
    memory,
    modelAdapter,
    modelConnectionLocality,
    options,
    overrides,
    persistencePort,
    recipes,
    sandboxHost,
    secrets,
    sitePolicy,
    tools,
    readMemos,
  } = composed;
  // `http.request` — the keystone capability: credentials are
  // resolved inside the handler from the same read-only chain the model and
  // connectors use, and never returned to the model.
  // Extraction and finding an element are utility work: the
  // workspace's extraction model, else its fast one, else its main, else its default, else the owner's.
  // A chat that used or runs on a local connection reads pages with local models only.
  // A worker is judged by its chat too.
  const localChat = async (context: InvocationContext) => {
    for (const taskId of new Set([context.chatTaskId ?? context.runId, context.runId]))
      if (await chatIsLocal(context.workspaceId, taskId)) return modelConnectionLocality;
    return undefined;
  };
  const extraction: BrowserExtractOptions = {
    browser,
    models: modelAdapter,
    target: async (workspaceId, context) =>
      await utilityTarget(
        persistencePort.repositories.modelConfig,
        workspaceId,
        { connectionId: options.defaultConnectionId, model: options.defaultModel },
        await localChat(context),
      ),
    newId: () => randomUUID(),
    now: () => clock.now(),
    sessionOpener: (sessionId) => browserTools.sessionOpener(sessionId),
    noteObservation: async (observation, workspaceId) => await browserTools.noteObservation(observation, workspaceId),
    findings: keptFindings,
    recipes,
    sites: sitePolicy,
    ...(browserOffered === undefined ? {} : { offered: browserOffered }),
  };
  // Reading a page with a model rides the browser: offered while `tavi.browser` is enabled.
  const browserOn = !disabledBuiltins.has(BROWSER_ENGINE_PLUGIN_ID);
  if (browserOn) registerBrowserExtractTool(tools, extraction);
  if (browserOn) registerBrowserFindTool(tools, extraction);
  // Acting by sight wants the best model that reads the page's pictures, not the cheapest.
  const readsImages = (target: ModelTarget): boolean => modelReadsImages(target.model);
  if (browserOn)
    registerBrowserVisionTool(tools, {
      ...extraction,
      urlNow: (sessionId) => browserTools.urlNow(sessionId),
      readsImages,
      target: async (workspaceId, context) =>
        await visionTarget(
          persistencePort.repositories.modelConfig,
          workspaceId,
          { connectionId: options.defaultConnectionId, model: options.defaultModel },
          readsImages,
          await localChat(context),
        ),
      // The model's own computer-use tool, only where the workspace chose it and the connection speaks it.
      nativeVendor: async (target, workspaceId) => {
        const settings = (await readMemos.workspaceSettings.get(workspaceId)).settings;
        if (browserVisionEngineOf(settings) !== "native") return undefined;
        const connection = await persistencePort.repositories.modelConfig.getConnection(target.connectionId);
        // A local connection keeps the generic loop: the vendors' tools are theirs, and a local chat stays local.
        if (connection === undefined || connectionLocality(connection) === "local") return undefined;
        if (connection.kind === "anthropic-messages") return "anthropic";
        return presetOf(connection.baseUrl)?.id === "openai" ? "openai" : undefined;
      },
    });
  /** Whether `taskId` is a worker spawned as the built-in browser worker, not a workspace's own `browser` definition. */
  const builtinWorkerOf = async (taskId: string): Promise<boolean> => {
    const delegation = await readMemos.agentDelegations.getByWorkerTaskId(taskId);
    if (delegation?.agentDefinitionId !== BROWSER_WORKER_AGENT_ID) return false;
    return (await persistencePort.repositories.agents.get(delegation.workspaceId, BROWSER_WORKER_AGENT_ID)) === undefined;
  };
  // The task's findings and their check against the request's constraints.
  // A planner reads what its browser workers kept: the task and every task under it.
  const taskTree = async (workspaceId: string, taskId: string): Promise<readonly string[]> =>
    (await readAgentTree(persistencePort.repositories, workspaceId, taskId)).nodes.map((node) => node.taskId);
  registerFindingsTools(tools, { findings: keptFindings, now: () => clock.now(), taskTree });
  // What a heartbeat turn reports, collected by its task for the host.
  const heartbeatReports = new HeartbeatReports();
  registerHeartbeatReportTool(tools, heartbeatReports);
  // The guarded public fetch, dialling only the hosts the heartbeat may read: its watched pages and its turns' own fetch.
  const heartbeatFetchPage =
    overrides.heartbeatFetchPage ??
    (async (url: string, allowedHosts: readonly string[], signal: AbortSignal) => {
      const fetched = await publicFetch({ networkMode: "custom_hosts", allowedHosts }, { url }, signal);
      return {
        status: fetched.status,
        text: /html/i.test(fetched.contentType) ? htmlToText(fetched.body, fetched.finalUrl) : fetched.body,
      };
    });
  registerHeartbeatFetchTool(tools, heartbeatReports, heartbeatFetchPage, sitePolicy);
  // Desktop control (`tavi.desktop`, experimental, off until enabled): macOS only, one helper for the owner, a gate per
  // workspace over the apps it granted (`desktop.grantedApps`).
  if (!disabledBuiltins.has(DESKTOP_PLUGIN_ID) && process.platform === "darwin") {
    // The helper's abort hotkey stops every workspace's gate.
    const bridge = createOwnerDesktopBridge(options.dataDirectory, () => workspaces.abortAll());
    late.desktopBridge = bridge;
    const workspaces = createDesktopWorkspaces({
      desktop: bridge,
      grantedApps: async (workspaceId) => (await readMemos.workspaceSettings.get(workspaceId)).settings.desktopGrantedApps ?? [],
      // Each run the hotkey stopped says so in its chat, on its own stream after its last attempt (the bus is bound later).
      onStopped: (runs) => {
        const bus = late.runEventBus;
        for (const { runId } of runs) {
          const attemptId = bus.lastAttempt(runId);
          if (attemptId === undefined) continue;
          bus.publish(runId, { kind: "plugin.notice", runId, attemptId, pluginId: DESKTOP_PLUGIN_ID, notice: DESKTOP_STOPPED_NOTICE });
        }
      },
    });
    registerDesktopTools(tools, {
      desktop: workspaces.portFor,
      grantTierOf: (workspaceId, bundleId, name) => workspaces.tierOf(workspaceId, { bundleId, name }),
      grantedApps: workspaces.grantedApps,
      noteRun: workspaces.noteRun,
      artifacts: persistencePort.repositories.artifacts,
      refresh: async (workspaceId, runId) => {
        requireDesktopHelper(options.dataDirectory);
        await workspaces.refresh(workspaceId, runId);
      },
      models: modelAdapter,
      target: async (workspaceId, context) =>
        await visionTarget(
          persistencePort.repositories.modelConfig,
          workspaceId,
          { connectionId: options.defaultConnectionId, model: options.defaultModel },
          readsImages,
          await localChat(context),
        ),
      newId: () => randomUUID(),
      now: () => clock.now(),
    });
  }
  // Flight search as a domain tool, before browsing: Kiwi.com's public MCP server, no key (`tavi.flights`).
  if (!disabledBuiltins.has(FLIGHTS_PLUGIN_ID))
    registerOwnerFlightsTools(tools, {
      findings: persistencePort.repositories.findings,
      now: () => clock.now(),
      settings: async (workspaceId) => {
        const settings = (await readMemos.workspaceSettings.get(workspaceId)).settings;
        return { search: flightSearchOn(settings), googleFlights: googleFlightsOn(settings) };
      },
      // Its fallbacks name the browser's tools only while `tavi.browser` offers them.
      browser: browserOn,
    });
  // The working tools: files in the calling chat's working folder —
  // always offered, built per call from the folder stamped on the turn
  // — a plan, past conversations, and
  // images. The data directory is closed to them but for the chat's own
  // managed folder; a dev plugin's folder is read-only to them: no
  // turn can reload code into the owner.
  registerFsTools(tools, fsToolOptions);
  // Reading PDFs and filling forms: one
  // single-use parser child per call, started on the first call. On macOS it
  // runs under srt with no network and nothing writable, as on Linux wherever the sandbox works; where it is
  // unavailable a call is refused unless `serve --pdf-allow-unconfined` runs it bare, which `doctor` says.
  // The engine is a port: `@tavi/plugin-pdf` by default, put together with its confinement and the OCR
  // add-on in `features/pdf/host.ts`, or an override; the tools see only `PdfEnginePort`.
  late.pdfService = overrides.pdfOverride;
  // Scans are read by OCR where the add-on is installed.
  const pdfOcr = await pdfOcrAssets();
  const pdfEngine = (): PdfEnginePort =>
    (late.pdfService ??= createPdfEngine(options.dataDirectory, pdfOcr, confinement, {
      host: sandboxHost,
      ...(limits === undefined ? {} : { limits }),
      ...(options.pdf?.allowUnconfined === true ? { allowUnconfined: true } : {}),
    }));
  // Offered while `tavi.pdf` is enabled; the engine itself stays, for what renders through it (video sheets' fonts).
  if (!disabledBuiltins.has(PDF_ENGINE_PLUGIN_ID))
    registerPdfTools(tools, {
      service: pdfEngine,
      artifacts: persistencePort.repositories.artifacts,
      readFile: folderFileReader(fsToolOptions),
      fileTaint: folderFileTaint(fsToolOptions),
      writeFile: folderFileWriter(fsToolOptions),
      resolvePath: fsRootResolver(fsToolOptions),
      memoryText: async (context, recordId) => {
        const record = await memory.get({ actor: memoryActorFrom(context), recordId });
        if (record.status !== "approved" || record.currentRevisionId === undefined) return undefined;
        const revision = await persistencePort.repositories.memory.getRevision(record.currentRevisionId);
        return revision?.body === undefined ? undefined : { text: revision.body, revisionId: revision.revisionId };
      },
      enabled: async (workspaceId) => pdfToolsOn((await readMemos.workspaceSettings.get(workspaceId)).settings),
      // The engine's own core font; a font add-on's would follow it.
      fonts: () => pdfEngine().coreFonts(),
      now: () => Date.parse(clock.now()),
      // A PDF's user password, set on the host as `pdf.<its sha256>`: never a tool input.
      // A store that fails is an error, not "no password": the person is never told to set one already set.
      password: async (sha256) => (await secrets.getSecret(pdfPasswordRef(sha256))) ?? undefined,
    });
  // Video understanding: the person's own FFmpeg, found now and run on the
  // first call, each video read in a confined, capped run. Without FFmpeg the tools are not offered and `doctor` says
  // how to install it. The decoder is a port: `@tavi/plugin-video` by default, put together in `features/video/host.ts`.
  const videoOptions = { ...(options.video ?? {}), host: sandboxHost, ...(limits === undefined ? {} : { limits }) };
  late.videoDecoder = overrides.videoDecoderOverride === undefined ? undefined : Promise.resolve(overrides.videoDecoderOverride);
  const videoDecoderOf = (): Promise<VideoDecoderPort> =>
    (late.videoDecoder ??= createVideoDecoder(options.dataDirectory, confinement, videoOptions));
  const videoOffered = overrides.videoDecoderOverride !== undefined || !("missing" in videoFfmpeg(videoOptions));
  // The owner's analysers: `<data>/video/analyzers.json`'s chains, read at start and again when voice setup writes it;
  // `doctor` lists them.
  const readAnalyzers = async (): Promise<VideoAnalyzers> =>
    createVideoAnalyzers(
      options.dataDirectory,
      confinement,
      videoOptions,
      videoBuiltins(
        options.dataDirectory,
        confinement,
        videoOptions,
        await loadVideoPoseAddOn(),
        await loadVideoTranscribeAddOn(),
        pdfEngine,
      ),
      await resolveVideoMcpTools(options.dataDirectory, mcpHost),
    );
  const videoAnalyzers: ReloadableAnalyzers =
    overrides.videoAnalyzersOverride === undefined
      ? reloadableAnalyzers(await readAnalyzers(), readAnalyzers)
      : reloadableAnalyzers({ registry: overrides.videoAnalyzersOverride, chains: {}, close: async () => undefined });
  if (videoOffered && !disabledBuiltins.has(VIDEO_ENGINE_PLUGIN_ID)) {
    registerVideoTools(tools, {
      decoder: videoDecoderOf,
      analyzers: videoAnalyzers.registry,
      pose: videoPoseEngine(),
      // The rule the adapter's resolveVideo applies when the clip is sent: the task's own origin.
      attended: async (runId) => attendedVideoOrigin((await persistencePort.repositories.tasks.get(runId))?.origin),
      artifacts: persistencePort.repositories.artifacts,
      readFile: folderFileReader(fsToolOptions),
      fileTaint: folderFileTaint(fsToolOptions),
      enabled: async (workspaceId) => videoToolsOn((await readMemos.workspaceSettings.get(workspaceId)).settings),
      // A sheet's time labels, where the person's FFmpeg can draw text: the PDF engine's core font.
      font: () => pdfEngine().coreFonts()[0] ?? new Uint8Array(),
      now: () => Date.parse(clock.now()),
    });
  }
  // A voice message's speech, on the same decoder and analysers. Offered even without FFmpeg or whisper.cpp: then
  // it says what is missing and how to install it, so a voice note is never answered as if it had not arrived.
  // FFmpeg is looked for at each call, not only at start: voice setup may install it while the owner runs.
  const ffmpegMissing = (): string | undefined => {
    if (overrides.videoDecoderOverride !== undefined) return undefined;
    const found = videoFfmpeg(videoOptions);
    return "missing" in found ? found.missing : undefined;
  };
  // Registered even with the video plugin off: a voice note's line names this tool, which then says how to turn it on.
  registerAudioTools(tools, {
    ...(disabledBuiltins.has(VIDEO_ENGINE_PLUGIN_ID)
      ? {
          disabled: `the video plugin (${VIDEO_ENGINE_PLUGIN_ID}) is turned off here (turn it on with \`tavi plugins enable ${VIDEO_ENGINE_PLUGIN_ID}\`, then restart tavi serve)`,
        }
      : {}),
    decoder: async () => {
      // A decoder made before FFmpeg was installed is the missing one: made again now that it is found.
      const made = await videoDecoderOf();
      if (!("missing" in made.facts())) return made;
      late.videoDecoder = undefined;
      return await videoDecoderOf();
    },
    ffmpegMissing,
    analyzers: videoAnalyzers.registry,
    transcribeSetup: () => transcribeSetupNote(videoAnalyzers),
    modelsDirectory: join(options.dataDirectory, "video", "models"),
    artifacts: persistencePort.repositories.artifacts,
    enabled: async (workspaceId) => videoToolsOn((await readMemos.workspaceSettings.get(workspaceId)).settings),
  });
  const voiceSetup = createVoiceSetup({
    dataDirectory: options.dataDirectory,
    ffmpegFound: () => ffmpegMissing() === undefined,
    whisperFound: async () => (await findWhisperCli()) !== undefined,
    transcriberReady: () => videoAnalyzers.registry.for("transcribe").length > 0,
    reload: () => videoAnalyzers.reload(),
  });
  return {
    builtinWorkerOf,
    heartbeatFetchPage,
    heartbeatReports,
    taskTree,
    videoAnalyzers,
    videoDecoderOf,
    videoOffered,
    videoOptions,
    voiceSetup,
  };
}

export type ToolsContext = ChannelsContext & Awaited<ReturnType<typeof composeTools>>;
