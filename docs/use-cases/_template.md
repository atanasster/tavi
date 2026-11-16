<!--
  The shape of a how-to guide (tests/use-case-guides.test.ts checks it). Copy this file to
  docs/use-cases/<folder>/<slug>.md, write its walk at tests/guides/<folder>/<slug>.guide.test.ts,
  and run `pnpm test:guides <folder>/<slug> --update-shots` to take its pictures, then
  `pnpm docs:indexes`. Copy the block below (without its fence) and delete these comments.

  - The title is the task, as the reader would say it.
  - The lead: what you get, and roughly how long it takes.
  - The context box is required: **Uses** (the parts of Tavi involved, tool names in code) and
    **Before you start** (each prerequisite, linked to the guide that sets it up).
  - Four to nine steps, `## N. Imperative title`, one to three sentences each, the canvas's own
    labels in bold, then exactly one picture: a canvas shot
    `![what is on screen](../../assets/use-cases/<folder>/<slug>/NN-<step-key>.webp)`, or a
    terminal shot as a <picture> with its -dark.svg twin. The step key is the title in lower
    case, hyphenated. Put <!-- cover --> above the picture the folder index should show.
  - "What Tavi will and won't do": the safety a reader will notice, in two or three sentences.
  - "Related": two to four neighbouring guides, then the reference doc.
-->

````markdown
# Do the task

What you get, in a sentence or two. About five minutes.

> **Uses:** the parts of Tavi this touches (`tool.name`)
> **Before you start:** what must be set up first, each linked to its guide

## 1. First thing to do

What to do, in the screen's own words: open **Settings → Models**, choose **Add**.

![What the reader sees after doing it](../../assets/use-cases/folder/slug/01-first-thing-to-do.webp)

## 2. Next thing to do

A command, when the step is one: `tavi models list`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/use-cases/folder/slug/02-next-thing-to-do-dark.svg">
  <img src="../../assets/use-cases/folder/slug/02-next-thing-to-do.svg" alt="What the command printed">
</picture>

## What Tavi will and won't do

What asks first, what never happens, and where the details are.

## Related

- Neighbouring guides, by their titles
- Reference: the reference doc for this part of Tavi
````
