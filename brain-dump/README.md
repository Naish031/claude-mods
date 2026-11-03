# Brain Dump

You dictate a long, rambling prompt. Brain Dump tidies it into a clear, structured prompt before Claude sees it.

## What happens

1. **Under 40 words:** sent as typed.
2. **Longer:** a quick read looks for real gaps and clashes (two instructions that disagree, or a must-know fact that is missing). If it finds any, it asks up to 3 multiple-choice questions, one at a time. Type under **Other** for your own answer. Dismissing a question skips it.
3. The prompt is rewritten into a short structure. Your names, paths, links, numbers and code are kept exactly. Nothing is invented.
4. **The result goes into your prompt box.** Read it, edit it, press Enter to send. (Settings below can show a dialog or send straight away instead.) The transcript notes that the brief is waiting in the box; your original is not sent.
5. **Pressing Enter on the brief sends it as it is.** A brief always starts with `## Goal`, and Brain Dump also recognises its own briefs by their headings and by a short memory of what it wrote, so a brief you edited a little is never rewritten again.

## Commands

| Command | Does |
| --- | --- |
| `/braindump` | Turns Brain Dump on or off |
| `/braindump undo` | Puts your original text back in the prompt box |
| `/braindump status` | Shows the current state and settings |
| `/braindump delivery review` or `confirm` or `auto` | Box, dialog, or send straight away |
| `/braindump format standard` or `four-part` | Choose the prompt layout |

End a prompt with `!!` to send it exactly as typed.

## Settings

Shortest dump (default 40 words), prompt format, delivery, model (default `sonnet`), plain dashes. The `/braindump delivery` and `/braindump format` commands win over the settings screen.

- **standard:** Goal, Context, Requirements, Constraints, Done when.
- **four-part:** THE JOB, THE WHY, THE GUARDRAILS, DONE MEANS. A part with nothing in it says "unknown: ask me".

## Good to know

- It never touches slash commands, scheduled tasks, other sessions or headless runs.
- If anything fails, your original text is sent as typed.
- Each long prompt costs one or two small model calls through your own session.
- Turn it off for every chat in the shared switch file `~/.claude/claude-mods/switches.json` with `{"brain-dump": false}`.
- Log: `~/.claude/claude-mods/logs/brain-dump.log` (times and counts, never your text).
