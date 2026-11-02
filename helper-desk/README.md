# Helper Desk

Two things on your screen while Claude works:

1. **A task bar above the prompt.** It fills as Claude ticks off its to-do list. It shows the job's name, "Tasks 2/4", the percent, and the step Claude is on now.
2. **A side pane with one card per subagent.** Each card has a small crab in its own colour, what the subagent is doing right now, how long it has run, how many tokens it used, and a progress bar. Cards are grouped as Running, Finished and Stopped.

## How to use it

Nothing to do. When Claude has a task with a few steps, the bar appears. When Claude starts a subagent, the pane opens.

- `/helpers` opens the pane (and un-hides the mod if you hid it).
- `/helpers hide` hides the bar and the pane. `/helpers clear` removes finished cards.
- In the pane: click a card's "All N steps" to see every step, click a group heading to fold it, click "Show more" for older cards, "Clear finished" to tidy up, "Hide" to hide the mod.
- On the bar, the ✕ hides it until the list changes again.

Where does the bar get its list? From Claude's own to-do tools (`TodoWrite`, `TaskCreate`, `TaskUpdate`) in the main chat. If Claude has none of these, it uses this mod's own `plan` tool. A short note in Claude's instructions and a gentle reminder after a few tool calls ask Claude to keep the list. A subagent's own list is never shown on the bar.

## Settings

Open the plugin's settings (in the desktop app: the plugin list, or `/config` in a terminal).

| Setting | What it does | Default |
| --- | --- | --- |
| Task bar colour | purple, blue, teal, green, orange or pink | purple |
| Animations | Sparkles, the moving crab, the shimmer. Off gives a still screen | on |
| Open the side pane by itself | Open the pane when the first subagent starts | on |
| Ask Claude to keep a to-do list | The system-prompt note and the reminders. Off if you only want the cards | on |
| Pop-ups when a step is done | A short pop-up per finished step | on |
| Seconds to keep a finished bar | How long the bar stays at 100 percent. 0 hides it at once | 20 |

## The on/off switch

All of Naish's mods share one file, `~/.claude/claude-mods/switches.json`. Put `"helper-desk": false` in it to switch the mod off: nothing is drawn, no reminders are added, and every tool call and prompt passes through untouched. Remove the line to switch it on. A missing or broken file means on. The file is read at most once a second, when something happens. If you flip the switch while nothing is going on, it takes effect at the next prompt or tool call.

`"helper-desk:hidden": true` (what Hide writes) hides the bar and the pane but keeps the mod running.

## Files it writes

All under `~/.claude/claude-mods/`:

- `logs/helper-desk.log`: one line per event (session start, a helper starting or finishing, plan saved, a switch change, a failure). The last 300 lines are kept. **No prompt text, no task words, no plan steps.** Only counts and agent types.
- `state/plan-<session id>.json`: the current to-do list, so other tools can read it and so the bar comes back after a reload. It holds the job's title and the step texts. The title defaults to the first words of your prompt when Claude gives none.
- `switches.json`: only when you press Hide (it adds one key, and keeps the others).

## Limits

- The bar follows the **main chat's** to-do list. If Claude never makes one, there is no bar.
- Token counts are work tokens: input, output and cache writes. Cache reads are left out, because they repeat the same prefix on every step and make a small job look huge. So the number is lower than what a bill shows.
- A card keeps a helper's last 200 steps. The desk keeps the newest 60 helpers.
- The desk and the bar start over after `/clear`.
- Commands shown in a card hide obvious secrets (tokens, keys, passwords on the command line), but a card is on your own screen only, never in the log.
- The plan tool is added to Claude's tool list only while the mod is on. If you switch it off, the tool stays for the rest of that chat and answers "off".
- Colours of the bar and the crabs are fixed pictures. All words use the app's own text, so they follow light and dark mode.
