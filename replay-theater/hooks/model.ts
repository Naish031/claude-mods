// SPDX-License-Identifier: Apache-2.0
// Replay Theater, a modified version of Anthropic's sample (Copyright 2026 Anthropic PBC, Apache License 2.0). See LICENSE and NOTICE.
// Replay Theater, the view model: the filter, groups of files, windows over long diffs, the turns kept, and the
// words of /replay. Pure functions. New in this version: the sample only held the last turn and showed one step.

import type { ReplayHistory, ReplayMode, ReplayPending, ReplayStep, ReplayTurn, ReplayView } from '../types'
import { patchOf } from './diff'

export const emptyHistory = (): ReplayHistory => ({ turns: [], seq: 1 })
export const emptyPending = (): ReplayPending => ({ steps: [], dropped: 0, chars: 0 })
export const emptyView = (split = false): ReplayView => ({ open: false, inBand: false, turn: 0, mode: 'step', index: 0, off: 0, split, filter: '', expanded: [], top: 0 })

export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, Math.max(lo, hi)))
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// ---------------------------------------------------------------------------------------------
// Settings from plugin.json userConfig, read safely.
// ---------------------------------------------------------------------------------------------

export type Settings = { keepTurns: number; collapse: number; showHint: boolean; split: boolean }

const whole = (v: unknown, fallback: number, lo: number, hi: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= lo ? Math.min(Math.floor(n), hi) : fallback
}

export function readSettings(options: unknown): Settings {
  const o = (options && typeof options === 'object' ? options : {}) as Record<string, unknown>
  return {
    keepTurns: whole(o.keep_turns, 10, 1, 50),
    collapse: o.fold_over_lines === 0 ? 0 : whole(o.fold_over_lines, 300, 20, 100_000),
    showHint: o.show_hint !== false,
    split: o.default_view === 'split',
  }
}

// ---------------------------------------------------------------------------------------------
// The filter: "liquid", "*.json", "sections/*, !locales". A word matches inside the path, a * makes a glob.
// ---------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')

export type Filter = { include: RegExp[]; exclude: RegExp[] }

