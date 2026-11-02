// Pure helpers for the Mods switchboard. Nothing here touches the engine, so the
// rules (what counts as a mod, how a switch is written, what may be blocked) can be
// tested without one.

export type Json = Record<string, unknown>

// ---------- switches.json ----------

export type SwitchRead = {
  /** missing: no file or an empty one. ok: a JSON object. bad: anything else, so it must not be rewritten blindly. */
  kind: 'missing' | 'ok' | 'bad'
  json: Json
}

const isPlain = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/** `null` means the file does not exist. */
export function parseSwitches(raw: string | null): SwitchRead {
  if (raw === null || raw.trim() === '') return { kind: 'missing', json: {} }
  try {
    const v = JSON.parse(raw) as unknown
    if (isPlain(v)) return { kind: 'ok', json: v }
  } catch {
    // Falls through to bad.
  }
  return { kind: 'bad', json: {} }
}

/** A mod name that is safe to use as a key in switches.json. */
export const safeName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)

export const hiddenKey = (name: string) => `${name}:hidden`
export const blockKey = (name: string) => `${name}:block`

export const isOff = (json: Json, name: string) => json[name] === false
export const isHidden = (json: Json, name: string) => json[hiddenKey(name)] === true
export const isBlocked = (json: Json, name: string) => json[blockKey(name)] === true

/** A change to one key. `value: undefined` deletes the key. */
export type Change = { key: string; value: unknown }

/** Applies changes to a copy. `before` and `after` hold each touched key's old and new value (undefined: no key). */
export function applyChanges(json: Json, changes: readonly Change[]) {
  const next: Json = { ...json }
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const c of changes) {
    if (!(c.key in before)) before[c.key] = json[c.key]
    if (c.value === undefined) delete next[c.key]
    else next[c.key] = c.value
    after[c.key] = c.value
  }
  return { json: next, before, after }
}

/** The changes that put the keys of an earlier change back, for the keys nobody touched since. */
export function undoChanges(json: Json, entry: { before: Record<string, unknown>; after: Record<string, unknown> }) {
  const changes: Change[] = []
  let skipped = 0
  for (const key of Object.keys(entry.before)) {
    if (json[key] === entry.after[key]) changes.push({ key, value: entry.before[key] })
    else skipped += 1
  }
  return { changes, skipped }
}

export const sameJson = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Why a module must not load, or null. Only a mod the person blocked in the pane
 * ("<name>:block": true), only at the user tier, never this switchboard, and not
 * at all while the switchboard itself is off.
 */
export function blockReason(mod: { name: string; tier: string }, json: Json, self: string): string | null {
  if (mod.name === self || mod.tier !== 'user') return null
  if (json[self] === false) return null
  if (!safeName(mod.name) || !isBlocked(json, mod.name)) return null
  return `Blocked in the Mods pane ("${blockKey(mod.name)}" in switches.json)`
}

// ---------- reading a mod ----------

export type PaneCall = { command: string; args: string }

export type Info = {
  name: string
  title: string
  what: string
  version: string
  /** Slash commands the mod registers, found in its code. */
  commands: string[]
  /** file: the mod reads switches.json itself. none: it does not, so only a block at load can stop it. */
  switchKind: 'file' | 'none'
  /** The mod understands "<name>:hidden". */
  hide: boolean
  /** The slash command that opens its pane, from its metadata or found in its code. */
  pane: PaneCall | null
  /** The mod draws a side pane. */
  hasPane: boolean
  /** How to ask it to open: run its command, or leave the request file it polls for. */
  opener: 'command' | 'request' | null
}

const parseObject = (raw: string): Json => {
  try {
    const v = JSON.parse(raw) as unknown
    return isPlain(v) ? v : {}
  } catch {
    return {}
  }
}

/** Cuts comment lines and block comments, so a word in a comment does not count as use. */
export function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n')
}

