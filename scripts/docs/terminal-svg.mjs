// Draws what a terminal shows as an SVG window, for the documentation's
// terminal screenshots (scripts/docs/capture-ui.mjs). `screenOf` plays a
// recorded transcript into a grid of cells — the subset of VT sequences Ink
// writes: text, CR/LF/BS/TAB, cursor moves (CUU/CUD/CUF/CUB/CNL/CPL/CHA/CUP), erase in
// line and display, and SGR colours — and `svgOf` draws the grid with the
// canvas's Pine & Sun colours, light and dark.

const DEFAULT = { fg: undefined, bg: undefined, bold: false, dim: false, italic: false, underline: false, inverse: false };

/** The 16 ANSI colours, as the canvas's tokens would draw them. */
const PALETTES = {
  light: {
    background: "#f4f6f4",
    window: "#ffffff",
    border: "#d9e0dc",
    foreground: "#132620",
    title: "#52605a",
    ansi: [
      "#132620",
      "#c22b2b",
      "#1b6a4b",
      "#8c5a07",
      "#155e8f",
      "#7b3fa0",
      "#1f6b55",
      "#52605a",
      "#52605a",
      "#d64545",
      "#23845d",
      "#b07410",
      "#1b74b0",
      "#9450c0",
      "#2b8a6e",
      "#132620",
    ],
  },
  dark: {
    background: "#0d1512",
    window: "#141e1a",
    border: "#26332e",
    foreground: "#e6efea",
    title: "#9aaba3",
    ansi: [
      "#e6efea",
      "#ef7a7a",
      "#5fd6a3",
      "#f5c75a",
      "#5fb8ef",
      "#c391e6",
      "#6fd9b4",
      "#9aaba3",
      "#9aaba3",
      "#f39a9a",
      "#7fe2b8",
      "#f8d57d",
      "#86caf3",
      "#d2a9ee",
      "#8fe3c4",
      "#ffffff",
    ],
  },
};

