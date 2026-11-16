import type { HeartbeatGetAnswer, HeartbeatSettingsChange } from "@tavi/contracts";

import { useLoaded } from "../../hooks/use-loaded.js";
import { loadModels, type BrowsedModel } from "../settings/models-api.js";
import { listAgents, type AgentSummary } from "./memory-api.js";
import { Select } from "../../ui/Select.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * Under *More* in Center → Heartbeat: the model its checks run on in place of
 * the workspace's fast model (a turn that asks for `main` still runs it) and the persona they
 * run as (none unless one is chosen). Either can be set back to its default.
 */
export function HeartbeatTurn({
  config,
  onChange,
}: {
  readonly config: Pick<HeartbeatGetAnswer["config"], "model" | "agentId">;
  readonly onChange: (change: HeartbeatSettingsChange, said: string) => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const models: readonly BrowsedModel[] = useLoaded(() => loadModels(client, workspaceId), [client, workspaceId]).data?.models ?? [];
  const agents: readonly AgentSummary[] =
    useLoaded(() => listAgents(client, workspaceId), [client, workspaceId]).data?.agents.filter((agent) => agent.enabled) ?? [];
  const chosen = config.model === undefined ? "" : `${config.model.connectionId}/${config.model.model}`;
  // A model or persona chosen earlier and no longer listed still shows, by its id.
  const modelListed = chosen === "" || models.some((model) => `${model.connectionId}/${model.modelId}` === chosen);
  const agentListed = config.agentId === undefined || agents.some((agent) => agent.agentId === config.agentId);
  return (
    <>
      <label>
        Model{" "}
        <Select
          aria-label="Model"
          value={chosen}
          onChange={(event) => {
            const value = event.target.value;
            const model = models.find((entry) => `${entry.connectionId}/${entry.modelId}` === value);
            onChange(
              model === undefined ? { model: null } : { model: { connectionId: model.connectionId, model: model.modelId } },
              "Model changed.",
            );
          }}
        >
          <option value="">Workspace fast model</option>
          {modelListed ? null : <option value={chosen}>{chosen}</option>}
          {models.map((model) => (
            <option key={`${model.connectionId}/${model.modelId}`} value={`${model.connectionId}/${model.modelId}`}>
              {model.displayName ?? model.modelId} ({model.connectionLabel})
            </option>
          ))}
        </Select>
      </label>
      <label>
        Persona{" "}
        <Select
          aria-label="Persona"
          value={config.agentId ?? ""}
          onChange={(event) => onChange({ agentId: event.target.value === "" ? null : event.target.value }, "Persona changed.")}
        >
          <option value="">None</option>
          {agentListed || config.agentId === undefined ? null : <option value={config.agentId}>{config.agentId}</option>}
          {agents.map((agent) => (
            <option key={agent.agentId} value={agent.agentId}>
              {agent.name}
            </option>
          ))}
        </Select>
      </label>
    </>
  );
}
