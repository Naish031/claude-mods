# Reflect

When you correct Claude ("No, I said never use em dashes"), Reflect offers to save the fix as a lasting rule. It never writes anything on its own.

## How it works

1. You correct Claude. A cheap wording check decides if it looks like a correction (not "thanks", "no problem" or a plain question). Doubtful ones get a quick yes/no check from a small model. Clear ones go straight to a draft.
2. When Claude's turn ends, a band appears above the prompt box: **Save this as a rule?**, the drafted rule (one short imperative line), its category and the folder it was learned in.
3. You choose where it goes:
   - **Save everywhere**: the end of `~/.claude/CLAUDE.md`.
   - **Save to project**: the end of `CLAUDE.md` in the folder this chat runs in. Hidden when the chat runs in your home folder.
   - **Save to vault**: its own note in a rules folder (`rules_folder`, or asked once and remembered).
   - **Edit**: reword the rule first (Enter to use it).
   - **Skip**, or **Not for this chat** (no more offers until `/clear` or `/reflect mute`).
4. A second step shows the **exact text** that will be written and where. Press **Write it** to save, or Back.
5. The saved line has **Open** and **Undo** (20 seconds). `/reflect undo` works any time.

## Safety

- Nothing is written without your button press, and what you see is exactly what is written. If the file changes between the preview and **Write it**, Reflect shows the new text instead of writing.
- `CLAUDE.md` is only appended to. Everything already in it stays byte for byte. The mod adds a heading `## Rules saved by reflect` and a comment marker, once; later rules are added as bullets under it (or under a fresh heading if you wrote more text after it). It refuses to append to a file that ends inside an open code block.
- Before the first write to a file in a chat, a timestamped backup is saved to `~/.claude/claude-mods/backups/reflect/`. If the backup fails, nothing is written.
- Every save is journalled (last 30). Undo removes exactly the text that was added, even if you added more text after it. If you edited the saved text away, it leaves the file alone and says so. Undo of a note or a `CLAUDE.md` Reflect created removes only that file, and only if it is unchanged.
- A rule that looks like it holds a secret (API keys, tokens, private keys, passwords in links, card numbers, long key-like strings) is never offered or saved. Secrets in your correction are cut out before the model sees it and before it goes in a note's "Why" line. This catches known shapes only.
- A `@` at the start of a word is removed from rules, because `CLAUDE.md` reads `@path` as an import of another file.
- Only your own typed (or Remote Control) prompts are looked at. Notifications, scheduled tasks, other sessions, plugin prompts and slash commands are ignored.
- Duplicates are caught: a rule already in the global or project `CLAUDE.md` (including lines saved by other tools in `- rule (added date)` form), in the rules folder, or in the journal is not offered again, and pressing save for one says "Already saved in".

## Not noisy

- A quiet time (default 3 minutes) after each offer. Each offer you skip in a row doubles it (up to 8 times the quiet time).
- A rule you skipped is not offered again in the same chat.
- **Not for this chat** mutes until `/clear`.
- Sensitivity: `careful` (only clear corrections), `normal`, `eager`.

## Commands

| Command | What it does |
| --- | --- |
| `/reflect` | Turn Reflect on or off (kept between chats). `on` and `off` set it. |
| `/reflect status` | Shows the settings, the mute state and the number of undoable saves. |
| `/reflect undo` | Takes out the most recent saved rule. |
| `/reflect list` | The last 5 saved rules. |
| `/reflect add <rule>` | Offers your own words as a rule (no model call). `/reflect add` alone drafts one from your last message. |
| `/reflect mute` | Quiet for this chat, or back on. |
| `/reflect folder` | Forgets the remembered rules folder. `/reflect folder <path>` sets it. |
| `/reflect cooldown <minutes>` | Quiet time, 0 to 240. |
| `/reflect sensitivity <careful\|normal\|eager>` | How eagerly to offer. |
| `/reflect project <on\|off>` | Show or hide Save to project. |

The `/reflect cooldown`, `sensitivity`, `project` and `folder` choices are kept in the mod's store and win over the settings below, so they take effect without a reload.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Rules folder (`rules_folder`) | empty | Where Save to vault writes. Empty: asked once, answer remembered. Must be a full path or start with `~`, and not the home folder or inside `~/.claude`. |
| Offer Save to project | on | The project button. |
| How eagerly to offer | normal | careful, normal, eager. |
| Quiet time between offers | 3 | Minutes. |
| Model | sonnet | Drafts the rule. |
| Plain dashes | on | Long dashes become commas in the rule. |

## Vault notes

`<rules folder>/<slug>.md` (a taken name gets `-2`, `-3`, ...). Never overwrites a file.

```
---
type: rule
status: active
date: 2026-10-15
category: writing
learned_in: "my-project"
source: correction in a Claude Code chat
tags: [rule, writing, newsletters]
---

# Never use em dashes in newsletter copy

Never use em dashes in newsletter copy.

Why: "No, I said never use em dashes."
```

Categories: writing, code, style, process, tools, communication, other.

## On/off switch and log

Off when `~/.claude/claude-mods/switches.json` has `"reflect": false` (read when something happens, cached 1 second). Off means: nothing drawn, nothing drafted, presses ignored. A missing or broken file means on.

Log: `~/.claude/claude-mods/logs/reflect.log`, one line per event, last 300 lines. It never holds your words, rules or file names.

## Limits

- Detection is wording-based plus a model check, so it misses corrections phrased without any of the usual words. `/reflect add` covers those.
- Wording hints are English.
- Undo history is the last 30 saves.
- "Save to vault" and "Open" use `open` (macOS) or `xdg-open`.
- The test kit in Claude Code 2.1.283 ignores setting values; 2.1.309 applies them.
