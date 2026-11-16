// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { ChannelDescriptor } from "@tavi/contracts";

import { ChannelIcon, ChannelNamesProvider, useChannelNames } from "../../../src/features/shell/ChannelNames.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

/** A channel a plugin adds, with its own PNG icon: named and drawn from its descriptor alone. */
const shape = { label: "Number", placeholder: "", pattern: ".+", normalize: "none" } as const;
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const pager: ChannelDescriptor = {
  providerId: "pager",
  label: "Pager",
  kind: "sms",
  icon: { png: PNG },
  description: "d",
  settings: [],
  auth: { kind: "none" },
  sender: { ...shape, authentication: "provider" },
  target: shape,
};

let names: ReturnType<typeof useChannelNames> | undefined;
function Probe() {
  names = useChannelNames();
  return <ChannelIcon providerId="pager" />;
}

it("names a connection by its channel, draws a plugin's PNG, and reads again on refresh", async () => {
  let connections = [{ connectionId: "pager-1", providerId: "pager" }];
  let lists = 0;
  const client: SettingsClient = {
    request: async (_command, payload) => {
      const action = (payload as { action: string }).action;
      if (action === "catalog") return { ok: true, result: { channels: [pager] } };
      lists += 1;
      return { ok: true, result: { connections, ingress: { host: "127.0.0.1", port: 8025 } } };
    },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <ChannelNamesProvider client={client} workspaceId="w">
        <Probe />
      </ChannelNamesProvider>,
    ),
  );
  expect(names?.connection("pager-1")).toBe("Pager");
  expect(names?.connection("pager-2")).toBeUndefined();
  expect(names?.label("pager")).toBe("Pager");
  expect(host.querySelector("img.channel-icon")?.getAttribute("src")).toBe(PNG);
  connections = [...connections, { connectionId: "pager-2", providerId: "pager" }];
  await act(async () => names!.refresh());
  expect(lists).toBe(2);
  expect(names?.connection("pager-2")).toBe("Pager");
});
