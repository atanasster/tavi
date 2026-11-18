/**
 * Node-only helpers the packages share, each one implementation instead of a
 * copy per package. Depends on Node's built-ins, and on Windows on `koffi` for
 * the few Win32 calls (`win32.ts`), loaded only there.
 */

export {
  flushDirectory,
  flushFile,
  retryWhileHeld,
  retryWhileHeldAsync,
  writeFileAtomic,
  writeFileAtomicAsync,
  writeJsonAtomic,
  type AtomicJsonOptions,
  type AtomicWriteOptions,
} from "./atomic.js";
export { BodyTooLargeError, readBoundedBody, type BodySource, type BoundedBody, type BoundedBodyOptions } from "./body.js";
export { sha256Hex } from "./hash.js";
export { securityHeaders, type SecurityHeaderOptions } from "./headers.js";
export { prefixedId } from "./id.js";
export { launchCommand, LaunchRefusedError, type Launch, type LaunchOptions } from "./launch.js";
export { isLoopbackHostname } from "./loopback.js";
export {
  NO_FOLLOW_FLAGS,
  NoFollowReadError,
  openDirectoryNoFollow,
  openDirectoryNoFollowSync,
  openNoFollow,
  openNoFollowSync,
  readNoFollow,
  readNoFollowSync,
  windowsPathRefusal,
  type NoFollowOpen,
  type NoFollowOpenOptions,
  type NoFollowReadOptions,
  type NoFollowRefusal,
} from "./no-follow.js";
export {
  openerFor,
  openersFor,
  openerShowsUrl,
  openUrl,
  type Opener,
  type OpenerProcess,
  type OpenerSpawn,
  type OpenUrlOptions,
} from "./open-url.js";
export {
  childBaseEnv,
  executableExtensions,
  findExecutable,
  joinPath,
  pathDelimiter,
  pathEntries,
  systemChildEnv,
  systemEnv,
  systemPathEntries,
  type FindExecutableOptions,
} from "./path-env.js";
export { serialLock, type SerialLock } from "./serial-lock.js";
export { sleep, type SleepOptions } from "./sleep.js";
export {
  WSL1_UNSUPPORTED,
  WSL_DEFAULT_DRIVES,
  WSL_INTEROP_DIRECTORY,
  WSL_KEEP_RUNNING,
  wslDenyRoots,
  wslVersion,
  type WslProbe,
  type WslVersion,
} from "./wsl.js";
export {
  EndpointRefusedError,
  assertPipeOwnedHere,
  isPipeEndpoint,
  newPipeEndpoint,
  protectPipe,
} from "./endpoint.js";
export { makePrivateDirectory, ownedHere, privacyProblem, privateExpectation, privateRemedy } from "./private-path.js";
export { processStartTime, startTimeFromStat } from "./process-start.js";
export {
  ADMINISTRATORS_SID,
  LOCAL_SYSTEM_SID,
  NETWORK_SID,
  ownerOnlySddl,
  parseSddl,
  privateAccessProblem,
  privateDirectorySddl,
  trustedOwner,
  trusteeSid,
  type AccessEntry,
  type SecurityDescriptor,
} from "./security-descriptor.js";
export {
  Win32Error,
  currentUserSid,
  detachConsole,
  namedSecurity,
  processCreationTime,
  processHandleCount,
  setNamedAccessList,
  shellOpen,
} from "./win32.js";
export { sameIdentity, type FileIdentity } from "./identity.js";
export { REMOTE_MIRROR_FILE, type RemoteMirror, readRemoteMirrorFile } from "./remote-mirror.js";
