# Handoff

When a chat gets very long, Handoff writes a short "handoff" of the whole chat and helps you start a fresh chat with it. You keep the goal, the rules you set, the files to open and the next steps, without paying to re-read a huge chat.

## How it works

1. **The offer.** When the chat reaches 250k tokens (you can change this), a line appears above the prompt: Refresh, Not now, Turn off.
2. **The steps.** Press Refresh. Five steps show with progress bars: reading the chat, finding the files you used, listing skills, tools and links, writing the handoff, saving and checking.
3. **The result.** When it is ready you can:
   - **Copy handoff prompt**: puts it on your clipboard.
   - **Start new chat with it**: opens a new chat with the handoff filled in. Press Return there to start it.
   - **Preview**: shows the first lines, so you can check it.
   - **Open file**: opens the saved file.
   - **Close**: puts the panel away.

If a step fails, you are never left with nothing. A plain draft (built without the model) is saved first. The panel then offers Try again, Copy draft, Start new chat with draft and Open draft.

## Commands

| Command | What it does |
| --- | --- |
| `/handoff` | Writes a handoff now. |
| `/handoff <words>` | Same, with a focus, for example `/handoff focus on the checkout bug`. |
| `/handoff last` | Brings back the last saved handoff (from any chat) with its buttons. Useful after `/clear` or after closing the panel. |
| `/refresh` | Shows the Refresh panel now, at any chat size. It also turns the automatic offer back on. |

Claude can also start it: if you say "hand this off" or "move this to a new chat", it uses its `refresh` tool. The handoff starts when its turn ends.

## Settings (`/config`, under this mod)

| Setting | Default | What it does |
| --- | --- | --- |
| Offer a handoff automatically | on | Turn off to use only `/handoff` and `/refresh`. The "Turn off" button sets this. |
| Offer at (tokens) | 250000 | The chat size that triggers the offer. It is capped at 80% of the model's window, so a small window still gets the offer. |
| Ask again after (tokens) | 100000 | After Not now or Close, ask again once the chat has grown by this much. A compaction or `/clear` resets it. |
| Handoff length (words) | 1500 | The most words the handoff should have. |
| Extra rules for every handoff | empty | One or two sentences added to every request. |
| Save handoffs in | `~/.claude/handoffs` | Where handoffs are saved. |
| New chat opens in the same folder | on | Used by the app link. |
| Use Claude Pet when it is running | on | If Claude Pet is running, it starts the new chat instead of the app link. |
| Fallback model | sonnet | Used only when the chat cannot be reused (see Limits). |

## On/off switch

Handoff is off when `~/.claude/claude-mods/switches.json` contains `"handoff": false`. A missing or broken file means on. When it is off, nothing is drawn, the commands and the tool say it is off, and a handoff in progress stops. The file is read when something happens (cached for 1 second), not on a timer.

## Where things are saved

- Handoffs: `~/.claude/handoffs/<date>-<title>.md` (or your chosen folder). Drafts end in `-draft.md`. The folder and the files are readable only by you.
- Log: `~/.claude/claude-mods/logs/handoff.log`, one line per event (start, ok, failed, cancelled, copy, new chat). It holds counts, times, short chat ids and the saved file's name, which comes from the handoff's title. It never holds the chat text. It moves to `handoff.log.1` past 512 KB.

The handoff and the draft **do** hold content from your chat. Anything shaped like a secret (API keys, tokens, passwords in links, private keys) is cut out before saving and shown as `<secret removed>`. The panel tells you how many were removed. This catches known shapes only: read a handoff before you share it.

## Working with other mods

- **Cache Clock** can ask for a handoff by creating `~/.claude/handoffs/.request-<chat id>` (the old way) or `~/.claude/claude-mods/requests/handoff-<chat id>`. It can also run `/handoff`. Handoff picks the file up within 5 seconds, deletes it, and starts.
- A switchboard can show the offer by creating `~/.claude/claude-mods/requests/handoff-show-<chat id>` (or the old `~/.claude/mods/.open-handoff-<chat id>`).

## Limits

- **One timer.** Every 5 seconds Handoff looks for the request files above and checks the chat size. When it is switched off, the timer does almost nothing.
- **Mid-turn.** A handoff asked for during a turn waits until the turn ends. The panel says "queued".
- **Long chats.** Claude Code gives the mod the newest 4,096 messages. A longer chat is summarised from those, and the draft says so.
- **A chat that cannot be reused.** The handoff is normally written by asking the model about the chat it already has, which is cheap because it is cached. Right after a resume or `/clear` that is not possible. Handoff then sends a trimmed copy of the chat to the fallback model, and says "from a trimmed copy" on the writing row.
- **Busy model.** A busy or dropped model call is tried once more after 3 seconds.
- **Long handoffs and the app link.** The Claude app cuts the text of a link at about 14,000 characters (the version checked). A longer handoff is not sent in the link: the new chat is told to read the saved file instead.
- **No app, no new chat.** "Start new chat" needs the Claude app (or Claude Pet). In a plain terminal with no app, it copies the handoff and tells you to run `/clear` and paste.
- **Cancel.** Cancel stops the panel. The model call itself cannot be cut once it started; if it finishes anyway, the handoff is saved and a toast tells you where.
- **macOS first.** Copy and open use the system's own tools (`pbcopy` and `open` on a Mac; `wl-copy`, `xclip` or `xdg-open` on Linux; `clip` and `start` on Windows). Only the Mac has been exercised.
