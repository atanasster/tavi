# Tavi on Windows

Tavi runs on Windows today inside **WSL2**, as Linux, with its sandbox. Native
Windows support is being built: what already works, and what is still refused,
is below.

## WSL2 (recommended)

Install WSL2 and a Linux distribution from an administrator PowerShell, then
install Tavi inside the distribution as on Linux (see the
[README](../README.md#quick-install)):

```powershell
wsl --install
```

- Inside the distribution install Node.js 22.21 or later, pnpm
  (`corepack enable`), Git, and `bubblewrap`, `socat` and `ripgrep` for the
  sandbox. Clone into your Linux home (`cd ~`), not under `/mnt`, then run
  `tavi sandbox check`.
- Keep the data directory on the Linux filesystem (the default
  `~/.local/share/tavi`). Every command that opens it refuses one on a Windows
  drive under `/mnt` (or any other 9p mount).
- The Windows drives are closed to sandboxed commands, under `/mnt` or wherever
  `/etc/wsl.conf` mounts them, as other mounted drives are, and so is WSL's
  interop, which would start a Windows program outside the sandbox. Attach a
  folder there to work in it.
- WSL stops a distribution soon after its last terminal closes, and `tavi serve`
  with it. `tavi doctor`, `tavi service unit` and `tavi onboard` say which
  `.wslconfig` settings keep it running.
- WSL1 cannot run the sandbox: move the distribution to WSL2 with
  `wsl --set-version <distro> 2`.

[SANDBOX](SANDBOX.md#wsl2) has the details.

## Native Windows

### Install

**Native Windows is not supported for daily use yet:** `tavi serve` refuses to
start and sandboxed tools are refused (below). A single foreground command
works; for everything else, use WSL2.

Tavi runs from a clone of this repository; there is no npm package or `winget`
package yet. You need Node.js 22.21 or later (x64 or arm64), pnpm, Git, and the
Microsoft Visual C++ runtime, which Tavi's native modules load:

```powershell
winget install Microsoft.VCRedist.2015+.x64   # .arm64 on Windows on Arm
corepack enable   # from an administrator PowerShell if Node.js is in Program Files
git clone https://github.com/atanasster/tavi.git
cd tavi
pnpm install
pnpm run build
$taviCli = "$PWD\scripts\tavi.mjs"
function tavi { node $taviCli @args }
```

Add the two `tavi` lines to your `$PROFILE` to keep the command in new
windows. `tavi doctor` reports whether the Visual C++ runtime is installed
(`vcRuntime`) and names the `winget` line for your processor when it is not.
The data directory is `%LOCALAPPDATA%\tavi` unless `--data-dir` or
`TAVI_DATA_DIR` names another.

### What works, and what is refused

- **`tavi serve` refuses to start** until the owner's named pipe has been proven
  against a second Windows account in CI. Until then, run the owner in WSL2.
- **The sandbox is not used on Windows yet.** Every tool that needs it (shell
  commands, MCP stdio servers, the PDF and video children) is refused, never run
  unconfined by default. `tavi doctor` reports the sandbox unavailable and names
  WSL2 as the fix.
- **The owner's endpoint** is a named pipe with an access list for your account,
  SYSTEM and Administrators only, refusing network logons. A client checks the
  pipe's owner before it sends its cookie.
- **Private files** (the cookie, credentials, the policy file, the data
  directory) are held to the same rule by their access lists. When one is not,
  Tavi refuses it and prints the `icacls` line that fixes it.
- **The credential key** can be kept in Windows Credential Manager
  (`tavi credentials key --to-keychain`; see [CONFIGURATION](CONFIGURATION.md)).
- **Children Tavi starts** run in a Job Object that ends with Tavi, so nothing it
  started outlives it.
- **Folder tools** never read or write Windows's own key stores (Credential
  Manager's files, DPAPI keys, the GitHub CLI's and gcloud's tokens) nor what
  runs at logon (the Startup folder, PowerShell profiles), as on macOS and
  Linux they never touch `~/.ssh` or a shell's startup files.
- **The browser** relies on Chromium's own sandbox, as on macOS. Names resolve
  only through Tavi's proxy, a site is never offered your Windows sign-in, and a
  `file://` URL naming a network share is refused ([BROWSER](BROWSER.md)).
- **URLs** open in your browser through the Windows shell (`ShellExecuteW`).

### Starting at logon

`tavi service unit --kind task --out dev.tavi.serve.xml` writes a Task
Scheduler task that starts the owner when you log on, as you, never elevated,
with no console window, and restarts it after an error exit. Install it with
`schtasks /Create /TN dev.tavi.serve /XML dev.tavi.serve.xml`
([CLI](CLI.md#windows-a-logon-task)). **Do not install it yet:** it is for
when `tavi serve` runs on Windows, and until then it would only start a
refused owner at each logon (which then ends the task). Keep the owner running
under WSL2 instead.

### Antivirus

Tavi stages no helper program of its own on Windows yet, so it needs no
antivirus exclusion. The sandbox helper that will confine tools natively is
staged under `%ProgramData%\tavi\srt-win` once it ships, and this page will
say whether to exclude it if your antivirus slows or blocks it.

### Tested on

The `windows` CI job builds, lints and type-checks Tavi on Windows x64, runs
the repository's own checks, which must pass, and every workspace's unit tests,
which do not fail the job yet. The `windows-arm` job loads the native modules,
builds and type-checks Tavi on Windows 11 on Arm, and runs the repository's
own checks.
Tests that need POSIX are listed, each with its reason, in `POSIX_ONLY`
(`packages/test-support/src/posix-only.ts`).
