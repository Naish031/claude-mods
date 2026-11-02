# Mods

The switchboard for your mods. `/mods` opens a pane that finds every mod on this Mac, turns each one on or off in every chat, hides or shows the ones that draw something, and opens the side-pane ones.

## Using it

- `/mods` opens the pane. `/mods list` prints the same list as text. `/mods off <mod>` and `/mods on <mod>` switch one without the pane.
- Each row shows the mod's name, what it does, its slash commands, its version, and where it stands: **Loaded** (this chat shows signs of running it), **Installed, not seen loaded**, **Disabled in Claude Code**, or **On disk, not installed**.
- **On / Off** works in every chat. **Shown / Hidden** keeps a mod on but out of sight (only for mods that support it). **Open** opens a side pane.
- **All on** and **All off** change every mod that has a switch (never this one). **Undo** puts back the last change, and leaves alone any key someone else changed since.
- With six mods or more there is a filter box. A press leaves a short note under the list; it goes after 90 seconds.
- The pane redraws by itself when another chat changes a switch (within 3 seconds) and when a mod appears or goes (within 9 seconds). While it is closed, nothing runs.

Turning this mod itself off asks you to press Off twice. When it is off, the pane shows only a "Turn Mods back on" button, `/mods` says it is off, and nothing is blocked at load.

## Where it looks

Your mod folders (setting below), the folder this mod sits in, `CLAUDE_CODE_PLUGIN_DIRS`, `~/.claude/mods/`, `~/.claude/dev-mods/<chat id>/` (this chat's own mods, then up to 20 other chats'), plugins installed from marketplaces (read from `~/.claude/plugins/installed_plugins.json`, with the on or off state from your plugin settings), and every module the engine admitted after this mod. A folder counts as a mod only if it has `.claude-plugin/plugin.json` and a `hooks/hooks.json` with `"modules"`. The Claude Code API has no call that lists loaded plugins, so "Loaded" is worked out from the commands and settings rows the engine reports and the modules it admitted; a mod with none of those shows as "Installed".

**Setting: Folders that hold your mods.** Default `~/Documents/Claude/claude-mods`. Colon-separated; one folder per mod inside each; `~` is your home.

## The switch file

All of Naish's mods share `~/.claude/claude-mods/switches.json`. This mod is the one that writes it.

| Key | Means |
| --- | --- |
| `"<mod>": false` | The mod is off in every chat. No key means on. |
| `"<mod>:hidden": true` | The mod stays on but hides its band or pane. |
| `"<mod>:block": true` | This mod's own key: do not load a mod that has no switch (see below). |

Mods read the file when something happens, with about a one-second cache, so a change reaches a mod at its next event.

Every write reads the whole file, changes only the keys it means to change, writes a temporary file, renames it over the old one, and reads it back. If that fails, the old file stays. Unknown keys are kept. A missing file is created (and its folder). An empty file counts as `{}`. A file that is not a JSON object is saved next to itself as `switches.json.bad-<time>` before a new one is started, and the pane says so. A file that cannot be read is never overwritten. One change runs at a time inside a chat. Two chats changing the file in the same instant could still lose one change, which is why Undo checks before it restores.

## Mods that do not have a switch

A mod that never reads `switches.json` cannot be turned off live. The pane says so on its row. The one supported way to stop such a mod is to refuse it when the engine admits it, which this mod does (the `plugin.register` event). So the button for those rows is **Block** (shown as "Blocked"):

- It writes `"<mod>:block": true` and takes effect the next time the mod loads: a new chat or a restart. `/reload-plugins` may keep a mod it already loaded, so do not count on it.
- Only mods at the normal user tier are refused. A managed (organization) mod, a built-in and this mod are never refused. If anything fails while checking, the mod loads.
- This mod only sees modules admitted after it. If another mod is admitted first, Block cannot stop it. (See Check live below.)
- Claude Code's own plugin on/off setting is read-only from a mod. The pane shows "Disabled in Claude Code" and points to `/plugin`.

## How other mods work with this one

A mod needs nothing to be listed. To be listed well, add a small file named **`mod.json`** at the mod's root (next to `.claude-plugin/`, not inside it). It is optional and every field is optional:

```json
{
  "title": "Helper Desk",
  "pane": "helpers",
  "hide": true,
  "switch": true
}
```

| Field | Meaning |
| --- | --- |
| `title` | The name on the row. Default: the plugin name with capitals. |
| `pane` | The slash command that opens the mod's side pane, without the slash. An argument may follow (`"helpers open"`). The Open button runs it. `false` says the mod has no pane. |
| `hide` | The mod understands `"<mod>:hidden": true`. Shows the Shown / Hidden button. |
| `switch` | `true`: the mod reads `"<mod>": false`. `false`: it does not, so only Block is offered. |

Why a separate file: `claude plugin validate --strict` fails on unknown fields in `plugin.json`. The same four fields are read from `plugin.json` too, and `mod.json` wins when both exist, but that costs a validate warning.

When there is no `mod.json`, the pane reads the mod's `hooks/*.ts*` source (comment lines left out):

- the text `switches.json` means it has a switch;
- the text `:hidden` means it can hide;
- `$.ui.open(` plus a `component: 'Pane'` render hook means it draws a pane, and its first `$.command.register` name is taken as the command that opens it;
- the text `.open-` means it polls for an open-request file, `~/.claude/claude-mods/.open-<mod>-<chat id>` (an empty file). The Open and Show buttons leave one when there is no command to run.

Reading source is a guess; `mod.json` is the answer.

Open runs the command with `$.command.run`, as if you typed it, so its line shows in the transcript, and it runs when the chat is idle. Request files that nobody picked up (empty, older than 6 hours) are removed when `/mods` opens.

## Log

`~/.claude/claude-mods/logs/mods.log`: one line per event (open, on, off, hide, show, open a pane, block, undo, a scan, a failure). The last 300 lines are kept. It holds mod names and counts only, never prompt text.

## Good to know

- Nothing here ever blocks or changes your prompts or tool calls. If a part fails, it is logged and skipped.
- The list of what is "Loaded" and the record of what was blocked live in this mod's memory, so a hot reload of this mod starts them over.
- Version 0.1.0. The test kit checks the logic on the desktop and terminal surfaces, not the paint. The checks below need a real session.

## Check live

1. `/mods` on the desktop and in a terminal: the rows draw, Off and On flip, and a mod that reads the file reacts within a second or two.
2. Open on Helper Desk and Chat Inventory runs `/helpers` and `/inventory`.
3. Block a mod with no switch, start a new chat, and check it did not load (`/mods list` shows it, and its command is gone). Then check whether a mod loaded before this one can be blocked at all.
4. With the pane open, change a switch by hand in `switches.json`: the pane follows within 3 seconds.
5. Press Off twice on this mod, then use "Turn Mods back on".
