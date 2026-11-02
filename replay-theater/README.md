# Replay Theater

Step through the file edits Claude made, one diff at a time.

After a turn that changed files, a hint appears above the prompt:

```text
▶ Replay: 5 edits (press r)  3 files, +42 -17  [ Replay ]
```

Open it (type `/replay`, press `r`, or press the Replay button) and a pane shows one edit at a time: the file, the tool, a count of added and removed lines, and the diff with the file's own line numbers. A strip of numbered cells shows every step. Prev, Next and Close buttons move through them.

It only watches. It never blocks, changes or delays an edit, a prompt or a tool call.

## What it records

An edit is recorded after it ran, from what the tool reported. A refused or failed edit is not a step.

| Tool | Step |
| --- | --- |
| Edit | The diff, with line numbers. `replace all` says how many places. `you changed it first` when you edited the proposal. |
| Write | `new file`, or a `rewrite` diffed against the old text. A write held for review is skipped. |
| MultiEdit | One step for each edit (`edit 2 of 3`), where your build has the tool. |
| NotebookEdit | One step for the cell (replace, insert or delete). |
| Bash `rm`, `mv`, `git rm`, `git mv` | The removed file as removed lines, a folder as removed, a rename or a move. Only plain commands: a pipe, a variable, a glob, a redirect or a `cd` in the line means nothing is recorded. |

Binary files show as one line. Edits by helpers (subagents) are part of the turn and tagged `helper`.

## Commands

| Command | Does |
| --- | --- |
| `/replay` | Open the last turn |
| `/replay 2` | Open the turn before it (up to 10 turns are kept) |
| `/replay list` | List the turns kept |
| `/replay files` | Open the file list of the turn |
| `/replay file` | Open the file view: all the edits of one file together |
| `/replay step` | Open the step view: one edit at a time |
| `/replay filter *.liquid, sections/` | Show only matching files. A word matches inside the path, a `*` makes a glob, a `!` leaves matches out. `/replay filter` clears it. |
| `/replay split` or `/replay unified` | Old and new side by side, or one column |
| `/replay copy [turn]` | Put the turn's patch on the clipboard |
| `/replay save` | Write the turn's patch to `~/.claude/claude-mods/replay-theater/last.patch` |
| `/replay status` | On or off, turns kept, layout, filter, settings |
| `/replay hide`, `/replay show` | Hide or show the hint above the prompt |
| `/replay help` | The list above, short |

## In the pane