export function commandsIn(source: string) {
  const out: string[] = []
  for (const m of source.matchAll(/command\.register\(\s*\{\s*name:\s*['"`]([A-Za-z0-9_-]{1,64})['"`]/g)) {
    const name = m[1] ?? ''
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

export const usesSwitchFile = (source: string) => /switches\.json/.test(source)
export const understandsHidden = (source: string) => /:hidden/.test(source)
export const pollsOpenRequest = (source: string) => /\.open-/.test(source)
/** The code opens a pane and draws a Pane component. */
export const drawsPane = (source: string) => /\$\.ui\.open\(/.test(source) && /component:\s*['"`]Pane['"`]/.test(source)

/** A `pane` value from metadata: "helpers", "/helpers", "helpers open". false or empty means none. */
export function parsePane(v: unknown): PaneCall | null | undefined {
  if (v === false || v === '') return null
  if (typeof v !== 'string') return undefined
  const m = /^\/?([A-Za-z0-9_-]{1,64})(?:\s+(.{0,200}))?$/.exec(v.trim())
  if (!m) return undefined
  return { command: m[1] ?? '', args: (m[2] ?? '').trim() }
}

const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined)

export function titleCase(name: string) {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** The first sentence of a description, short enough for one row. */
export function shortWhat(text: string, max = 110) {
  const flat = text.replace(/\s+/g, ' ').trim()
  const dot = flat.search(/[.!?](\s|$)/)
  const first = dot > 20 ? flat.slice(0, dot + 1) : flat
  return cut(first, max)
}

export function cut(s: string, n: number) {
  if (n <= 0) return ''
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`
}

/**
 * What a folder is, from the text of its files. null when it is not a mod:
 * no plugin.json, or a hooks.json with no "modules".
 * `modRaw` is mod.json (the metadata file, see the README); the same fields in
 * plugin.json are read too, and mod.json wins.
 */
export function buildInfo(folder: string, pluginRaw: string, hooksRaw: string, modRaw: string, rawSource: string): Info | null {
  if (!pluginRaw) return null
  const hooks = parseObject(hooksRaw)
  if (!('modules' in hooks)) return null
  const plugin = parseObject(pluginRaw)
  const meta: Json = { ...pickMeta(plugin), ...pickMeta(parseObject(modRaw)) }
  const name = typeof plugin.name === 'string' && plugin.name ? plugin.name : folder
  if (!name) return null
  const source = stripComments(rawSource)
  const commands = commandsIn(source)
  const metaPane = parsePane(meta.pane)
  const inferred = metaPane === undefined && drawsPane(source) && commands[0] ? { command: commands[0], args: '' } : null
  const pane = metaPane === undefined ? inferred : metaPane
  const request = pollsOpenRequest(source)
  const switchFlag = bool(meta.switch)
  const hideFlag = bool(meta.hide)
  const title = typeof meta.title === 'string' && meta.title.trim() ? cut(meta.title.trim(), 60) : titleCase(name)
  return {
    name,
    title,
    what: typeof plugin.description === 'string' ? shortWhat(plugin.description) : '',
    version: typeof plugin.version === 'string' ? cut(plugin.version, 20) : '',
    commands: commands.slice(0, 4),
    switchKind: (switchFlag ?? usesSwitchFile(source)) ? 'file' : 'none',
    hide: hideFlag ?? understandsHidden(source),
    pane,
    hasPane: pane !== null || (metaPane === undefined && drawsPane(source)),
    opener: pane ? 'command' : request ? 'request' : null,
  }
}

function pickMeta(o: Json): Json {
  const out: Json = {}
  for (const k of ['pane', 'hide', 'switch', 'title']) if (k in o) out[k] = o[k]
  return out
}

// ---------- the list ----------

export type Group = 'yours' | 'market' | 'chat' | 'other'
export const GROUP_ORDER: readonly Group[] = ['yours', 'market', 'chat', 'other']
export const GROUP_TITLE: Record<Group, string> = {
  yours: 'Your mods',
  market: 'From marketplaces',
  chat: 'This chat only',
  other: "Made in other chats",
}

/** Where a mod's folder says it lives. */
export function groupOf(root: string, sid: string): Group {
  if (sid && root.includes(`/.claude/dev-mods/${sid}/`)) return 'chat'
  if (root.includes('/.claude/dev-mods/')) return 'other'
  if (root.includes('/.claude/plugins/')) return 'market'
  return 'yours'
}

export type Status = 'loaded' | 'installed' | 'disabled' | 'disk' | 'blocked'

export const STATUS_TEXT: Record<Status, string> = {
  loaded: 'Loaded',
  installed: 'Installed, not seen loaded',
  disabled: 'Disabled in Claude Code',
  disk: 'On disk, not installed',
  blocked: 'Blocked at load',
}

export type Row = Info & {
  dir: string
  group: Group
  status: Status
  self: boolean
  /** Other folders with a mod of the same name. */
  copies: number
}

export function sortRows<T extends { group: Group; title: string }>(rows: readonly T[]) {
  return [...rows].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.title.localeCompare(b.title))
}

export function matchesFilter(row: { name: string; title: string; what: string; commands: string[] }, text: string) {
  const words = text.toLowerCase().split(/\s+/).map(w => w.replace(/^\//, '')).filter(Boolean)
  if (!words.length) return true
  const hay = `${row.name} ${row.title} ${row.what} ${row.commands.join(' ')}`.toLowerCase()
  return words.every(w => hay.includes(w))
}

export const signature = (rows: readonly Row[]) =>
  rows.map(r => [r.name, r.title, r.what, r.version, r.status, r.group, r.switchKind, r.hide, r.opener, r.hasPane, r.commands.join(',')].join('|')).join('\n')

// ---------- paths ----------

/** "~" and "~/x" mean the home folder; others stay. Trailing slashes go. */
export function expandHome(p: string, home: string) {
  const x = p.trim()
  const out = x === '~' ? home : x.startsWith('~/') ? `${home}${x.slice(1)}` : x
  return out.replace(/\/+$/, '')
}

/** A colon-separated list of folders. Empty parts and duplicates go. */
export function splitPaths(raw: string | undefined, home: string) {
  const out: string[] = []
  for (const part of (raw ?? '').split(':')) {
    const p = expandHome(part, home)
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

export const parentOf = (p: string) => p.replace(/\/+$/, '').split('/').slice(0, -1).join('/')
export const baseOf = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? ''

// ---------- installed plugins ----------

export type Installed = { key: string; name: string; dir: string; version: string }

/** The entries of ~/.claude/plugins/installed_plugins.json, whichever shape the file has. */
export function parseInstalled(raw: string): Installed[] {
  const root = parseObject(raw)
  const plugins = isPlain(root.plugins) ? root.plugins : root
  const out: Installed[] = []
  for (const [key, value] of Object.entries(plugins)) {
    if (typeof key !== 'string' || !key.includes('@')) continue
    const list = Array.isArray(value) ? value : [value]
    for (const item of list) {
      if (!isPlain(item) || typeof item.installPath !== 'string' || !item.installPath) continue
      out.push({
        key,
        name: key.slice(0, key.lastIndexOf('@')),
        dir: item.installPath.replace(/\/+$/, ''),
        version: typeof item.version === 'string' ? item.version : '',
      })
    }
  }
  return out
}

/** `name@market` and `name` both give `name`. */
export const pluginName = (s: string) => (s.includes('@') ? s.slice(0, s.lastIndexOf('@')) : s)
