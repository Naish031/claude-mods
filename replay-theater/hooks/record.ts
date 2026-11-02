// SPDX-License-Identifier: Apache-2.0
// Replay Theater, a modified version of Anthropic's sample (Copyright 2026 Anthropic PBC, Apache License 2.0). See LICENSE and NOTICE.
// Replay Theater, turning one finished tool call into steps. Pure functions: the engine's `$` stays in register.tsx.
// Derived from Anthropic's Replay Theater sample (Apache-2.0). Changed: steps are made from what the tool reported
// after it ran (so a refused or failed edit is never recorded, the diff has the file's real line numbers, and nothing
// is read from disk before a write), and removes and moves run through Bash are listed too.

import type { ReplayKind, ReplayStep } from '../types'
import { foldReason, hasNul, isBinaryPath, labelOf, languageOf } from './classify'
import { capHunks, charTotal, countHunks, diffTexts, hunksFromPatch, lineTotal, locate, wholeHunk } from './diff'

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export const STEP_LINES = 2000 // diff lines kept for one step
export const STEP_CHARS = 80_000 // characters of diff kept for one step
export const TURN_CHARS = 700_000 // characters of diff kept for one turn, then steps keep their counts only
export const TURN_STEPS = 300 // steps kept for one turn

export type Ctx = {
  cwd: string
  home: string
  /** Fold diffs of more than this many changed lines. 0 never folds on size. */
  collapse: number
  now: number
  /** Characters of diff the turn may still keep. */
  budget: number
  helper: boolean
}

type Rec = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})

/** A path as shown: relative to the folder the chat runs in, or ~/ for the home folder, else as given. */
export function displayPath(path: string, cwd: string, home: string): string {
  if (!path) return '(unknown file)'
  if (cwd && path.startsWith(`${cwd.replace(/\/+$/, '')}/`)) return path.slice(cwd.replace(/\/+$/, '').length + 1)
  if (home && path.startsWith(`${home.replace(/\/+$/, '')}/`)) return `~/${path.slice(home.replace(/\/+$/, '').length + 1)}`
  return path
}

type Draft = {
  id: string
  tool: string
  abs: string
  from?: string
  kind: ReplayKind
  note: string
  hunks: ReturnType<typeof wholeHunk>
  known: boolean
}

/** Makes the stored step: counts first (from the whole diff), then the part that is kept. */
function finish(d: Draft, ctx: Ctx): ReplayStep {
  const { add, del } = countHunks(d.hunks)
  const total = lineTotal(d.hunks)
  const why = d.kind === 'binary' ? '' : foldReason(d.abs, d.hunks, add + del, ctx.collapse)
  const room = Math.min(STEP_CHARS, ctx.budget)
  let hunks = d.hunks
  let more = 0
  let note = d.note
  if (total > 0 && (room <= 0 || total > STEP_LINES || charTotal(d.hunks) > room)) {
    const capped = capHunks(d.hunks, STEP_LINES, Math.max(0, room))
    hunks = capped.hunks
    more = capped.more
    if (room <= 0) note = note ? `${note}, diff not kept (turn is very large)` : 'diff not kept (turn is very large)'
  }
  return {
    id: d.id,
    tool: d.tool,
    file: displayPath(d.abs, ctx.cwd, ctx.home),
    abs: d.abs,
    from: d.from ? displayPath(d.from, ctx.cwd, ctx.home) : '',
    kind: d.kind,
    note,
    hunks,
    add,
    del,
    more,
    known: d.known,
    helper: ctx.helper,
    label: labelOf(d.abs),
    lang: d.kind === 'notebook' ? '' : languageOf(d.abs),
    why,
    at: ctx.now,
  }
}

const places = (n: number) => `${n} place${n === 1 ? '' : 's'}`

function editStep(id: string, e: Rec, res: Rec, ctx: Ctx): Draft[] {
  const abs = str(e.file_path)
  const oldS = str(e.old_string)
  const newS = str(e.new_string)
  const original = typeof res.originalFile === 'string' ? res.originalFile : null
  let hunks = hunksFromPatch(res.structuredPatch)
  let known = hunks !== null
  const loc = original !== null ? locate(original, oldS) : null
  if (!hunks) {
    hunks = diffTexts(oldS, newS, loc?.line ?? 1, loc?.line ?? 1)
    known = loc !== null
  }
  const notes: string[] = []
  const all = e.replace_all === true || res.replaceAll === true
  if (all) notes.push(loc && loc.count > 1 ? `replace all, ${places(loc.count)}` : 'replace all')
  if (res.userModified === true) notes.push('you changed it first')
  return [{ id, tool: 'Edit', abs, kind: 'edit', note: notes.join(', '), hunks, known }]
}

