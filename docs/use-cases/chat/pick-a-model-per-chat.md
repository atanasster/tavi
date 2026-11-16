# Switch the model for one chat

Pick a different model for the chat you are in, from the canvas or the terminal, and see the next answer come from it. About three minutes.

> **Uses:** the composer's model picker (`tavi ui`) · `/model` in the terminal chat (`tavi chat`)
> **Before you start:** a model connected ([Connect your first model](../get-started/first-model.md)) · Tavi running in the background with `tavi serve` ([Keep Tavi running in the background](../get-started/keep-tavi-running.md))

## 1. Start a chat

Run `tavi ui` and send a message to **Home**. The strip at the foot of the page names the model that answered: **Model: gemini-3.8-flash**.

![Home with one question and its answer, the composer's picker showing Gemini 3.8 Flash and the footer naming the model](../../assets/use-cases/chat/pick-a-model-per-chat/01-start-a-chat.webp)

## 2. Open the model picker

Choose the model's name in the composer, beside **Send**. The list holds every model your connections offer; type part of a name to narrow it.

![The model picker open under the composer, narrowed to Claude Haiku 5.5 by typing haiku 5.5](../../assets/use-cases/chat/pick-a-model-per-chat/02-open-the-model-picker.webp)

## 3. Pick a model

Choose the model. The picker shows it at once, and nothing needs a restart: the chat runs it from its next message.

![The composer with Claude Haiku 5.5 now picked](../../assets/use-cases/chat/pick-a-model-per-chat/03-pick-a-model.webp)

## 4. Send your next message

Send the chat its next message. The answer comes from the model you picked, and the footer names it: **Model: claude-haiku-5.5**.

<!-- cover -->
![The chat's second answer, with the footer now naming claude-haiku-5.5](../../assets/use-cases/chat/pick-a-model-per-chat/04-send-your-next-message.webp)

## 5. Switch from the terminal

In `tavi chat`, type `/model` to see which model the chat shown runs, and `/model <connection> <model>` to change it, for example `/model openrouter google/gemini-3.8-flash`. The chat runs it from its next turn, and new chats start with it too.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/use-cases/chat/pick-a-model-per-chat/05-switch-from-the-terminal-dark.svg">
  <img src="../../assets/use-cases/chat/pick-a-model-per-chat/05-switch-from-the-terminal.svg" alt="tavi chat on Home: /model names the chat's model, then /model openrouter google/gemini-3.8-flash switches it back">
</picture>

## What Tavi will and won't do

A pick changes the chat from its next message, never a turn already running. It also becomes the default for new chats, the same as **Default** in **Settings → Models**; when something else still chooses the model for new chats (a role binding, or a model given to `tavi serve`), a note under the picker says so. The picker only offers models your own connections reach: adding a provider is done in **Settings → Models**.

## Related

- [Have your first conversation in the terminal](../get-started/first-chat.md)
- [Connect your first model](../get-started/first-model.md)
- [Send a file or image with your message](attach-files-to-chat.md)
- Reference: [WEB-UI.md](../../WEB-UI.md#the-composer-and-the-model-picker), [TERMINAL-UI.md](../../TERMINAL-UI.md)
