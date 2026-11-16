import { expect, it } from "vitest";
import { AsyncWork } from "../src/async-work.js";

it("closes admission and waits for accepted work even when a caller stops waiting", async () => {
  const work = new AsyncWork();
  const barrier = Promise.withResolvers<void>();
  const accepted = work.run(() => barrier.promise);
  work.stop();
  await expect(work.run(async () => {})).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await work.idleWithin(1)).toBe(false);
  expect(work.active).toBe(true);
  barrier.resolve();
  await accepted;
  expect(await work.idleWithin(100)).toBe(true);
});

it("joins work registered while a previously accepted operation settles", async () => {
  const work = new AsyncWork();
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const accepted = work.run(async () => {
    await first.promise;
    work.track(second.promise);
  });
  let idle = false;
  const joined = work.idle().then(() => {
    idle = true;
  });
  first.resolve();
  await accepted;
  await Promise.resolve();
  expect(idle).toBe(false);
  second.resolve();
  await joined;
  expect(idle).toBe(true);
});
