import { createRequire } from "node:module";

import type * as Koffi from "koffi";

/**
 * The few Win32 calls Tavi makes itself, through `koffi`, which is loaded the
 * first time one is called: never on macOS or Linux. Every function here
 * throws off Windows. Pointers are `koffi`'s BigInts; what Windows allocates
 * with `LocalAlloc` is freed with `LocalFree` before returning.
 */

/** `SE_OBJECT_TYPE`: a file, directory or named pipe (a pipe is opened by its name as a file is). */
const SE_FILE_OBJECT = 1;
const OWNER_SECURITY_INFORMATION = 0x1;
const DACL_SECURITY_INFORMATION = 0x4;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x8000_0000;
const SDDL_REVISION_1 = 1;
const TOKEN_QUERY = 0x8;
const TOKEN_USER = 1;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SW_SHOWNORMAL = 1;

interface Win32 {
  readonly koffi: typeof Koffi;
  readonly GetLastError: () => number;
  readonly LocalFree: (memory: unknown) => unknown;
  readonly CloseHandle: (handle: unknown) => boolean;
  readonly GetCurrentProcess: () => unknown;
  readonly OpenProcess: (access: number, inherit: boolean, pid: number) => unknown;
  readonly GetProcessTimes: (process: unknown, creation: bigint[], exit: bigint[], kernel: bigint[], user: bigint[]) => boolean;
  readonly OpenProcessToken: (process: unknown, access: number, token: unknown[]) => boolean;
  readonly GetTokenInformation: (token: unknown, kind: number, buffer: Buffer, length: number, needed: number[]) => boolean;
  readonly ConvertSidToStringSidW: (sid: unknown, text: unknown[]) => boolean;
  readonly ConvertStringSecurityDescriptorToSecurityDescriptorW: (
    sddl: string,
    revision: number,
    descriptor: unknown[],
    size: null,
  ) => boolean;
  readonly ConvertSecurityDescriptorToStringSecurityDescriptorW: (
    descriptor: unknown,
    revision: number,
    information: number,
    text: unknown[],
    length: null,
  ) => boolean;
  readonly GetSecurityDescriptorDacl: (descriptor: unknown, present: number[], dacl: unknown[], defaulted: number[]) => boolean;
  readonly SetNamedSecurityInfoW: (
    name: string,
    type: number,
    information: number,
    owner: null,
    group: null,
    dacl: unknown,
    sacl: null,
  ) => number;
  readonly FreeConsole: () => boolean;
  readonly GetProcessHandleCount: (process: unknown, count: number[]) => boolean;
  readonly ShellExecuteW: (window: null, operation: string, file: string, parameters: null, directory: null, show: number) => unknown;
  readonly GetNamedSecurityInfoW: (
    name: string,
    type: number,
    information: number,
    owner: null,
    group: null,
    dacl: null,
    sacl: null,
    descriptor: unknown[],
  ) => number;
}

let loaded: Win32 | undefined;

function win32(): Win32 {
  if (process.platform !== "win32") throw new Error("a Win32 call was made off Windows");
  if (loaded !== undefined) return loaded;
  const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi;
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");
  const shell32 = koffi.load("shell32.dll");
  loaded = {
    koffi,
    GetLastError: kernel32.func("uint32_t __stdcall GetLastError()"),
    LocalFree: kernel32.func("void * __stdcall LocalFree(void *hMem)"),
    CloseHandle: kernel32.func("bool __stdcall CloseHandle(void *hObject)"),
    GetCurrentProcess: kernel32.func("void * __stdcall GetCurrentProcess()"),
    OpenProcess: kernel32.func("void * __stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)"),
    GetProcessTimes: kernel32.func(
      "bool __stdcall GetProcessTimes(void *hProcess, _Out_ uint64_t *lpCreationTime, _Out_ uint64_t *lpExitTime, _Out_ uint64_t *lpKernelTime, _Out_ uint64_t *lpUserTime)",
    ),
    OpenProcessToken: advapi32.func(
      "bool __stdcall OpenProcessToken(void *ProcessHandle, uint32_t DesiredAccess, _Out_ void **TokenHandle)",
    ),
    GetTokenInformation: advapi32.func(
      "bool __stdcall GetTokenInformation(void *TokenHandle, int TokenInformationClass, _Out_ uint8_t *TokenInformation, uint32_t TokenInformationLength, _Out_ uint32_t *ReturnLength)",
    ),
    ConvertSidToStringSidW: advapi32.func("bool __stdcall ConvertSidToStringSidW(void *Sid, _Out_ void **StringSid)"),
    ConvertStringSecurityDescriptorToSecurityDescriptorW: advapi32.func(
      "bool __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *StringSecurityDescriptor, uint32_t StringSDRevision, _Out_ void **SecurityDescriptor, _Out_ uint32_t *SecurityDescriptorSize)",
    ),
    ConvertSecurityDescriptorToStringSecurityDescriptorW: advapi32.func(
      "bool __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void *SecurityDescriptor, uint32_t RequestedStringSDRevision, uint32_t SecurityInformation, _Out_ void **StringSecurityDescriptor, _Out_ uint32_t *StringSecurityDescriptorLen)",
    ),
    GetSecurityDescriptorDacl: advapi32.func(
      "bool __stdcall GetSecurityDescriptorDacl(void *pSecurityDescriptor, _Out_ int *lpbDaclPresent, _Out_ void **pDacl, _Out_ int *lpbDaclDefaulted)",
    ),
    SetNamedSecurityInfoW: advapi32.func(
      "uint32_t __stdcall SetNamedSecurityInfoW(const char16_t *pObjectName, int ObjectType, uint32_t SecurityInfo, void *psidOwner, void *psidGroup, void *pDacl, void *pSacl)",
    ),
    FreeConsole: kernel32.func("bool __stdcall FreeConsole()"),
    GetProcessHandleCount: kernel32.func("bool __stdcall GetProcessHandleCount(void *hProcess, _Out_ uint32_t *pdwHandleCount)"),
    ShellExecuteW: shell32.func(
      "intptr_t __stdcall ShellExecuteW(void *hwnd, const char16_t *lpOperation, const char16_t *lpFile, const char16_t *lpParameters, const char16_t *lpDirectory, int nShowCmd)",
    ),
    GetNamedSecurityInfoW: advapi32.func(
      "uint32_t __stdcall GetNamedSecurityInfoW(const char16_t *pObjectName, int ObjectType, uint32_t SecurityInfo, _Out_ void **ppsidOwner, _Out_ void **ppsidGroup, _Out_ void **ppDacl, _Out_ void **ppSacl, _Out_ void **ppSecurityDescriptor)",
    ),
  };
  return loaded;
}

