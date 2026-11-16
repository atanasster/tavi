import { createRequire } from "node:module";

import type * as Koffi from "koffi";

/**
 * Windows Job Objects for the children Tavi starts itself, through `koffi`
 * (loaded the first time one is made: never on macOS or Linux). A child put
 * in a job with "kill on close" takes everything it starts with it: ending
 * the job ends the tree, and so does this process ending, since the job's one
 * handle is this process's. `taskkill /T` is not used: it walks parent ids,
 * and misses grandchildren once a wrapper between them has exited.
 *
 * A child runs a moment before it is placed (Node cannot start one
 * suspended), so what it starts in that moment is not in the job.
 */

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
/** `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` on 64-bit Windows: the basic limits (64 bytes), I/O counters (48), then four sizes. */
const EXTENDED_LIMIT_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;
const PEAK_JOB_MEMORY_OFFSET = 136;

interface JobApi {
  readonly koffi: typeof Koffi;
  readonly CreateJobObjectW: (attributes: null, name: null) => unknown;
  readonly SetInformationJobObject: (job: unknown, kind: number, information: Buffer, length: number) => boolean;
  readonly QueryInformationJobObject: (job: unknown, kind: number, information: Buffer, length: number, returned: null) => boolean;
  readonly AssignProcessToJobObject: (job: unknown, process: unknown) => boolean;
  readonly TerminateJobObject: (job: unknown, exitCode: number) => boolean;
  readonly OpenProcess: (access: number, inherit: boolean, pid: number) => unknown;
  readonly CloseHandle: (handle: unknown) => boolean;
}

let loaded: JobApi | undefined;

function jobApi(): JobApi {
  if (loaded !== undefined) return loaded;
  const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi;
  const kernel32 = koffi.load("kernel32.dll");
  loaded = {
    koffi,
    CreateJobObjectW: kernel32.func("void * __stdcall CreateJobObjectW(void *lpJobAttributes, const char16_t *lpName)"),
    SetInformationJobObject: kernel32.func(
      "bool __stdcall SetInformationJobObject(void *hJob, int JobObjectInformationClass, uint8_t *lpJobObjectInformation, uint32_t cbJobObjectInformationLength)",
    ),
    QueryInformationJobObject: kernel32.func(
      "bool __stdcall QueryInformationJobObject(void *hJob, int JobObjectInformationClass, _Out_ uint8_t *lpJobObjectInformation, uint32_t cbJobObjectInformationLength, uint32_t *lpReturnLength)",
    ),
    AssignProcessToJobObject: kernel32.func("bool __stdcall AssignProcessToJobObject(void *hJob, void *hProcess)"),
    TerminateJobObject: kernel32.func("bool __stdcall TerminateJobObject(void *hJob, uint32_t uExitCode)"),
    OpenProcess: kernel32.func("void * __stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)"),
    CloseHandle: kernel32.func("bool __stdcall CloseHandle(void *hObject)"),
  };
  return loaded;
}

const isNull = (handle: unknown): boolean => handle === null || handle === 0n || handle === undefined;

/**
 * The job each child placed in one is in, by its pid, until the job is ended
 * or the child exits: then the pid may be another process's.
 */
const jobs = new Map<number, unknown>();

/** What `placeInJob` needs of a child: its pid, and its exit, which releases its job. */
export interface Jobbable {
  readonly pid?: number | undefined;
  once?(event: "exit", listener: () => void): unknown;
}

/**
 * On Windows, put `child` in a new job that ends with this process: what it
 * starts goes into the job too. Returns whether it was placed (never off
 * Windows, and not when the child has already gone or Windows refuses).
 * When the child exits, its job is closed, ending whatever it left running.
 */
export function placeInJob(child: Jobbable, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32" || child.pid === undefined) return false;
  const pid = child.pid;
  if (jobs.has(pid)) return true;
  const api = jobApi();
  const job = api.CreateJobObjectW(null, null);
  if (isNull(job)) return false;
  const limits = Buffer.alloc(EXTENDED_LIMIT_SIZE);
  limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET);
  const process = api.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
  const placed =
    api.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limits, limits.length) &&
    !isNull(process) &&
    api.AssignProcessToJobObject(job, process);
  if (!isNull(process)) api.CloseHandle(process);
  if (!placed) {
    api.CloseHandle(job);
    return false;
  }
  jobs.set(pid, job);
  // Whatever it left running ends with it (as its group does off Windows), and the pid is freed.
  child.once?.("exit", () => endJob(pid));
  return true;
}

/**
 * `placeInJob`, required: on Windows a child that could not be placed would
 * outlive this process, so it is ended at once and the start refused (throws).
 * Off Windows, and for a child that never started (no pid), nothing is done.
 */
export function requireJob(
  child: Jobbable & { kill?(signal?: NodeJS.Signals): boolean },
  platform: NodeJS.Platform = process.platform,
  place: (child: Jobbable, platform: NodeJS.Platform) => boolean = placeInJob,
): void {
  if (platform !== "win32" || child.pid === undefined || place(child, platform)) return;
  child.kill?.("SIGKILL");
  throw new Error(`process ${String(child.pid)} could not be placed in a Job Object, so it would outlive Tavi; it was ended`);
}

/** End every process in the job of the child `pid`, and the job. Returns whether there was a job to end. */
export function endJob(pid: number): boolean {
  const job = jobs.get(pid);
  if (job === undefined) return false;
  jobs.delete(pid);
  const api = jobApi();
  api.TerminateJobObject(job, 1);
  api.CloseHandle(job);
  return true;
}

/**
 * The most memory the job of the child `pid` has held at once, in KiB
 * (Windows keeps the job's peak, not its current use; a cap is crossed when
 * the peak is), or undefined when it is in no job.
 */
export function jobPeakKb(pid: number): number | undefined {
  const job = jobs.get(pid);
  if (job === undefined) return undefined;
  const api = jobApi();
  const information = Buffer.alloc(EXTENDED_LIMIT_SIZE);
  if (!api.QueryInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, information, information.length, null)) return undefined;
  return Number(information.readBigUInt64LE(PEAK_JOB_MEMORY_OFFSET) / 1024n);
}
