# Approve, reject or always-allow a tool call

Decide what Tavi may do when it wants to change something: allow a call once, for the rest of the chat or always, or deny it with a reason the model reads. About five minutes.

> **Uses:** approvals (the approval card, `tavi approvals list`) · permissions (`tavi permissions list`) · the web canvas and the terminal chat
> **Before you start:** a model connected ([Connect your first model](../get-started/first-model.md)) · Tavi running in the background with `tavi serve` ([Keep Tavi running in the background](../get-started/keep-tavi-running.md)) · the canvas open ([Open the web canvas and walk through Welcome](../get-started/web-canvas-tour.md))

## 1. Ask for a change

Start a new chat with **+** above the chat list and ask for something that changes a file, such as `Write a file called notes.txt in this chat's folder containing the line: Buy milk.` Before the write, Tavi stops and shows **Needs your approval**: what the call does, its risk, and where its values came from.

<!-- cover -->
![The approval card: Write notes.txt, fs.write, medium risk, notes.txt from your message, and the buttons Allow once, Allow for this chat, Always allow and Deny](../../assets/use-cases/chat/approve-tool-calls/01-ask-for-a-change.webp)

## 2. Check what it will do

Open **Details** to see the change itself: for a file, the lines it adds or removes, then the call's full input. Nothing has been written yet.

![The card with Details open: the diff adding the line Buy milk, and the call's path and content](../../assets/use-cases/chat/approve-tool-calls/02-check-what-it-will-do.webp)

## 3. Allow it once

Choose **Allow once**. The write goes ahead and Tavi finishes its answer. The next call like it asks you again.

![The chat after Allow once: the fs.write call done, then Tavi saying it created notes.txt with the line Buy milk](../../assets/use-cases/chat/approve-tool-calls/03-allow-it-once.webp)

## 4. Allow it for the rest of the chat

Ask for another change to the same file, for example `Add a second line to notes.txt: Call the plumber.`, and choose **Allow for this chat**. In this chat, Tavi won't ask again for that tool on that file; another file still asks. In Home, the same button reads **Allow until tomorrow**.

![A second card, Edit notes.txt with fs.edit, with Allow for this chat beside Allow once, and the note on what Always allow would save](../../assets/use-cases/chat/approve-tool-calls/04-allow-it-for-the-rest-of-the-chat.webp)

## 5. Deny it with a reason

Ask for something you don't want, such as `Also write shopping.txt with: Eggs, bread.` Choose **Deny…**, type why, and choose **Deny**. Nothing is written, and the model reads your reason and carries on without it.

![The card's deny form: Why deny? The agent reads the reason, with the reason typed in, above Deny and Cancel](../../assets/use-cases/chat/approve-tool-calls/05-deny-it-with-a-reason.webp)

## 6. Decide in the terminal

In `tavi chat` the same card appears in the transcript. Press `y` to allow once, `s` for the rest of the chat, `a` to always allow (a rule for the whole workspace), `n` to deny, or `N` to deny with a reason. You can also decide from another terminal with `tavi approvals approve <task-id>` or `tavi approvals reject <task-id>`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/use-cases/chat/approve-tool-calls/06-decide-in-the-terminal-dark.svg">
  <img src="../../assets/use-cases/chat/approve-tool-calls/06-decide-in-the-terminal.svg" alt="tavi chat: Round 1 needs approval for fs.write, the keys y, s, a, n and N, then the round approved and the file written">
</picture>

## 7. Look back in the Command Center

Open **Center → Approvals**. **Waiting** lists every call still waiting on you, from every chat and schedule, and **History** shows what you decided: by whom, from where, and for how long (**Once**, **This chat**, **Always**).

![Center, Approvals: nothing waiting, and History listing the decisions with their scope](../../assets/use-cases/chat/approve-tool-calls/07-look-back-in-the-command-center.webp)

## 8. Remove an Always allow rule

Open **Settings → Permissions**. Each **Always allow** you chose is an **allow** rule under **Rules**, matching exactly the call it was saved from. Choose **Remove**, and Tavi asks about that call again.

![The allow rule for fs.write saved from the terminal, as Settings → Permissions lists it, with its Remove button](../../assets/use-cases/chat/approve-tool-calls/08-remove-an-always-allow-rule.webp)

## What Tavi will and won't do

A call that changes something or sends something out waits for you, and nothing runs until you decide. **Always allow** saves a rule for exactly what the card showed, never for the whole tool, and in a chat that has read a web page or an email, a call that could send data out or change something lasting asks every time, whatever your rules say. The details are in [SECURITY-MODEL.md](../../SECURITY-MODEL.md).

## Related

- [Find and answer everything Tavi is waiting on](answer-waiting-questions.md)
- [Understand a blocked action (untrusted content)](why-was-this-blocked.md)
- [Find your way around the Command Center](command-center.md)
- Reference: [CLI.md](../../CLI.md), [WEB-UI.md](../../WEB-UI.md), [TERMINAL-UI.md](../../TERMINAL-UI.md)
