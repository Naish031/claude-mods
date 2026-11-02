// SPDX-License-Identifier: Apache-2.0
// Replay Theater, a modified version of Anthropic's sample (Copyright 2026 Anthropic PBC, Apache License 2.0). See LICENSE and NOTICE.
// Replay Theater, diff helpers. Pure functions: no engine, no disk.
// Derived from Anthropic's Replay Theater sample (Apache-2.0). Changed: the line diff is a Myers diff with a
// common-start and common-end trim (the sample used a 400-line LCS table), hunks carry real line numbers,
// and the rows can be cut into windows, shown side by side or written out as a patch.

import type { ReplayHunk, ReplayStep } from '../types'

export const CONTEXT = 3 // unchanged lines kept around a change
export const LINE_MAX = 1000 // characters kept per diff line
const MYERS_MAX = 1500 // the most edits Myers looks for before it gives up and calls the middle one replaced block

export type Row = {
  /** ' ' kept, '+' added, '-' removed. */
  k: ' ' | '+' | '-'
  /** The next old line number when this row was reached. For a kept or removed row, its own. */
  o: number
  /** The next new line number when this row was reached. For a kept or added row, its own. */
  n: number
  t: string
  /** The hunk the row came from. */
  h: number
}

export type Pair = { l?: Row; r?: Row }

/** Splits text into lines. A closing newline does not make an extra empty line. */
export function splitLines(text: string | undefined | null): string[] {
  if (text === undefined || text === null || text === '') return []
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export const clip = (t: string) => (t.length > LINE_MAX ? `${t.slice(0, LINE_MAX)} …` : t)

type Op = ' ' | '-' | '+'

/** The edit script of two lists of numbers, or null when it would take more than `max` edits. */
function myers(a: number[], b: number[], max: number): Op[] | null {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map(() => '+' as const)
  if (m === 0) return a.map(() => '-' as const)
  const limit = Math.min(n + m, max)
  const off = limit + 1
  const v = new Int32Array(2 * limit + 3)
  // The part of v each round can read, kept for the walk back: indexes -d-1 to d+1.
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      const i = k + off
      let x = k === -d || (k !== d && v[i - 1]! < v[i + 1]!) ? v[i + 1]! : v[i - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[i] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
  }
  if (found < 0) return null
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const vv = trace[d]!
    const at = (kk: number) => vv[kk + d + 1]!
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const px = at(prevK)
    const py = px - prevK
    while (x > px && y > py) {
      ops.push(' ')
      x--
      y--
    }
    ops.push(x === px ? '+' : '-')
    x = px
    y = py
  }
  while (x > 0 && y > 0) {
    ops.push(' ')
    x--
    y--
  }
  return ops.reverse()
}

/** The edit script of two lists of lines: a run of kept lines, then edits, and so on. Always answers. */
export function diffOps(a: string[], b: string[]): Op[] {
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length
  let eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--
    eb--
  }
  const ids = new Map<string, number>()
  const id = (line: string) => {
    let i = ids.get(line)
    if (i === undefined) {
      i = ids.size
      ids.set(line, i)
    }
    return i
  }
  const midA = a.slice(s, ea)
  const midB = b.slice(s, eb)
  let mid: Op[] | null = null
  // A cheap guard on the work: Myers is O(N·D), so a huge middle with a small D is fine, a huge one with a big D is not tried.
  if (midA.length + midB.length <= 40_000) mid = myers(midA.map(id), midB.map(id), MYERS_MAX)
  if (!mid) mid = [...midA.map(() => '-' as const), ...midB.map(() => '+' as const)]
  return [...new Array<Op>(s).fill(' '), ...mid, ...new Array<Op>(a.length - ea).fill(' ')]
}