| Key | Does |
| --- | --- |
| `n` / `p` | Next / previous step (in the file view, file) |
| `f` / `b` | Next / previous file |
| `v` | Change view: step, file, file list |
| `s` | Side by side or unified |
| `y` | Copy the diff (the whole turn's patch in the file list) |
| `e` | Expand or fold a folded diff |
| `u` / `d` | Scroll a long diff up or down |
| `o` / `l` | Older / newer turn |
| `c` or `Escape` | Close |

Mouse clicks work on every button. In the file list, press a file to jump to its first edit. Where the surface has a text field (not the phone app), the file list has a "Show only" field for the filter.

## Views

- **Step view:** one edit at a time, as the sample did. The header says `step 2 of 5`.
- **File view:** every edit of one file stacked, with Next going to the next file.
- **File list:** every file of the turn with how many edits and +/- lines. A turn header says how many edits, files and lines.
- **Unified:** the engine's own diff drawing, with line numbers and syntax colours in light and dark. Liquid is coloured as HTML, JSON as JSON.
- **Side by side:** old on the left, new on the right, with line numbers. It needs 72 columns, and falls back to one column in a narrower pane.

## Shopify themes

Files get a plain name: Liquid section, Liquid snippet, Liquid layout, Liquid block, JSON template, Section group, Theme settings data, Locale, Theme script, Theme style. A very long line (a minified file), a `.min.js`, a source map, a lock file or a folder like `dist/` starts folded. So does a change of more than 300 lines. Press Expand to read it. A small edit to `settings_data.json` is not folded.

## Long diffs

Nothing is cut to 12 lines any more. The pane shows a window of the diff and says where it is (`lines 15-30 of 120`). Down and Up scroll it. The first 2,000 lines of one edit are kept, and a very large turn keeps counts only for the edits past its budget, so memory stays small. The strip around many steps follows the current one.

## Settings

| Setting | Does | Default |
| --- | --- | --- |
| Turns kept | How many of the latest turns can be replayed (1 to 50) | 10 |
| Fold diffs longer than | Lines changed before a diff starts folded. 0 never folds on size. | 300 |
| Diff layout | `unified` or `split` to start with | unified |
| Show the hint above the prompt | Turn off to open the replay with `/replay` only | on |

## Turn it off

Put `"replay-theater": false` in `~/.claude/claude-mods/switches.json`. Every hook then does nothing and the pane closes at the next action in the chat. Remove the line (or set it to `true`) to turn it back on. A missing or broken file means on.

`"replay-theater:hidden": true` in the same file hides the hint and closes the pane; `/replay show` (or any `/replay`) clears it and keeps your other lines. The file is read when something happens in the chat, at most once a second. There is no timer.

A request file named `~/.claude/claude-mods/.open-replay-theater-<chat id>` (left by a mods switch panel) opens the replay at the next edit, Bash command, or turn start or end in that chat (there is no timer, so nothing happens while the chat is idle).

## Log

`~/.claude/claude-mods/logs/replay-theater.log` gets one line for a notable failure (a recording that failed, a copy or save that failed, the mod switched off with its pane open). It never holds file contents or diffs. The newest 300 lines are kept.

## Limits

- The replay is kept in memory for the current session. It is lost when Claude Code restarts.
- Only changes made through Claude's tools are recorded. A script that rewrites files, or a shell command other than the plain `rm` and `mv` forms above, is not.
- A moved or renamed file shows as a move, not as a diff.
- An Edit that does not report where it sits in the file shows its snippet from line 1 and says `line numbers not known`.
- Side by side has no syntax colours. Unified has.
- The hint above the prompt shares its band with other mods. This one draws under theirs.
- `ui.close` (Escape or the close mark) cannot be raised by the test kit, so that one hook is checked by hand.
- The clipboard may be out of reach on a remote surface. Copy then saves the patch to the file above and says so.

## Install and check

```bash
claude plugin validate ./replay-theater
claude plugin test ./replay-theater
claude --plugin-dir ./replay-theater
```

Needs Claude Code 2.1.287 or later (mods load by default). Built and tested on 2.1.309 (the test kit of 2.1.283 also passes).

## Attribution and licence

This mod is derived from **Replay Theater**, a sample mod by Claude Code DevRel at Anthropic (Copyright 2026 Anthropic PBC), from [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/replay-theater). It is shared under the Apache License, Version 2.0: the full text is in `LICENSE` and the notice is in `NOTICE`. A third-party copy of the sample added support for a mods switchboard; this version has its own switch support (below) written from scratch.

Changes from the sample, as the Apache License asks us to state them:

1. Edits are recorded after they ran, from the tool's own result. The sample recorded at call time, so an edit you refused or that failed still showed.
2. The diff has the file's real line numbers and context lines (from the tool's patch). The sample diffed only `old_string` against `new_string` and showed no line numbers.
3. The sample read the old file from disk before a Write; this version reads nothing from disk to record an edit.
4. A Myers line diff with a trim of the common start and end replaces the sample's 400-line LCS table, so a big rewrite shows a real diff and not "all removed, then all added".
5. The 12-line cap per step is replaced by a scrolling window, with the first 2,000 lines kept.
6. Any of the last turns can be replayed (up to 10), not only the last. New: `/replay <number>`, `/replay list`, Older and Newer buttons.
7. New views: file view, file list, a header with edits, files and +/- lines, side by side or unified, a jump to a file.
8. New: a filter by file (`/replay filter`, a text field), copy and save as a patch.
9. New: syntax colours through the engine's own diff drawing, in the person's light or dark theme, instead of fixed red and green text.
10. New: Shopify file names, folded diffs for minified, generated and very large changes.
11. New: NotebookEdit, and Bash `rm`, `mv`, `git rm`, `git mv` (deleted and renamed files); binary files; writes held for review; "you changed it first".
12. The strip of steps is cut around the current step when there are many.
13. State lives in `$.state` and survives a reload of the mod; the sample kept it in module variables.
14. The switch file moved to `~/.claude/claude-mods/switches.json`, read at event time with a one second cache. The sample polled every three seconds with a timer.
15. A log file, a settings screen, `/replay status`, `/replay hide` and `/replay show`.
16. TypeScript and JSX in several modules, with tests, instead of one `.mjs` file.

Not an official Anthropic product. No support or maintenance is implied.
