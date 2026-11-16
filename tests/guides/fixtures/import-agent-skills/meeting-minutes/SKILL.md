---
name: meeting-minutes
description: Turn rough meeting notes into minutes with decisions and action items. Use when asked to write up or tidy meeting notes.
allowed-tools: Read, Grep
compatibility: Works with any agent that can read files.
metadata:
  version: "0.3.0"
  author: Example Skills Collective
---

# Meeting minutes

1. Read the notes file you are given.
2. Find the action items: lines starting with `TODO` or `ACTION`.
3. Write the minutes in the shape of `references/template.md`: attendees, decisions, then action items with their owner.
4. `scripts/count_actions.py` shows how the action items are counted; you do not need to run it.
