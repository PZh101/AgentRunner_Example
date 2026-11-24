---
name: code-review
description: Review code changes for correctness bugs, ranked most-severe first.
---

When asked to review code:

1. Identify the target files or diff first; if ambiguous, list candidates and pick the modified ones.
2. Read the code fully before judging. Do not flag style preferences as bugs.
3. For every finding, state: file path, the concrete failure scenario (inputs/state -> wrong output), and a severity (important / minor / nit).
4. Verify each finding against the code before reporting it; drop anything you cannot make concrete.
5. End with a one-line verdict: APPROVE or CHANGES REQUESTED.
