# Screen Share

`/screen-share` hides emails, phone numbers, money amounts, names, API keys, card numbers and your user name on screen while you record or present. **Claude still reads the real data.** Only the drawing changes.

## The promise, and its limits

- **Display only.** The chat, your prompts, tool inputs and results, and what Claude reads are never touched. The mod has no hook on prompts, tool calls or the chat history. It only changes how rows are drawn. (It does hide the dim prompt suggestion while on, see Settings, because Tab would write it into your box.)
- **Fails closed on screen.** If hiding a row throws, the row is drawn as a placeholder (`▒▒▒▒▒▒ hidden by screen share`), never as raw text. A failing band keeps its "SCREEN SHARE ON" line and drops other mods' bands. A failing toast is a placeholder too. Each failure is one line in the log, with no data in it.
- **It is a screen filter, not a vault.** It cannot hide what the engine does not let a mod change. Read **What it cannot hide** below before you record.

## Use it

| Command | Does |
| --- | --- |
| `/screen-share` | Turns it on or off |
| `/screen-share on`, `off`, `status` | Same, explicit. `status` says what is hidden and never prints your words. |
| `/screen-share peek [seconds]` | Shows the real text for a few seconds (default 10, most 120), then hides again. `hide` ends it early. |
| `/screen-share add <words>` | Always hide these words or names (also `mask`). Separate several with commas. |
| `/screen-share remove <words>` | Stop hiding them (also `unmask`). |
| `/screen-share allow <words>` | Never hide these by the automatic rules. `unallow` undoes it. |
| `/screen-share words` | How many words are listed (they are not printed). |
| `/screen-share style bar\|partial\|label` | How hidden text looks. |
| `/screen-share names off\|context\|smart` | How names are found. |
| `/screen-share cat <email\|phone\|amount\|name\|secret\|number\|path\|address> on\|off` | One kind on or off. |
| `/screen-share test` | A sample line, hidden with your settings. |
| `/screen-share reset` | Clears style, names and category overrides. |

It works at once, also while Claude is busy.

**You cannot forget it is on.** While it is on you see: a band above the prompt (`● SCREEN SHARE ON`, with **Peek** and **Turn off** buttons), the status line `Screen share ON`, and a `screen share ON` label at the right of the prompt footer. While peeking, the band turns red and counts down, and the status line and footer label say peeking.

It is remembered per machine, across chats: if it was on, a new chat starts on. Turn on before you start recording, off when you stop.

### Two different "off"s

- **Screen share OFF** is what you toggle with `/screen-share`. The mod is loaded and ready, nothing is hidden.
- **The switch file** `~/.claude/claude-mods/switches.json` with `{"screen-share": false}` turns the whole mod off in every chat (the shared switch of all the claude-mods). Then nothing is hidden **even if screen share was on**. When the file flips while it was on, you get a toast saying nothing is hidden, the band and the status line go, and `/screen-share status` says why. The file is read at draw time (cached for 1 s) and every 2 s. A missing or broken file means the mod is on.

## What is hidden

