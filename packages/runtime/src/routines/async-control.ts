import {
  isBuiltinRoutineTemplate,
  TaviError,
  type RoutineScope,
  type RoutineSnapshot,
  type RoutineTemplate,
  type RoutinesPayload,
} from "@tavi/contracts";
import type { Locale } from "@tavi/contracts/i18n";
import type { DatabaseClient } from "../persistence/client.js";
import { routineSetupPermissions, type RoutineControlOptions } from "./control.js";
import type {
  RoutineService,
  RoutineExecutionService,
  RoutineNewsService,
  RoutineDeliveryService,
  RoutinePublicationService,
} from "../persistence/routine-facades.js";
export class RoutineControlService {
  readonly options: RoutineControlOptions<{
    routines: RoutineService;
    runs: RoutineExecutionService;
    news: RoutineNewsService;
    delivery: RoutineDeliveryService;
    publication: RoutinePublicationService;
  }> & {
    /**
     * A routine's pinned host folder, checked as a chat's primary folder is
     * (`ChatFolders.checkPrimary`): the answer is its real path, and
     * a refusal refuses the create or update. Absent, a folder is refused.
     */
    checkFolder?: (path: string) => string;
    /**
     * A plugin's routine template by id, as installed now: a create or update copies the one its report names
     * into the revision, and one not installed is refused. Absent, only the host's own templates are saved.
     */
    templateOf?: (id: string) => RoutineTemplate | undefined;
    /** The workspace's language: a routine created from a setup writes its report in it. Absent, English. */
    languageOf?: (workspaceId: string) => Promise<Locale>;
  };
  constructor(options: RoutineControlService["options"]) {
    this.options = options;
  }
  private pinnedFolder(payload: RoutinesPayload): RoutinesPayload {
    return pinTemplate(pinFolder(payload, this.options.checkFolder), this.options.templateOf ?? (() => undefined));
  }
  setupPermissions(): RoutineSnapshot["permissions"] {
    return routineSetupPermissions(this.options.allowedHosts);
  }
  async execute(payload: RoutinesPayload): Promise<unknown> {
    payload = this.pinnedFolder(payload);
    const now = this.options.now?.();
    const language =
      payload.action === "create" && payload.setup !== undefined ? await this.options.languageOf?.(payload.workspaceId) : undefined;
    const result = await this.options.routines.call("routine.control", {
      payload,
      control: {
        defaultModels: this.options.defaultModels(),
        allowedHosts: this.options.allowedHosts,
        renderer: this.options.renderer?.(),
        ...(language === undefined ? {} : { language }),
      },
      ...(now === undefined ? {} : { now }),
    });
    this.options.wake();
    return result;
  }
}
/**
 * A create or update that pins a host folder, with the folder checked against
 * the owner's `--fs-root` set and written as its real path. Every
 * other action, and one without a folder, is as it was.
 */
function pinFolder(payload: RoutinesPayload, check: ((path: string) => string) | undefined): RoutinesPayload {
  const pinned =
    payload.action === "create" ? payload.create?.folder : payload.action === "update" ? payload.update?.snapshot.folder : undefined;
  if (pinned === undefined) return payload;
  if (check === undefined)
    throw new TaviError(
      "NOT_CONFIGURED",
      "A routine's folder is checked against a running owner's --fs-root folders; pin it through the owner",
    );
  const folder = { path: check(pinned.path) };
  if (payload.action === "create" && payload.create !== undefined) return { ...payload, create: { ...payload.create, folder } };
  if (payload.update !== undefined) return { ...payload, update: { ...payload.update, snapshot: { ...payload.update.snapshot, folder } } };
  return payload;
}
/**
 * A create or update with its report's template copied in, as installed now:
 * the host's own carry none; any other id must be installed, else the save is
 * refused. Every other action is as it was (an edit keeps its revision's own).
 */
function pinTemplate(payload: RoutinesPayload, templateOf: (id: string) => RoutineTemplate | undefined): RoutinesPayload {
  const pinned = (report: RoutineSnapshot["report"]): RoutineSnapshot["report"] => {
    // A payload without a report is the worker's to refuse, in its own words.
    if (typeof report !== "object" || report === null) return report;
    const { template: _given, ...rest } = report;
    if (isBuiltinRoutineTemplate(report.templateVersion)) return rest;
    const template = templateOf(report.templateVersion);
    if (template === undefined)
      throw new TaviError(
        "NOT_FOUND",
        `No routine template ${report.templateVersion} is installed: enable the plugin that provides it, on a running owner`,
      );
    return { ...rest, template };
  };
  if (payload.action === "create" && payload.create !== undefined)
    return { ...payload, create: { ...payload.create, report: pinned(payload.create.report) } };
  if (payload.action === "update" && payload.update !== undefined)
    return {
      ...payload,
      update: { ...payload.update, snapshot: { ...payload.update.snapshot, report: pinned(payload.update.snapshot.report) } },
    };
  return payload;
}
export function routineSkillContext(store: DatabaseClient, scope: RoutineScope, pins: RoutineSnapshot["skills"]): Promise<string> {
  return store.call("routine.skillContext", { scope, pins });
}