/** Hunks from the edit script of two lists of lines, with `ctx` kept lines around every change. */
export function buildHunks(a: string[], b: string[], ops: Op[], oldStart = 1, newStart = 1, ctx = CONTEXT): ReplayHunk[] {
  type Item = { op: Op; t: string }
  const items: Item[] = []
  let i = 0
  let j = 0
  for (const op of ops) {
    if (op === ' ') {
      items.push({ op, t: a[i]! })
      i++
      j++
    } else if (op === '-') {
      items.push({ op, t: a[i]! })
      i++
    } else {
      items.push({ op, t: b[j]! })
      j++
    }
  }
  const changed: number[] = []
  items.forEach((it, k) => {
    if (it.op !== ' ') changed.push(k)
  })
  if (!changed.length) return []
  // Spans of items to keep: each change, padded by ctx, merged where they touch.
  const spans: [number, number][] = []
  for (const k of changed) {
    const from = Math.max(0, k - ctx)
    const to = Math.min(items.length - 1, k + ctx)
    const last = spans[spans.length - 1]
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to)
    else spans.push([from, to])
  }
  // Line numbers before each item.
  const oldAt: number[] = []
  const newAt: number[] = []
  let o = oldStart
  let n = newStart
  for (const it of items) {
    oldAt.push(o)
    newAt.push(n)
    if (it.op !== '+') o++
    if (it.op !== '-') n++
  }
  return spans.map(([from, to]) => {
    const lines: string[] = []
    let oc = 0
    let nc = 0
    for (let k = from; k <= to; k++) {
      const it = items[k]!
      lines.push(`${it.op}${clip(it.t)}`)
      if (it.op !== '+') oc++
      if (it.op !== '-') nc++
    }
    // The usual numbering: a hunk that adds only (or removes only) names the line before it.
    return { oldStart: oc === 0 ? Math.max(0, oldAt[from]! - 1) : oldAt[from]!, oldLines: oc, newStart: nc === 0 ? Math.max(0, newAt[from]! - 1) : newAt[from]!, newLines: nc, lines }
  })
}

/** The hunks of two texts. `oldStart` and `newStart` say where the first line sits in its file. */
export function diffTexts(before: string | undefined | null, after: string | undefined | null, oldStart = 1, newStart = oldStart): ReplayHunk[] {
  const a = splitLines(before)
  const b = splitLines(after)
  return buildHunks(a, b, diffOps(a, b), oldStart, newStart)
}

/** Every line added (a new file) or every line removed (a deleted one), as one hunk. */
export function wholeHunk(text: string | undefined | null, sign: '+' | '-'): ReplayHunk[] {
  const lines = splitLines(text)
  if (!lines.length) return []
  const body = lines.map(l => `${sign}${clip(l)}`)
  return sign === '+'
    ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: body }]
    : [{ oldStart: 1, oldLines: lines.length, newStart: 0, newLines: 0, lines: body }]
}

/** The tool's own structuredPatch, checked and tidied. Null when it is missing, empty or not the shape expected. */
export function hunksFromPatch(patch: unknown): ReplayHunk[] | null {
  if (!Array.isArray(patch) || !patch.length) return null
  const out: ReplayHunk[] = []
  for (const h of patch) {
    if (!h || typeof h !== 'object') return null
    const o = h as Record<string, unknown>
    if (!Array.isArray(o.lines) || !['oldStart', 'newStart'].every(k => typeof o[k] === 'number' && Number.isFinite(o[k] as number))) return null
    const lines: string[] = []
    for (const l of o.lines) {
      if (typeof l !== 'string') return null
      if (l.startsWith('\\')) continue // "\ No newline at end of file"
      if (!/^[ +-]/.test(l)) return null
      lines.push(`${l[0]}${clip(l.slice(1))}`)
    }
    const oc = lines.filter(l => l[0] !== '+').length
    const nc = lines.filter(l => l[0] !== '-').length
    out.push({ oldStart: o.oldStart as number, oldLines: oc, newStart: o.newStart as number, newLines: nc, lines })
  }
  return out
}

export const countHunks = (hunks: ReplayHunk[]) => {
  let add = 0
  let del = 0
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l[0] === '+') add++
      else if (l[0] === '-') del++
    }
  }
  return { add, del }
}

export const lineTotal = (hunks: ReplayHunk[]) => hunks.reduce((n, h) => n + h.lines.length, 0)

export const charTotal = (hunks: ReplayHunk[]) => hunks.reduce((n, h) => n + h.lines.reduce((m, l) => m + l.length + 1, 0) + 24, 0)

/** Keeps the first diff lines that fit `maxLines` and `maxChars`. Says how many were left out. */
export function capHunks(hunks: ReplayHunk[], maxLines: number, maxChars: number): { hunks: ReplayHunk[]; more: number } {
  const total = lineTotal(hunks)
  let left = Math.max(0, maxLines)
  let chars = Math.max(0, maxChars)
  const out: ReplayHunk[] = []
  let kept = 0
  for (const h of hunks) {
    if (left <= 0 || chars <= 0) break
    const lines: string[] = []
    for (const l of h.lines) {
      if (left <= 0 || chars <= 0) break
      lines.push(l)
      left--
      chars -= l.length + 1
    }
    if (!lines.length) break
    kept += lines.length
    const oc = lines.filter(l => l[0] !== '+').length
    const nc = lines.filter(l => l[0] !== '-').length
    out.push({ oldStart: h.oldStart, oldLines: oc, newStart: h.newStart, newLines: nc, lines })
  }
  return { hunks: out, more: total - kept }
}

