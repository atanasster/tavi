<!--
  The shape of an everyday recipe: one page per template of the Ideas catalogue
  (packages/plugin-kit/src/ideas/catalogue.ts). Copy it to docs/use-cases/everyday/<area>/<slug>.md,
  where the slug is the template's key without its prefix (travel.fare-watch → fare-watch).
  tests/use-case-guides.test.ts checks the context box against the template:
  **Uses** is the capabilities in `requires`, in order, by their Idea card labels
  (`ideaCapabilityLabel`), joined with " · "; **Asks first** is `asks` the same way, or
  "Nothing — it only reads and suggests"; **Runs** is "Daily", "Weekly" or "When you ask";
  **Idea card** is the template's label in quotes and its key in code.
  Name the prompt, never a card: an idea card shows only once Tavi knows the topic, and in its own words.
  Steps: ask for it, what Tavi does, the approval (only if it asks first), the result, and making
  it recurring (only if it runs daily or weekly). Copy the block below (without its fence) and delete these comments.
-->

````markdown
# Do the everyday thing

What Tavi does for you, in a sentence or two.

> **Uses:** Web · Reminders
> **Asks first:** Nothing — it only reads and suggests
> **Runs:** When you ask
> **Idea card:** "Label" (`category.key`)
> **Before you start:** what each capability needs, linked to its guide

## 1. Ask for it

Choose **New chat** above the chats to open a chat of its own and send the prompt, with your details in it. Once Tavi knows this is something you do, **Ideas** may offer it as a card in its own words; **Try it** there starts the same chat.

![The prompt in the chat](../../../assets/use-cases/everyday/area/slug/01-ask-for-it.webp)

## 2. Read the result

What comes back, and what to do with it.

![The answer](../../../assets/use-cases/everyday/area/slug/02-read-the-result.webp)

## Variations

- Another way to ask

## Related

- The capability guides this recipe relies on
````
