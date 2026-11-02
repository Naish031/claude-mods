# claude-mods

Nine mods for Claude Code. A mod changes what you see or adds a helper while you work.

| Mod | What it does | Opens with |
| --- | --- | --- |
| [brain-dump](brain-dump) | Turns a long, rambling voice dump into a clear, structured prompt before it is sent | `/braindump` |
| [helper-desk](helper-desk) | Task progress bar above the prompt, plus a pane with one live card per subagent | `/helpers` |
| [cache-clock](cache-clock) | Countdown until the chat's prompt cache goes cold, with capped Keep warm | `/cacheclock` |
| [handoff](handoff) | Writes a handoff of a very long chat and starts a fresh chat with it | `/handoff` |
| [reflect](reflect) | Offers to save a correction as a lasting rule, with preview and undo | `/reflect` |
| [chat-inventory](chat-inventory) | Pane listing the to-do list, connectors, files and skills this chat used | `/inventory` |
| [screen-share](screen-share) | Hides names, emails, phones, amounts and secrets on screen while recording | `/screen-share` |
| [replay-theater](replay-theater) | Steps through Claude's file edits, one diff at a time | `/replay` |
| [mods](mods) | Switchboard to turn each mod on or off | `/mods` |

Each folder has its own README with what it does, its settings and its limits.

## Install

From a shell, add the marketplace once, then install the mods you want:

```
claude plugin marketplace add Naish031/claude-mods
```

```
claude plugin install brain-dump@claude-mods
```

Repeat the second command for each mod: `brain-dump`, `helper-desk`, `cache-clock`, `handoff`, `reflect`, `chat-inventory`, `screen-share`, `replay-theater`, `mods`. Then open a new chat, or run `/reload-plugins` in one that is already open.

From a Claude Code terminal session you can type the same thing as `/plugin install brain-dump --marketplace Naish031/claude-mods`. In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Naish031/claude-mods`, then **Add plugin**.

Needs Claude Code 2.1.309 or newer (screen-share will not load on older builds). Working from a local copy instead? Use its folder path in place of `Naish031/claude-mods`.

## How the mods fit together

- **One switch file.** `~/.claude/claude-mods/switches.json` turns any mod off with `{"<mod>": false}`. The `mods` switchboard writes it safely.
- **One log folder.** `~/.claude/claude-mods/logs/<mod>.log`, bounded, with no prompt text.
- **Fail open.** If a mod breaks, your prompts and tool calls still go through untouched.
- **`mod.json`** at each mod's root tells the switchboard its title, its pane command and whether it can hide or switch.
- **cache-clock and handoff** are linked: when a big chat goes cold, cache-clock offers `/handoff`.

## Licence

Everything here is original except `replay-theater`, which is derived from Anthropic's Claude Code DevRel sample under the Apache License 2.0 (see its `LICENSE` and `NOTICE`).
