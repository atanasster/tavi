import { isUntrusted } from "@tavi/contracts";
import { createTurnFolder } from "../features/folders/turn-folder.js";
import { ChatFolders, createArtifactMaterializer } from "@tavi/runtime";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import type { ToolsContext } from "./tools.js";

/** The chats' folders, artifact materialization and each turn's folder. */
export function composeFolders(composed: ToolsContext) {
  const { access, chatNotices, clock, folderSpace, late, logger, options, persistencePort } = composed;
  // Each chat's working folder: resolved
  // once per admission and stamped on the turn as `folder`. `--fs-root` names
  // the folders a chat may attach; the file tools and the shell
  // work in the folder.
  const chatFolders = new ChatFolders({
    dataDirectory: options.dataDirectory,
    fsRoots: (options.fsRoots ?? []).map((root) => resolvePath(root)),
    devPluginFolders: options.devPlugins ?? [],
    homeDirectory: homedir(),
    repository: persistencePort.repositories.taskFolders,
    tasks: persistencePort.repositories.tasks,
    agentDelegations: persistencePort.repositories.agentDelegations,
    actsIn: (workspaceId, principalId) => access.actsIn(workspaceId, principalId),
    // Folder taint: a side chat's parent, or a worker's root chat, tainted during a
    // turn not yet ended, as its checkpoint says now. No checkpoint yet is a clean chat.
    chatTainted: async (taskId) => {
      const task = await persistencePort.repositories.tasks.get(taskId);
      if (task === undefined || late.workflow?.checkpoints.contextLabel === undefined) return false;
      const label = await late.workflow.checkpoints.contextLabel(task.threadId);
      return label !== undefined && isUntrusted(label);
    },
    now: () => clock.now(),
  });
  late.chatFolders = chatFolders;
  // Approved downloads and reports, copied into their chat's managed folder:
  // wherever a review approves one, and at once for a report, which is
  // stored approved. A copy that fails is logged; the approval stands.
  const materializeArtifact = createArtifactMaterializer({
    artifacts: persistencePort.repositories.artifacts,
    folders: chatFolders,
    space: folderSpace,
    log: (message, fields) => logger.warn(message, fields),
  });
  const turnFolder = createTurnFolder({
    folders: chatFolders,
    notices: chatNotices,
    space: folderSpace,
    warn: (message, fields) => logger.warn(message, fields),
  });
  return { chatFolders, materializeArtifact, turnFolder };
}

export type FoldersContext = ToolsContext & ReturnType<typeof composeFolders>;
