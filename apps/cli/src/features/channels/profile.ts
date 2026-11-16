/**
 * The tools the messaging profile holds back from a task a chat started,
 * each of which `serve --messaging-allow-tool` can let through. Kept
 * apart from the composition so argument parsing can check a flag against it.
 */
export const MESSAGING_PROFILE_TOOLS: readonly string[] = ["sandbox.run", "fs.write", "fs.edit", "http.request", "plugins.validate"];
