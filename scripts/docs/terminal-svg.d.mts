/** One character cell of a terminal screen and how it is drawn. */
export interface Cell {
  readonly ch: string;
  readonly style: Readonly<Record<string, unknown>>;
}

export function screenOf(transcript: string, cols: number, rows: number): Cell[][];
export function svgOf(lines: readonly (readonly Cell[])[], options?: { theme?: "light" | "dark"; title?: string; cols?: number }): string;
