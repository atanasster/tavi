import { useRef, useState, type ReactNode } from "react";
import type { AgentTreeNode, AgentTreeResult } from "@tavi/contracts";
import { errorMessage, nowTimestamp, plural } from "@tavi/contracts/util";
import { instantLabel, todayIn, formatElapsed } from "../../lib/time.js";
import { useSerialRead } from "../../hooks/use-loaded.js";
import { usePoll } from "../../hooks/use-poll.js";
import { Failure, Pending } from "../../ui/Parts.js";
import { refusal } from "../../lib/ipc.js";
import { FinalText, loadAgentTree, useSettledRevision, workerLabel } from "./WorkerView.js";
import { Button } from "../../ui/Button.js";
import { AGENT_TREE_MAX_INDENT_EM } from "../../lib/layout.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";
/** How often the tree is read when the owner offers no change feed (`center watch`) to follow. */
export const AGENT_TREE_FALLBACK_POLL_MS = 30_000;
const ended = (status: string) => ["completed", "failed", "stopped", "cancelled"].includes(status);
/** The owner bounds breadth-first; the visual tree groups each parent's subtree. */
export function orderedTree(nodes: readonly AgentTreeNode[]): readonly AgentTreeNode[] {
  const children = new Map<string | undefined, AgentTreeNode[]>();
  const ids = new Set(nodes.map((node) => node.taskId));
  for (const node of nodes) {
    const parent = node.parentTaskId && ids.has(node.parentTaskId) ? node.parentTaskId : undefined;
    const siblings = children.get(parent) ?? [];
    siblings.push(node);
    children.set(parent, siblings);
  }
  const ordered: AgentTreeNode[] = [];
  const seen = new Set<string>();
  const visit = (node: AgentTreeNode) => {
    if (seen.has(node.taskId)) return;
    seen.add(node.taskId);
    ordered.push(node);
    for (const child of children.get(node.taskId) ?? []) visit(child);
  };
  for (const node of children.get(undefined) ?? []) visit(node);
  for (const node of nodes) visit(node); // Preserve malformed/cyclic historical rows once.
  return ordered;
}
export function foldableChildren(nodes: readonly AgentTreeNode[], taskId: string, now: number): readonly string[] {
  const parents = new Map(nodes.map((node) => [node.taskId, node.parentTaskId]));
  const eligible = (node: AgentTreeNode) =>
    node.status === "completed" && !node.needs?.length && now - Date.parse(node.updatedAt) >= 30_000;
  // Reverse preorder keeps descendants ahead of parents even across twenty-row batches.
  return orderedTree(nodes)
    .filter(
      (node) =>
        node.taskId !== taskId &&
        eligible(node) &&
        !nodes.some((other) => {
          if (other.taskId === node.taskId || eligible(other)) return false;
          const seen = new Set<string>();
          let parent = other.parentTaskId;
          while (parent && !seen.has(parent)) {
            if (parent === node.taskId) return true;
            seen.add(parent);
            parent = parents.get(parent);
          }
          return false;
        }),
    )
    .reverse()
    .map((node) => node.taskId);
}
/**
 * The chat's agent tree. It is read again when `watch` moves — the Command
 * Center's change feed (`center watch`) reporting a task, question, review or
 * approval change, the moves of a second gathered into one read, one read in
 * flight at a time — and, with no feed (`watch` absent: an owner without
 * `center`), every `AGENT_TREE_FALLBACK_POLL_MS`. A worker's row says what it
 * did last and, once it ended, its final text; opening it shows its view-only
 * transcript (`onOpenWorker`), never a chat of its own.
 */
