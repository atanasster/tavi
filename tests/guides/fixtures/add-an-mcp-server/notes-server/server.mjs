// A small MCP server over stdio for the connected-apps guides: a shelf of notes in its own home folder. It imports
// nothing outside Node, so it runs from the copy `tavi mcp add --dir` makes, in its sandbox.
// `list_notes` and `read_note` only read; `add_note` writes a note into $HOME/notes.json (the sandbox's home for it).
// An update the guide's walk drops into $HOME/update.json changes what it lists, as a server's new release would:
// `{ "<tool>": "<description>" }` replaces a tool's description, `"<tool>": null` drops it, a new name adds a tool
// that only reads.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME ?? ".";
const shelf = join(home, "notes.json");
const STARTER = {
  plumber: "Call Sam's Plumbing about the dripping kitchen tap. They only come out on Tuesdays.",
  garden: "Order two bags of compost and a new trowel before the weekend.",
};
const text = (value) => ({ content: [{ type: "text", text: String(value) }] });
const notes = () => (existsSync(shelf) ? JSON.parse(readFileSync(shelf, "utf8")) : { ...STARTER });

const TOOLS = [
  {
    name: "list_notes",
    title: "List notes",
    description: "Lists the titles of the notes on the shelf.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_note",
    title: "Read a note",
    description: "Reads one note by its title.",
    inputSchema: { type: "object", properties: { title: { type: "string", description: "The note's title" } }, required: ["title"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_note",
    title: "Add a note",
    description: "Adds a note to the shelf, or replaces the note with that title.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", description: "The note's title" }, text: { type: "string", description: "What it says" } },
      required: ["title", "text"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

/** What it lists now: its own tools, as the update (if any) changes them. */
function listed() {
  const file = join(home, "update.json");
  if (!existsSync(file)) return TOOLS;
  const update = JSON.parse(readFileSync(file, "utf8"));
  const kept = TOOLS.filter((tool) => update[tool.name] !== null).map((tool) =>
    typeof update[tool.name] === "string" ? { ...tool, description: update[tool.name] } : tool,
  );
  const added = Object.entries(update)
    .filter(([name, description]) => typeof description === "string" && !TOOLS.some((tool) => tool.name === name))
    .map(([name, description]) => ({
      name,
      description,
      inputSchema: { type: "object", properties: { url: { type: "string" } } },
      annotations: { readOnlyHint: true },
    }));
  return [...kept, ...added];
}

function call(name, args) {
  const shelfNow = notes();
  if (name === "list_notes") return text(Object.keys(shelfNow).join("\n"));
  if (name === "read_note") return text(shelfNow[String(args.title ?? "").toLowerCase()] ?? `No note called ${args.title}.`);
  if (name === "add_note") {
    writeFileSync(shelf, JSON.stringify({ ...shelfNow, [String(args.title).toLowerCase()]: String(args.text) }, null, 2));
    return text(`Saved the note ${args.title}.`);
  }
  return { isError: true, content: [{ type: "text", text: `This server has no tool ${name}.` }] };
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === "") continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
    if (message.method === "initialize")
      reply({
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "notes-shelf", version: "1.0.0" },
        instructions: "Use list_notes to see what is on the shelf before reading a note.",
      });
    else if (message.method === "tools/list") reply({ tools: listed() });
    else if (message.method === "tools/call") reply(call(message.params.name, message.params.arguments ?? {}));
    else if (message.method === "ping") reply({});
    else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }
});
