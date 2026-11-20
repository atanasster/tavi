# The web canvas: `tavi ui`

This covers `tavi ui`, the browser front end to a running owner: starting it
and how it is secured, the page's layout (chats list, conversation, chat
panel), the chat itself, the Command Center, Settings, addresses, keys and
accessibility. The terminal front end is in [TERMINAL-UI.md](TERMINAL-UI.md);
the agent's browser and its live view are in [BROWSER.md](BROWSER.md). Every
flag is in [CLI.md](CLI.md#tavi-ui).

```bash
tavi ui [--print-url] [--port <n>] [--data-dir <path>]
```

## Starting it

`tavi ui` serves the canvas on `http://127.0.0.1:<port>` (any free one, unless
`--port` names one) and bridges it to the running owner (exit `4` without
one). It opens a one-time link in your browser (`--print-url` prints it
instead); press **Enter** where `tavi ui` runs for another link (a new tab needs
its own), and Ctrl-C to stop it. The owner and its runs are untouched. A tab
whose sign-in has ended (`tavi ui` restarted, or 12 hours passed) says so; open
a new link in that same tab and it loads again and signs in with it.

To open the link, `tavi ui` hands it to your system's opener. On macOS that is
`osascript`, which reads the link on stdin, so it is never on a command line.
On Linux it is `xdg-open`, whose command line other accounts on the same
computer can see in the process list while it runs — and a browser started
that way keeps it there. After opening one there it says so on stderr. On a
Linux computer other people have accounts on, use `tavi ui --print-url` and
paste the link yourself: it is then never on a command line. On a computer
only you use, there is nothing to do. The OAuth sign-ins (`tavi mcp login`,
`tavi apps connect`, and the OpenRouter and ChatGPT sign-ins in
`tavi onboard`) open their sign-in page the same way, and say the same on
Linux. On a shared computer, `--no-open` on `tavi mcp login` and
`tavi apps connect` prints the sign-in address instead.

After updating Tavi, rebuild with `pnpm run build` and restart both `tavi serve`
and `tavi ui`, then reload open tabs, so the owner and the bundled web assets
match.

### Security

- The canvas binds `127.0.0.1` only. To use an owner on another computer,
  run `tavi remote connect` and `tavi ui --data-dir ~/.tavi-remote/<host>` on
  this one ([OPERATIONS.md](OPERATIONS.md#using-the-owner-from-another-computer)).
- The link's token, in the URL's fragment, works once, within a minute, and is
  exchanged for a session cookie and a secret the tab keeps. Both are needed to
  reach the owner, and no other local server can obtain the secret.
- A session lasts 12 hours; a new tab, or a session past that, needs a new
  link.
- The page cannot stop the owner, recover tasks or run diagnostics (`shutdown`,
  `recover` and `doctor` are not bridged). Through the page, a stored model key
  cannot be moved to a new address.
- What a run shows, tool input and output included, reaches the page as it is:
  a browser extension with access to `127.0.0.1` can read it.
- The canvas acts as workspace `default`, principal `operator`.

## The page

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screens/chat-answer-dark.png">
  <img src="assets/screens/chat-answer.png" alt="The web canvas: the chats list on the left, the conversation in the middle under its tabs, and the chat panel's icons on the right">
</picture>

The page is three zones: the chats down the left, the conversation in the
middle, and **this chat's panel** on the right. The header carries **Chat**,
**Ideas** (when the owner offers it), **Center** (the Command Center, when the
owner offers it) and **Settings**. Tavi's mark at its left says whether the
page is connected to the owner: in its own colours when it is, grey when it is
not, and breathing while it connects (its tooltip says which in words).

At phone width the composer keeps the model picker on the row between the
attach and send buttons, cutting a long name with an ellipsis. The picker's
list is compact, its rows at its search field's size.

### The chats list

Chats are grouped by **Needs you**, **Working**, then **Stopped** and
**Completed** by day, newest day first, in the workspace's time zone: what a
fleet is read for is which one needs you, not which is newest. A chat you
stopped is not done, so it has a heading of its own, and a reply goes on in it. A pen marks a chat with instructions of its own, and a
bookmark with a count the notes it keeps.

- Each chat can be pinned to the top or archived out of the list (the
  **Archived** toggle below the list brings the archive up), even one that needs you, which the
  Center's Needs queue still lists. A chat's unread dot clears once you have
  looked at it. These marks are the owner's, kept per workspace under the data
  directory (`ui/`), not the browser's, so they survive `tavi ui` restarting on
  a new port.
- The **+** beside the list (**New side chat**, or **New chat** with Home off)
  starts a new chat: the canvas empties and the next prompt starts a chat of
  its own. With a chat open it is a side chat of that one, and the box says
  **Start a side chat…**; with none, on a fresh store say, it is an ordinary
  chat, and the box says **Start a new chat…** (picking a chat again, or that
  prompt's own entry, ends the empty canvas). The rail's **+**
  and the keyboard sheet's entry do the same. With Home on, **New chat** (the
  pen beside the **+**) starts a chat of its own whatever is on screen: it
  begins with nothing of the chat you were in (nor its untrusted-content
  flag: a side chat carries that on), and the box says **Start a new
  chat…**. The folded sidebar's rail, as on a phone, offers it too. An empty canvas, this one or
  Home before its first message, greets you for the time of day in the
  workspace's time zone (**Good morning**, **Good afternoon** or **Good
  evening**) above where the first prompt goes.
- The list folds from its own header: the control at its top-right collapses
  it to a rail, and the rail's control brings it back. Picking a chat there
  opens it, whichever route you were on.
- A worker is never listed as a chat, nor as a row of its own under Needs you:
  the chat that delegated to it carries its need: it reads **needs you**, Home
  too, and its badge counts it.
- Schedule, reminder, routine and `tavi run` fires are grouped under
  **Activity** (one that needs you under **Needs you**).

The header, the panel and the chats list all use the owner's name for a chat:
your rename, its generated title, or **Home** for your Home.

### Home and side chats

With `chat.home` on (the default), `/` opens your Home chat; with none yet, the
first message you send makes it, or the first thing a schedule posts there. A message typed with nothing else open goes to
Home, and the **+** (and the rail's, and the keyboard sheet's) becomes **New
side chat**: the next message starts a side chat of the chat on screen (Home or
another), which begins with background from it and reads its chat notes (see
[TERMINAL-UI.md](TERMINAL-UI.md#side-chats)), or a chat of its own when none is
open.

- The chats list pins Home on top, whatever you search and however many chats
  are newer, shown **ready** between turns (status `idle`, never `completed`), and lists
  side chats under the chat they came from. Before Home's first message it is
  listed there all the same, as **Home** with "No messages yet": choosing it
  opens an empty Home, and the message you send there starts it, whatever chat
  you had open before.
- A chat's notices are cards after its latest turn: the newest three, with
  **Show earlier notices** for the rest, each with **Open run** and **Reply in a
  side chat**, which opens a side chat of this chat that begins with the run's
  output quoted as background. A side chat's card offers **Open side chat**
  only, since a side chat is answered in itself. The **Earlier chats** notice
  sits above Home's first turn, folded to one line, its list opened on a click.
- The prompt box says where a message goes: "Message Home…", "Message
  ‹chat›…", or "Queue a message for after this turn…" while a turn runs
  ("Queue a message for after the approval…" while it waits on your approval
  or review). A screen reader hears "Sent to Home" or "Queued after the
  current turn".
- A message the owner never got (it was busy past the page's wait, or refused
  it) leaves the chat and goes back in the box, under "Not sent: … Your
  message is back in the box: send it again."; the chat keeps its state.
- A busy Home keeps its rollover dividers however many notices arrive after
  them.

With `chat.home` off, **New chat** does the same as **New side chat**, the box
says "Start a new chat…" on an empty canvas, and Home is an ordinary chat pinned
on top.

### This chat's panel

Shut, the panel is a rail of icons: **Activity**, **Schedule**, **Memory**,
**Instructions** and **Details**; any of them opens it on that tab.
Activity's icon counts what the chat is waiting on you for; the Instructions
icon is marked when the chat's instructions changed since you last looked
(saved in another tab, from the terminal or by someone else); the Memory icon
counts the notes proposed for the chat and what it proposed for every chat.
Open, the panel is a column you can drag wider or narrower (double-click its
edge to reset it, drag it below 200px to close it). The page remembers, in this
browser, whether the panel was open, on which tab, and how wide.

When the panel would leave the conversation narrower than 480px, the chats list
folds to its rail first. Between 721px and 1279px the panel lies over the
conversation rather than beside it. On a phone it is a sheet over the bottom of
the page: drag its grip to make it as tall as you like (from a quarter of the
page to nearly all of it; dragged lower, it closes), tap the grip to move
between half and nearly full height, or step it with the arrow keys. The page
remembers the height in this browser. Shut, it is a
single button in the corner, marked when any of its tabs has news. A browser
handoff opens the panel by itself only beside the conversation: on a phone it
stays as you left it, so the sheet never covers the card's **Take control**. On a phone
the chats list starts folded to its rail, since open it leaves the conversation
no room, and folds again once you pick a chat from it. A window narrowed to 720px
or less folds it the same way, and widening brings back a list that was open.

The pencil beside the chat's name in the panel's header renames it (Enter
saves, Escape leaves it), and the new name shows in the chats list too; **Use
the generated name** goes back to the title the chat was given.

The open tab keeps up as the chat goes on: a turn finishing, or memory changing
anywhere in the workspace, reads its memory and instructions again (an edit you
have started is kept).

**Activity** starts with what the chat is waiting on you for (a round to
approve, outputs to review, a question) with **Go to it**, and answers its
question right there. Then the chat's timeline by day: each prompt it was given
and how that turn stands (a turn that stopped to ask you something says it was
answered once you sent the next message), each task it delegated, and where the chat's
instructions changed. A prompt scrolls the conversation to it (opening the
recorded prompts a reload folds away); a delegated task opens in the chat. The
task's plan (`plan.update`) shows as a checklist at the top.

**Schedule** names the schedule or reminder that started the chat, if one did
(**Open** goes to its page: a plain schedule's, or its routine's), and lists the
reminders asked for in it, each opening its page in the Command Center. **Remind me about this chat…** sets one from there (delivered in the
app, listed with the chat).

**Set up a schedule…**, in the Schedule tab's **Repeat on a schedule** (which
quotes the chat's opening message it would run again), and **Repeat this…**
among a message's actions open the **Create schedule** form filled from the
chat: its prompt (the chat's opening message, or the message the action is on), a name from the prompt's first line,
and as allowed tools the read-only ones the chat used that a schedule may list —
the owner's `schedules tools` answer, so scheduling writes (`schedules.*`,
`routines.*`), MCP tools not approved read-only, form fills and `*` are never
filled in; the form names the ones it left out. The chat's other listable tools
are offered under **Used in this chat — add**, one click each, and one that can
change or send things is named once added. **Deliver result to** starts at
**Home**, as a schedule made in a chat does. When the owner cannot list tools, the
form says so instead. A chat that searched or fetched the web and
used nothing but memory reads (`memory.search`, `memory.list`, `memory.get`) or a read-only tool
family opens **Create routine** instead, its objective the prompt, with **Repeat
it as a schedule instead** (and the schedule form offers **Make it a research
routine instead**). Neither a routine nor a schedule has memory, so a chat that
read yours is told to put what it needs in the objective or prompt. What you typed
— the name, the prompt or objective, the cadence — comes along when you switch. The chat's words
only fill an editable form: nothing is created until you save, through the same
checks as any new schedule or routine. When the chat read content Tavi does not
trust (or that could not be read), the form says so, fills in no tool (each is
offered to add) and asks you to check the prompt and tools first, since the
schedule runs unattended with them; a routine saved from such a chat carries
what it read as its provenance, even when you edited the objective before
saving (a later edit of its objective or instructions clears it). A prompt longer than the field takes is
shortened, and the form says so. It is
offered where the owner offers Schedule.

**Memory** lists the chat's **notes** (remembered for this chat only, for as
long as it lasts: add one, or let the model propose one), what the chat
**learned** for every chat, the memory **used in this chat** (each record its
answers were given, its scope, and when it was last used, most recent first;
a listing isn't a use, so what the model only looked through stays out),
its **History** — **Fresh context** (the chat's next message starts a new
epoch) and **Forget history…** — and the workspace's memory every chat
inherits, folded under its count. When proposals wait, the way to the Command
Center at the foot says **Review N proposals**. A note can be
made memory for every chat (**Remember everywhere**) and a lesson kept to this
chat (**Keep to this chat**); proposals are kept or discarded here. **Forget
history…** forgets the chat's saved history (see [Saved
history](#saved-history-rewind-and-forget)). An agent's task shows the notes of
the chat it works for, and says it runs under its agent's instructions rather
than the chat's, with a way to that chat. See [MEMORY.md](MEMORY.md).

**Instructions** is where you tell one chat how to work: tone, language, what to
focus on. They are the top layer of that chat's system prompt, after the base
and any agent persona. A save applies from the chat's next message (never to a
turn already running), every save is kept as a revision you can take back from
**History**, and a save against instructions changed elsewhere is refused with
your draft kept. **Discard** shows once you have edited them, **Clear** only
while instructions are saved. In a new chat you can write them before the first message,
which carries them. Below, the tab shows the prompt the chat's next turn gets
(the workspace's base as it is now, then its instructions) with about how many
tokens of the context budget it takes before memory and skills (warned when
close to it or over, when calls are refused), and sends you to Settings →
System prompt or Soul & memory for the inherited layers. A chat's instructions
apply wherever the owner runs it: the web canvas, the terminal, Telegram or
email alike. `tavi tasks instructions <task-id> [show|history|set
"<text>"|reset]` reads and saves the same instructions from a terminal.

**Details** says how many turns the chat took, the model it is set to and the
models that made its calls (by name; the full id on hover), its token totals,
any round waiting on a decision (only while one is), and folds the task, its
workspace and thread, its operation key and the full model target under
**Technical details**. It also shows how many artifacts the chat archived (with a way into
**Held files**), and its open browser sessions (earlier ones are in the Command
Center's **Browser**). It shows the actual model identities and
provider-reported token totals once an execution reports them, covering the
latest execution's tool steps and fallback attempts; a running turn keeps the
previous turn's figures until its own arrive, and a first turn shows none. When
the event stream is no longer available, it shows this chat's totals recovered
from persisted provider calls. Missing usage is marked partial. A session whose
task has ended is marked **Ended**: it stays open, its pages and sign-ins kept,
for the chat's next turn to pick up, until you press **Close browser**.

### Plugin contributions

UI plugins add to the chat panel: a contributed tab after the built-in five
(its address is `/tasks/<taskId>/plugin:<plugin-id>/<contribution-id>`), and a
strip between the panel's header and its tabs. A contribution placed in the
strip "while active" shows only while one of the chat's browser sessions (a
sub-agent's included) is open and the chat is running, then for 30 seconds
more; one placed "always" shows whatever the chat is doing. One placed both in
the strip and as a tab leaves the strip while its own tab is open. Each can be
collapsed, and its height dragged or set with the arrow keys on its handle,
remembered for this browser tab. On a phone it shows only with the panel's sheet
at full height. Hidden, collapsed or scrolled away in another browser tab, it is
told so and stops receiving frames. A plugin's page runs in a sandboxed frame:
it sees only what its manifest declares, and never the page around it.

The slots are `chat.panel.top`, `chat.panel.tab`, `overlay.takeover`,
`center.browser`, `center.heartbeat` and `onboarding.step`. `tavi plugins ui
list | set-role | place` chooses which plugin fills each role and where
contributions show ([CLI.md](CLI.md#tavi-plugins-ui), [MODS.md](MODS.md));
**Settings → Plugins → Canvas** offers every place a person may put a
contribution (the chat panel's top and tabs, the Center's Browser and
heartbeat, a Welcome step), never the takeover overlay. A `while-active`
contribution in the top slot shows while what it shows is active: a
`browser-view` while the chat's browser session is open, any other while the
chat's task runs. Welcome's and the heartbeat panel's frames show without the
live view; only the Center's Browser needs it. The
built-in contribution is the **live browser view** (`tavi.browserview`), with
its **Browser** tab and strip; it and taking over the browser are described in
[BROWSER.md](BROWSER.md#the-live-view). Once the chat's turn has finished, the
**Browser** tab shows the page its session kept ("Tavi has finished; the page is
kept.") and still offers **Take control**. On a phone, the page you take is laid
out at the phone's width, so it shows at its real size.

![A chat using the browser: the panel's strip shows bbcgoodfood.com live, with Take control, Open in transcript and Expand, while the chat asks to open the next page](assets/screens/chat-browser.png)

## The chat

The chat is the same conversation as `tavi chat`: prompts, streamed answers,
tool cards, **Allow once**/**Deny…** for a round (a file change's **Details**
show its diff, added and removed lines marked; a new file's starts at
`@@ -0,0`; a card's read-back in words, such as a schedule's when, where its
results go and what it runs, is on the card itself, and **Details** keeps the
exact command and the full input; a call that waited on you, such as a question or a **Connect** card, runs again once you answer and stays one card), **Stop** to abort a running turn. After a task finishes, the next prompt continues it, and the prompt box
names the chat it goes to. A finished chat started elsewhere (from Telegram, a
schedule, `tavi run`) is continued too. **Retry** after a failed turn sends the
prompt again in the same chat; a new chat started after it offers **Send**,
not the old chat's **Retry**. A turn you stop isn't a failure: it says "You
stopped this.", the chat and the chats list read **stopped** (Home reads
**ready**), there is no **Retry**, and the next prompt continues the chat, with
its history, whether you come back later or the owner has restarted since. Tavi
goes back to what you stopped only if you ask: not because you replied about
something else, and not because a worker reported after. A
cancel (`tavi cancel`) is final: the chat and the chats list read **cancelled**,
its last turn says "This was cancelled: <reason>.", and the prompt box closes,
with a stopped chat you cancel too; there is nothing to retry or reply to, and
**+** starts another chat.

### Queueing and sending into a running turn

While a task is still working, or waiting on your approval, the next prompt is
**queued**: it shows as "Queued: sends after this turn" ("Queued: sends after
you decide the approval above." while it waits on you) with **Cancel**, and goes
as the chat's next turn once this one ends (not if the task is cancelled).
**Send now** sends a queued prompt into the turn that is running instead (not
one waiting on your approval or a question): the model reads it before its next
step, and it shows in that turn as "You, during this turn". A turn takes at most
five such messages; one it ends before reading becomes the chat's next turn, so
nothing you send is lost.

### The composer and the model picker

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screens/chat-empty-dark.png">
  <img src="assets/screens/chat-empty.png" alt="A new chat: the greeting, three suggested prompts, and the floating composer with its model picker">
</picture>

The composer floats at the foot of the chat: a rounded card on a soft shadow,
whose edge takes the focus colour while you type. **Send**, **Stop** and
**Retry** are one round pill at its corner.

The composer's model picker lists every model the connections have discovered
(the Models view's catalog) and shows the open chat's own model. A pick sets
that chat's model from its next turn (or, in a new chat, from its first
message) and makes it the workspace default for new chats (the same write as
the Models view's **Default** row). A note shows only when the pick did not do
all that: the default could not be saved, or role `main` or the owner's flags
still choose another model for new chats. Nothing needs a restart: the owner
reads its models at each turn. Each answer names the model that gave it. An
owner with no model configured refuses every run, so the composer holds Send,
keeping the prompt, until one is picked. The control beside it opens model
settings; with nothing discovered yet, the picker is that link. With more than
one connection, each model in the list says which it comes from (**Ollama**,
**OpenRouter**), and the search finds models by it; the list opens above the
composer and stays there as a search narrows it, and the picker keeps naming
the chat's model while the search hides it.

A new chat suggests up to three prompts (a chat to continue, your best ideas, or
what Tavi can do here), each filling the box, never sending; see
[IDEAS.md](IDEAS.md#suggestions-in-an-empty-chat).

### Attachments

Attach up to five files:

| Kind | Limit | How it is sent |
| :--- | :--- | :--- |
| UTF-8 text and code files | 48 KB each | Their content is included in the prompt, within the combined 64K-character prompt limit |
| PDFs | 20 MiB each | Uploaded when you send; see [PDF.md](PDF.md) |
| Photos (PNG, JPEG) | 5 MB each, up to 8000 pixels a side | Uploaded when you send; the chat looks at it with `artifacts.view_image` |
| Videos (MP4, MOV, M4V, WebM) and GIFs | 50 MiB each | Uploaded when you send; see [VIDEO.md](VIDEO.md) |

An uploaded file is checked by its bytes (a file merely renamed `.pdf` is
refused), kept as an untrusted attachment, and named in the message as a
channel attachment is, so the chat reads it with its tools. It goes when the
chat is erased. A message with an upload is its own turn, never merged into a
running one. A photo needs no PDF or video tools; one a model could not be
shown (too many pixels, a damaged header) is refused when it is sent. Other
binary files are refused with a note saying so. Your message shows its files as
badges under your words: an uploaded file by its name, and a text file by its
name too, which opens its whole content in a dialog when you press it.
Remove a file chip before sending to exclude it. A completed PDF fill shows a
review panel: the filled pages on the left; on the right every value with its
source and check, what was left blank for you, and a Download button for the
filled copy.

### Messages

Your messages sit right-aligned in a bubble that holds only the words; their
actions show under it on hover. Prompts and responses have copy actions (the
icon shows a check for a moment once the text is on the clipboard); completed
responses can be read aloud using browser speech synthesis, with a Stop reading
control. On the same line, at its far end, a finished answer says quietly how
long it worked, the model that answered and its tool calls when it made any
(`2m 05s · gemma4-32k:latest · 3 tool calls`); hovering the model shows the
full `connection/model`. The time is the turn's working time on the owner's own
timestamps: a round waiting on your approval or answer is not in it, and a
model reading a long prompt on a local server shows none until it answers. A
turn read back whose record kept no time or model leaves that one out. An
answer that used memory has a memory icon with the count beside its actions
(named **Used 2 memories**); it opens the memories on a line below.

Tokens, cost, context % and tokens per second are deliberately not there.
Provider-reported tokens, once a turn ends, are in the chat panel's
**Details** tab; there is no price table to turn tokens into cost, and no model
connection reports a context window to be a percentage of.

The message box's placeholder says where a message goes (**Message Home…**,
**Start a new chat…**, **Continue this chat…**: the chat's title is in the header
above it) and, with a keyboard, a second line, **Enter to send · Shift+Enter for
a new line**.

The chat's header is one line: its title, its status (a coloured dot on a
phone, the word read to a screen reader), and at the far end its tools as
icons — an amber shield once it has read content Tavi does not trust (it opens
what it read and **Start a fresh chat**), a folder for its working folder and
files, and its memory, raised while on and crossed out while off. Each icon's
tooltip and name say what it is.

**Rewind to here** takes the chat back to before that message: after you
confirm, the message, Tavi's answer and every later turn are removed from the
chat's history and from what the model is given from your next message on, and
the message returns to the composer to edit and send again. It is offered once
the chat's turn has ended, not while one runs, waits on an approval or a
question, or has a message queued behind it. A turn already folded into an
epoch summary is removed from the history, but the summary still remembers it.
Rewind never changes files: its confirmation says the chat's folder was not
changed.

**Repeat this…** on a sent message opens the schedule form filled from that
message and the chat's tools, as the chat panel's Schedule tab does; once saved,
the message's actions say what was created. The form says a schedule or routine
has no memory only when a chat's saved turn names a memory record it read or
listed, or called a memory tool on a turn with no such record; a search that
found nothing is not a read.

Answers are drawn as Markdown: headings, lists, GitHub tables and task lists,
links (opening in a new tab; `#heading` links scroll within the answer), code
highlighted by language with a copy button, and `$$…$$` math through KaTeX,
displayed when it stands on its own line and inline within a sentence, while a
lone `$` stays a price and a pair is math only around a backslash command KaTeX
reads (`$\times 10$`), with neither `$` against a word and none escaped. Raw HTML in an answer stays text, so a quoted `<script>`
never runs, but for a bare `<br>` in a table cell, which breaks the line; and because the canvas's Content Security Policy admits only its
own images and stylesheets, an image from another host is a link to it and a
Mermaid block shows its source. (The only inline styles it allows carry a
nonce that changes each time the page is served: the styles a list picker
adds to keep the page from scrolling behind it and to hide its own scroll bar.) The renderer loads beside the page rather than
in it, and until it arrives an answer shows as written. While an answer
streams, only the block a new piece of text lands in is parsed again, so a
long answer stays smooth to scroll and type beside; the result is the same page
one pass over the whole answer would draw.

In a turn that read untrusted content (a web page, an email, a search result:
the turn the taint gate marks tainted), a link in the answer that the
conversation does not already hold exactly shows its real host in brackets
beside the label, and clicking it (middle click included) first asks
"Open `<host>` from a turn that read untrusted content?". A `mailto:`, `xmpp:`
or `irc:` link shows its scheme and target instead (an email address whose
text already is the address, such as `ana@example.com`, gets no bracket), and
always asks. A page
the turn read can plant such a link to carry what the chat holds to a site (or
an address) of its choosing; the confirm makes that a decision rather than a
click. A yes covers that exact address for the page's life, not its host: a
later link to the same host with another path or query asks again, since that
is where the data would ride. Links the conversation already held as written (a URL you sent, a
page a tool returned) open as before; another page on a known host still asks,
since the page the turn read is on a known host and could plant one there. A
clean chat draws every link as it always did. It applies to an answer as it
streams and to one read back from the chat's history.

### Tool calls and long answers

Tool calls are collapsed, with what each one touched on its summary line (the
command it ran, the URL it fetched, the question it asked), and a run of them
folds into a single block saying how many there were and how many failed. A
block stays open or folded as you left it while its calls run. Each turn's own
prompt stays at the top of the transcript while its answer streams past, and the
view follows that answer while you are near the bottom, stopping the moment you
scroll up. A message you send comes into view wherever you were, and the view
follows until it reaches the top, so a long answer is read from its start; with
more below the fold, **Jump to latest** takes you to the end and follows from
there. A round waiting on you is always scrolled into view, and so is a new
question, review, worker's ask or memory card. One entry the
page cannot draw says so in its own row and leaves the rest of the session
alone.

A very long answer keeps its first 20 and its last 200 entries on screen, with
**Expand N older** for the rest (one bound per prompt; **Collapse** puts it
back).

### Transcript, Trajectory, Held files and Agents

Beside **Transcript**, the chat has three other views:

- **Trajectory** restores retained tool inputs, results and model identities
  from saved checkpoints and accounting records. Older calls may lack
  durations. Compacted or bounded history is marked partial, and data that was
  never saved shows as "not recorded".

  ![Trajectory: each turn opened to its model attempt and timed tool call (browser.create_session, 3.9 s, its retained bytes), and the chat's record below](assets/screens/chat-trajectory.png)

- **Held files** shows the files the chat's tools saved (screenshots,
  downloads, outputs) as cards: an approved image (JPEG, PNG or WebP, up to
  4 MiB) as its picture, any other file as a tile with its type, each with its
  name or type, its size and whether it is approved, waiting for review or
  rejected. A card opens the file in **Details**, which shows an approved
  image at full width, with **Load more**. A file the chat wrote with `fs.write` or
  `fs.edit` is not listed here: its diff is on the call's approval card.
- **Agents** shows the session's agent tree: the child tasks it spawned, their
  status, when each last changed, what a running one did last (its newest tool
  or a line of its newest text), an ended one's final answer (clipped, with
  **Show all**), and **Cancel** for one still running. It follows the Command
  Center's change feed, so it updates as workers move (an owner without the
  feed is read every 30 s).

  ![Agents: a side chat's tree with one browser worker it delegated to, admitted, with its age and a Cancel button](assets/screens/chat-agents.png)

Opening a worker shows its transcript beside the chat (**Worker ‹name› — view
only**), its saved turns and, while it runs, the turn in progress, with no
composer: a worker is not a chat, so it takes no messages. **Close** (or Esc)
returns to the chat alone.

### Questions and workers' needs

A question the task asks is answered in the chat; in the web app any task's
question can be answered, whichever chat or schedule started it, and the chat
it was asked in then says where it was answered. A clicked option is sent after
four seconds, with **Undo** until then; from the keyboard, the option's number
moves to it, Enter sends it at once, `o` opens an answer in your own words and
⌘/Ctrl+Enter sends that. If someone answers elsewhere while your click is still
in its four seconds, your pick is not sent, and the chat says so when it
differs from theirs.

A worker's question, approval or browser handoff is a card in its chat's
transcript, after the latest turn, answered there; the answer goes to the
worker, and **Open the task** on its corner card opens that chat. An approval
card has the **Details** Center's does, its **In** link opens the worker's own
page, and the chat's header reads **needs you** while any of these waits.
Allowing a worker for the chat is allowing the chat: it and its other workers
aren't asked again. A
question and
a handoff are also in the chat panel's **Activity** (and the Agents view). Once answered from the page it
becomes a one-line receipt. The composer says **Answer the question above…**
when exactly one question is open in the chat (its own or a worker's): what you
type then answers it. With two or more open, what you type is a message, and
each question is answered in its card.

A need that arrives while the page is open shows as a small card in the corner
when it is not the chat you are in (a question answerable right in it), and the
tab's icon gets a dot while anything waits. Browser notifications are off until
you turn them on: the first time something needs you while the tab is in the
background, the page asks once, and **Notify me** in Approvals turns them on or
off at any time. A burst of needs is one notification, naming the newest.

### Saved history, rewind and forget

Every turn is saved as it ends (its prompt, text and tool lines), so a chat
reopened after the owner restarted, or long after its stream was let go, shows
its history, with **Load earlier turns** for the rest. A turn whose save failed
(the owner stopped, a busy disk) comes back from its recorded prompt and
outcome, without its tool cards, before the chat's next turn is saved and when
`tavi serve` starts. A chat keeps only its newest 20 checkpoints once it rolls
over, so one that never ends does not grow without bound.

From a terminal:

```bash
tavi tasks history <task-id>                                   # export as Markdown
tavi tasks history <task-id> forget --before <time> [--with-memory]
tavi tasks history <task-id> forget --epoch <n> [--with-memory]
tavi tasks history <task-id> rewind --turn <n>
```

- **Export** prints the chat's latest epoch summary, then its turns, with the
  notices posted among them and the messages you sent into a running turn,
  oldest first.
- **Forget** (`--before <time>`, or `--epoch <n>` for everything before that
  epoch began) erases what the chat saved before then: its turns, notices and
  steers; the archives its summaries folded earlier turns into; the memory
  proposals it made then that still wait; the prompt and answer text of those
  turns' records (a retry of one is still recognised, never run again), so
  neither the task's record nor search shows them; the text of its messages in
  the messaging inbox and outbox; and, when nothing is left, the chat's last
  answer, generated title and summary (a name you gave it stays). What its
  workers sent it before then is marked read, and the owner's live stream no
  longer replays it. Approved memories the chat taught stay, and forget says how
  many, unless you add `--with-memory` (or tick **Also forget the N memories
  this chat taught** under **Forget history…** in the chat panel's Memory tab,
  which forgets the whole history). Memory is only forgotten on a running owner,
  and only for your own chats.
- **What forget does not reach:** the chat's newest 20 checkpoints still hold
  the current epoch's conversation word for word (until the chat rolls over, or
  a fresh context starts one), and the summary of its earlier epochs a condensed
  account of it; side chats and workers begun from the chat keep their own copy
  of what they were given. Forget lists them, to forget each in turn.
- **Rewind** `--turn <n>` does what **Rewind to here** does: turn `n` (as export
  numbers it, `## Turn n`) and every later turn leave the saved history and what
  the model is given from the chat's next message on, and the turn's message is
  printed to send again.

### Working folders

The chat header's folder icon names where the open chat works, in its tooltip
and name: **Chat files** for its own folder, the host folder's path otherwise.
When the chat's folder is gone or no longer under a root, the icon turns amber
and **Reset** shows beside it, so a chat
never needs a terminal to recover.

The chip opens a panel listing the chat's folders (its own folder, a host folder
it works in, each attached folder with its mode) and their files, each with a
download. Files are read in chunks, checked against the hash the first chunk
named (a file that changed while it downloaded fails rather than arriving
spliced), capped at 32 MiB, and always saved as `application/octet-stream`, so
a folder's HTML file never opens on the canvas. **Attach a folder…** browses
the `--fs-root` folders (directories only; never the data directory, a
credential folder, a dev plugin's folder or a hidden folder) to attach one
read-only or read-write, or to work in it. There is no path to type: the canvas
sends only a token the owner issued for the folder it showed. On a phone the
panel only lists and downloads. See [WORKING-FOLDERS.md](WORKING-FOLDERS.md).

A chat that hasn't started (a new chat, or Home before its first message) shows
the chip too, as **Chat files** (**Chat files +2** once two are picked). Its
panel has the same **Attach a folder…** picker, read-only or read-write (not
**Work in this folder**), and a **Detach** beside each folder picked. Nothing
is attached yet: the page holds the picks, and the first message carries them,
so the chat starts with them attached and its first turn already sees them. A
folder that can no longer be attached then is named under that message.
Reloading the page, or the canvas reconnecting, drops the picks: pick again. A
message to a Home that has begun meanwhile attaches nothing, and says so.

The header's **Center** tab carries the number of things waiting on you across
the workspace: approvals, reviews, questions and memory proposals, from every
chat and channel, and unseen reminders. Against an owner without the Command
Center, the tab is absent and the header instead counts the sessions this page
is following that are waiting on you. The browser tab's title carries the same
count, and a screen reader hears it too, along with each reminder as it fires
("Reminder: Take your pills").

## The Command Center

![The Command Center's Schedule: reminders and a schedule in the order they run, with the rail of what is waiting and coming up](assets/screens/center-schedule.png)

**Center** is offered when the owner supports it. The chats column becomes its
section nav: **Activity**, **Approvals**, **Schedule**, **Heartbeat**, **Soul &
memory** and **Browser**, each with a live count. A section appears only when
the owner offers what it reads, and the address of one it does not offer opens
Activity.

A rail beside the section lists:

- fired reminders you have not seen yet, each a card with **Done**, **Snooze 10
  min** and **Snooze 1 h** (while one shows, the rail never says nothing is
  waiting);
- what is **Waiting on you**, each count opening its section: approvals,
  reviews and questions open Approvals at Waiting, and browser handoffs (tasks
  waiting for you to act in their browser) open Browser;
- what is **Coming up** next: the next three reminder, routine and schedule
  fires, in the workspace's time zone, opening Schedule (a plain schedule's
  opens its page) — not on Schedule itself, which lists the same in full;
- a few figures.

A channel whose OAuth sign-in has lapsed shows as **Reconnect …** in the
Command Center.

The page follows the owner's change feed, so counts and lists update on their
own without moving focus. Below 1280 px wide (the docked width) the rail moves under the section;
on a phone the nav becomes a scrolling bar under the header.

### Activity

![The Command Center's Activity section after two turns](assets/screens/center-activity.png)

Activity lists every top-level task in the workspace (started here, in the
terminal, over messaging or by a routine), newest first, under the day it was
asked in the workspace's time zone, so "Today" here is the same day Telegram
means. A strip of turns per day (a task started, or a chat taken up again) for
the last 14 days sits on top; a bar jumps to its day, and for a day the list
does not hold yet it lists back from the end of that day (**Back to the
newest** returns).

Each row shows the time, the task's title and a one-line summary of what it did
(generated when it finishes; until then, its first prompt line and last answer,
read as plain text), where it came from (**Web**, **Terminal**, **Telegram**,
**Email**, **Routine:** *name*, **Reminder** (hover for its text),
**Schedule:** *name* or **Agent**), the person when more than one uses the
workspace, its tool calls, and whether it is done, working, failed, cancelled or
waiting on you. A task from a channel is named, with its icon, as the channel
describes itself, a plugin's channel included.

- A task you sent more prompts to shows **N follow-ups**; expanding it lists
  them with their times, oldest first.
- A task that handed work to other agents shows **+N delegated** (nested under
  it, not listed separately); expanding it lists each worker with its status,
  and a worker's name opens its view-only transcript beside the task's chat.
- Filter by source or person (the owner is asked for just those tasks, so older
  pages hold them too), search prompts, answers, titles and summaries, and
  **Load older** for earlier days. A row opens the task in the chat; its panel
  icon, shown on hover or focus, opens it with the chat panel on Activity.

When the owner's own memory, open files or child processes have more than
doubled over the last 6 hours and stayed there, a warning above the day strip
says which and suggests restarting it (`tavi doctor` reports the same trend
under `health`).

### Schedule

Schedule is where reminders, routines and plain schedules live. The old
addresses `/routines` and `/settings/schedules` open it.

- **Coming up** lists every reminder, routine and schedule fire in the next
  seven days, under the day it falls on in the workspace's time zone: the time,
  whether it is a reminder (an amber square), a to-do with a due time (**To-do**,
  opening the to-do list rather than a reminder page), a routine or a schedule, its name
  (opening its page), its cadence ("Daily 21:00 ·
  Europe/Berlin", "Mon–Fri 07:00 · Europe/Berlin", "Once"; for a reminder
  "Mon–Fri 07:00, 19:00 · until 31 Dec", "Monthly on the 1st, 09:00", "Yearly
  on 29 Feb, 08:00", or an event's notice such as "Event Mon 5 Oct 10:00 · the
  evening before at 20:00"), the person it is for when more
  than one has reminders, "Added from ‹chat›" for one the agent created (opening
  that chat), and how soon ("in 14 h", moving each minute even on an idle
  page). A fire that is late but will still run
  says **Overdue — runs shortly**; the section says when more fires fall in the
  week than it lists, and names any schedule it could not read. The first two
  days with something in them show; **Show the rest of the week (N more)**
  lists the others.
- **Recurring** lists repeating reminders, routines, plain schedules and,
  where the owner has one, the heartbeat, as one kind of row sorted by next
  run (soonest first; anything paused or with nothing due last). Each row
  says what it is (Reminder, Routine, Schedule, Heartbeat), its name (opening
  its page; the heartbeat's opens Center → Heartbeat), a badge, its cadence
  and next run, and how the last run went, or "Not run yet."; then, in the
  same order for every kind, **Run now** (not for a reminder), a
  **Pause** / **Resume** switch and **More**. Visible labels stay short and the
  name is in each control's accessible name ("Run now: Brief", "Pause Brief",
  "More actions for Brief"). **More** is a menu opened by click, Enter, Space or
  the down arrow (the arrows, Home and End move through it; Escape closes it
  and returns focus to **More**):
  - a schedule: **Edit**, **Duplicate**, **Open last task** (once it ran) and
    **Delete**;
  - a routine: **Edit**, **Duplicate** and **Archive** (asked first; its runs
    and reports are kept);
  - a reminder: **Edit** (its form, filled in; saved as a change to it),
    **Duplicate** and **Delete**;
  - the heartbeat: **Edit**, which opens its section.

  **Delete** hides the row (and its Coming up and Later entries) at once and
  shows "‹name› deleted." with **Undo** at the foot of the page for 8 seconds,
  with focus on **Undo**. The wait stops while you move focus back to the
  toast or put the pointer on it (not for the focus it was given), at most 30
  seconds in all, and goes on once it has neither; should the toast close while it
  has focus, focus goes to the Recurring heading. Its page, opened meanwhile,
  says "‹name› is being deleted." with **Undo**. Only then is the owner asked,
  so **Undo** keeps the schedule or reminder whole (its id, fire history and
  task links). Leaving Schedule does not cut the wait short: back before it
  is over, the row is still hidden and **Undo** is there again, and a refusal
  that came meanwhile is said on return. A delete still waiting is made at
  once when another starts, when Schedule opens for another workspace, or
  when the page is closed. A refused delete brings the row back and says why.
  **Duplicate** opens the filled form: a schedule's settings under "‹name›
  (copy)", where its result goes and its run limit included; a routine's
  name, objective, triggers, researcher instructions (shown to read and edit,
  under the note when the agent changed them after reading untrusted content),
  report style, skills, models and first destination under "‹name› (copy)",
  the form naming what is not copied (its other destinations and delivery
  window); or a reminder's text, cadence, task prompt and chat, for the same
  person. The copy keeps where its words came from: a reminder made from
  untrusted content stays labelled as its source is, and a routine keeps its
  source's note until you change the objective or instructions it copied.

  A reminder's row says how its last fire went ("Last: Shown in the app Mon 28
  Sep 21:02", "Missed", "Failed"). A routine's switch is drawn in the warning
  colour while its research is blocked by a failing credential. A schedule's
  badge is **ok**, **failed**, **skipped**, **resumed** (resumed after failing:
  its failure count starts again, until its next run), **paused**, or **paused failures**
  once three failed fires in a row paused it, when the line under its name says
  "Paused after 3 failed runs in a row; resume it to run again" and **Resume**
  clears it, or **finished** once its once or until date has passed: its switch
  is disabled, with a hint to edit the date, and it is left out of **Failing**,
  **Paused** and **Pause all**; its last line says how the last fire went in a sentence, such as
  "Missed by 6 h 40 min, too late to catch up (6 hours at most).", with the
  failures in a row. The heartbeat's row says its active hours and days ("Daily
  every 30 min 08:00–22:00 · Europe/Berlin"), its next and last check, and its
  switch turns it on or off; its **Run now** checks at once, while it is on
  and `tavi serve` runs it.

  A watcher's row carries a **Watcher** badge and says what it watches in
  place of its cadence ("Watches the page https://example.com/status every
  hour; runs only when it changes").

  Above the rows, chips show **All**, **Reminders**, **Routines**,
  **Schedules**, **Watchers**, **Failing** or **Paused**, a field filters by name ("2 of 5
  shown"), and **Pause all** pauses every reminder, routine and schedule shown
  that is running (the heartbeat keeps its own pause), after a confirm that
  names them. It then says how each went ("Paused 2 of 3: Stretch, Brief. Not
  paused: LLM news (…)") and offers **Resume the N paused items**, which
  resumes exactly those. **New schedule** adds one;
  its form sets when it runs with the [cadence field](#the-cadence-field). **Allowed tool**
  suggests the tools this owner has that a schedule may name, by id first,
  then the `prefix.*` families whose every tool is read-only (an MCP tool only
  once approved read-only; nothing a schedule's list is refused for), and Enter adds the one typed rather than
  saving the form. **Alert target** picks a chat you added as a routine
  delivery target, or **No alerts**; an alert set from the terminal to a chat
  that list does not have stays a choice, named "(not among your delivery
  targets)", so saving another change keeps it. **Deliver result to** posts
  each run's result into **Home** (the first one starts your Home if you have
  none; with Home off it isn't posted, and its fire says so), or **Nowhere** (only what the run sends
  itself; the default). **Tell me** chooses **After every run**, **Only when there is
  something to tell** or **Only when the result changed** (failures are always
  told). **Run limit (minutes)** stops a run still working after that long
  (empty: 30), and **Token ceiling** stops a run, its workers included, once it
  uses more tokens than that (empty: none, but a run a webhook or email starts
  stops past 250,000, as the schedule's page says); it is checked between model
  calls, so a run can go past it by one call, as the form says; a ceiling below
  30,000 tokens is warned of as below one model call (a run's first call alone
  takes about 25,000 tokens). **Only run when** is **Always: no
  pre-check** (the default), **A page changed**, **A feed has new items** or
  **A file changed**, with its address or file (under one of the owner's
  `--fs-root` folders): before each scheduled run that is read, and when
  nothing is new nothing runs and no model is called. With one set, **Watch
  it** makes the schedule a watcher: **Yes: check every hour** (or every 2, 3,
  4, 6, 8 or 12 hours) replaces its times with that step, and it runs only
  when something changed; a file watcher is also checked about 30 seconds
  after its file changes while `tavi serve` runs (at most once a minute and 12
  times an hour). **No** keeps the pre-check at its own times. Editing sends only what changed.
  Under the heading, one line says what the workspace's schedules and
  routines spent this calendar month in its zone ("Scheduled work in October
  2026: 12,345 tokens (about $0.42)."), with the share of
  `scheduled.monthlyTokenBudget` when one is set and a **Near budget** badge
  from 80% of it.
  Its count, of every row the heartbeat's included (the same total the filter's "N of M shown" gives), shows once every list has been read. Each action says what it changed ("Morning brief paused."); a refusal shows
  as an error, in red, with the owner's reason.
- **Later** lists one-off reminders beyond the week (an event with the notices
  still to come: "Mon 5 Oct 10:00 · reminds Sun 4 Oct 20:00, Mon 5 Oct 09:00").
- **Done / missed**, collapsed at the end, lists the reminders that finished or
  were cancelled and the fires missed in the last 30 days.

**New reminder** in the header opens a form: the text; once, event or repeat;
the date and time in the workspace's time zone; an event's notices (the evening
before at 20:00 and one hour before unless you change them); a repeat's cadence,
set with the [cadence field](#the-cadence-field): its times, days of the week,
a day each month or year, an optional last day and its time zone; where to deliver it (**This app**, **Home** — a
notice there, and the result of the task it starts another when that task
settles; with Home off it is said in the app — or a chat you
added as a routine delivery target, enabled and still authorized; a chat that
cannot be reached for a while falls back to the app); and optionally a task
prompt to start on each fire. **Turn on notifications** asks the browser for
permission (only when clicked); once granted, each reminder fired in the app
while the canvas is open also shows one browser notification, never for fires
that were already waiting when the page opened.

A plain schedule opens as its own page (`/center/schedule/schedules/<id>`): its
name and badge, cadence (a watcher's says what it watches, as its row does) and next run, **Run now**, **Pause** / **Resume**,
**Edit**, **Duplicate** and **Delete** (back to the lists, where it waits
behind **Undo** as a row's delete does); its prompt; its policy (the tools it may use
unattended, what happens to a missed run, its run limit, its token ceiling, where its result goes,
when it tells you, what it watches if it is a watcher, its pre-check and when it last read, where alerts go (your Home when it has no alert target, as `schedules add` says), the agent it runs as, whether it may ask questions, its last
run (any run that started, Run now, a watcher, a webhook or an email included) and failures in a row); its **Webhook** — off ("nothing outside can start
it") with **Turn on**, or on since when, at which address, with **New secret** and
**Turn off** (each confirmed): turning it on or making a new secret shows the
secret, the signing key (or, with no encrypted credential store, that signed
calls need one) and how a call sends them once, each in a read-only field
with **Copy**, under "Copy it now", until **Done** or the page is left (see [AUTOMATION.md](AUTOMATION.md)); its **Email trigger** — off ("no email starts it")
with **Set up**, which lists the workspace's email connections that check their senders (Mailgun, Gmail; the only one is
chosen), a **From** field (addresses or `@domain`, comma-separated) and an optional **Subject holds**, under a warning that
email is where injected instructions come from most and that the run may only read — or on since when, on which connection,
from whom, with **Turn off** (confirmed); and its **Fires**, the last 30 from its ledger,
newest first: when each was for in the workspace's time zone, a badge, what
happened in a sentence ("Completed.", "Skipped: the previous run was still
going.", "Stopped after 30 minutes of work, its run limit.", "Stopped after 52,000
tokens, past its ceiling of 50,000 tokens.", "Completed with
nothing to report, so nothing was sent.", "Nothing new at its pre-check, so
nothing ran and no model was called.", "Failed on a provider error; trying
again at Tue 29 Sep 07:02 (retry 1 of 3).", "Webhook call (payload 312 bytes):
completed.", "Its file changed: completed.", "Email (from ann@example.com, 312 bytes): completed.", "Webhook refused 4 calls this hour (4 bad credentials)."), **Retry N** on a retried try's
row, and **Open its task** when one ran. A schedule a routine owns points to the routine's page.

A reminder opens as its own page: what it says, its cadence, next notices,
recent fires with late and missed marks, **Snooze 10 min** / **Snooze 1 h**
(once it has fired and you haven't seen it), **Pause** / **Resume**, **Delete** (back to the lists, where it waits behind
**Undo** as a row's delete does), and "Added from ‹chat›". A schedule's,
reminder's or routine's page is read again whenever the owner reports a change,
so a new fire or run shows without a refresh. With nothing
scheduled the section suggests asking "remind me to stretch every day at
15:00", and offers templates — **Morning inbox brief** and **End-of-day
wrap-up** (schedules delivered into Home, on weekdays), **Weekly research
digest** (a routine, Mondays) and, where reminders are offered, **Daily stretch
reminder** — each opening its form filled in, in the workspace's time zone;
nothing is created until you save it.

**New routine** opens the routine form: its name and objective (empty, with
examples as placeholders, so saving it as it opens creates nothing) and when it runs,
with the [cadence field](#the-cadence-field) (a plain daily time is set up as
before; any other cadence, or once on a date at one time, is the routine's
trigger). It, and **New schedule**, start in the workspace's time zone. On a
routine's page, **Edit routine** changes its name, objective and triggers
(each a cadence field; **Add a trigger**, up to ten, and **Remove trigger N**)
besides its report, delivery, questions and researcher instructions; only what
changed is sent. A routine opens as its own page inside Schedule
(overview, runs, health checks, researcher and settings, revisions), and a run
as a page beneath it. Its current settings read as one labelled value each
("Delivery › target ids", "Execution › timezone"), the raw configuration
behind **Raw configuration (JSON)**. A revision under **Changes** opens with
what restoring it would change against the newest revision, each setting it
differs in shown **Now** and as in that revision (its raw configuration again
behind a disclosure), before **Restore as a new revision**; the newest one says
it is the current revision and has nothing to restore. Each run under **Runs** shows how long it took, its
tokens and its report's headline; the overview's **Last 7 days** sums the
routine's runs, calls and tokens, and a run's summary adds its model and tool
calls, counting those of attempts a provider failure cut short (which its
budget does not). Neither shows a cost. A routine's page leads back to **Schedule**, and a
run's back to its routine; **Cancel run** on a live run asks first ("Stop this
run now?"), with **Keep running** beside it. **Run now** (from the page or the
row in Recurring, and **Preview latest revision**) opens the
run it started; an owner that does not name the run says "Run started." with
**See it under Runs**. A routine's status notice carries the fix beside it:
**Open credentials** when research is blocked by a credential, **Check
readiness** when setup is needed or it paused after repeated failures (Health
also checks readiness on its own for those three), and **Resume delivery** when
the owner paused its delivery target (as **Resume this delivery target** does
on a run's deliveries). An active `news-v1` routine that no run has yet
published a report for says **Not yet tried on its topic**, since its setup
check measured the models on a fixed test set, with **Preview** beside it (its
Overview says the setup check in plain words, "Passed its setup check on a fixed test set.", with the
scorer's measurements under **What it measured**); a
preview that publishes a report clears it, and never activates a routine. While a run is queued, running or interrupted, its page
reads itself again every few seconds while the tab is showing, timeline and
evidence included, and once more as it settles. A run's page lists its **Questions** with how each was
settled; **Always answer … for this routine** keeps your answer for later runs,
and **Edit routine** lists those answers, each with **Forget**. See
[AUTOMATION.md](AUTOMATION.md#agent-routines).

Against an owner without the Command Center that still offers routines and
schedules, the **Center** tab holds Schedule alone, with no rail and no live
updates: its lists are read when it opens, after each action, and every 30
seconds.

#### The cadence field

Every form that says when something runs (a schedule, a routine and each of
its triggers, a repeating reminder) uses one control, a group with its own
legend:

- **Repeats**: **On days of the week**, **Monthly**, **Yearly** or **Once**
  (what the form allows: a reminder's repeat has no **Once**, its own kind
  does; a routine's one-off trigger runs at one time). Days are chips,
  Monday first, each a toggle button named in full, with the presets **Every
  day**, **Weekdays** and **Weekends**; the last day chosen cannot be
  unchosen, so "nothing ticked" never means anything. **Monthly** is a day of
  the month, its nth weekday ("the last Friday") or its last day; **Yearly**
  a month and its day; **Once** a date.
- **Times of day**: **At set times**, one or several (at most six; **Add a
  time**, **Remove time HH:MM**), or **Every few hours** (1–12) within a
  window, its start and end.
- **Until (optional)**: the last date it runs on.
- **Time zone**: a combobox of the zones this browser knows, the
  workspace's first and marked "(workspace zone)"; another zone offers **Use
  the workspace zone (…)** back.
- **Next 3 runs**: when it would run next, in its own zone, worked out by the
  owner's scheduler (`schedules preview`) a moment after you stop typing, so
  the preview and the fires cannot disagree; "It does not run again." for a
  cadence that has ended.

What is wrong is said under the group as you type ("The window must end after
it starts, within one day.", "That month has no such day.", "Choose a time zone
from the list."), the field it is about is marked invalid, and Save refuses
with the same words. Editing a schedule or routine sends its cadence only when
it changed, and then whole.

### Heartbeat

The Heartbeat section turns the heartbeat on and tunes it: its instructions,
cadence, active hours, days (the cadence field's day chips and presets; the
last day chosen stays), channels, limits, sources, model, provider and log. See
[HEARTBEAT.md](HEARTBEAT.md).

### Approvals

![The Approvals section: one browser call waiting, with Allow once, Allow until tomorrow, Always allow and Deny](assets/screens/center-approvals.png)

Approvals gathers what waits on you across every task, chat and schedule.

**Waiting** is one queue: the soonest deadline first, a task's needs kept
together under its name, with chips to show only questions, approvals, reviews
or what schedules raised.

- Each pending tool-call round is one card: the tool, a one-line summary of each
  call (the URL, query, path or command; a single call is titled in words, as
  "Write notes.txt"), the task (a link that opens it), the person
  when more than one uses the workspace, a stripe and label for its risk (none
  when no risk was recorded), a countdown when the round expires, and the chat
  it was asked in ("Asked in Telegram").
- It offers only the buttons every call of the round allows (**Allow once**,
  **Allow for this chat**, **Always allow**) and **Deny…**, which asks why,
  since the task reads the reason. A critical-risk call asks you to confirm in
  the card before it runs.
- A round of several calls can be decided per call: untick one and **Allow
  ticked, deny the rest**, with an optional reason for the unticked.
- **Details** shows each call's input, read only when opened (a very long one is
  cut, saying how much is left out).
- Text a model, page or sender wrote (title, command, URL, values, reasons)
  shows control, bidi and invisible characters as visible marks (`⟨U+202E⟩`),
  and the card says so
  ([SECURITY-MODEL.md](SECURITY-MODEL.md#hidden-characters-on-a-card)).
- A decision collapses the card to "Allowed once · just now"; a round already
  decided elsewhere (in Telegram, by an email link, or by expiry) collapses to
  "Already decided in Telegram by Ana, 14:02" instead of an error.
- A question is answered right there, with the same card the task's chat shows
  (why it is asked, its options, when it stops waiting and the chats it was also
  sent to); an answer that arrives after someone answered elsewhere says so.
- Reviews are listed with **Open**, since the results to review are kept or
  rejected where they were made.
- A question or review a delegated agent raises is listed once, under that
  agent's own task, not again under the task that delegated to it.
- What leaves the queue while you look (answered in a chat, decided by an email
  link, expired) folds under **Resolved just now**, saying who and how.

The queue works from the keyboard: `j`/`k` move between cards, the option's
number picks it on a question, `a` allows once, `s` allows for the chat, `r`
denies and `o` opens the card's chat (or agent). A screen reader hears once when
a question's last five minutes begin.

**History** is a table of earlier decisions (approvals, reviews and answered
questions), newest first, filtered by kind, decision, tool and person, showing
who decided and through which channel, how long a grant stands (Once, This chat,
Always; an **Always** row links to its rule in Settings → Permissions) and
when, with **Load more** for older ones. Both lists refresh as decisions arrive
from anywhere. Calls a rule allowed without asking are not listed; they are in
the task's transcript.

### Soul & memory

![Soul & memory: the system prompt's parts on the left, memory settings and records on the right](assets/screens/center-memory.png)

Soul & memory shows who the agent is told to be and what it knows about you, in
two panes side by side (stacked on a narrower window), and below them **Chat
notes**: every chat's notes in one list, each under its chat's name, which opens
that chat with its panel on Memory.

**Soul** lists the layers a new task's instructions are built from, in the order
the model receives them, each with its length: the shipped default (struck
through when your prompt replaces it), your prompt, an agent's persona, and the
runtime facts and memory context, which are written per response (open
**Sample facts** to see an example). **Layers for** shows them for a plain task
(**None (plain tasks)**, the default) or for one agent. Below it, **Your
prompt** is the same editor as Settings → System prompt (Save checks the
revision you started from; if someone saved meanwhile your draft is kept, with
**Reload saved** and **Copy draft**; **Use shipped default** stages a reset),
**Persona** picks an agent and edits its persona the same way (for an agent a
routine runs, it says the routine keeps its own pinned instructions), and
**Shipped default** shows the built-in prompt read-only. Changes apply from the
next message.

**Memory** shows your records and the space they use against your quota, then
its settings (on or paused, learning from chats, kinds kept without asking,
sensitive topics, search quality, digest, tidy-up suggestions, limits and the
memory provider), then what the agent proposes to remember (**Keep** or
**Discard** each, **Keep all** / **Discard all**), then your memory grouped into
Facts, Preferences, Lessons and Summaries, with **Past**, search, **Reveal**,
**Correct**, **Forget** and **Remember**. Other people's memory is never listed,
only counted per person. Every control is described in [MEMORY.md](MEMORY.md).

**Skills** (when the owner offers them) lists what waits for review first, then
every skill with its versions, use count and last use. A version opens its text,
diffed against the version it follows, with **Approve**, **Reject**,
**Activate**, **Disable** and **Roll back to this**. **Approve** on a version you
did not write — an agent's proposal (`chat:…`, the dialog names its chat) or an
Agent Skills package imported as another author's (`archive:…`), the ones `tavi
skills approve` takes only with `--yes` — asks once before it approves: **Yes,
approve** or **Cancel**. A proposal the agent made
also shows **What the task did** (the tool calls of the task it came from, each
on one line), a warning naming what its turn read when that was untrusted
content, **Edit** (your text saved as a new version to review, following the
proposal, which is set aside) and **Regenerate with feedback** (your feedback
sent to the chat it came from as your message, for the agent to propose it
again). When a turn ends with a skill the agent offered on its own, the chat
shows a card after it: *Save how I did this as a skill?* with **Review** (opens
it here), **Not now** (it keeps waiting) and **Don't suggest this** (rejected,
so the topic is not offered again for 30 days). See [SKILLS.md](SKILLS.md).

### Browser

Browser shows the sites the agent is on or was on in the last 30 days, one card
per browser session: **Open now** for sessions still open, then **Earlier**,
newest first, with **Load older**; sessions that never reached a page are
folded under **N sessions that opened no page**. The two newest live cards show the page live,
with **Take control**; a session whose task ended (**Ended**) offers it too, for
the page it kept. The section is described in
[BROWSER.md](BROWSER.md#browser-history).

## Ideas and Welcome

The **Ideas** tab (when the owner offers it) shows things Tavi offers to do for
you; see [IDEAS.md](IDEAS.md). `/welcome` (and `/welcome/<stepId>`, `?all=1` for
every step) is setup's Welcome; see [ONBOARDING.md](ONBOARDING.md).

## Settings

![Settings → General: setup, timezone, task summaries and the other workspace switches](assets/screens/settings-general.png)

Settings' views are listed in the left column, in three groups — Workspace
(General, Models, Web search, System prompt), Connections (Connected apps,
Credentials, Channels, Allowed people) and Control (Plugins, Permissions,
Ideas, listed only when the owner offers it) — and on a phone as a strip of
tabs above the page. It has these views:

- **General**: **Setup**, whose **Run setup again** goes through every setup
  step again (the model, about you, apps, channels, search and first ideas),
  keeping what is set up unless you change it ([ONBOARDING.md](ONBOARDING.md));
  the workspace timezone the agent states the local time in (the
  zone in effect, whether it is the host's default, a searchable picker and
  **Use host zone**); **Task summaries** (the switch that turns generated task
  titles and summaries off, and the model that writes them: by default the
  **Fast** role's model when one is bound, else the model the task itself used,
  and never a remote model for a task that ran on a local one); **Flight search**;
  **Skill suggestions** (whether the agent may offer, unasked, to save a
  procedure that worked as a skill for your review: `skills.suggestions`);
  **Rarely used tools** (automatic, always or never waiting behind
  `tools.search`: `models.toolDeferral`); **Secrets in tool results** (keys
  and tokens a tool returns are masked as `[redacted:<kind>]` before the model,
  the archive or the page sees them, and a write that would put a placeholder
  back into a file is refused: `tools.redactResults`); **Video** (**Let the
  agent read videos**, `video.enabled`, and how many days videos from chats
  and uploads are kept; [VIDEO.md](VIDEO.md)); **Your to-do list** (Tavi's own
  list, or a task app connected as an MCP server that this workspace allows
  and has enabled: `tasks.home`); **Browser thumbnails** (the hosts whose pages never get one, comma-separated,
  `*.example.com` for a domain and its subdomains, `none` to block no host by
  name, with **Reset to defaults**); the browser's site recipes, each with
  **Save as a site note** (a proposed note in the data directory's
  `site-notes/`, shown off with the `tavi browser site-notes --on <id>` that
  turns it on) and **Forget**, and **Clear
  browser profile…** (see [BROWSER.md](BROWSER.md)); and last, **Reset
  instance**: after you type `reset`, the owner deletes everything it keeps
  (every workspace's chats, tasks, memory, schedules and settings, artifacts,
  saved credentials, installed plugins and logs), starts again on the empty data
  directory, and the page reloads as on a new install.
- **Connected apps**: the apps and channels Tavi can use, their accounts, sites
  and tool decisions, with a **Discover** catalog (`/settings/apps`,
  `/settings/apps/discover`, `/settings/apps/<app>`). See [APPS.md](APPS.md)
  and [MCP.md](MCP.md).
- **Models**: roles first, the workspace default and each role, saying whether
  it has its own model, uses the default, or is not set. **Set** opens one
  searchable picker for the primary model and up to three ordered fallbacks,
  with a test before saving; **Use default** returns a role to the default
  (Embedding, which never uses the default, has **Clear** instead, which unbinds
  it: memory search then matches words only). Below, the
  connections, each with its model count, **Rediscover**, and **Manage**
  (replace its key, rebind its credential, remove it). Each connection has
  **Native video**, except a provider-managed one or an endpoint that takes no
  video: a switch for each model that reads video, which sends it whole clips
  in an attended chat instead of frames once you confirm what leaves the
  machine, and **Probe** for any other model.
  **Video analysers** checks FFmpeg and which pose, transcription and
  on-screen-text analysers can run here ([VIDEO.md](VIDEO.md)). **Add
  connection** picks a provider, takes its key, discovers its models and, when
  the workspace has no default yet, asks for one. **Model retirements**
  stores a free [Rhumb](https://rhumbdata.com/sign-up) key (as the
  credential `rhumb`), after which the owner checks daily which models in use
  retire, are redirected or change price; with one stored, **Check now** runs
  `tavi models sync` and says what it found.
- **Web search**: add, test, enable, disable and remove providers, each named
  once by its kind (its own id beside it only when that differs).
- **System prompt**: the built-in base prompt, or a workspace's own, with the
  shipped text shown and an override saved as a revision.

  ![Settings → System prompt: the built-in default in an editor with its character count, Save, Discard and Write a custom prompt, and the shipped default folded below](assets/screens/settings-system-prompt.png)

- **Credentials**: the stored references, each with what it is for where its
  name says so ("ollama API key", "Channel token") above the reference itself;
  set a value through a masked form
  (sent once, never shown again) or delete one. A read-only line under the
  notice says whether the store is encrypted at rest and where its key is, as
  `tavi credentials key` does: "Encrypted; key in the macOS Keychain" (or the
  Secret Service keyring, or `credentials.key` in the data directory), or "Not
  encrypted: run `tavi credentials encrypt`".
- **Channels** and **Allowed people**: the workspace's channel connections
  (Telegram, Mailgun email, Gmail, and any channel a plugin adds) and who may
  chat with the agent through each. See [CHANNELS.md](CHANNELS.md).
  - Each connection shows its status (when it last took a message in or sent
    one, and why its last send failed), a form drawn from the channel's own
    description, **Test** and **Remove**; the page also holds the shared webhook
    port and public address. A save applies at once, with no restart. Settings
    are saved in the database and secrets in the credential store; a connection
    set by `tavi serve` flags is shown read-only.
  - Each connection's row says who is allowed on it, or **No one allowed**,
    since it answers no one until someone is; its **People** button allows,
    pairs and revokes people on that connection alone. Adding a connection opens
    it straight away. A channel's page in Connected apps lists the same
    connections with their settings, which secrets are saved and the people
    allowed.
  - A channel that signs in with OAuth uses its plugin's OAuth app or one of your
    own, entered once per channel, and is signed in with **Connect with …** in a
    window of its own, once credentials are encrypted (**Encrypt credentials**
    in place). The owner refreshes its token; signing in again must be the same
    account, and changing the channel's OAuth app asks each of its connections
    to connect again.
  - Your own account on a channel is allowed with **This is me** in Allowed
    people (shown as *you*): it takes this workspace's principal, so its chats
    join yours in the app (and Home, with `chat.home-dm`) and you approve its
    rounds with the buttons in that chat. An account already allowed under
    another ID is first revoked (**Revoke access**), then allowed again.
  - A connection is named with its channel (*Work · Telegram*), once when the
    connection is named after the channel (*Parrot*). Not knowing what to
    enter as the channel's sender field (its own label, as written), **Pair
    with a code** asks the person to send a code instead.
  - A person allowed under a Person ID of their own uses the workspace's tools
    and models and keeps their own memory; a round of approvals in their task is
    shown to them as waiting for you, and only you decide it (in the app, with
    `tavi approvals`, or by its token from your own chat). A question the agent
    asks them, they answer in their chat, or you answer for them from the inbox
    (or `tavi approvals answer`).
  - **Pair with a code** gives a one-time code for the person to send on the
    channel (`/link XXXX-XXXX`), and on Telegram also renders a QR code and an
    **Open in Telegram** deep link (`https://t.me/<bot>?start=XXXX-XXXX`); you
    confirm who sent it before they are allowed.
  - **Test** offers the people allowed on the connection, each reached in their
    own chat (a Telegram user's private chat is at their user ID), or a target
    typed in, and remembers the last one in this browser; a target it reached
    that is also a sender ID can be allowed as a person right there.
  - **Remove** revokes the people allowed on the connection and settles a send
    left pending on it as uncertain. One whose channel is not installed shows
    *provider missing* until the channel is back.
  - While a message's turn runs, the channel shows the agent typing (Telegram,
    Discord).
- **Plugins**: built-in and installed plugins with their state in the running
  owner; install a plugin directory, approve or reject a version, enable or
  disable, and edit an installed plugin's settings. Tavi's other built-ins are
  folded under **Built in · N** (opened when one is off or not ready), and the
  core ones, which cannot be turned off, under **Core (always on)**. A plugin
  with more than three tools folds them under **Tools · N**. An enabled
  plugin the owner has not loaded yet is badged **loads at next start**; one
  that only adds to the canvas applies at once and gets no such badge. Each
  **Approve** button is named by its visible words first (**Approve 1.0.0 of
  acme.units**). **Hook activity** gives each decision's time in the
  workspace's zone and each hook's median and worst time over its last calls.
  See [PLUGINS.md](PLUGINS.md).
- **Permissions**: the rules that decide a tool call before any approval round,
  and the grants approvals made; it lists, removes and revokes, and never adds.
  Your rules come first; the ones shipped with Tavi are folded under
  **Shipped with Tavi · N**, opened when an approval points at one.
  Each chat grant names its chat by title, as a link to it, with the task id
  beside it. See [SECURITY-MODEL.md](SECURITY-MODEL.md).
- **Ideas** (when the owner offers it): what Ideas hides, mutes and excludes,
  and turning them off. See [IDEAS.md](IDEAS.md).

The forms these views open (a schedule, a provider, a credential, a routine) are
dialogs: the title and the Cancel/Save row stay put while a long form scrolls
between them. `Esc` or the **×** in the title closes one; a click on the page
behind it does not, so a half-filled form survives a stray click. Key and token
fields are masked but are not password fields, so the browser's password manager
does not offer saved logins in them or offer to save a key as a password.

## Routes

Each page has its own path, so a refresh, a bookmark or **Back** lands where you
were:

| Path | Page |
| :--- | :--- |
| `/` | The chat, on the session the page holds |
| `/tasks/<taskId>` | The chat, reading that session |
| `/tasks/<taskId>/<tab>` | The same, with the chat panel open on `activity`, `schedule`, `memory`, `instructions` or `details` |
| `/tasks/<taskId>/plugin:<plugin-id>/<contribution-id>` | The same, on a plugin's tab |
| `/center`, `/center/<section>` | The Command Center at `activity` (the default), `approvals`, `schedule`, `heartbeat`, `identity` (Soul & memory) or `browser` |
| `/center/schedule/routines/<routineId>` | A routine's page; `/runs/<runId>` beneath it is one of its runs |
| `/center/schedule/reminders/<reminderId>` | A reminder's page |
| `/center/schedule/schedules/<scheduleId>` | A plain schedule's page |
| `/ideas` | The Ideas tab |
| `/welcome`, `/welcome/<stepId>` | Setup's Welcome, at that step (`?all=1` walks every step) |
| `/settings`, `/settings/<view>` | Settings at that view (`models` by default); a view is named by its id (`search` for Web search, also `web-search`), and an unknown one opens Models |
| `/settings/apps/<app>[/connect]` | A connected app's page, and its connect sheet |

`/routines`, `/routines/<routineId>[/runs/<runId>]` and `/settings/schedules`
open the same pages under Schedule, and the address bar is corrected to the new
path. A path the canvas does not know is the chat, and the address bar is
corrected to it. What is narrower than a page (which chat sub-view, whether the
chats are open) stays the page's own state and is not sent to anyone; the chat
panel's open state, tab and width are kept in this browser's local storage.

The chat is part of the canvas's first load; the Command Center, Schedule,
Ideas, Settings and Welcome pages are each fetched the first time you open
one, so that first visit shows "Loading…" briefly, and if the fetch fails the
page offers **Try again**. The same goes, inside a chat, for the side panel's Schedule,
Details, Memory and Instructions tabs, the Trajectory, Held files and Agents views,
"Repeat this", the takeover overlay and the connect sheet.

## Keyboard

![The keyboard sheet: every shortcut the canvas answers](assets/screens/keyboard.png)

| Key | What it does |
| :--- | :--- |
| `Enter` / `Shift+Enter` | Send / new line |
| `Esc` | Stop the running turn; with a popover or menu open, close only that |
| `Cmd+Alt+Enter` | Allow the waiting round: the card's first button, **Allow once**, or **Allow for this chat** on a browser card |
| `Cmd+Alt+Backspace` | Deny the waiting round |
| `Cmd+K` | Search chats |
| `Cmd+/` | The full sheet: a dialog over the dimmed page with each chord as keycaps (`Esc`, another `Cmd+/` or its **×** dismisses it) |
| `Cmd+Shift+S` | Hide or show the chats |
| `Cmd+Shift+.` | Hide or show this chat's panel |
| `Cmd+Alt+1` … `Cmd+Alt+5` | Open the chat panel on Activity, Schedule, Memory, Instructions or Details |

`Ctrl` stands in for `Cmd` where there is no Cmd key. The approve and deny
chords are deliberately awkward, and `Enter` alone never allows anything. These
chords are the browser's to overrule, so each also has a button (the keyboard
icon at the right end of the header, absent on a touch screen and at phone width; the fold
controls on the chats list and the chat panel) and none depends on the chord surviving. The rest (a new chat,
settings, the model picker) are buttons in that sheet rather than keys the page
pretends to own.

## Accessibility and look

<img src="assets/screens/chat-phone.png" alt="The canvas at phone width: the header, the chat tabs, the greeting and the composer with its model picker on a row of its own" width="320">

A screen reader hears the events, not the tokens: one region announces
responding, complete, a question, a permission request, a review, stopped and
failed, plus the connection and what your next prompt will do. Every turn is
labelled (`you:`, `assistant:`, `tool:`, `permission required:`) so the
transcript can be searched, focus stays in the prompt box while an answer
streams, and the page honours `prefers-reduced-motion`. While a turn runs, three
bouncing dots under its latest output say it is still working.

Notes an action leaves ("Saved.", a model picked, what a chats search found)
are said through that same region, so none is missed for appearing at the same
moment as its line. The page's tab title names the view and, on a chat, its
title (for example `(2) Settings – Models – tavi`), after the count of what is
waiting. **Skip to content** is the first Tab stop, and while a notification is
up **Jump to notification** follows it. Dialogs, the takeover and the expanded
browser view keep focus inside them while open (the page behind is inert) and
give it back to what opened them; a form keeps your place while it saves. An
icon button that cannot be used yet stays focusable and says it is unavailable,
and a confirm reads its warning as it opens. Focus is drawn as an outline, so it
still shows in Windows High Contrast (forced colours), and a field that must be
filled says **Required** on its label line.

The look is Pine & Sun: white cards on a cool, faintly green ground with pine
ink, deep forest with mint when the system is dark (the page follows the
system's light or dark setting; it has no switch of its own), and one warm
accent, the
sun, kept for what waits on you (an approval's dot) and the dot on the
wordmark's i. The header shows Tavi's mark, a speech bubble with a sprout,
which is also the tab's icon and the face over each answer. Text is Inter;
the wordmark, Welcome's title, page titles and an empty canvas's greeting are
Bricolage Grotesque, both self-hosted. Edges are mostly tone, with hairlines
where a card meets a card, and there are no gradients. Motion is small (a
waiting approval settles in and its sun dot's halo breathes while it waits,
and the working dots breathe) and stops under reduced motion. Every colour is
a token, icons are drawn SVG (never an emoji or a glyph), and
`apps/ui/test/styles/design.test.ts` fails the build that breaks one. Text keeps a 4.5:1 contrast and control edges,
focus and selected states 3:1 in both themes, checked from the tokens by
`apps/ui/test/styles/contrast.test.ts`.

The layout has five breakpoints, named once in `apps/ui/src/styles/breakpoints.css`
as `@custom-media` and read by every stylesheet as `@media (--phone)`: `--phone`
(up to 720px), `--wide` (from 960px: Soul & memory's two panes, Welcome's step
rail), `--overlay` (721–1279px: the chat panel over the transcript),
`--undocked` (below 1280px: the Command Center's rail under its section) and
`--short` (up to 500px tall, a phone on its side: the transcript keeps the
height, the box is one line beside its controls). Chats opened by hand at phone width
scroll with the chat below them rather than taking its height. The
build writes them out (Lightning CSS); `src/lib/breakpoints.ts` holds the same
numbers for the script, `design.test.ts` holds the two equal, and `lint:css`
refuses a width query anywhere else.

A page that fails to draw says so in its place, with **Try again**; the header
and the other pages keep working.

## Reloading

Reloading keeps your session, the page you were on and the page's last task
(its prompts and answers), and the next prompt continues it. The prompts come
from the task's record; when the owner no longer holds every turn, they are
listed apart under **Recorded prompts** rather than guessed onto the wrong
answer. **Earlier in this chat** marks where the turns read back from the
record begin. A turn read back keeps what its saved turn holds: the
memory chip (**Used N memories** or **Looked through N memories**) under its answer, and
what **Repeat this…** says of what the chat read.

A chat on screen shows a turn it takes without you as it happens — Home
reading a worker's answer or a schedule's result — without a reload: once the
chats list says the chat is working, or shows it updated since its last turn
settled (a short turn can start and end between two looks at the list), the
page follows it again.

## Architecture

`tavi ui` combines a loopback HTTP + WebSocket bridge in `@tavi/cli`, a browser transport client in `@tavi/client/browser`, and the React 19 + Vite single-page application in `@tavi/ui`:

| Layer | Module / Path | Responsibility |
| :--- | :--- | :--- |
| **Loopback UI Bridge & Plugin Route** | `apps/cli/src/server/ui-bridge.ts`, `apps/cli/src/server/plugin-ui-route.ts` | Binds `127.0.0.1`, exchanges one-time fragment tokens for a 12-hour session cookie + tab secret, proxies authorized IPC commands and WebSocket event streams to the owner, and serves CSP-isolated plugin UI assets at `/plugin-ui/<plugin-id>/<content-hash>/<path>`. |
| **Browser Client (`@tavi/client/browser`)** | `packages/client/src/browser.ts`, `packages/client/src/browser/*`, `packages/client/src/reduce-run.ts` | Browser-safe HTTP + WebSocket client (`websocket.ts`), run-event state reducer, and cursor management. |
| **Shell, Startup & Welcome** | `apps/ui/src/features/shell/*`, `apps/ui/src/features/startup/*`, `apps/ui/src/features/welcome/*` | Top-level 3-zone layout, route handling, theme/token CSS enforcement, first-run `/welcome` setup wizard (`ConnectSteps.tsx`), and Home setup checklist. |
| **Chat, Sessions & Transcript** | `apps/ui/src/features/chat/*`, `apps/ui/src/features/chat-panel/*`, `apps/ui/src/features/sessions/*`, `apps/ui/src/features/transcript/*`, `apps/ui/src/features/workers/*` | Chats rail (**Needs you** / **Working** / **Stopped** / **Completed**), composer + model picker, Markdown/KaTeX transcript, Trajectory/Held files/Agents tabs, worker read-only view, and the 5-tab right-hand chat panel (`Activity`, `Schedule`, `Memory`, `Instructions`, `Details`). |
| **Command Center, Ideas & Overlays** | `apps/ui/src/features/center/*`, `apps/ui/src/features/needs/*`, `apps/ui/src/features/routines/*`, `apps/ui/src/features/ideas/*`, `apps/ui/src/features/takeover/*`, `apps/ui/src/features/plugin-host/*` | Command Center sections (`activity`, `approvals`, `schedule`, `heartbeat`, `identity`, `browser`), routine/reminder/schedule detail pages, `/ideas` tab, interactive browser takeover modal, and sandboxed plugin iframe host (`tavi.ui/1`). |
| **Settings & Connected Apps** | `apps/ui/src/features/settings/*`, `apps/ui/src/features/apps/*`, `apps/ui/src/ui/QrCode.tsx` | Settings views (`General`, `Connected apps`, `Models`, `Web search`, `System prompt`, `Credentials`, `Channels`, `Plugins`, `Permissions`, `Ideas`) and QR-code / deep-link channel pairing (`ChannelsSettings.tsx`, `QrCode.tsx`). |

See [ARCHITECTURE.md](ARCHITECTURE.md) and [TERMINAL-UI.md#architecture](TERMINAL-UI.md#architecture) for how the web canvas and terminal UI share `@tavi/client`.