/** The rows of a step's hunks, each with its old and new line number. */
export function rowsOf(hunks: ReplayHunk[]): Row[] {
  const rows: Row[] = []
  hunks.forEach((h, hi) => {
    // A hunk that only adds starts one line late in the usual numbering: -0,0 for a new file, -5,0 after line 5.
    let o = h.oldLines === 0 && h.oldStart > 0 ? h.oldStart + 1 : h.oldStart
    let n = h.newLines === 0 && h.newStart > 0 ? h.newStart + 1 : h.newStart
    if (h.oldLines === 0 && h.oldStart === 0) o = 1
    if (h.newLines === 0 && h.newStart === 0) n = 1
    for (const l of h.lines) {
      const k = l[0] as Row['k']
      rows.push({ k, o, n, t: l.slice(1), h: hi })
      if (k !== '+') o++
      if (k !== '-') n++
    }
  })
  return rows
}

const range = (start: number, count: number) => `${start}${count === 1 ? '' : `,${count}`}`

/** Unified diff text of rows `from` to `to`, one @@ header for each run of rows from one hunk. */
export function unifiedText(rows: Row[], from = 0, to = rows.length): string {
  const part = rows.slice(from, to)
  const out: string[] = []
  let i = 0
  while (i < part.length) {
    let j = i
    while (j < part.length && part[j]!.h === part[i]!.h) j++
    const run = part.slice(i, j)
    const oc = run.filter(r => r.k !== '+').length
    const nc = run.filter(r => r.k !== '-').length
    const os = oc === 0 ? Math.max(0, run[0]!.o - 1) : run[0]!.o
    const ns = nc === 0 ? Math.max(0, run[0]!.n - 1) : run[0]!.n
    out.push(`@@ -${range(os, oc)} +${range(ns, nc)} @@`)
    for (const r of run) out.push(`${r.k}${r.t}`)
    i = j
  }
  return out.join('\n')
}

/** Rows paired for a side by side view: kept lines on both sides, a run of removed lines beside the run of added lines after it. */
export function pairRows(rows: Row[]): Pair[] {
  const out: Pair[] = []
  let i = 0
  while (i < rows.length) {
    const r = rows[i]!
    if (r.k === ' ') {
      out.push({ l: r, r })
      i++
      continue
    }
    const dels: Row[] = []
    const adds: Row[] = []
    while (i < rows.length && rows[i]!.k === '-') dels.push(rows[i++]!)
    while (i < rows.length && rows[i]!.k === '+') adds.push(rows[i++]!)
    const len = Math.max(dels.length, adds.length)
    for (let k = 0; k < len; k++) out.push({ l: dels[k], r: adds[k] })
  }
  return out
}

/** A hunk gap shows between two pairs that came from different hunks. */
export const isGap = (pairs: Pair[], at: number) => {
  if (at <= 0 || at >= pairs.length) return false
  const a = (pairs[at - 1]!.l ?? pairs[at - 1]!.r)!
  const b = (pairs[at]!.l ?? pairs[at]!.r)!
  return a.h !== b.h
}

/** The first line of `needle` in `text` (1-based) and how many times it occurs. Null when it is not there. */
export function locate(text: string, needle: string): { line: number; count: number } | null {
  if (!needle) return null
  const at = text.indexOf(needle)
  if (at < 0) return null
  let count = 0
  for (let p = text.indexOf(needle); p >= 0 && count < 10_000; p = text.indexOf(needle, p + needle.length)) count++
  let line = 1
  for (let p = 0; p < at; p++) if (text.charCodeAt(p) === 10) line++
  return { line, count }
}

/** A step's whole patch in unified format, for the clipboard. */
export function patchOf(step: ReplayStep): string {
  const a = step.kind === 'create' ? '/dev/null' : `a/${step.from || step.abs}`
  const b = step.kind === 'delete' ? '/dev/null' : `b/${step.abs}`
  const out: string[] = []
  const name = step.from || step.abs
  out.push(`diff --git a/${name} b/${step.abs}`)
  if (step.kind === 'rename') out.push(`rename from ${name}`, `rename to ${step.abs}`)
  if (step.kind === 'binary') {
    out.push(`Binary file ${step.abs} changed`)
    return out.join('\n')
  }
  if (!step.hunks.length) {
    if (step.kind === 'create') out.push('new file (empty)')
    else if (step.kind === 'delete') out.push('deleted (nothing to list)')
    else if (step.kind !== 'rename') out.push(`# ${step.note || 'no line changes'}`)
    return out.join('\n')
  }
  out.push(`--- ${a}`, `+++ ${b}`, unifiedText(rowsOf(step.hunks)))
  const notes: string[] = []
  if (!step.known) notes.push('# line numbers are a guess: this edit did not report where it sits in the file')
  if (step.more > 0) notes.push(`# ${step.more} more lines were not kept`)
  return [...notes, ...out].join('\n')
}
