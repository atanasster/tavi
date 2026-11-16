// A plugin that registers one more tool each time its worker starts: a restart registers something else.
import { readFileSync, writeFileSync } from "node:fs";

export function register(ctx) {
  const file = `${process.env.HOME}/starts`;
  let starts = 0;
  try {
    starts = Number(readFileSync(file, "utf8"));
  } catch {}
  writeFileSync(file, String(starts + 1));
  for (let index = 0; index <= starts; index += 1) {
    ctx.registerTool({ name: `tool${index}`, inputSchema: ctx.z.object({}), handler: async () => ({ index }) });
  }
}
