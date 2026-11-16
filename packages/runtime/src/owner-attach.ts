/**
 * What a CLI command needs to attach to a live owner, apart from the runtime:
 * the discovery and token files, the ownership probe that clears a dead
 * owner's leftovers, and the IPC client.
 *
 * Every attached command (`tavi tasks`, an attached `tavi run`, the TUI) loads
 * this before it asks the owner anything. Importing it from the package root
 * loaded the whole runtime (the SQLite loader, every repository and service)
 * for a command that only opens a socket, so it is an entry of its own and
 * must stay off the database client.
 */
export { clearDiscovery, clearToken, ipcPaths, readDiscovery, readStopping, readToken } from "./ipc/credentials.js";
export { createIpcClient, type IpcClient, type IpcClientOptions } from "./ipc/transport.js";
export { acquireDataDirectoryOwnership } from "./persistence/ownership-client.js";
export { SERVE_SESSION_PREFIX, liveOwnerProcess } from "./persistence/owner-process.js";
