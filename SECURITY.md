# Security policy

Tavi runs agents with your credentials, reads untrusted web pages and
messages, and executes tools in a sandbox, so security reports matter to us.

## Reporting a vulnerability

Please report it privately through GitHub: on this repository's **Security**
tab, choose **Report a vulnerability**. Do not open a public issue, pull
request or discussion for it.

Include what you can of:

- the version (`tavi --version`) and platform (macOS or Linux, and its version);
- what an attacker controls (a web page, a message to a channel, a plugin, a
  file in a chat's folder) and what they gain;
- steps or a proof of concept, and `tavi doctor` output with secrets removed.

We aim to acknowledge a report within a week and to agree a disclosure date
with you once a fix is ready.

## Supported versions

Tavi is pre-1.0 and runs from a clone: fixes land on `main`. Update your
checkout (`git pull`, `pnpm install`, `pnpm run build`) to pick them up.

## Scope

In scope: the CLI, the owner process (`tavi serve`), the web canvas, the IPC
and HTTP surfaces, the sandbox and confinement of tools, plugins and MCP
servers, credential storage, approvals and taint tracking, and the bundled
plugins. A weakness in a model provider, an MCP server or a third-party plugin
you installed is theirs to fix, but tell us if Tavi makes it worse.
