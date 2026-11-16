/** What both PDF children (the parser and OCR) do the same way on their side of the pipe. */

/** The child's peak resident memory, in KB: each answer reports it for the owner's limits. */
export const maxRssKb = (): number => process.resourceUsage().maxRSS;

/** Write an answer's bytes to stdout, settled once the pipe has taken them. */
export function writeStdout(bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(bytes, (error) => (error === null || error === undefined ? resolve() : reject(error)));
  });
}
