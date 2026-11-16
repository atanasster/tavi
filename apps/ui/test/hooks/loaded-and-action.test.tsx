// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";

import { useAction } from "../../src/hooks/use-action.js";
import { useLoaded } from "../../src/hooks/use-loaded.js";
import type { Outcome } from "../../src/lib/ipc.js";
import { mount, rerender, settle } from "../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** An owner whose every answer waits until the test gives it, in the order asked. */
function slowOwner() {
  const waiting: ((value: Outcome<number>) => void)[] = [];
  let asked = 0;
  const load = (): Promise<Outcome<number>> => {
    asked += 1;
    const answer = asked;
    return new Promise((resolve) => waiting.push(() => resolve({ ok: true, value: answer })));
  };
  const answer = async (): Promise<void> => {
    await act(async () => waiting.shift()?.({ ok: true, value: 0 }));
    await settle();
  };
  return { load, answer, asked: () => asked };
}

function Loaded({
  load,
  beat,
  serial,
  enabled = true,
}: {
  readonly load: () => Promise<Outcome<number>>;
  readonly beat: number;
  readonly serial: boolean;
  readonly enabled?: boolean;
}) {
  const { data } = useLoaded(load, [beat], { serial, enabled });
  return <p>{data === undefined ? "none" : `answer ${data}`}</p>;
}

describe("useLoaded", () => {
  it("drops a slow read when the next beat starts another, unless it is serial: then each answer shows, and one read follows", async () => {
    const dropping = slowOwner();
    const plain = await mount(<Loaded load={dropping.load} beat={0} serial={false} />);
    await rerender(<Loaded load={dropping.load} beat={1} serial={false} />);
    await dropping.answer();
    // The first read's answer came after the second began: it is not shown.
    expect(plain.textContent).toBe("none");

    const keeping = slowOwner();
    const serial = await mount(<Loaded load={keeping.load} beat={0} serial />);
    await rerender(<Loaded load={keeping.load} beat={1} serial />);
    await rerender(<Loaded load={keeping.load} beat={2} serial />);
    // Two beats while the first read is out: no read is started over it.
    expect(keeping.asked()).toBe(1);
    await keeping.answer();
    expect(serial.textContent).toBe("answer 1");
    // The beats missed meanwhile ask once more, not twice.
    expect(keeping.asked()).toBe(2);
    await keeping.answer();
    expect(serial.textContent).toBe("answer 2");
    expect(keeping.asked()).toBe(2);
  });

  it("reads nothing while off, keeps what it held, and reads at once when on again", async () => {
    let asked = 0;
    const load = async (): Promise<Outcome<number>> => ({ ok: true, value: ++asked });
    const page = await mount(<Loaded load={load} beat={0} serial={false} />);
    await settle();
    expect(page.textContent).toBe("answer 1");
    await rerender(<Loaded load={load} beat={1} serial={false} enabled={false} />);
    await settle();
    expect(asked).toBe(1);
    expect(page.textContent).toBe("answer 1");
    await rerender(<Loaded load={load} beat={1} serial={false} />);
    await settle();
    expect(asked).toBe(2);
    expect(page.textContent).toBe("answer 2");
  });
});

function Actions({ work, reloads }: { readonly work: () => Promise<Outcome<string | undefined>>; readonly reloads: { count: number } }) {
  const { busy, note, tone, run } = useAction(() => {
    reloads.count += 1;
  });
  return (
    <>
      <button type="button" disabled={busy !== undefined} onClick={() => void run("act", work)}>
        Act
      </button>
      <button type="button" disabled={busy !== undefined} onClick={() => void run("look", work, { reload: false })}>
        Look
      </button>
      <p data-tone={tone}>{note}</p>
    </>
  );
}

describe("useAction", () => {
  it("ends work that throws as a refusal in words, with every button enabled again", async () => {
    const reloads = { count: 0 };
    const page = await mount(
      <Actions
        reloads={reloads}
        work={async () => {
          throw new Error("the owner went away");
        }}
      />,
    );
    await act(async () => page.querySelector("button")?.click());
    await settle();
    expect(page.querySelector("p")?.textContent).toBe("the owner went away");
    expect(page.querySelector("p")?.getAttribute("data-tone")).toBe("failure");
    expect([...page.querySelectorAll("button")].every((button) => !button.disabled)).toBe(true);
    expect(reloads.count).toBe(1);
  });

  it("reads nothing again after an action that only read", async () => {
    const reloads = { count: 0 };
    const page = await mount(<Actions reloads={reloads} work={async () => ({ ok: true, value: "Opened." })} />);
    await act(async () => page.querySelectorAll("button")[1]?.click());
    await settle();
    expect(page.querySelector("p")?.textContent).toBe("Opened.");
    expect(reloads.count).toBe(0);
    await act(async () => page.querySelector("button")?.click());
    await settle();
    expect(reloads.count).toBe(1);
  });
});
