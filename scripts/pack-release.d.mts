/** `SHA256SUMS` in `directory`: one line per tarball and the installer. */
export function writeChecksums(directory: string): void;
/** The `## <heading>` section of the changelog, without its heading, or `undefined`. */
export function changelogSection(changelog: string, heading: string): string | undefined;
