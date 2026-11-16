/** Hand the browser a file to save. */
export function saveFile(bytes: Uint8Array<ArrayBuffer>, type: string, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
