# Cache Clock

A countdown above the prompt that shows when this chat's prompt cache goes cold, what that would cost, and a Keep warm button that is off until you press it.

## Why it matters

Claude keeps your chat in a short-lived cache. While the cache is warm, your next message re-reads the whole chat at about 10% of the normal input price. Once it goes cold (5 minutes after the last reply, or 1 hour on some plans), the next message pays to write the whole chat to the cache again: 125% of the input price for a 5 minute cache, 200% for a 1 hour cache. In a big chat that is real money, so it helps to see the clock.

## What you see

- **Warm.** `Cache warm 4:30`, a bar that drains, and where the length comes from. A dim line says how many tokens are in the chat and what replying now or a cold restart would cost.
- **Cold.** `Cache cold since 6 min ago`, and what your next message will cost. The cache also goes cold at once, with the reason, when you change model or compact the chat.
- **Big chat gone cold.** If the chat is at least 150k tokens, a **Hand off to a fresh chat** button shows (see "Handoff seam").
- **Keep warm.** One extra line while it runs: ping number, time to the next ping, what the last ping read, and what the pings have spent so far.

It draws in the desktop app and in the terminal. Colors follow your theme, so they read in light and dark. Nothing is drawn while Claude is working, while a survey is showing, or before the first reply.

## Commands and buttons

| What | Does |
| --- | --- |
| Keep warm button, `/keepwarm` | Turns Keep warm on or off for this chat. `/keepwarm on`, `/keepwarm off`, `/keepwarm status` also work. |
| Hide button, `/cacheclock hide` | Hides the clock in every chat. `/cacheclock show` (or `/cacheclock` again) brings it back. |
| `/cacheclock status` | One line: clock state, cache length, tokens, Keep warm. |
| `/cacheclock demo` | A 60 second cache, for this chat only, so you can film the countdown. `/cacheclock auto` goes back. |

## Keep warm: opt in, capped, visible

Keep warm is off in every chat until you turn it on. It is never on by default and never carries over to another chat.

While it is on, a small background question ("Reply with the single word: ok") is sent about 45 seconds before the cache would go cold. The question goes over the chat's own transcript, so the API reads the chat from its cache and the timer starts again. It is not written into your chat.

Every ping spends tokens (about 10% of the input price for the chat, plus a few output tokens). So:

- It stops by itself after **20 pings** or **90 minutes**, whichever comes first (both are settings).
- It stops when you send a message, hide the clock, change model, compact, or /clear.
- It stops after 3 failed pings in a row, and when a ping finds the cache already gone (for example after the computer slept) instead of paying to write it again.
- The band shows the price of a ping before you turn it on, and the total spent so far while it runs. The log has every ping.
- If you turn it on while the cache is already cold, the button says so ("Write it again and keep warm"): the first ping writes the chat to the cache once.

Keep warm only pays off when you expect to come back within the cache time. For a long break, a fresh chat (or the handoff) is cheaper.

## How the cache length is found

The length (5 minutes or 1 hour) is not something a mod can ask the API for: a model call reports only four token counts. The old version of this mod ran a Python helper script to read it from the chat log. This version needs no helper program. It uses, in this order:

1. **Your setting** `Cache length`, if you set it to 5m or 1h.
2. **The chat log.** After each reply it reads the chat's own log file (the path comes from Claude Code's own hook events) and looks for the latest reply that wrote to the cache: the API reports `ephemeral_1h_input_tokens` or `ephemeral_5m_input_tokens` there. A small log is read directly; a log over 1.5 MB is read with `tail -c 600000` (no shell, no script). Nothing leaves your computer. Turn it off with the `Read the chat log` setting.
3. **Claude Code's own figure**, which it gives when you change model.
4. **What it saw.** A reply after a 7 minute break that still read the chat from cache proves a 1 hour cache. A ping that finds a cold cache long before an hour shows it is a 5 minute one.
5. Otherwise a **5 minute guess**, labelled as a guess.

The line next to the countdown says which of these was used.

A chat you resume starts its clock straight away, from how long ago the last reply was.

## Costs

Estimates, not a bill. The price per million input tokens is, in order: your setting, Claude Code's own figure (known after a model switch), a list-price guess by model family (Opus 5, Sonnet 3, Haiku 1 USD; old Opus 15). For a model it does not know, no dollars are shown: the band says "about 10% of the normal input price, 125% once cold" instead. Long-context surcharges are not included. Set `Show cost estimates` off to hide all of it.

## Settings

Set these in the plugin's settings (the config menu).

| Setting | Default | Meaning |
| --- | --- | --- |
| Cache length | auto | auto, 5m or 1h. |
| Read the chat log to find the cache length | on | Off means the length is a guess unless you set it. |
| Show cost estimates | on | Replying now, a cold restart, Keep warm spend. |
| Input price per million tokens (USD) | 0 | 0 means work it out as above. |
| Big chat size (tokens) | 150000 | A cold chat this big gets the handoff offer. 0 turns the offer off. |
| Handoff command | handoff | The slash command the handoff button runs. |
| Keep warm: most pings | 20 | 1 to 200. |
| Keep warm: most minutes | 90 | 5 to 720. |
| Keep warm: ping this many seconds before cold | 45 | 15 to 120. |

## Handoff seam

This mod does not contain a handoff. It offers one only if another mod provides it:

- It looks for a slash command named by the `Handoff command` setting (default `handoff`) in `$.command.list()`, at most once every 10 seconds and only while the chat is cold and big.
- If the command exists, the **Hand off to a fresh chat** button runs it with `$.command.run({ command: 'handoff', args: '' })` (queued until the session is idle, as if the person typed `/handoff`). A failure is logged and shown as a toast; the band is unaffected.
- If the command does not exist, there is no button and no error: one dim line says a fresh chat would skip the cost and to start one by hand.

To wire the handoff mod in, it only has to register `/handoff` (`$.command.register({ name: 'handoff', ... })`) and answer `command.run` with `{ command: 'handoff' }`, treating empty args as "hand off this chat". To take over the press itself, it can hook `ui.press` with `{ plugin: 'cache-clock', element: 'handoff' }`. It may also read this mod's state with `$.state.get({ plugin: 'cache-clock', key: 'clock' })` (token count, cache length, when the cache went cold). Cache Clock writes no request file for the handoff.

## Conventions

- **On/off.** Off when `~/.claude/claude-mods/switches.json` has `"cache-clock": false`. A missing or broken file means on. Off: every hook just passes through, nothing is drawn, Keep warm stops, and no timer reads the file.
- **Hide flag.** `/cacheclock hide` writes `{"hidden": true}` to `~/.claude/claude-mods/cache-clock.json`, so every chat hides the clock.
- **Log.** `~/.claude/claude-mods/logs/cache-clock.log`, one line per notable event (Keep warm on and off, every ping with its token counts, cache length found, switch changes, failures), the last 300 lines. No prompt text.
- **Fail open.** An error in this mod is logged and skipped. It never blocks, delays or changes a prompt, a turn or a tool call.

## Limits

- The countdown counts from the end of the last reply. The cache really starts from the last request inside it, so the clock can be a few seconds late, never early.
- The 5 minute guess can be wrong until the chat log has been read once; the label says so.
- Keep warm cannot set the question's output budget: if thinking is on, a ping may cost a few more output tokens.
- The clock is per chat. The hide flag and the switch are the only things shared.
- Needs a Claude Code build with function hooks (early access). The cost line for a model switch and the resume clock use Claude Code's `PostModelSwitch` and `SessionStart` events; where a build does not raise them, those two extras simply do not appear.
