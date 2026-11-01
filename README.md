# claude-mods

Small mods for Claude Code. A mod is a plugin that changes how Claude Code itself behaves.

| Mod | What it does |
| --- | --- |
| [`brain-dump`](#brain-dump) | Turns a rambling voice dump into a clear, structured prompt before it is sent. |

---

## Brain Dump

You dictate a prompt out loud. It comes out as a wall of "um, so, maybe, actually, wait, no" with the real request buried inside. Brain Dump sits between your dictation and Claude. It cleans the text up first, so Claude gets a clear, structured request and you get a better answer.

### Install

From a terminal session:

```
/plugin install brain-dump --marketplace Naish031/claude-mods
```

From a shell:

```
claude plugin install brain-dump --marketplace Naish031/claude-mods
```

In the desktop app (where `/plugin` does not run): click **+** next to the prompt box, then **Plugins**, then **Add marketplace** with `Naish031/claude-mods`, then **Add plugin**.

You will be asked `Add marketplace?`. Answer `y`, then pick a scope (user scope is fine). The mod is active straight away.

### How to use it

There is nothing to learn. Dictate or type a prompt and press Enter.

1. **Short prompt (under 15 words):** sent as typed. Brain Dump stays out of the way.
2. **Longer prompt:** Brain Dump rewrites it into a structured prompt.
3. **Only if something important is missing:** it asks up to 3 multiple-choice questions, one at a time. Most prompts need none.
4. **You approve:** you see the cleaned-up prompt, then choose **Send it**, **Send my original** or **Cancel**. Type under **Other** to ask for a change, for example "make it shorter" or "add that it must work on mobile".

If you cancel, your original text is printed back so a long dictation is never lost.

### Example

You say:

> okay so um I was thinking about the product page, the add to cart button is kind of small on mobile and maybe the color is off too, I don't know, can you take a look and fix it

Brain Dump proposes:

```
## Goal
Make the add-to-cart button on the product page easier to use on mobile.

## Requirements
- Increase the button's size on mobile.
- Review the button color and fix it if it is off.
```

### What it is good for

- Voice dictation: the main use. Talk freely, send something tidy.
- Long, rambling thoughts that need turning into a clear task.
- Handing Claude a vague idea and having it ask only the questions that matter.
- Getting consistent prompts (goal, requirements, constraints, done-when) without writing them yourself.

### Shortcuts

| You do this | What happens |
| --- | --- |
| End your prompt with `!!` | Skips Brain Dump and sends exactly what you typed (without the `!!`). |
| Start with `/` | Slash commands are never touched. |

### What it will not do

- It does not invent requirements. If it has to assume something, it lists it under **Assumptions** so you can see it.
- It keeps names, file paths, URLs, numbers and code exactly as you said them.
- It leaves alone prompts from scheduled tasks, other sessions and headless runs.
- If anything goes wrong (the model call fails, times out or returns something unusable), your original text is sent as typed.

### Good to know

- Each long prompt makes one small extra model call (Sonnet, low effort) through your own Claude session. Clarifying questions or change requests add more calls.
- Your dictated text is sent to Claude as part of that call, the same as any prompt you send.
- This is an early version (0.1.0). The 15-word cutoff and the model are constants at the top of [`brain-dump/hooks/register.ts`](brain-dump/hooks/register.ts) if you want to change them.

---

## Layout

Each mod is a folder with a standard layout, and the repository root is the marketplace.

```
.claude-plugin/marketplace.json     lists the mods
brain-dump/
├── .claude-plugin/plugin.json
└── hooks/ (hooks.json, register.ts)
```
