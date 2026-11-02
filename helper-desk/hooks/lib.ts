// Small pure helpers: text, numbers and colours. Nothing here touches the engine.

export const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

/** Cut to `n` characters, ending with an ellipsis when something was left out. */
export const cut = (t: string, n: number) => (n <= 0 ? '' : t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t)

/** Collapse every run of white space, so one value is one line. */
export const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim()

/** A path with the home folder written as ~. */
export function tidyPath(p: string, home: string) {
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p
}

/** The folder of a path, with the home folder written as ~. */
export function folderOf(p: string, home: string) {
  const parts = p.split('/')
  parts.pop()
  return tidyPath(parts.join('/'), home)
}

/** 83 seconds reads 1:23; an hour and a half reads 1:30:00. */
export function clockTime(ms: number) {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function tokenText(n: number) {
  if (n < 1000) return String(Math.max(0, Math.round(n)))
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** "claude-opus-5-5" reads "Opus 5.5"; "haiku" reads "Haiku"; an unknown name stays as it is. */
export function shortModel(model: string) {
  const hit = /(opus|sonnet|haiku|fable)(?:[-_ ](\d+))?(?:[-_.](\d+))?/i.exec(model)
  if (!hit) return model
  const fam = hit[1]![0]!.toUpperCase() + hit[1]!.slice(1).toLowerCase()
  return hit[2] ? `${fam} ${hit[2]}${hit[3] ? `.${hit[3]}` : ''}` : fam
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/**
 * Tokens of work: what went in new, what came out, and what was written to the cache.
 * Cache reads are left out. They repeat the same long prefix on every step and would
 * make a small job look huge.
 */
export const workTokens = (u: Partial<Usage>) => num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens)

/** Hide the kinds of secret that turn up in a command line, before it is drawn on screen. */
export function scrub(text: string) {
  return text
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, '••••')
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat|xox[abprs]|glpat|AKIA|AIza)[A-Za-z0-9_-]{12,}/g, '••••')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ••••')
    .replace(/\b([A-Za-z_]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z_]*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=••••')
}

/** A colour between `a` and `b`, both #rrggbb; `t` from 0 to 1. */
export function mix(a: string, b: string, t: number): string {
  const at = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  return `#${[0, 1, 2].map(i => Math.round(at(a, i) + (at(b, i) - at(a, i)) * t).toString(16).padStart(2, '0')).join('')}`
}

export const xml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

/** The bar colours a person can pick: light at the start, deep at the head. */
export type Palette = { name: string; light: string; mid: string; deep: string }

export const PALETTES: Palette[] = [
  { name: 'purple', light: '#c4b5fd', mid: '#8b5cf6', deep: '#6d28d9' },
  { name: 'blue', light: '#93c5fd', mid: '#3b82f6', deep: '#1d4ed8' },
  { name: 'teal', light: '#99f6e4', mid: '#14b8a6', deep: '#0f766e' },
  { name: 'green', light: '#bbf7d0', mid: '#22c55e', deep: '#15803d' },
  { name: 'orange', light: '#fed7aa', mid: '#f97316', deep: '#c2410c' },
  { name: 'pink', light: '#fbcfe8', mid: '#ec4899', deep: '#be185d' },
]

export const paletteOf = (name: unknown): Palette => PALETTES.find(p => p.name === name) ?? PALETTES[0]!

/** A setting read as a boolean, with a default for a missing or odd value. */
export const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)

/** A setting read as a number inside a range, with a default for a missing or odd value. */
export function whole(v: unknown, fallback: number, min: number, max: number) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.min(max, Math.max(min, n))
}