export function AgentTree({
  taskId,
  version,
  watch,
  onOpen,
  onOpenWorker,
  opened,
  needs,
}: {
  readonly taskId: string;
  readonly version: string /** The change feed's revision; absent when there is none to follow. */;
  readonly watch?: number | undefined /** Open an ancestor chat. */;
  readonly onOpen: (taskId: string) => Promise<void> /** Show a worker's view-only transcript beside this chat. */;
  readonly onOpenWorker: (node: AgentTreeNode) => void /** The worker whose transcript is open. */;
  readonly opened?: string | undefined /** The chat's workers' questions and handoffs as cards, answered here. */;
  readonly needs?: ReactNode;
}) {
  const { client, workspaceId } = useWorkspace();
  const timeZone = useTimeZone();
  const [tree, setTree] = useState<AgentTreeResult>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<string>();
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [showCompleted, setShowCompleted] = useState(false);
  const settled = useSettledRevision(watch);
  const serial = useSerialRead();
  const latestRead = useRef<() => void>(() => undefined);
  // The feed says when to read again (gathered for a second); only without one is the tree polled, slowly.
  usePoll(
    (alive) => {
      const read = async (): Promise<void> => {
        if (!alive() || document.hidden) return;
        // One read at a time, across effects: one asked meanwhile runs once it is answered.
        if (!serial.begin()) return;
        try {
          const result = await loadAgentTree(client, workspaceId, taskId);
          if (alive()) {
            setTree(result);
            setError(undefined);
          }
        } catch (failure) {
          if (alive()) setError(errorMessage(failure));
        } finally {
          serial.end(() => latestRead.current());
        }
      };
      latestRead.current = () => void read();
      void read();
    },
    settled === undefined ? AGENT_TREE_FALLBACK_POLL_MS : undefined,
    { immediate: true, visibility: true },
    [client, workspaceId, taskId, revision, version, settled, serial],
  );
  usePoll(
    () => {
      if (!tree || document.hidden) return;
      const eligible = new Set(tree.truncated ? [] : foldableChildren(tree.nodes, taskId, Date.now()));
      setFolded((before) => {
        const kept = new Set([...before].filter((id) => eligible.has(id)));
        const additions = [...eligible].filter((id) => !kept.has(id)).slice(0, 20);
        additions.forEach((id) => kept.add(id));
        return kept.size === before.size && [...kept].every((id) => before.has(id)) ? before : kept;
      });
    },
    1000,
    { enabled: tree !== undefined, immediate: true },
    [tree, taskId],
  );
  const act = async (id: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(id);
    setError(undefined);
    try {
      await work();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(undefined);
    }
  };
  const cancel = (id: string) =>
    act(id, async () => {
      const answer = await client.request("cancel", { taskId: id, reason: "Cancelled from canvas agent tree" });
      if (!answer.ok) throw new Error(refusal(answer, "Cancellation refused"));
      setRevision((before) => before + 1);
    });
  const rows = tree
    ? orderedTree(tree.nodes).filter(
        (node) =>
          node.taskId !== taskId &&
          (!dismissed.has(`${node.taskId}:${node.updatedAt}`) || !ended(node.status) || !!node.needs?.length) &&
          (showCompleted || !folded.has(node.taskId)),
      )
    : [];
  const parents = new Map(tree?.nodes.map((node) => [node.taskId, node.parentTaskId]) ?? []);
  const countDescendants = (id: string) =>
    tree?.nodes.filter((node) => {
      const seen = new Set<string>();
      let parent = node.parentTaskId;
      while (parent && !seen.has(parent)) {
        if (parent === id) return true;
        seen.add(parent);
        parent = parents.get(parent);
      }
      return false;
    }).length ?? 0;
  return (
    <section className="agent-tree" aria-label="agent hierarchy">
      <div className="agent-tree-column">
        <nav aria-label="task ancestry">
          {tree?.ancestors.map((id) => (
            <Button key={id} disabled={busy !== undefined} onClick={() => void act(id, () => onOpen(id))}>
              {id} /
            </Button>
          ))}
          <span>{taskId}</span>
        </nav>
        <Failure message={error || undefined} />
        {!tree && !error ? <Pending label="Loading tree…" className="notice" status /> : null}
        {tree?.ancestryUnknown ? <p>Historical parent/root ancestry is incomplete.</p> : null}
        {tree?.truncated ? <p>Tree truncated at 200 tasks or 32 ancestors. Open a child to inspect its subtree.</p> : null}
        {tree?.nodes[0]?.needs?.length ? (
          <p role="status">
            This agent or the agents under it need: {tree.nodes[0].needs.join(", ")}. A worker's question or browser handoff is answered
            here and in the chat's transcript.
          </p>
        ) : null}
        {needs}
        {folded.size ? (
          <Button aria-expanded={showCompleted} onClick={() => setShowCompleted((before) => !before)}>
            Completed ({folded.size})
          </Button>
        ) : null}
        {tree && tree.nodes.length === 1 ? <p>No recorded children.</p> : null}
        <ul>
          {rows.map((node) => (
            <li
              key={node.taskId}
              style={{
                marginInlineStart: `${Math.min(AGENT_TREE_MAX_INDENT_EM, Math.max(0, node.depth - (tree?.nodes[0]?.depth ?? 0) - 1))}em`,
              }}
            >
              <span className="badge">{node.status}</span>{" "}
              <Button aria-pressed={opened === node.taskId} onClick={() => onOpenWorker(node)}>
                {workerLabel(node)} — {node.taskId}
              </Button>
              <span>
                {" "}
                ·{" "}
                {formatElapsed(Math.max(0, Date.parse(ended(node.status) ? node.updatedAt : nowTimestamp()) - Date.parse(node.createdAt)))}{" "}
                · updated <time dateTime={node.updatedAt}>{instantLabel(node.updatedAt, timeZone, todayIn(timeZone))}</time>
                {agentsUnder(countDescendants(node.taskId))}
              </span>
              {node.activity !== undefined && !ended(node.status) ? (
                <p className="agent-tree-activity truncate">
                  {node.activity.kind === "tool" ? `Using ${node.activity.text}` : node.activity.text}
                </p>
              ) : null}
              {node.finalText !== undefined && ended(node.status) ? (
                <FinalText key={`${node.taskId}:${node.updatedAt}`} text={node.finalText} label={workerLabel(node)} />
              ) : null}
              {node.needs?.length ? <strong> · Needs {node.needs.join(", ")}</strong> : null}
              {!ended(node.status) ? (
                <Button disabled={busy !== undefined} onClick={() => void cancel(node.taskId)}>
                  Cancel {node.taskId}
                </Button>
              ) : node.status !== "completed" && !node.needs?.length ? (
                <Button onClick={() => setDismissed((before) => new Set([...before, `${node.taskId}:${node.updatedAt}`].slice(-200)))}>
                  Dismiss {node.taskId}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** How many agents a row's agent started, shown in the tree, as its line says it: nothing for none. */
function agentsUnder(count: number): string | null {
  return count === 0 ? null : ` · ${plural(count, "agent")} under it`;
}
