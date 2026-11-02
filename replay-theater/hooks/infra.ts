// SPDX-License-Identifier: Apache-2.0
// Replay Theater, a modified version of Anthropic's sample (Copyright 2026 Anthropic PBC, Apache License 2.0). See LICENSE and NOTICE.
// The shared conventions every one of Naish's mods follows: the on/off switch file and the log file.
//   ~/.claude/claude-mods/switches.json   {"replay-theater": false} turns this mod off
//   ~/.claude/claude-mods/logs/replay-theater.log   one line per notable failure
// Pure functions only: the engine's `$` is used in register.tsx, never passed across an import.
// Written for the claude-mods convention. The sample's switch support (added in a third-party copy) polled a timer every three
// seconds and is not used here: the file is read at event time with a one second cache.

export const NAME = 'replay-theater'
export const HIDE_KEY = `${NAME}:hidden`

export const modDir = (home: string) => `${home}/.claude/claude-mods`
export const switchesPath = (home: string) => `${modDir(home)}/switches.json`
export const logPath = (home: string) => `${modDir(home)}/logs/${NAME}.log`
export const openRequestPath = (home: string, sid: string) => `${modDir(home)}/.open-${NAME}-${sid}`
export const patchPath = (home: string) => `${modDir(home)}/${NAME}/last.patch`

export type Flags = {
  /** The mod is off: every hook passes through and nothing is drawn. */
  off: boolean
  /** The person hid the hint above the prompt. /replay still opens the pane and shows it again. */
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

/** The message of an error, short and on one line. Never the input of a tool call, never a file's text. */
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
