# Helper Desk

Two things on your screen while Claude works:

1. **A side pane that shows Claude working.** At the top is a card for **this chat**: what Claude is doing right now ("Reading register.tsx", "Running: npm test", "Waiting for you"), whether it is Working, Idle or Waiting, how long the turn has run, how many tools it used, and its last five steps. Below it is one card per **helper** (subagent), then a short **Recent** list of helpers that just finished.
2. **A task bar above the prompt.** It fills as Claude ticks off its to-do list. It shows the job's name, "Tasks 2/4", the percent, the step Claude is on now, and, when something is running, "2 helpers working" with the newest helper's live line (or Claude's own line when there are no helpers).

## What's new in 0.2

- **A permanent "Claude (this chat)" card** at the top of the pane. It updates as Claude works and settles to Idle when the turn is over. Before, you only saw a card while a helper was running, and helpers often finish in seconds.
- **The pane opens by itself much more often**: with the first to-do list or the first helper, once per chat. New setting "Open the side pane by itself" (see Settings).
- **Helper cards are easier to read**: the helper's own description is the title, its agent type is a small tag, and a finished card shows the first line of its result and how long it took. A state is always a dot or tick **and** a word (Working, Done, Stopped), never colour alone.
- **A "Recent" group** keeps the last 10 helpers that finished or stopped, one short row each. "Clear finished" empties it.
- **The task bar says more**: an "N helpers working" chip and a live line, not just a percentage.
- A soft live dot while Claude works, on the desktop. It follows the Animations setting and stops for people who ask for less motion.

## How to use it

Nothing to do. The pane opens with Claude's first to-do list or its first helper. When Claude has a task with a few steps, the bar appears.

- `/helpers` opens the pane (and un-hides the mod if you hid it).
- `/helpers hide` hides the bar and the pane. `/helpers clear` removes finished cards.
- In the pane: click a card's "All N steps" to see every step, click a group heading (Running, Recent, Finished, Stopped) to fold it, click "Show more" for older cards, "Clear finished" to tidy up, "Hide" to hide the mod.
- If you close the pane yourself, it stays closed for that chat. Type `/helpers` to bring it back.
- On the bar, the ✕ hides it until the list changes again.

Where does the bar get its list? From Claude's own to-do tools (`TodoWrite`, `TaskCreate`, `TaskUpdate`) in the main chat. If Claude has none of these, it uses this mod's own `plan` tool. A short note in Claude's instructions and a gentle reminder after a few tool calls ask Claude to keep the list. A subagent's own list is never shown on the bar.

## Settings

Open the plugin's settings (in the desktop app: the plugin list, or `/config` in a terminal).

| Setting | What it does | Default |
| --- | --- | --- |
| Task bar colour | purple, blue, teal, green, orange or pink | purple |
| Animations | Sparkles, the moving crab, the shimmer, the live dot. Off gives a still screen | on |
| Open the side pane by itself (`open_pane`) | **with a task or helper**: open at the first to-do list or the first helper. **with helpers only**: open only at the first helper. **never**: only `/helpers` opens it. It opens at most once per chat. | with a task or helper |
| Ask Claude to keep a to-do list | The system-prompt note and the reminders. Off if you only want the cards | on |
| Pop-ups when a step is done | A short pop-up per finished step | on |
| Seconds to keep a finished bar | How long the bar stays at 100 percent. 0 hides it at once | 20 |

The old on/off setting `auto_open_pane` is still read: if it is present and set to off, the pane never opens by itself, whatever the picker says. Turn it on again by choosing a mode in the picker and removing the old key from your settings.

## What the main card shows

- **Working**: a tool is running or Claude is thinking. The line says which tool and what it acts on. Commands hide obvious secrets (tokens, keys, passwords), as helper cards do.
- **Waiting for you**: Claude asked you a question or a plan to approve, and nothing moves until you answer.
- **Idle**: the turn is over. The card keeps the last steps and says how long the turn took.

## The on/off switch

All of Naish's mods share one file, `~/.claude/claude-mods/switches.json`. Put `"helper-desk": false` in it to switch the mod off: nothing is drawn, no reminders are added, and every tool call and prompt passes through untouched. Remove the line to switch it on. A missing or broken file means on. The file is read at most once a second, when something happens. If you flip the switch while nothing is going on, it takes effect at the next prompt or tool call.

`"helper-desk:hidden": true` (what Hide writes) hides the bar and the pane but keeps the mod running.

## Files it writes

All under `~/.claude/claude-mods/`:

- `logs/helper-desk.log`: one line per event (session start, a helper starting or finishing, the pane opening by itself, plan saved, a switch change, a failure). The last 300 lines are kept. **No prompt text, no task words, no plan steps, no paths, no commands, no helper results.** Only counts and agent types.
- `state/plan-<session id>.json`: the current to-do list, so other tools can read it and so the bar comes back after a reload. It holds the job's title and the step texts. The title defaults to the first words of your prompt when Claude gives none.
- `switches.json`: only when you press Hide (it adds one key, and keeps the others).

## Limits

- The bar follows the **main chat's** to-do list. If Claude never makes one, there is no bar.
- Token counts are work tokens: input, output and cache writes. Cache reads are left out, because they repeat the same prefix on every step and make a small job look huge. So the number is lower than what a bill shows.
- A card keeps a helper's last 200 steps. The desk keeps the newest 60 helpers, and Recent shows the last 10 that ended. The main card keeps the last 8 steps and shows 5.
- **Waiting for you** is shown for questions and plans to approve. A permission prompt ("Allow this command?") is not shown as waiting: Claude Code gives mods no signal for when you answer one, so the card would stay stuck on it.
- A helper's result line is the first line of its final report. If the report starts with a heading or a greeting, that is what shows.
- The main card follows model turns of the main chat. Work the app does by itself outside a turn (such as a compaction) is not shown.
- The desk and the bar start over after `/clear`.
- Commands and results shown in a card hide obvious secrets (tokens, keys, passwords on the command line), but a card is on your own screen only, never in the log.
- The plan tool is added to Claude's tool list only while the mod is on. If you switch it off, the tool stays for the rest of that chat and answers "off".
- Colours of the bar and the crabs are fixed pictures. All words use the app's own text, so they follow light and dark mode.
