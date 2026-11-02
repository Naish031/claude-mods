# Chat Inventory

A side pane called **In this chat**. It shows what this chat has used, so you can see at a glance what Claude touched.

## What it shows

| Section | What is in it |
| --- | --- |
| **To-do** | Claude's to-do list for the chat, with a mark for each step: done, now, or later. Shows "2 of 5". Long steps wrap. A list of more than 12 steps hides finished steps until you press "Show done". |
| **Connectors** | Every connector Claude used, newest first, with its call count and any failed calls. Press a name to open it: a count per tool, then each call (what it did, the main argument, the time). |
| **Context files** | Files Claude read, plus files it changed (tagged "changed") and the memory files loaded at the start (tagged "auto"). A line shows how many were read. |
| **Skills** | Skills used, with a use count. Skills loaded at the start show "always loaded". |

A connector is any MCP server (a tool named `mcp__<server>__<tool>`), such as Shopify, Figma, Notion, Slack, Gmail, Google Drive, Google Calendar, GitHub, GitBot, Claude in Chrome or the Browser pane. Command line tools Claude runs in Bash also count: `gh`, `shopify`, `gws`, `vercel`, `netlify`, `supabase`, `stripe`, `wrangler`, `firecrawl`, `gitbot`. They are tagged "via CLI".

On the desktop app each connector gets a small letter tile. In the terminal each one is a plain row.

Counts are for this chat only. A `/clear` starts them again from zero. A resumed chat is counted from its history, once.

## How to use it

- The pane opens by itself the first time the chat uses a tool, a file or a skill.
- `/inventory` opens it any time.
- Press a section title to fold or unfold it. Long lists show 10 rows; use **Up** and **Down**.
- **Copy** puts the whole list on your clipboard as plain text. `/inventory copy` does the same.
- **Hide** (or `/inventory hide`) closes the pane and stops it opening by itself. `/inventory` brings it back.

## Settings

Set these in the mod's settings (the `/config` menu or the desktop app's plugin settings).

| Setting | What it does | Default |
| --- | --- | --- |
| Open by itself | Open the pane the first time the chat uses something. | on |
| Hide these connectors | Connector names to leave out, separated by commas. | none |
| Extra command line tools | `command=Name` pairs for more tools to count, for example `aws=AWS, firecrawl=Firecrawl`. | none |

## Turn it off

Put `"chat-inventory": false` in `~/.claude/claude-mods/switches.json`. Every hook then does nothing and the pane closes at the next action in the chat. Remove the line (or set it to `true`) to turn it back on. A missing or broken file means on. The pane's Hide button adds `"chat-inventory:hidden": true` to the same file and keeps your other lines.

## Log

`~/.claude/claude-mods/logs/chat-inventory.log` gets one line for each notable event or failure (hidden, copied, reset, an error). It never holds prompts, queries or file contents. The newest 300 lines are kept.

## Limits

- It only watches. It never changes a tool call, a prompt or a result, and any failure inside it is skipped.
- A helper (subagent) does not change the to-do list. Its calls do count, tagged "helper".
- Connector names come from the app's own server names when it reports them. A claude.ai connector whose name cannot be told is shown as "Connector 1", "Connector 2", and so on.
- Call times of an old chat are read from its saved transcript, so they stay blank when that file is over 4 MB.
- At most 200 calls per connector and 500 files are kept. Counts keep going past that.
- Copy needs a clipboard the app can reach. If it cannot, the list is printed in the chat instead so you can select it.
- A shared plan file from another mod is read from `~/.claude/claude-mods/plans/plan-<chat id>.json` (or the older `~/.claude/mods-state/` folder).
- No network. Nothing leaves your machine.

## Check it

```
claude plugin validate chat-inventory
claude plugin test chat-inventory
```
