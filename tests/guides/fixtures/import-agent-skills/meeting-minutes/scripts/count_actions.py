"""Counts the action items in a notes file: lines starting with TODO or ACTION."""
import sys

with open(sys.argv[1], encoding="utf-8") as notes:
    print(sum(1 for line in notes if line.lstrip().startswith(("TODO", "ACTION"))))