export function parseFilter(text: string): Filter {
  const f: Filter = { include: [], exclude: [] }
  for (const raw of text.split(/[\s,]+/)) {
    if (!raw) continue
    const neg = raw.startsWith('!')
    const term = (neg ? raw.slice(1) : raw).toLowerCase()
    if (!term) continue
    const re = term.includes('*') || term.includes('?') ? new RegExp(`^(.*/)?${esc(term).replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i') : new RegExp(esc(term), 'i')
    ;(neg ? f.exclude : f.include).push(re)
  }
  return f
}

export const matches = (f: Filter, file: string) => (f.include.length === 0 || f.include.some(r => r.test(file))) && !f.exclude.some(r => r.test(file))

/** The steps of a turn the filter lets through, in order. */
export function visibleSteps(turn: ReplayTurn | undefined, filter: string): ReplayStep[] {
  if (!turn) return []
  const f = parseFilter(filter)
  return f.include.length || f.exclude.length ? turn.steps.filter(s => matches(f, s.file) || (s.from !== '' && matches(f, s.from))) : turn.steps
}

// ---------------------------------------------------------------------------------------------
// Totals, groups of steps by file, windows
// ---------------------------------------------------------------------------------------------

export type Totals = { edits: number; files: number; add: number; del: number }

export function totals(steps: ReplayStep[]): Totals {
  const files = new Set<string>()
  let add = 0
  let del = 0
  for (const s of steps) {
    files.add(s.abs)
    add += s.add
    del += s.del
  }
  return { edits: steps.length, files: files.size, add, del }
}

export type Group = { file: string; abs: string; first: number; count: number; add: number; del: number; kinds: string[] }

/** The files of a list of steps, in the order each was first changed. `first` is the index of its first step. */
export function groupsOf(steps: ReplayStep[]): Group[] {
  const byAbs = new Map<string, Group>()
  steps.forEach((s, i) => {
    let g = byAbs.get(s.abs)
    if (!g) {
      g = { file: s.file, abs: s.abs, first: i, count: 0, add: 0, del: 0, kinds: [] }
      byAbs.set(s.abs, g)
    }
    g.count++
    g.add += s.add
    g.del += s.del
    if (!g.kinds.includes(s.kind)) g.kinds.push(s.kind)
  })
  return [...byAbs.values()]
}

/** The index of the group a step belongs to. */
export const groupOfStep = (groups: Group[], step: number) => {
  let at = 0
  groups.forEach((g, i) => {
    if (g.first <= step) at = i
  })
  return at
}

/** The steps of one group, as indexes into the list, in order. */
export const stepsOfGroup = (steps: ReplayStep[], g: Group | undefined) => (g ? steps.map((s, i) => (s.abs === g.abs ? i : -1)).filter(i => i >= 0) : [])

/** The cells of the strip to draw: the whole list when it fits, else a window around the current one. */
export function stripRange(total: number, current: number, cells: number): { from: number; to: number } {
  const fit = Math.max(3, cells)
  if (total <= fit) return { from: 0, to: total }
  const from = clamp(current - Math.floor(fit / 2), 0, total - fit)
  return { from, to: from + fit }
}

/** Which slice of each of several lists a window of `win` rows, starting at row `off` of all of them joined, shows. */
export function windowChunks(counts: number[], off: number, win: number): { i: number; from: number; to: number }[] {
  const out: { i: number; from: number; to: number }[] = []
  let start = 0
  const end = off + win
  counts.forEach((n, i) => {
    const from = Math.max(off, start) - start
    const to = Math.min(end, start + n) - start
    if (to > from) out.push({ i, from, to })
    start += n
  })
  return out
}

// ---------------------------------------------------------------------------------------------
// Turns kept
// ---------------------------------------------------------------------------------------------

export const stepChars = (s: ReplayStep) => 260 + s.file.length + s.note.length + s.hunks.reduce((n, h) => n + h.lines.reduce((m, l) => m + l.length + 1, 0), 0)

export const turnChars = (t: ReplayTurn) => t.steps.reduce((n, s) => n + stepChars(s), 0)

/** The newest `keep` turns, and fewer when together they hold more than `maxChars`. The newest turn always stays. */
export function trimHistory(turns: ReplayTurn[], keep: number, maxChars: number): ReplayTurn[] {
  const kept = turns.slice(-Math.max(1, keep))
  let sum = 0
  const out: ReplayTurn[] = []
  for (let i = kept.length - 1; i >= 0; i--) {
    const c = turnChars(kept[i]!)
    if (out.length && sum + c > maxChars) break
    sum += c
    out.unshift(kept[i]!)
  }
  return out
}

/** The turn `back` turns before the newest one (0 is the newest), or the oldest kept when `back` is too big. */
export const turnAt = (turns: ReplayTurn[], back: number): ReplayTurn | undefined => turns[clamp(turns.length - 1 - back, 0, turns.length - 1)]

export const clockOf = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

export function turnLine(turn: ReplayTurn, back: number): string {
  const t = totals(turn.steps)
  const which = back === 0 ? 'last turn' : `${back} turns ago`
  const more = turn.dropped > 0 ? `, ${turn.dropped} more not kept` : ''
  return `${which} (#${turn.n}, ${clockOf(turn.at)}): ${plural(t.edits, 'edit')} in ${plural(t.files, 'file')}, +${t.add} -${t.del}${more}`
}

export const hintText = (edits: number) => `▶ Replay: ${plural(edits, 'edit')} (press r)`

/** The whole patch for a list of steps. */
export const patchForSteps = (steps: ReplayStep[]) => `${steps.map(patchOf).join('\n')}\n`

// ---------------------------------------------------------------------------------------------
// /replay
// ---------------------------------------------------------------------------------------------

export type Cmd =
  | { kind: 'open'; turn: number; mode?: ReplayMode }
  | { kind: 'list' }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'filter'; text: string }
  | { kind: 'view'; split: boolean }
  | { kind: 'copy'; turn: number }
  | { kind: 'save' }
  | { kind: 'hide' }
  | { kind: 'show' }
  | { kind: 'bad'; text: string }

/** Reads the words after /replay. Turn numbers are 1 for the last turn; the result's `turn` counts from 0. */
export function parseCommand(args: string): Cmd {
  const text = args.trim()
  if (!text) return { kind: 'open', turn: 0 }
  const [word = '', ...rest] = text.split(/\s+/)
  const w = word.toLowerCase()
  const tail = text.slice(word.length).trim()
  const turnArg = (s: string | undefined): number | undefined => {
    if (s === undefined || s === '') return 0
    return /^\d+$/.test(s) && Number(s) >= 1 ? Number(s) - 1 : undefined
  }
  if (/^\d+$/.test(w)) return Number(w) >= 1 ? { kind: 'open', turn: Number(w) - 1 } : { kind: 'bad', text: 'Turns count from 1, the last turn.' }
  switch (w) {
    case 'step':
    case 'steps': {
      const t = turnArg(rest[0])
      return t === undefined ? { kind: 'bad', text: 'Use /replay step [turn number].' } : { kind: 'open', turn: t, mode: 'step' }
    }
    case 'file': {
      const t = turnArg(rest[0])
      return t === undefined ? { kind: 'bad', text: 'Use /replay file [turn number].' } : { kind: 'open', turn: t, mode: 'file' }
    }
    case 'files':
    case 'overview': {
      const t = turnArg(rest[0])
      return t === undefined ? { kind: 'bad', text: 'Use /replay files [turn number].' } : { kind: 'open', turn: t, mode: 'overview' }
    }
    case 'list':
    case 'turns':
    case 'history':
      return { kind: 'list' }
    case 'status':
      return { kind: 'status' }
    case 'help':
    case '?':
      return { kind: 'help' }
    case 'filter':
    case 'only':
    case 'match': {
      const clear = !tail || /^(clear|off|none|all|reset)$/i.test(tail)
      return { kind: 'filter', text: clear ? '' : tail }
    }
    case 'split':
    case 'side':
      return { kind: 'view', split: true }
    case 'unified':
    case 'inline':
      return { kind: 'view', split: false }
    case 'view': {
      const v = (rest[0] ?? '').toLowerCase()
      if (v === 'split' || v === 'side' || v === 'side-by-side') return { kind: 'view', split: true }
      if (v === 'unified' || v === 'inline') return { kind: 'view', split: false }
      return { kind: 'bad', text: 'Use /replay view unified or /replay view split.' }
    }
    case 'copy':
    case 'patch': {
      const t = turnArg(rest[0])
      return t === undefined ? { kind: 'bad', text: 'Use /replay copy [turn number].' } : { kind: 'copy', turn: t }
    }
    case 'save':
      return { kind: 'save' }
    case 'hide':
      return { kind: 'hide' }
    case 'show':
      return { kind: 'show' }
    default:
      return { kind: 'bad', text: `Do not know "${word}". Type /replay help.` }
  }
}

export const HELP = [
  'Replay Theater steps through the file edits Claude made, one diff at a time.',
  '/replay: open the last turn. /replay 2: open the turn before it (up to 10 are kept).',
  '/replay list: the turns kept. /replay files: the files of the turn. /replay file: one file at a time. /replay step: one edit at a time.',
  '/replay filter <word or *.glob, ...>: show only matching files (a ! leaves matches out). /replay filter: clear it.',
  '/replay split or unified: side by side or one column. /replay copy [turn]: patch to the clipboard. /replay save: patch to a file.',
  '/replay status. /replay hide and /replay show: the hint above the prompt.',
  'In the pane: n and p step, f and b jump file, v the file list, s split or unified, y copy, e open a folded diff, u and d scroll, o and l change turn, c or Escape close.',
].join('\n')
