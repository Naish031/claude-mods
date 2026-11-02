// Settings and word lists for Screen Share. Pure functions: no engine calls.
//
// Three places hold a setting, later ones win:
//   1. the plugin's config menu (userConfig),
//   2. the words file ~/.claude/claude-mods/screen-share.json (always-mask and never-mask words),
//   3. what /screen-share commands stored (style, names, categories), kept in $.store.

import { BAR, DEFAULT_RULES, KINDS, NAME_MODES, STYLES, cleanList, type Kind, type NameMode, type Rules, type Style } from './mask'

type Options = Readonly<Record<string, string | number | boolean | readonly string[]>>

export type Settings = {
  kinds: Record<Kind, boolean>
  names: NameMode
  style: Style
  glyph: string
  deny: string[]
  allow: string[]
  peekSeconds: number
  fade: boolean
  hideSuggestions: boolean
  maskPanels: boolean
  maskUsername: boolean
}

/** What a stored override can hold. Anything else in the store is ignored. */
export type Overrides = {
  style?: Style
  names?: NameMode
  kinds?: Partial<Record<Kind, boolean>>
}

/** The shape of ~/.claude/claude-mods/screen-share.json. */
export type WordFile = { mask: string[]; allow: string[] }

export const GLYPHS = ['▒', '█', '▓', '░', '•', '*'] as const
export const PEEK_MAX = 120

/** Settings key for each hidden kind, as plugin.json spells them. */
export const KIND_SETTING: Record<Exclude<Kind, 'custom'>, string> = {
  email: 'mask_emails',
  phone: 'mask_phones',
  amount: 'mask_amounts',
  name: 'mask_names',
  secret: 'mask_secrets',
  number: 'mask_numbers',
  path: 'mask_paths',
  address: 'mask_addresses',
}

export const TOGGLE_KINDS = Object.keys(KIND_SETTING) as Array<Exclude<Kind, 'custom'>>

const str = (o: Options, k: string, fallback: string) => (typeof o[k] === 'string' ? (o[k] as string) : fallback)
const flag = (o: Options, k: string, fallback: boolean) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : fallback)

/** Splits "a, b; c | d" (or one word per line) into a list. */
export function parseList(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return cleanList(raw.split(/[,;|\n\r]+/))
}

export function readSettings(o: Options = {}): Settings {
  const style = str(o, 'style', 'bar')
  const names = str(o, 'names', 'smart')
  const glyph = str(o, 'bar_glyph', BAR)
  const peek = Number(o.peek_seconds)
  const kinds = { ...DEFAULT_RULES.kinds }
  for (const k of TOGGLE_KINDS) kinds[k] = flag(o, KIND_SETTING[k], true)
  return {
    kinds,
    names: (NAME_MODES as readonly string[]).includes(names) ? (names as NameMode) : 'smart',
    style: (STYLES as readonly string[]).includes(style) ? (style as Style) : 'bar',
    glyph: (GLYPHS as readonly string[]).includes(glyph) ? glyph : BAR,
    deny: parseList(o.always_mask),
    allow: parseList(o.never_mask),
    peekSeconds: Number.isFinite(peek) && peek >= 1 ? Math.min(Math.floor(peek), PEEK_MAX) : 10,
    fade: flag(o, 'fade_in', true),
    hideSuggestions: flag(o, 'hide_suggestions', true),
    maskPanels: flag(o, 'mask_panels', true),
    maskUsername: flag(o, 'mask_username', true),
  }
}

/** Reads what the store holds as overrides, ignoring anything of the wrong shape. */
export function readOverrides(raw: { style?: unknown; names?: unknown; kinds?: unknown }): Overrides {
  const out: Overrides = {}
  if (typeof raw.style === 'string' && (STYLES as readonly string[]).includes(raw.style)) out.style = raw.style as Style
  if (typeof raw.names === 'string' && (NAME_MODES as readonly string[]).includes(raw.names)) out.names = raw.names as NameMode
  if (raw.kinds && typeof raw.kinds === 'object') {
    const kinds: Partial<Record<Kind, boolean>> = {}
    for (const k of KINDS) {
      const v = (raw.kinds as Record<string, unknown>)[k]
      if (typeof v === 'boolean') kinds[k] = v
    }
    out.kinds = kinds
  }
  return out
}

/** Parses the words file. A missing or broken file is empty lists. */
export function parseWordFile(text: string): WordFile {
  try {
    const json = JSON.parse(text) as { mask?: unknown; allow?: unknown }
    return {
      mask: Array.isArray(json.mask) ? cleanList(json.mask) : [],
      allow: Array.isArray(json.allow) ? cleanList(json.allow) : [],
    }
  } catch {
    return { mask: [], allow: [] }
  }
}

export function wordFileText(file: WordFile): string {
  return `${JSON.stringify({ mask: file.mask, allow: file.allow }, null, 2)}\n`
}

// Usernames that are ordinary words: masking every "test" or "user" would only be noise.
const COMMON_USERNAMES = new Set(['test', 'user', 'users', 'admin', 'root', 'guest', 'runner', 'ubuntu', 'home', 'claude', 'node', 'dev', 'demo', 'default'])

/** The account's own name, taken from the home folder (/Users/jane gives jane), when it is worth hiding everywhere. */
export function usernameOf(home: string): string | undefined {
  const name = home.split(/[\\/]/).filter(Boolean).pop() ?? ''
  if (name.length < 4 || COMMON_USERNAMES.has(name.toLowerCase()) || !/^[\p{L}\p{N}._-]+$/u.test(name)) return undefined
  return name
}

/** Puts the three places together into the rules the masker uses. */
export function buildRules(base: Settings, ov: Overrides, file: WordFile, home: string): Rules {
  const kinds = { ...base.kinds, ...(ov.kinds ?? {}) }
  const user = base.maskUsername ? usernameOf(home) : undefined
  const deny = cleanList([...base.deny, ...file.mask, ...(user ? [user] : [])])
  return {
    kinds: { ...kinds, custom: deny.length > 0 },
    names: ov.names ?? base.names,
    style: ov.style ?? base.style,
    glyph: base.glyph,
    deny,
    allow: cleanList([...base.allow, ...file.allow]),
  }
}

/** Splits the words after /screen-share add into a list: commas, semicolons or lines separate; spaces do not. */
export function wordsFromArgs(rest: string): string[] {
  const cleaned = rest.replace(/^["'“”]+|["'“”]+$/g, '')
  return cleanList(parseList(cleaned).map(w => w.replace(/^["'“”]+|["'“”]+$/g, '')))
}

/** The names of the hidden kinds that are on, for a status line. */
export function onKinds(kinds: Readonly<Record<Kind, boolean>>): string[] {
  return TOGGLE_KINDS.filter(k => kinds[k])
}