| Kind | Examples | How it is found |
| --- | --- | --- |
| **email** | `jane.doe+x@acme.co.uk`, `José@café.com`, an email inside a link | Shape. Not hidden: `git@github.com:me/repo`, `react@18.3.1`, `logo@2x.png`, `@scope/pkg`. |
| **phone** | `+44 7700 900123`, `(415) 555-0132`, `07700 900123`, `98765 43210`, `+49 30 12345678`, `06 12 34 56 78` | A phone shape that passes checks. A bare run of digits is a phone only in a clear national shape or after a word like "call" or "phone". Not hidden: dates, versions, IPs, years, order numbers, SKUs, timestamps, lists like `10 20 30 40 50`. |
| **amount** | `$4,250.00`, `£900`, `€12k`, `₹1.2 lakh`, `1.234,56 €`, `USD 300`, `12 dollars`, `"total_price": "129.00"`, `total: 1,200.00` | A currency sign, code or word beside a number, or a plain number after a word like total, price or balance (only with cents, thousands separators or 4+ digits, and no unit like "files"). Not hidden: `182k tokens`, `12 files`, `2026`, `v2.1.309`, `$1` in a shell script. |
| **name** | `Jane Doe <jane@x.com>`, `From: Jane Doe`, `Hi Jane`, `Dr Smith`, `"first_name": "Ravi"`, `Sarah Connor` | See **Names**. |
| **secret** | `sk-ant-…`, `ghp_…`, `AKIA…`, `shpat_…`, JWTs, private key blocks, `Bearer …`, `password: …`, `API_KEY=…`, `?token=…`, `user:pass@host` | Token shapes, and the value after a key name. Not hidden: `max_tokens=4000`, `password: ******`, `secret=${SECRET}`, git hashes. |
| **number** | Card numbers that pass their checksum, IBANs (checksum), SSN-style `123-45-6789`, Aadhaar-style, UK NINO | Checksums, so an order number or timestamp is not hidden. |
| **path** | `/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\` | The account name only. |
| **address** | `12 High Street`, `SW1A 1AA`, `Springfield, IL 62704`, fields named `address`, `zip` | Street shape, UK postcode, US city line, field names. |
| **your words** | Anything on the always-mask list | See **Your words**. |

Fields named like private data (`email`, `phone`, `first_name`, `address1`, `password`…) have their value hidden whole inside tool results, whatever it looks like. A value that is a type or a template slot (`address: string`, `{{zip}}`) is left alone.

While a reply is still streaming, a half-written email, key or `+44 …` number at the very end is hidden until it is whole. The last word of a streaming reply can flash for a moment before it is recognised as a name.

### Names

- `smart` (default): everything in `context`, plus two capitalised words where the first is a common given name (`Sarah Connor`, `Alex Johnson`). A given name that is also an everyday word (Will, Mark, Rose, Mason) counts only before a common surname (`Will Smith`).
- `context`: only where the text says it is a person: next to an email, in a From/To/Name/Customer/Assigned to line, after Hi/Dear/Thanks, after Mr/Dr/Prof, in a sign-off, after "my name is", in `first_name`-style fields.
- `off`: never.

Colours, products and places (`Forest Green`, `Mason Jar`, `New York`, `Visual Studio Code`) and company words (`Platform Team`) are not names. The name list is limited: a rare name in plain prose is missed. Put it on the always-mask list.

### Your words

Names, clients, project code names:

- `/screen-share add Acme Corp, Project Falcon` writes them to `~/.claude/claude-mods/screen-share.json` (`{"mask": [...], "allow": [...]}`). Edit that file by hand any time; changes are picked up within 2 s, in every chat.
- Or use the settings screen: **Always hide these words** and **Never hide these words**.
- Matching ignores case, whole words only (`Globex` is not found inside `Globexes`), and a phrase also matches with `.`, `_` or `-` between its words (`acme corp` finds `acme-corp` and `ACME_CORP`).
- Never-hide entries stop the automatic rules. `@mycompany.com` allows a whole email domain. **Always-hide wins** when a word is on both lists.
- Your account name (from your home folder) is hidden everywhere, not only in paths, unless it is an ordinary word like `test` or `admin`.

Careful: the command you type is in your prompt box, your prompt history (↑) and the chat while you type it, and it is in the chat the model reads. Add sensitive words before you start recording, or edit the file by hand. `add` never prints the word back.

### Looks

- `bar`: `▒▒▒▒ ▒▒▒ <▒▒▒▒▒▒▒▒▒▒>`, as long as what it hides, so lines keep their length. The character is a setting (`▒ █ ▓ ░ • *`). The bars fade in light for 150 ms when you turn it on.
- `partial`: `J*** D*** <j***@x***.com>`, `+** **** ****23`, `$*,***.**`, `**** **** **** 1111`, `sk-********`.
- `label`: `[name] <[email]>`, `[phone]`, `[amount]`, `[number]`, `[secret]`, `[user]`, `[address]`, `[hidden]`.

## Where it hides

Your messages, Claude's replies, tool rows and their results (inputs, outputs, errors), folded tool groups, command output, the info line on the terminal, the spinner words (the desktop shows file names there), the question dialog's questions and option descriptions, other mods' panes and the band above the prompt (their text is walked, their layout is left alone), and text other mods put on screen through toasts, log lines, notices, the status line and native notifications. It also hides the dim prompt suggestion.

## What it cannot hide

Honest list for this build (Claude Code 2.1.309):

- **The prompt box.** What you type is the same text that is sent, so hiding it there would change your prompt. Typing a name, email or `/screen-share add <word>` shows it as you type. Prompt history (↑) recall shows it too.
- **The OS window title and tab titles**, **the desktop sidebar** (chat titles and previews), **the browser pane** and anything drawn by another app.
- **Images and screenshots** inside tool results or attachments (it hides text, not pixels), and PDFs or pages a viewer draws.
- **Claude's thinking** (no drawing hook exists for it). Keep it collapsed.
- **Permission and approval dialogs**, file diff dialogs, the login header and logo (account email, organisation, folder), the typeahead rows for `/commands` and `@files`, and the engine's own toasts and footer. A mod can only reach the components in the list above.
- **Option labels in the question dialog.** The label is what the answer carries, so it is left alone. Questions and descriptions are hidden.
- **Other mods' drawing that is not text** (custom `Client` drawings, button labels). A Button's label is its address when it has no key, so it is not changed.
- **Text that is not recognised.** Detection is rules, not understanding. Missed: spelled-out amounts ("four thousand dollars"), obfuscated emails ("jane at acme dot com"), a plain number with no sign or word (`price 45`), rare or non-Latin names in plain prose, a phone with unusual grouping, an ID that is not a checksummed card or IBAN. Put sure things on the always-mask list.
- **A row the engine refuses.** If the engine refuses a rewritten row (for example a tool result that no longer fits its tool's schema) it draws its own row, with the real text. The debug log says so (`claude --debug`, a line with `ui.render ... refused`). Check your tools once before you record.
- **Everything outside Claude Code**: terminal scrollback and title, the recording tool's own overlays, the clipboard if you copy before it hid.

## Settings (`/config`, under this mod)

How hidden text looks, Bar character, Names, Always hide these words, Never hide these words, one switch per kind (emails, phones, amounts, names, keys and tokens, card and ID numbers, user name in paths, street addresses), Hide this computer's user name everywhere, Also hide in other mods' panels and bands, Hide the prompt box suggestion, Peek length (default 10 s), Fade bars in. The commands `style`, `names` and `cat` are kept per machine and win over the settings screen until `/screen-share reset`.

## Performance

A row is hidden once per setting and the answer is kept (4 MB of text at most), so scrolling and redraws do not scan again. A megabyte of text takes under a second the first time. Rows read the mode from `$.state`, so a switch redraws exactly the rows that drew with it. A 2 s poll reads two small files.

## Log

`~/.claude/claude-mods/logs/screen-share.log`: when it turned on or off and how, a peek, a changed words file, a switch-file flip, and any row that failed and was drawn as a placeholder. Times and counts only: never prompt text, never a hidden value. Capped at 100 KB.

## Needs

Claude Code 2.1.309 or newer (it hooks `ui.notify`, `SessionMode` and `Spinner`, which older builds lack: 2.1.283 refuses to load it). Works on the desktop app and the terminal. Colours follow your theme.

## Test

`claude plugin validate screen-share --strict` and `claude plugin test screen-share` (the masker is tested as pure functions, every surface on desktop and terminal, the fail-closed path, the lists, peek and the switch file).
