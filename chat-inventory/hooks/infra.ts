// The shared conventions every one of Naish's mods follows: the on/off switch file and the log file.
//   ~/.claude/claude-mods/switches.json   {"chat-inventory": false} turns this mod off
//   ~/.claude/claude-mods/logs/chat-inventory.log   one line per notable event or failure
// Pure functions only: the engine's `$` is used in register.tsx, never passed across an import.

export const NAME = 'chat-inventory'
export const HIDE_KEY = `${NAME}:hidden`

export const modDir = (home: string) => `${home}/.claude/claude-mods`
export const switchesPath = (home: string) => `${modDir(home)}/switches.json`
export const logPath = (home: string) => `${modDir(home)}/logs/${NAME}.log`
export const openRequestPath = (home: string, sid: string) => `${modDir(home)}/.open-${NAME}-${sid}`
export const planPaths = (home: string, sid: string) => [`${modDir(home)}/plans/plan-${sid}.json`, `${home}/.claude/mods-state/plan-${sid}.json`]

export type Flags = {
  /** The mod is off: every hook passes through and nothing is drawn. */
  off: boolean
  /** The person hid the pane: it stays closed and never opens by itself. */
  hidden: boolean
}

/** The flags in the text of a switch file. Broken text, or an array, means the mod is on. */
export function parseFlags(text: string): Flags {
  try {
    const json = JSON.parse(text) as unknown
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const o = json as Record<string, unknown>
      return { off: o[NAME] === false, hidden: o[HIDE_KEY] === true }
    }
  } catch {
    // Broken file: on.
  }
  return { off: false, hidden: false }
}

/**
 * The switch file's text with the hidden flag set or cleared, every other key kept.
 * `text` is undefined for a file that does not exist yet. Throws for text that is not a JSON object,
 * so a broken file is never overwritten.
 */
export function withHidden(text: string | undefined, value: boolean): string {
  let json: Record<string, unknown> = {}
  if (text !== undefined) {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('switches.json is not an object')
    json = parsed as Record<string, unknown>
  }
  if (value) json[HIDE_KEY] = true
  else delete json[HIDE_KEY]
  return `${JSON.stringify(json, null, 2)}\n`
}

/** The message of an error, short and on one line. Never the input of a tool call. */
export const errText = (err: unknown) => String(err instanceof Error ? err.message : err).replace(/\s+/g, ' ').slice(0, 160)

/** One log line: time, event, and a short detail. */
export const logLine = (now: number, event: string, detail: string) =>
  `${new Date(now).toISOString()} ${event}${detail ? `: ${detail.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`

/** The log text with a line added, keeping the newest 300 lines. */
export function appendLog(old: string, line: string): string {
  const lines = old.split('\n').filter(Boolean).slice(-299)
  lines.push(line)
  return `${lines.join('\n')}\n`
}

/** The three settings from plugin.json userConfig, read safely (a missing or wrong value falls back to its default). */
export function parseOptions(options: unknown): { autoOpen: boolean; hideConnectors: string; extraCliTools: string } {
  const o = (options && typeof options === 'object' ? options : {}) as Record<string, unknown>
  return {
    autoOpen: o.autoOpen !== false,
    hideConnectors: typeof o.hideConnectors === 'string' ? o.hideConnectors : '',
    extraCliTools: typeof o.extraCliTools === 'string' ? o.extraCliTools : '',
  }
}
