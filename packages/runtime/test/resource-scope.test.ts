import { expect, it, vi } from "vitest";
import { OwnedResourceScope } from "@tavi/runtime";

it("joins concurrent and reentrant disposal and exposes failures as they arrive", async () => {
  const scope = new OwnedResourceScope();
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cleanup = vi.fn(() => pending);
  scope.defer(cleanup);
  scope.defer(() => {
    throw new Error("failed first");
  });
  let reentrant: ReturnType<OwnedResourceScope["dispose"]> | undefined;
  scope.signal.addEventListener("abort", () => {
    reentrant = scope.dispose();
  });
  const first = scope.dispose();
  expect(scope.dispose()).toBe(first);
  expect(reentrant).toBe(first);
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  expect(scope.disposalFailures.map((f) => f.message)).toEqual(["failed first"]);
  release();
  expect(await first).toHaveLength(1);
  await scope.dispose();
  expect(cleanup).toHaveBeenCalledOnce();
});
