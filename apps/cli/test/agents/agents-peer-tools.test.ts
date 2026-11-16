import type { AgentCommunicationServicePort, AgentRequestInput, AgentSendInput, InvocationContext } from "@tavi/contracts";
import { ToolRegistry } from "@tavi/runtime";
import { describe, expect, it } from "vitest";

import { registerAgentTools } from "../../src/features/agents/tools.js";

/**
 * `agents.send` and `agents.request` name the recipient's agent as its task
 * runs as — never the model's word, which is still accepted and ignored — and
 * `agents.request`/`agents.reply` are offered only where a peer grant exists.
 */
describe("agents.send and agents.request's recipient, and the peer tools' offer", () => {
  const context: InvocationContext = { workspaceId: "w1", principalId: "operator", runId: "task-parent", caller: "test" };
  const fixture = (granted: boolean) => {
    const sends: AgentSendInput[] = [];
    const requests: AgentRequestInput[] = [];
    const agents = {
      send: async (input: AgentSendInput) => {
        sends.push(input);
        return { messageId: "msg-1", accepted: true };
      },
      request: async (input: AgentRequestInput) => {
        requests.push(input);
        return { messageId: "msg-2" };
      },
    } as unknown as AgentCommunicationServicePort;
    const registry = new ToolRegistry();
    registerAgentTools(registry, agents, {
      delegations: {
        getByWorkerTaskId: async (taskId: string) => (taskId === "task-worker" ? ({ workerAgentId: "agent-writer" } as never) : undefined),
      },
      peerMessaging: (offer) => granted && offer.workspaceId === "w1",
    });
    const call = (id: string, input: unknown) =>
      registry.get(id)?.handler({ input, context, signal: new AbortController().signal, callId: "call-1" });
    return { registry, call, sends, requests };
  };

  it("derives the recipient's agent from its task, ignoring one the model gives", async () => {
    const { call, sends, requests } = fixture(true);
    await call("agents.send", { recipientTaskId: "task-worker", kind: "message", content: "hi" });
    await call("agents.send", { recipientAgentId: "someone-else", recipientTaskId: "task-root", kind: "progress" });
    await call("agents.request", {
      recipientAgentId: "agent-granted",
      recipientTaskId: "task-worker",
      deadlineAt: "2026-10-28T00:00:00.000Z",
    });
    expect(sends.map((send) => [send.recipientAgentId, send.recipientTaskId])).toEqual([
      ["agent-writer", "task-worker"],
      ["task-root", "task-root"],
    ]);
    expect(requests.map((request) => request.recipientAgentId)).toEqual(["agent-writer"]);
  });

  it("offers agents.request and agents.reply only where a peer-messaging grant exists", async () => {
    const offered = async (granted: boolean, workspaceId = "w1") =>
      (await fixture(granted).registry.listOffered({ workspaceId })).map((tool) => tool.id).filter((id) => id.startsWith("agents."));
    expect(await offered(true)).toEqual(expect.arrayContaining(["agents.request", "agents.reply", "agents.send"]));
    expect(await offered(false)).not.toEqual(expect.arrayContaining(["agents.request"]));
    expect(await offered(false)).not.toContain("agents.reply");
    expect(await offered(true, "w2")).not.toContain("agents.request");
    expect(await offered(false)).toContain("agents.send");
  });
});