function writeStep(id: string, e: Rec, res: Rec, hasResult: boolean): Draft[] {
  if (res.staged === true) return [] // held for review: the file is unchanged
  const abs = str(e.file_path)
  const content = str(e.content)
  const original = typeof res.originalFile === 'string' ? res.originalFile : null
  const type = res.type === 'create' || res.type === 'update' ? res.type : ''
  const isNew = type === 'create'
  const base = { id, tool: 'Write', abs }
  const modified = res.userModified === true ? ', you changed it first' : ''
  if (hasNul(content) || isBinaryPath(abs)) {
    return [{ ...base, kind: 'binary', note: `${isNew ? 'new ' : ''}binary file, ${content.length.toLocaleString('en-US')} bytes${modified}`, hunks: [], known: true }]
  }
  const fromTool = hunksFromPatch(res.structuredPatch)
  let hunks = fromTool
  let known = true
  if (!hunks) {
    if (isNew || original === null) {
      hunks = wholeHunk(content, '+')
      known = isNew
    } else {
      hunks = diffTexts(original, content)
    }
  }
  if (isNew) return [{ ...base, kind: 'create', note: `new file${modified}`, hunks, known }]
  if (!hasResult) return [{ ...base, kind: 'rewrite', note: 'new or rewritten file (the tool did not say which)', hunks, known: false }]
  if (original === null && !fromTool) return [{ ...base, kind: 'rewrite', note: `rewrite, the old version was too large to compare${modified}`, hunks, known: false }]
  if (!hunks.length) return [{ ...base, kind: 'unchanged', note: `rewritten with the same content${modified}`, hunks, known }]
  return [{ ...base, kind: 'rewrite', note: `rewrite${modified}`, hunks, known }]
}

function multiSteps(id: string, e: Rec, res: Rec): Draft[] {
  const abs = str(e.file_path)
  const edits = Array.isArray(e.edits) ? e.edits : []
  let work = typeof res.originalFile === 'string' ? res.originalFile : null
  return edits.map((raw, k) => {
    const ed = rec(raw)
    const oldS = str(ed.old_string)
    const newS = str(ed.new_string)
    const loc = work !== null ? locate(work, oldS) : null
    if (work !== null && loc) work = ed.replace_all === true ? work.split(oldS).join(newS) : work.replace(oldS, () => newS)
    const note = `edit ${k + 1} of ${edits.length}${ed.replace_all === true ? ', replace all' : ''}`
    return { id: `${id}#${k + 1}`, tool: 'MultiEdit', abs, kind: 'edit' as const, note, hunks: diffTexts(oldS, newS, loc?.line ?? 1, loc?.line ?? 1), known: loc !== null }
  })
}

function notebookStep(id: string, e: Rec, res: Rec): Draft[] {
  if (typeof res.error === 'string' && res.error) return []
  const abs = str(res.notebook_path) || str(e.notebook_path)
  const mode = str(res.edit_mode) || str(e.edit_mode) || 'replace'
  const oldS = str(res.old_source)
  const newS = str(res.new_source) || str(e.new_source)
  const hunks = mode === 'insert' ? wholeHunk(newS, '+') : mode === 'delete' ? wholeHunk(oldS, '-') : diffTexts(oldS, newS)
  const cell = str(res.cell_id) || str(e.cell_id)
  const type = str(res.cell_type) || str(e.cell_type)
  const note = ['cell' + (cell ? ` ${cell}` : ''), mode, type].filter(Boolean).join(', ')
  return [{ id, tool: 'NotebookEdit', abs, kind: 'notebook', note, hunks, known: false }]
}

/** The steps for one finished Edit, Write, MultiEdit or NotebookEdit call. `result` is what the tool reported (may be missing). */
export function stepsForCall(input: Rec, result: unknown, ctx: Ctx): ReplayStep[] {
  const id = str(input.tool_use_id) || `call-${ctx.now}`
  const hasResult = result !== undefined && result !== null && typeof result === 'object'
  const res = rec(result)
  const tool = String(input.tool)
  let drafts: Draft[] = []
  if (tool === 'Edit') drafts = editStep(id, input, res, ctx)
  else if (tool === 'Write') drafts = writeStep(id, input, res, hasResult)
  else if (tool === 'MultiEdit') drafts = multiSteps(id, input, res)
  else if (tool === 'NotebookEdit') drafts = notebookStep(id, input, res)
  let left = ctx.budget
  return drafts.map(d => {
    const s = finish(d, { ...ctx, budget: left })
    left -= charTotal(s.hunks)
    return s
  })
}

// ---------------------------------------------------------------------------------------------
// Removes and moves run in Bash: rm, mv, git rm, git mv, in plain commands only.
// ---------------------------------------------------------------------------------------------

export type ShellOp = { op: 'rm'; path: string } | { op: 'mv'; from: string; to: string }

const MAX_OPS = 20

function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/**
 * The plain `rm`, `mv`, `git rm` and `git mv` commands in a Bash command line, with full paths. A line with anything
 * the mod cannot be sure of (a pipe, a variable, a glob, a redirect, a `cd`, an unbalanced quote) gives nothing.
 */