/** A failed Win32 call, with the error code Windows gave. */
export class Win32Error extends Error {
  readonly call: string;
  readonly winCode: number;

  constructor(call: string, winCode: number) {
    super(`${call} failed with Windows error ${winCode}`);
    this.name = "Win32Error";
    this.call = call;
    this.winCode = winCode;
  }
}

/** The text a `LocalAlloc`ed wide string holds, freed once read. */
function takeWideString(api: Win32, pointer: unknown): string {
  try {
    return api.koffi.decode(pointer, "char16_t", -1) as string;
  } finally {
    api.LocalFree(pointer);
  }
}

/** The SID of the account this process runs as, as text (`S-1-5-21-…`). */
export function currentUserSid(): string {
  const api = win32();
  const token: unknown[] = [null];
  if (!api.OpenProcessToken(api.GetCurrentProcess(), TOKEN_QUERY, token)) throw new Win32Error("OpenProcessToken", api.GetLastError());
  try {
    // TOKEN_USER is a SID pointer and its attributes; the SID itself follows in the same buffer.
    const buffer = Buffer.alloc(512);
    if (!api.GetTokenInformation(token[0], TOKEN_USER, buffer, buffer.length, [0]))
      throw new Win32Error("GetTokenInformation", api.GetLastError());
    const sid = api.koffi.decode(buffer, "void *");
    const text: unknown[] = [null];
    if (!api.ConvertSidToStringSidW(sid, text)) throw new Win32Error("ConvertSidToStringSidW", api.GetLastError());
    return takeWideString(api, text[0]);
  } finally {
    api.CloseHandle(token[0]);
  }
}

/**
 * Replace the access list of the file, directory or named pipe at `name` with
 * the one `sddl` gives (its `D:` part), marked protected so it inherits nothing.
 */
export function setNamedAccessList(name: string, sddl: string): void {
  const api = win32();
  const descriptor: unknown[] = [null];
  if (!api.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, descriptor, null))
    throw new Win32Error("ConvertStringSecurityDescriptorToSecurityDescriptorW", api.GetLastError());
  try {
    const present = [0];
    const dacl: unknown[] = [null];
    if (!api.GetSecurityDescriptorDacl(descriptor[0], present, dacl, [0]))
      throw new Win32Error("GetSecurityDescriptorDacl", api.GetLastError());
    const status = api.SetNamedSecurityInfoW(
      name,
      SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      null,
      null,
      dacl[0],
      null,
    );
    if (status !== 0) throw new Win32Error("SetNamedSecurityInfoW", status);
  } finally {
    api.LocalFree(descriptor[0]);
  }
}

/** The owner and access list of the file, directory or named pipe at `name`, as SDDL (`O:…D:…`). */
export function namedSecurity(name: string): string {
  const api = win32();
  const information = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
  const descriptor: unknown[] = [null];
  const status = api.GetNamedSecurityInfoW(name, SE_FILE_OBJECT, information, null, null, null, null, descriptor);
  if (status !== 0) throw new Win32Error("GetNamedSecurityInfoW", status);
  try {
    const text: unknown[] = [null];
    if (!api.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor[0], SDDL_REVISION_1, information, text, null))
      throw new Win32Error("ConvertSecurityDescriptorToStringSecurityDescriptorW", api.GetLastError());
    return takeWideString(api, text[0]);
  } finally {
    api.LocalFree(descriptor[0]);
  }
}

/** When process `pid` was created, as Windows's 100-nanosecond count; undefined when it cannot be opened (gone, or not ours to ask). */
export function processCreationTime(pid: number): string | undefined {
  const api = win32();
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (handle === null || handle === 0n) return undefined;
  try {
    const creation = [0n];
    if (!api.GetProcessTimes(handle, creation, [0n], [0n], [0n])) return undefined;
    return String(creation[0]);
  } finally {
    api.CloseHandle(handle);
  }
}

/**
 * Open `target` (a URL) with the program Windows has registered for it, as
 * Explorer would: no console window and no command line of Tavi's holding
 * it. Returns whether Windows took it (`ShellExecuteW` gives more than 32).
 */
export function shellOpen(target: string): boolean {
  const api = win32();
  return Number(api.ShellExecuteW(null, "open", target, null, null, SW_SHOWNORMAL)) > 32;
}

/**
 * Let go of this process's console: the window Windows opened for it closes
 * once no other process is attached. Returns whether Windows let it go.
 */
export function detachConsole(): boolean {
  return win32().FreeConsole();
}

/** How many handles this process holds open (files, pipes, events, threads and the rest); undefined when Windows will not say. */
export function processHandleCount(): number | undefined {
  const api = win32();
  const count = [0];
  return api.GetProcessHandleCount(api.GetCurrentProcess(), count) ? count[0] : undefined;
}
