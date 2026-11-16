/** An ISO instant as the CLI prints a time: `2026-11-03 16:27 UTC`. */
export function minuteUtc(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}