/** Plays `transcript` into a `rows` × `cols` grid; returns the rows that hold anything, trimmed at the end. */
export function screenOf(transcript, cols, rows) {
  const blank = () => Array.from({ length: cols }, () => ({ ch: " ", style: DEFAULT }));
  let grid = Array.from({ length: rows }, blank);
  let row = 0;
  let col = 0;
  let style = DEFAULT;
  const scroll = () => {
    grid.shift();
    grid.push(blank());
    row = rows - 1;
  };
  const sgr = (params) => {
    const codes = params === "" ? [0] : params.split(";").map(Number);
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index];
      if (code === 0) style = DEFAULT;
      else if (code === 1) style = { ...style, bold: true };
      else if (code === 2) style = { ...style, dim: true };
      else if (code === 3) style = { ...style, italic: true };
      else if (code === 4) style = { ...style, underline: true };
      else if (code === 7) style = { ...style, inverse: true };
      else if (code === 22) style = { ...style, bold: false, dim: false };
      else if (code === 23) style = { ...style, italic: false };
      else if (code === 24) style = { ...style, underline: false };
      else if (code === 27) style = { ...style, inverse: false };
      else if (code >= 30 && code <= 37) style = { ...style, fg: code - 30 };
      else if (code >= 90 && code <= 97) style = { ...style, fg: code - 90 + 8 };
      else if (code === 39) style = { ...style, fg: undefined };
      else if (code >= 40 && code <= 47) style = { ...style, bg: code - 40 };
      else if (code >= 100 && code <= 107) style = { ...style, bg: code - 100 + 8 };
      else if (code === 49) style = { ...style, bg: undefined };
      else if ((code === 38 || code === 48) && codes[index + 1] === 5) {
        // A 256-colour index: its first 16 are the ANSI colours; the rest take the nearest of them by brightness.
        const value = codes[index + 2] ?? 7;
        const ansi = value < 16 ? value : value >= 232 ? (value < 244 ? 8 : 7) : 7;
        style = code === 38 ? { ...style, fg: ansi } : { ...style, bg: ansi };
        index += 2;
      } else if ((code === 38 || code === 48) && codes[index + 1] === 2) {
        const hex = `#${codes
          .slice(index + 2, index + 5)
          .map((part) => (part ?? 0).toString(16).padStart(2, "0"))
          .join("")}`;
        style = code === 38 ? { ...style, fg: hex } : { ...style, bg: hex };
        index += 4;
      }
    }
  };
  const chars = [...transcript];
  for (let index = 0; index < chars.length; index++) {
    const ch = chars[index];
    if (ch === "\x1b") {
      const rest = chars.slice(index + 1, index + 40).join("");
      const csi = /^\[([?>=]?)([0-9;]*)([A-Za-z@`])/.exec(rest);
      if (csi !== null) {
        index += csi[0].length;
        const [, private_, params, command] = csi;
        // A count of 0 moves as 1 does, as a terminal takes it.
        const n = Math.max(1, Number(params.split(";")[0] || 1));
        if (private_ !== "") continue;
        if (command === "m") sgr(params);
        else if (command === "A") row = Math.max(0, row - n);
        else if (command === "B") row = Math.min(rows - 1, row + n);
        else if (command === "E") {
          // CNL and CPL: a number of lines down or up, at its first column.
          row = Math.min(rows - 1, row + n);
          col = 0;
        } else if (command === "F") {
          row = Math.max(0, row - n);
          col = 0;
        } else if (command === "C") col = Math.min(cols - 1, col + n);
        else if (command === "D") col = Math.max(0, col - n);
        else if (command === "G") col = Math.min(cols - 1, n - 1);
        else if (command === "H" || command === "f") {
          const [r, c] = params.split(";").map((part) => Number(part || 1));
          row = Math.min(rows - 1, (r ?? 1) - 1);
          col = Math.min(cols - 1, (c ?? 1) - 1);
        } else if (command === "K") {
          const mode = Number(params || 0);
          for (let c = mode === 1 ? 0 : col; c < (mode === 0 ? cols : mode === 1 ? col + 1 : cols); c++)
            grid[row][c] = { ch: " ", style: DEFAULT };
          if (mode === 2) for (let c = 0; c < col; c++) grid[row][c] = { ch: " ", style: DEFAULT };
        } else if (command === "J") {
          const mode = Number(params || 0);
          if (mode === 2 || mode === 3) grid = Array.from({ length: rows }, blank);
          else if (mode === 0) {
            for (let c = col; c < cols; c++) grid[row][c] = { ch: " ", style: DEFAULT };
            for (let r = row + 1; r < rows; r++) grid[r] = blank();
          }
        }
        continue;
      }
      // An OSC (a title) runs to BEL or ST; any other escape is one character more.
      const osc = /^\][^\x07\x1b]*(\x07|\x1b\\)/.exec(rest);
      index += osc !== null ? osc[0].length : 1;
      continue;
    }
    if (ch === "\r") col = 0;
    else if (ch === "\n") {
      row += 1;
      if (row >= rows) scroll();
    } else if (ch === "\b") col = Math.max(0, col - 1);
    else if (ch === "\t") col = Math.min(cols - 1, (Math.floor(col / 8) + 1) * 8);
    else if (ch >= " " || ch > "\x7f") {
      if (col >= cols) {
        col = 0;
        row += 1;
        if (row >= rows) scroll();
      }
      grid[row][col] = { ch, style };
      col += 1;
    }
  }
  const lines = grid.map((cells) => {
    let end = cells.length;
    while (end > 0 && cells[end - 1].ch === " " && cells[end - 1].style.bg === undefined) end--;
    return cells.slice(0, end);
  });
  while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop();
  while (lines.length > 0 && lines[0].length === 0) lines.shift();
  return lines;
}

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The grid as an SVG terminal window in `theme`, titled `title`. */
export function svgOf(lines, { theme = "light", title = "tavi chat", cols = 100 } = {}) {
  const palette = PALETTES[theme];
  const cell = { width: 8.4, height: 19 };
  const pad = 20;
  const bar = 36;
  const width = Math.round(cols * cell.width + pad * 2);
  const height = Math.round(Math.max(lines.length, 4) * cell.height + pad * 2 + bar);
  const colour = (value, fallback) => (value === undefined ? fallback : typeof value === "string" ? value : palette.ansi[value]);
  const rows = lines.map((cells, index) => {
    const y = bar + pad + (index + 1) * cell.height - 5;
    const spans = [];
    let run = "";
    let runStyle;
    const flush = () => {
      if (run === "") return;
      const s = runStyle;
      const fg = colour(s.inverse ? s.bg : s.fg, s.inverse ? palette.window : palette.foreground);
      const attrs = [
        `fill="${fg}"`,
        s.bold ? 'font-weight="700"' : "",
        s.dim ? 'opacity="0.62"' : "",
        s.italic ? 'font-style="italic"' : "",
        s.underline ? 'text-decoration="underline"' : "",
      ]
        .filter(Boolean)
        .join(" ");
      spans.push(`<tspan ${attrs}>${escape(run)}</tspan>`);
      run = "";
    };
    for (const { ch, style } of cells) {
      if (runStyle !== undefined && JSON.stringify(style) !== JSON.stringify(runStyle)) flush();
      runStyle = style;
      run += ch;
    }
    flush();
    return `<text x="${pad}" y="${y.toFixed(1)}" xml:space="preserve">${spans.join("")}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
<rect width="${width}" height="${height}" rx="12" fill="${palette.window}" stroke="${palette.border}"/>
<circle cx="22" cy="18" r="6" fill="#e5675e"/><circle cx="42" cy="18" r="6" fill="#e9a62b"/><circle cx="62" cy="18" r="6" fill="#5bbd72"/>
<text x="${width / 2}" y="23" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="13" fill="${palette.title}">${escape(title)}</text>
<line x1="0" y1="${bar}" x2="${width}" y2="${bar}" stroke="${palette.border}"/>
<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14">
${rows.join("\n")}
</g>
</svg>
`;
}