export function parseShell(command: string, cwd: string): ShellOp[] {
  if (!command || command.length > 1500 || !/\b(rm|mv)\b/.test(command)) return []
  const cmds: string[][] = []
  let cur: string[] = []
  let word = ''
  let inWord = false
  let q = ''
  const endWord = () => {
    if (inWord) cur.push(word)
    word = ''
    inWord = false
  }
  const endCmd = () => {
    endWord()
    if (cur.length) cmds.push(cur)
    cur = []
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (q) {
      if (c === q) q = ''
      else if (q === '"' && '$`\\!'.includes(c)) return []
      else word += c
      continue
    }
    if (c === '"' || c === "'") {
      q = c
      inWord = true
    } else if (c === ' ' || c === '\t') endWord()
    else if (c === ';') endCmd()
    else if (c === '&') {
      if (command[i + 1] !== '&') return []
      i++
      endCmd()
    } else if ('|$`\\<>(){}*?[]~!#\n\r'.includes(c)) return []
    else {
      word += c
      inWord = true
    }
  }
  if (q) return []
  endCmd()
  const abs = (p: string) => (p.startsWith('/') ? normalize(p) : cwd ? normalize(`${cwd}/${p}`) : '')
  const ops: ShellOp[] = []
  for (const tokens of cmds) {
    const head = tokens[0]
    if (head === 'cd' || head === 'pushd' || head === 'popd') return []
    const isGit = head === 'git'
    const name = isGit ? tokens[1] : head
    if (name !== 'rm' && name !== 'mv') continue
    const rest = tokens.slice(isGit ? 2 : 1)
    const args: string[] = []
    let flags = true
    for (const t of rest) {
      if (flags && t === '--') flags = false
      else if (flags && t.startsWith('-') && t.length > 1) {
        if (name === 'mv' && (/^-[a-zA-Z]*t/.test(t) || t.startsWith('--target-directory') || t === '-T')) return []
        if (isGit && name === 'rm' && (t === '--cached' || t === '-n' || t === '--dry-run')) return [] // the file stays on disk or nothing happens
        if (isGit && name === 'mv' && (t === '-n' || t === '--dry-run')) return []
      } else args.push(t)
    }
    if (name === 'rm') {
      if (!args.length) continue
      for (const a of args) {
        const p = abs(a)
        if (!p) return []
        ops.push({ op: 'rm', path: p })
      }
    } else {
      if (args.length < 2) continue
      const dest = abs(args[args.length - 1]!)
      if (!dest) return []
      for (const a of args.slice(0, -1)) {
        const p = abs(a)
        if (!p) return []
        ops.push({ op: 'mv', from: p, to: dest })
      }
    }
    if (ops.length > MAX_OPS) return []
  }
  return ops
}

/** What was on disk before the command ran, for one path. text is null for a file that is not text or too large to read. */
export type Fact = { kind: 'file' | 'dir' | 'none'; text: string | null }

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const dir = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'

/** Steps for the removes and moves of a Bash command that ran without error. `facts` is keyed by full path. */
export function stepsForShell(id: string, ops: ShellOp[], facts: Record<string, Fact | undefined>, ctx: Ctx): ReplayStep[] {
  const out: ReplayStep[] = []
  let left = ctx.budget
  const push = (d: Draft) => {
    const s = finish({ ...d, id: `${id}#${out.length + 1}` }, { ...ctx, budget: left })
    left -= charTotal(s.hunks)
    out.push(s)
  }
  for (const op of ops) {
    if (op.op === 'rm') {
      const f = facts[op.path]
      if (!f || f.kind === 'none') continue
      if (f.kind === 'dir') {
        push({ id, tool: 'Bash', abs: op.path, kind: 'delete', note: 'folder removed (its files are not listed one by one)', hunks: [], known: true })
      } else if (f.text === null || isBinaryPath(op.path)) {
        push({ id, tool: 'Bash', abs: op.path, kind: 'delete', note: 'file removed (not text, or too large to show)', hunks: [], known: true })
      } else {
        push({ id, tool: 'Bash', abs: op.path, kind: 'delete', note: 'file removed', hunks: wholeHunk(f.text, '-'), known: true })
      }
    } else {
      const f = facts[op.from]
      if (!f || f.kind === 'none') continue
      const into = facts[op.to]?.kind === 'dir'
      const to = into ? `${op.to.replace(/\/+$/, '')}/${base(op.from)}` : op.to
      if (to === op.from) continue
      const moved = dir(to) !== dir(op.from)
      push({ id, tool: 'Bash', abs: to, from: op.from, kind: 'rename', note: moved ? `moved from ${displayPath(op.from, ctx.cwd, ctx.home)}` : `renamed from ${base(op.from)}`, hunks: [], known: true })
    }
  }
  return out
}
