import { useCallback, useState } from "react";

import { DEFAULT_TASKS_HOME, MCP_PLUGIN_PREFIX, TasksHomeSchema, type ConnectableApp, type TasksHome } from "@tavi/contracts";

import { useLoaded } from "../../hooks/use-loaded.js";
import { useT } from "../../lib/i18n.js";
import { ConnectSheet } from "../apps/ConnectSheet.js";
import { appActions } from "../apps/apps-api.js";
import { workspaceSettingsActions } from "../settings/workspace-api.js";
import { completeStep, loadStatus } from "./onboarding-api.js";
import { type StepProps, withParts, Working } from "./WelcomeStepParts.js";
import { Icon } from "../../ui/Icon.js";
import { Failure } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { Command } from "../../ui/Command.js";

/**
 * Setup's "Where do you keep tasks?" on the canvas, the terminal's
 * `tasksStep` here: Tavi's own list, which needs nothing set (the step is
 * marked done, and a home saved before is cleared), or a task app — one
 * already connected, or Todoist, its preset, added and signed in with the
 * Apps page's connect sheet — saved as `tasks.home: mcp:<server>`.
 */

/** The Todoist preset's app, as Connected apps lists it once added. */
const TODOIST = "todoist";

/** The task home an MCP account is: `mcp.todoist` → `mcp:todoist`; undefined for one that is not a server. */
export function homeOfAccount(accountId: string): TasksHome | undefined {
  if (!accountId.startsWith(MCP_PLUGIN_PREFIX)) return undefined;
  const parsed = TasksHomeSchema.safeParse(`mcp:${accountId.slice(MCP_PLUGIN_PREFIX.length)}`);
  return parsed.success ? parsed.data : undefined;
}

export function TasksStep(props: StepProps) {
  const { client, workspaceId } = props;
  const t = useT();
  const [working, setWorking] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [connecting, setConnecting] = useState<ConnectableApp>();
  const items = props.status.steps.find((step) => step.kind === "tasks")?.items ?? [];
  const connected = items.filter((item) => item.state === "connected");
  // Todoist as Connected apps has it: absent until it is added.
  const readApps = useCallback(async (): Promise<ConnectableApp | undefined> => {
    const listed = await appActions.list(client, workspaceId);
    return listed.ok ? listed.value.apps.find((app) => app.appId === TODOIST) : undefined;
  }, [client, workspaceId]);
  const { data: todoist, replace: setTodoist } = useLoaded(async () => ({ ok: true, value: await readApps() }) as const, [readApps]);

  const refresh = async (): Promise<void> => {
    const read = await loadStatus(client, workspaceId);
    if (read.ok) props.onStatus(read.value);
  };
  /** `home` saved (Tavi's own list clears the key), and Tavi's own marked done: nothing else says it was chosen. */
  const choose = async (home: TasksHome, saving: string): Promise<void> => {
    setWorking(saving);
    setProblem(undefined);
    const settings = await workspaceSettingsActions.load(client, workspaceId);
    if (!settings.ok) {
      setWorking(undefined);
      return setProblem(settings.message);
    }
    const current = settings.value.effective.tasksHome ?? settings.value.settings.tasksHome ?? DEFAULT_TASKS_HOME;
    if (home !== current) {
      const saved = await workspaceSettingsActions.setTasksHome(client, workspaceId, home, settings.value.revision);
      if (!saved.ok) {
        setWorking(undefined);
        return setProblem(saved.message);
      }
    }
    if (home === DEFAULT_TASKS_HOME) {
      const marked = await completeStep(client, workspaceId, "tasks");
      setWorking(undefined);
      if (!marked.ok) return setProblem(marked.message);
      props.onStatus(marked.value);
    } else {
      setWorking(undefined);
      await refresh();
    }
    props.onDone();
  };
  /** Todoist added from its preset when it is not yet, then the Apps page's sheet to sign in. */
  const connectTodoist = async (): Promise<void> => {
    setProblem(undefined);
    let app = todoist ?? (await readApps());
    if (app === undefined) {
      setWorking(t("welcome.tasks.adding"));
      const added = await appActions.add(client, workspaceId, { kind: "preset", id: TODOIST });
      if (!added.ok) {
        setWorking(undefined);
        return setProblem(t("welcome.tasks.notAdded", { message: added.message }));
      }
      app = await readApps();
      setWorking(undefined);
      if (app === undefined) return setProblem(t("welcome.tasks.notListed"));
    }
    setTodoist(app);
    setConnecting(app);
  };
  const todoistConnected = connected.some((item) => item.id === `mcp:${TODOIST}`);
  return (
    <div className="welcome-connect">
      <ul className="welcome-cards">
        <li className="welcome-card">
          <h2>{t("welcome.tasks.ownTitle")}</h2>
          <p>{t("welcome.tasks.ownBody")}</p>
          <Button size="sm" disabled={working !== undefined} onClick={() => void choose(DEFAULT_TASKS_HOME, t("welcome.tasks.savingOwn"))}>
            {t("welcome.tasks.useOwn")}
          </Button>
        </li>
        {connected.map((item) => (
          <li key={item.id} className="welcome-card">
            <h2>{item.label}</h2>
            <p className="welcome-state">
              <Icon name="check" size="sm" /> {t("welcome.tasks.connected")}
            </p>
            <Button
              size="sm"
              aria-label={t("welcome.tasks.use", { app: item.label })}
              disabled={working !== undefined}
              onClick={() => {
                const parsed = TasksHomeSchema.safeParse(item.id);
                if (parsed.success) void choose(parsed.data, t("welcome.tasks.saving", { app: item.label }));
              }}
            >
              {t("welcome.tasks.use", { app: item.label })}
            </Button>
          </li>
        ))}
        {todoistConnected ? null : (
          <li className="welcome-card">
            <h2>Todoist</h2>
            <p>{t("welcome.tasks.todoistBody")}</p>
            <Button
              size="sm"
              aria-label={t("welcome.tasks.connectTodoist")}
              disabled={working !== undefined}
              onClick={() => void connectTodoist()}
            >
              {t("welcome.action.connect")}
            </Button>
          </li>
        )}
      </ul>
      <p className="settings-description">
        {withParts(t("welcome.tasks.later"), { command: <Command>tavi config set tasks.home</Command> })}
      </p>
      {working === undefined ? null : <Working>{working}</Working>}
      {problem === undefined ? null : <Failure>{problem}</Failure>}
      {connecting === undefined ? null : (
        <ConnectSheet
          client={client}
          workspaceId={workspaceId}
          app={connecting}
          onClose={() => {
            setConnecting(undefined);
            void refresh();
          }}
          onConnected={(accountId) => {
            setConnecting(undefined);
            const home = homeOfAccount(accountId);
            if (home === undefined) return void refresh();
            void choose(home, t("welcome.tasks.saving", { app: connecting.name }));
          }}
        />
      )}
    </div>
  );
}
