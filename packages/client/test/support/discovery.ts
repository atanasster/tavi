/**
 * Off Windows a cookie's mode is checked as an owner's would be. Windows has
 * no modes: there the caller supplies the access-list rule (node-kit's, tested
 * there), so the suites that test the reading pass one that finds nothing wrong.
 */
export const discovery = process.platform === "win32" ? { privacyProblem: () => undefined } : {};

/** On Windows the caller checks the pipe's owner (node-kit's `assertPipeOwnedHere`); the suites' own pipes pass. */
export const socket = process.platform === "win32" ? { verify: () => undefined } : {};
