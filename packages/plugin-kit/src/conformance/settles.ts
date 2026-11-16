import { expect } from "vitest";

/** Settles within `ms`, or fails the test: a provider or source never outlives its signal. */
export async function settlesWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  try {
    const settled = await Promise.race([
      work.then(
        () => "settled",
        () => "settled",
      ),
      late,
    ]);
    expect(settled, `settles within ${ms} ms of its signal aborting`).toBe("settled");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
