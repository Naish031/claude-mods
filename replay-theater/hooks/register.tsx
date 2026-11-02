// SPDX-License-Identifier: Apache-2.0
// Replay Theater, a modified version of Anthropic's sample (Copyright 2026 Anthropic PBC, Apache License 2.0). See LICENSE and NOTICE.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { ReplayHistory, ReplayMode, ReplayStep, ReplayTurn, ReplayView } from '../types'
import { pairRows, isGap, patchOf, rowsOf, unifiedText, type Pair, type Row } from './diff'
import type { Group } from './model'
import {
  HELP,
  clamp,
  emptyHistory,
  emptyPending,
  emptyView,
  groupOfStep,
  groupsOf,
  hintText,
  parseCommand,
  patchForSteps,
  plural,
  readSettings,
  stepChars,
  stepsOfGroup,
  stripRange,
  trimHistory,
  totals,
  turnAt,
  turnLine,
  visibleSteps,
  windowChunks,
  type Settings,
} from './model'
import { appendLog, errText, logLine, logPath, openRequestPath, parseFlags, patchPath, switchesPath, withHidden, type Flags } from './infra'
import { EDIT_TOOLS, TURN_CHARS, TURN_STEPS, parseShell, stepsForCall, stepsForShell, type Ctx, type Fact, type ShellOp } from './record'

// Replay Theater 0.2. Records the file edits Claude makes (Edit, Write, MultiEdit, NotebookEdit, and rm or mv run in
// Bash) once they have run, keeps the last few turns, and lets you step through them in a pane, one diff at a time.
//
// Derived from Anthropic's Replay Theater sample (Claude Code DevRel, Apache License 2.0, see LICENSE and NOTICE).
// Changed from the sample: see the list in README.md. The recording never blocks, changes or delays a tool call.
//
// Rules this mod follows:
// - Off when ~/.claude/claude-mods/switches.json has "replay-theater": false (read at event time, cached 1 s, no timer).
// - Fail open: an error here is logged and skipped. It never blocks, delays or changes a prompt or a tool call.
// - Log: ~/.claude/claude-mods/logs/replay-theater.log, one line per notable failure, never a file's text.

const NAME = 'replay-theater'
const PANE = 'replay-theater'
const CMD = 'replay'
const TITLE = 'Replay Theater'
const PANE_ROWS = 28
const PANE_COLUMNS = 76
const OFF_LINE = 'Replay Theater is off in ~/.claude/claude-mods/switches.json.'
const OFF_TEXT = 'Replay Theater is off. Turn it on by removing "replay-theater": false from ~/.claude/claude-mods/switches.json.'
const NO_EDITS = 'No file edits to replay yet. They are recorded as Claude makes them.'
const MAX_TOTAL_CHARS = 1_600_000
const SPLIT_MIN = 72 // columns a side by side view needs
const BAND_WAIT_MS = 200 // the band hides first, so the pane can take the keyboard

// State lives in $.state, not in module variables, so a reload of the mod keeps it.
const history = atom({ plugin: 'replay-theater', key: 'history' } as const, emptyHistory(), { shape: 'history-1' })
const pending = atom({ plugin: 'replay-theater', key: 'pending' } as const, emptyPending(), { shape: 'pending-1' })
const view = atom({ plugin: 'replay-theater', key: 'view' } as const, emptyView(), { shape: 'view-1' })

type Engine = EngineInterface
type Rec = Record<string, unknown>
type Els = ReturnType<Engine['ui']['resolve']>
type Press = { surface: RenderSurface }

// Module variables are lost on a reload, so they only hold things that can be found again.
let opts: Settings = readSettings({})
let homeDir = ''
let flagCache: (Flags & { at: number }) | undefined
let openCheckedAt = -1
let closedForOff = false
const lastLogged = new Map<string, number>()

// ---------------------------------------------------------------------------------------------
// Home folder, switch file, log file (the shared conventions of Naish's mods)
// ---------------------------------------------------------------------------------------------

async function getHome($: Engine): Promise<string> {
  if (homeDir) return homeDir
  try {
    homeDir = (await $.env.get('HOME')) ?? ''
  } catch {
    homeDir = ''
  }
  return homeDir
}

async function nowOf($: Engine): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return 0
  }
}

/** Reads the switch file at most once a second. A missing or broken file means on. No timer. */
async function readFlags($: Engine, force = false): Promise<Flags> {
  const now = await nowOf($)
  if (!force && flagCache && now >= flagCache.at && now - flagCache.at < 1000) return flagCache
  let flags: Flags = { off: false, hidden: false }
  try {
    const home = await getHome($)
    if (home && (await $.fs.exists(switchesPath(home)))) flags = parseFlags(String(await $.fs.read(switchesPath(home))))
  } catch {
    // Unreadable file: on.
  }
  flagCache = { ...flags, at: now }
  return flags
}

/** Sets or clears the hidden flag in the shared switch file, keeping every other line. False when it could not be saved. */
async function writeHidden($: Engine, value: boolean): Promise<boolean> {
  const home = await getHome($)
  if (!home) return false
  const path = switchesPath(home)
  const text = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined
  const next = withHidden(text, value)
  await $.fs.write(path, next)
  flagCache = { ...parseFlags(next), at: await nowOf($) }
  return true
}

/** One line for a notable failure. Never throws. The same line is written at most once every 30 seconds. */
async function log($: Engine, event: string, detail = '') {
  try {
    const home = await getHome($)
    if (!home) return
    const now = await nowOf($)
    const key = `${event}|${detail}`
    const before = lastLogged.get(key)
    if (before !== undefined && now >= before && now - before < 30_000) return
    if (lastLogged.size > 100) lastLogged.clear()
    lastLogged.set(key, now)
    let old = ''
    try {
      old = String(await $.fs.read(logPath(home)))
    } catch {
      // First line.
    }
    await $.fs.write(logPath(home), appendLog(old, logLine(now, event, detail)))
  } catch {
    // Nowhere left to report it.
  }
}

/** Runs a handler of a press and logs a failure instead of throwing. */
async function safely($: Engine, where: string, run: () => unknown) {
  try {
    await run()
  } catch (err) {
    await log($, where, errText(err))
  }
}

const tilde = (path: string, home: string) => (home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

async function cwdOf($: Engine): Promise<string> {
  try {
    return await $.session.cwd()
  } catch {
    return ''
  }
}

/** What was on disk before an rm or mv command, for each path it names. */
async function shellFacts($: Engine, ops: ShellOp[]): Promise<Record<string, Fact>> {
  const paths = new Set<string>()
  for (const op of ops) {
    if (op.op === 'rm') paths.add(op.path)
    else {
      paths.add(op.from)
      paths.add(op.to)
    }
  }
  const facts: Record<string, Fact> = {}
  const wantText = new Set(ops.filter(o => o.op === 'rm').map(o => (o as { path: string }).path))
  for (const path of paths) {
    try {
      const st = await $.fs.stat(path)
      if (st.kind === 'dir') facts[path] = { kind: 'dir', text: null }
      else if (st.kind === 'other') facts[path] = { kind: 'file', text: null }
      else if (!wantText.has(path) || st.isLink || st.size > 1_000_000) facts[path] = { kind: 'file', text: null }
      else {
        const text = String(await $.fs.read(path))
        facts[path] = { kind: 'file', text: text.includes('\u0000') ? null : text }
      }
    } catch {
      facts[path] = { kind: 'none', text: null }
    }
  }
  return facts
}

async function addSteps($: Engine, steps: ReplayStep[]) {
  if (!steps.length) return
  await update($, pending, p => {
    const take = steps.slice(0, Math.max(0, TURN_STEPS - p.steps.length))
    return {
      steps: [...p.steps, ...take],
      dropped: p.dropped + steps.length - take.length,
      chars: p.chars + take.reduce((n, s) => n + stepChars(s), 0),
    }
  })
}

async function record($: Engine, input: Rec, ran: Rec, ops: ShellOp[], facts: Record<string, Fact>) {
  // An edit that was refused or failed changed nothing, so it is not a step.
  if (ran.deny !== undefined || ran.isError === true) return
  const p = await read($, pending)
  const ctx: Ctx = {
    cwd: await cwdOf($),
    home: await getHome($),
    collapse: opts.collapse,
    now: await nowOf($),
    budget: TURN_CHARS - p.chars,
    helper: typeof input.agentId === 'string' && input.agentId !== '',
  }
  const id = String(input.tool_use_id ?? `call-${ctx.now}`)
  const steps = String(input.tool) === 'Bash' ? stepsForShell(id, ops, facts, ctx) : stepsForCall(input, ran.result, ctx)
  await addSteps($, steps)
}

/** The edits of the turn that ended become a turn of the replay. */
async function commitTurn($: Engine) {
  const p = await read($, pending)
  if (!p.steps.length) return
  const at = await nowOf($)
  await update($, pending, () => emptyPending())
  await update($, history, h => ({
    turns: trimHistory([...h.turns, { n: h.seq, at, steps: p.steps, dropped: p.dropped }], opts.keepTurns, MAX_TOTAL_CHARS),
    seq: h.seq + 1,
  }))
  // A pane left open on the newest turn follows it; one left on an older turn stays on that turn.
  await update($, view, v => (v.open ? (v.turn === 0 ? { ...v, index: 0, off: 0, top: 0 } : { ...v, turn: v.turn + 1 }) : v))
}

// ---------------------------------------------------------------------------------------------
// Opening and closing the pane
// ---------------------------------------------------------------------------------------------

async function openReplay($: Engine, o: { back?: number; mode?: ReplayMode; wait?: boolean } = {}): Promise<boolean> {
  const h = await read($, history)
  if (!h.turns.length) return false
  const back = clamp(o.back ?? 0, 0, h.turns.length - 1)
  // The state change hides the hint band: a pane only takes the keyboard while nothing else holds it.
  await update($, view, v => ({ ...v, open: true, inBand: false, turn: back, mode: o.mode ?? 'step', index: 0, off: 0, top: 0 }))
  if (o.wait) await $.clock.sleep(BAND_WAIT_MS)
  const placed = await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true, rows: PANE_ROWS, columns: PANE_COLUMNS })
  // No room for a pane: the replay is drawn in the band above the prompt instead.
  if (placed?.isPlaced === false) await update($, view, v => ({ ...v, inBand: true }))
  return true
}

async function closeReplay($: Engine) {
  const v = await read($, view)
  await update($, view, c => ({ ...c, open: false, inBand: false }))
  if (!v.inBand) await Promise.resolve($.ui.close({ id: PANE })).catch(() => undefined)
}

/** Keeps the pane and the switch file in step. Runs at events, never while drawing. */
async function sync($: Engine) {
  const flags = await readFlags($)
  if (flags.off || flags.hidden) {
    const v = await read($, view)
    if (v.open) {
      await closeReplay($)
      if (flags.off && !closedForOff) await log($, 'off', 'switched off: the pane was closed')
    }
    closedForOff = flags.off
  } else if (closedForOff) {
    closedForOff = false
  }
}

/** Honours an open request file left for this chat by a mods switch panel. Event time, once a second at most. */
async function takeOpenRequest($: Engine) {
  const now = await nowOf($)
  if (openCheckedAt >= 0 && now >= openCheckedAt && now - openCheckedAt < 1000) return
  openCheckedAt = now
  const home = await getHome($)
  if (!home) return
  const path = openRequestPath(home, await $.session.id())
  if (!(await $.fs.exists(path))) return
  await $.process.run(['rm', '-f', path])
  if ((await readFlags($)).off) return
  if (!(await openReplay($))) $.ui.toast('Replay Theater: no edits to replay yet.')
}

/** The upkeep done at each event, never allowed to throw. */
async function tick($: Engine, where: string) {
  try {
    await sync($)
    await takeOpenRequest($)
  } catch (err) {
    await log($, `${where} upkeep`, errText(err))
  }
}

// ---------------------------------------------------------------------------------------------
// Copying and saving a patch
// ---------------------------------------------------------------------------------------------

async function savePatch($: Engine, text: string): Promise<string> {
  try {
    const home = await getHome($)
    if (!home) return ''
    await $.fs.write(patchPath(home), text)
    return patchPath(home)
  } catch (err) {
    await log($, 'save', errText(err))
    return ''
  }
}

/** Copies a patch. Where the clipboard is out of reach it is saved to a file instead. Says what happened. */
async function copyPatch($: Engine, text: string, what: string, surface?: RenderSurface): Promise<{ done: 'copied' | 'saved' | 'failed'; path: string }> {
  let ok = false
  try {
    ok = (await $.ui.copy({ text, ...(surface ? { surface } : {}) })).isCopied
  } catch (err) {
    await log($, 'copy', errText(err))
  }
  if (ok) {
    $.ui.toast(`Copied ${what}.`)
    return { done: 'copied', path: '' }
  }
  const path = await savePatch($, text)
  const shown = tilde(path, await getHome($))
  $.ui.toast(path ? `The clipboard is out of reach. Saved ${what} to ${shown}.` : 'The clipboard is out of reach and the patch could not be saved.')
  return { done: path ? 'saved' : 'failed', path: shown }
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

type Kit = {
  els: Els
  surface: RenderSurface
  width: number
  win: number
  inBand: boolean
  v: ReplayView
  turns: ReplayTurn[]
  turn: ReplayTurn
  steps: ReplayStep[]
  groups: Group[]
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const kindColor = (s: ReplayStep) => (s.kind === 'create' ? 'success' : s.kind === 'delete' ? 'error' : s.kind === 'rename' ? 'warning' : undefined)

const trunc = (s: string, n: number) => (s.length <= n ? s : `…${s.slice(s.length - Math.max(1, n - 1))}`)

const setView = ($: Engine, where: string, change: (v: ReplayView) => ReplayView) => void safely($, where, () => update($, view, change))

/** Counts the rows a step shows: the diff lines (or side by side rows), or one line for a note or a folded diff. */
function stepCount(step: ReplayStep, v: ReplayView, split: boolean): number {
  if (isStub(step, v)) return 1
  const rows = rowsOf(step.hunks)
  return split ? pairRows(rows).length : rows.length
}

const isFolded = (step: ReplayStep, v: ReplayView) => step.why !== '' && !v.expanded.includes(step.id)
const isStub = (step: ReplayStep, v: ReplayView) => step.kind === 'binary' || !step.hunks.length || isFolded(step, v)

function stubText(step: ReplayStep, v: ReplayView): string {
  if (step.kind === 'binary' || step.kind === 'rename' || (step.kind === 'delete' && !step.hunks.length)) return step.note
  if (!step.hunks.length) return step.more > 0 ? `(${plural(step.more, 'line')} changed, not kept)` : '(no line changes)'
  if (isFolded(step, v)) return `Folded: ${step.why}. +${step.add} -${step.del}. Press Expand to read it.`
  return ''
}

function sideCell(r: Row | undefined, side: 'l' | 'r', numW: number): string {
  if (!r) return ''
  const no = side === 'l' ? (r.k === '+' ? '' : r.o) : r.k === '-' ? '' : r.n
  const sign = r.k === ' ' ? ' ' : r.k
  return `${String(no).padStart(numW)} ${sign} ${r.t.replace(/\t/g, '  ').replace(/\r/g, '')}`
}

/** A slice of one step's diff: unified (the engine's own diff drawing, with syntax colours) or side by side. */
function diffSlice(kit: Kit, step: ReplayStep, from: number, to: number) {
  const { Box, Text, Code } = kit.els
  const { v, width } = kit
  if (isStub(step, v)) return <Text dimColor={!isFolded(step, v)} color={isFolded(step, v) ? 'warning' : undefined}>{stubText(step, v)}</Text>
  const rows = rowsOf(step.hunks)
  if (v.split && width >= SPLIT_MIN) {
    const pairs = pairRows(rows)
    const half = Math.floor((width - 3) / 2)
    const maxNo = rows.reduce((m, r) => Math.max(m, r.o, r.n), 0)
    const numW = String(maxNo).length
    const out = pairs.slice(from, to).map((p: Pair, i) => {
      const at = from + i
      const gap = isGap(pairs, at)
      const lk = p.l?.k
      const rk = p.r?.k
      return (
        <Box flexDirection="column">
          {gap ? <Text dimColor>{'⋯'}</Text> : null}
          <Box flexDirection="row">
            <Box width={half} flexShrink={0}>
              <Text color={lk === '-' ? 'error' : undefined} dimColor={lk === ' '} wrap="truncate-end">{sideCell(p.l, 'l', numW) || ' '}</Text>
            </Box>
            <Text dimColor>{' │ '}</Text>
            <Box width={half} flexShrink={0}>
              <Text color={rk === '+' ? 'success' : undefined} dimColor={rk === ' '} wrap="truncate-end">{sideCell(p.r, 'r', numW) || ' '}</Text>
            </Box>
          </Box>
        </Box>
      )
    })
    return <Box flexDirection="column">{out}</Box>
  }
  const props = { source: unifiedText(rows, from, to), format: 'diff' as const, path: step.abs, wrap: step.why ? ('truncate-end' as const) : ('wrap' as const), ...(step.lang ? { language: step.lang } : {}) }
  return <Code {...props} />
}

const label = (s: ReplayStep) => [s.tool, s.note, s.label, s.helper ? 'helper' : '', s.known || s.hunks.length === 0 ? '' : 'line numbers not known'].filter(Boolean).join(' · ')

function header(kit: Kit) {
  const { Box, Text } = kit.els
  const { v, steps, groups, turn, turns } = kit
  const k = clamp(v.index, 0, steps.length - 1)
  const unit = v.mode === 'step' ? `step ${k + 1} of ${steps.length}` : v.mode === 'file' ? `file ${groupOfStep(groups, k) + 1} of ${groups.length}` : plural(groups.length, 'file')
  const t = totals(steps)
  const back = turns.length - 1 - turns.indexOf(turn)
  const which = turns.length > 1 ? `Turn ${turns.length - back} of ${turns.length}${back === 0 ? ' (last)' : ''}` : 'Last turn'
  const all = turn.steps.length
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">▶ Replay Theater</Text>
        <Text bold>{unit}</Text>
      </Box>
      <Text dimColor wrap="truncate-end">{`${which} · ${plural(t.edits, 'edit')} · ${plural(t.files, 'file')} · +${t.add} -${t.del}${turn.dropped > 0 ? ` · ${turn.dropped} more not kept` : ''}`}</Text>
      {v.filter ? <Text color="warning" wrap="truncate-end">{`filter: ${v.filter} (${steps.length} of ${all} edits)`}</Text> : null}
    </Box>
  )
}

function strip(kit: Kit) {
  const { Box, Text } = kit.els
  const { v, steps, groups, width } = kit
  const k = clamp(v.index, 0, steps.length - 1)
  const file = v.mode === 'file'
  const total = file ? groups.length : steps.length
  const current = file ? groupOfStep(groups, k) : k
  const wide = String(total).length + 2
  const { from, to } = stripRange(total, current, Math.floor((width - 2) / wide) - 1)
  const cells = []
  for (let i = from; i < to; i++) {
    const here = i === current
    const kind = file ? steps[groups[i]!.first]! : steps[i]!
    cells.push(<Text inverse={here} color={here ? 'claude' : kindColor(kind)} dimColor={!here && !kindColor(kind)}>{` ${i + 1} `}</Text>)
  }
  return (
    <Box flexDirection="row">
      {from > 0 ? <Text dimColor>{'… '}</Text> : null}
      {cells}
      {to < total ? <Text dimColor>{' …'}</Text> : null}
    </Box>
  )
}

function fileLine(kit: Kit, step: ReplayStep) {
  const { Box, Text } = kit.els
  return (
    <Box flexDirection="column">
      <Text bold color="suggestion" wrap="truncate-start">{step.from && step.kind === 'rename' ? `${step.from} → ${step.file}` : step.file}</Text>
      <Box flexDirection="row" gap={2}>
        <Text dimColor wrap="truncate-end">{label(step)}</Text>
        <Text color="success">{`+${step.add}`}</Text>
        <Text color="error">{`-${step.del}`}</Text>
      </Box>
    </Box>
  )
}

/** The body of the step and file views: the diffs of a list of steps, cut to a window. Returns the node and how many rows there are. */
function diffArea(kit: Kit, idxs: number[]) {
  const { Box, Text } = kit.els
  const { v, steps, win, width } = kit
  const split = v.split && width >= SPLIT_MIN
  const counts = idxs.map(i => stepCount(steps[i]!, v, split))
  const total = counts.reduce((a, b) => a + b, 0)
  const off = clamp(v.off, 0, total - win)
  const chunks = windowChunks(counts, off, win)
  const many = idxs.length > 1
  const parts = chunks.map(c => {
    const step = steps[idxs[c.i]!]!
    return (
      <Box flexDirection="column">
        {many ? (
          <Box flexDirection="row" gap={2}>
            <Text bold dimColor wrap="truncate-end">{`${c.i + 1}. ${label(step)}`}</Text>
            <Text color="success">{`+${step.add}`}</Text>
            <Text color="error">{`-${step.del}`}</Text>
          </Box>
        ) : null}
        {diffSlice(kit, step, c.from, c.to)}
      </Box>
    )
  })
  const more = idxs.reduce((n, i) => n + steps[i]!.more, 0)
  const shown = chunks.length ? Math.min(total, off + win) : 0
  const foot: string[] = []
  if (total > win) foot.push(`${split ? 'rows' : 'lines'} ${off + 1}-${shown} of ${total}`)
  if (more > 0) foot.push(`${plural(more, 'more line')} not kept`)
  if (v.split && !split) foot.push(`side by side needs ${SPLIT_MIN} columns`)
  return {
    total,
    off,
    node: (
      <Box flexDirection="column" marginTop={1}>
        {parts}
        {foot.length ? <Text dimColor>{foot.join(' · ')}</Text> : null}
      </Box>
    ),
  }
}

function overviewArea($: Engine, kit: Kit) {
  const { Box, Text, Button } = kit.els
  const { v, steps, groups, win, width } = kit
  const page = clamp(win, 5, 14)
  const top = clamp(v.top, 0, groups.length - page)
  const shown = groups.slice(top, top + page)
  const rows = shown.map((g, n) => {
    const gi = top + n
    const tag = g.kinds.length === 1 ? ({ create: 'new', delete: 'deleted', rename: 'moved', rewrite: 'rewrite', binary: 'binary', notebook: 'notebook', unchanged: 'same' } as Rec)[g.kinds[0]!] : ''
    const extra = `${g.count > 1 ? `  x${g.count}` : ''}${tag ? `  ${tag}` : ''}  +${g.add} -${g.del}`
    const text = `${trunc(g.file, Math.max(12, width - extra.length - 6))}${extra}`
    return <Button key={`file-${gi}`} plain label={text} {...(n === 0 ? { autoFocus: true as const } : {})} onPress={() => setView($, 'jump', c => ({ ...c, mode: 'step', index: g.first, off: 0 }))} />
  })
  void steps
  const foot = groups.length > page ? `files ${top + 1}-${top + shown.length} of ${groups.length}` : ''
  return {
    total: groups.length,
    page,
    top,
    node: (
      <Box flexDirection="column" marginTop={1}>
        {rows}
        {foot ? <Text dimColor>{foot}</Text> : null}
      </Box>
    ),
  }
}

function keysLine(kit: Kit) {
  const { Text } = kit.els
  const text = kit.v.mode === 'overview' ? 'keys: Enter opens a file · v steps · y copy patch · o l turns · c close' : 'keys: n p step · f b file · v view · s split · y copy · e expand · u d scroll · o l turn · c close'
  return <Text dimColor wrap="truncate-end">{text}</Text>
}

async function drawReplay($: Engine, e: Parameters<Engine['ui']['resolve']>[0], inBand: boolean) {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const props = ((e as unknown as { props?: Rec }).props ?? {}) as Rec
  const surface = (e as unknown as { surface: RenderSurface }).surface
  const scroll = (props.scroll ?? {}) as Rec
  const width = Math.max(30, (num(props.bodyColumns) || num((e as unknown as Rec).bodyColumns) || 80) - 2)
  const room = num(scroll.bodyRows) || num(props.maxRows) || num((e as unknown as Rec).maxRows)
  const win = inBand ? clamp((room || 20) - 13, 3, 12) : clamp((room || PANE_ROWS) - 12, 6, 48)

  const flags = await readFlags($).catch((): Flags => ({ off: false, hidden: false }))
  const closeBtn = <Button key="close" label="Close" hotkey="c" onPress={() => void safely($, 'close', () => closeReplay($))} />
  const frame = (kids: unknown) => (inBand ? <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>{kids}</Box> : <Box flexDirection="column">{kids}</Box>)
  if (flags.off) return frame([<Text dimColor>{OFF_LINE}</Text>, closeBtn])

  const hist: ReplayHistory = await read($, history)
  const v: ReplayView = await read($, view)
  if (!hist.turns.length) return frame([<Text dimColor>{NO_EDITS}</Text>, closeBtn])

  const turn = turnAt(hist.turns, v.turn)!
  const steps = visibleSteps(turn, v.filter)
  const groups = groupsOf(steps)
  const kit: Kit = { els, surface, width, win, inBand, v, turns: hist.turns, turn, steps, groups }
  const Input = 'Input' in els ? els.Input : undefined

  const setIn = (change: (c: ReplayView) => ReplayView) => setView($, 'press', change)
  const total = steps.length

  // Nothing matches the filter.
  if (!total) {
    return frame([
      header({ ...kit, v: { ...v, index: 0 } }),
      <Text color="warning">{`No file matches "${v.filter}". Clear the filter to see all ${plural(turn.steps.length, 'edit')}.`}</Text>,
      <Box flexDirection="row" gap={1}>
        <Button key="clear" label="Clear filter" hotkey="x" variant="primary" onPress={() => setIn(c => ({ ...c, filter: '', index: 0, off: 0, top: 0 }))} />
        {closeBtn}
      </Box>,
    ])
  }

  const k = clamp(v.index, 0, total - 1)
  const gi = groupOfStep(groups, k)
  const mode = v.mode
  const group = groups[gi]
  const idxs = mode === 'step' ? [k] : mode === 'file' ? stepsOfGroup(steps, group) : []
  const cur = steps[k]!

  const go = (to: number) => setIn(c => ({ ...c, index: clamp(to, 0, total - 1), off: 0 }))
  const goGroup = (to: number) => setIn(c => ({ ...c, index: groups[clamp(to, 0, groups.length - 1)]!.first, off: 0 }))
  const unitBack = () => (mode === 'file' ? goGroup(gi - 1) : go(k - 1))
  const unitNext = () => (mode === 'file' ? goGroup(gi + 1) : go(k + 1))
  const cycle = () => setIn(c => ({ ...c, mode: c.mode === 'step' ? 'file' : c.mode === 'file' ? 'overview' : 'step', off: 0, top: 0 }))
  const turnBy = (by: number) => setIn(c => ({ ...c, turn: clamp(c.turn + by, 0, hist.turns.length - 1), index: 0, off: 0, top: 0 }))
  const toggleSplit = () => setIn(c => ({ ...c, split: !c.split, off: 0 }))
  const folded = idxs.filter(i => steps[i]!.why !== '')
  const toggleFold = () =>
    setIn(c => {
      const ids = folded.map(i => steps[i]!.id)
      const open = ids.every(id => c.expanded.includes(id))
      return { ...c, off: 0, expanded: open ? c.expanded.filter(id => !ids.includes(id)) : [...new Set([...c.expanded, ...ids])] }
    })
  const copy = (press: Press) =>
    void safely($, 'copy', async () => {
      const list = mode === 'overview' ? steps : mode === 'file' ? idxs.map(i => steps[i]!) : [cur]
      const text = list.length === 1 ? `${patchOf(list[0]!)}\n` : patchForSteps(list)
      await copyPatch($, text, mode === 'overview' ? `the patch of ${plural(list.length, 'edit')}` : mode === 'file' ? `the patch of ${plural(list.length, 'edit')} to ${cur.file}` : `the patch of ${cur.file}`, press.surface)
    })

  const area = mode === 'overview' ? overviewArea($, kit) : diffArea(kit, idxs)
  const canScroll = mode === 'overview' ? area.total > (area as { page: number }).page : area.total > win
  const scrollBy = (by: number) =>
    setIn(c =>
      mode === 'overview'
        ? { ...c, top: clamp(c.top + by, 0, groups.length - clamp(win, 5, 14)) }
        : { ...c, off: clamp(c.off + by, 0, area.total - win) },
    )
  const stepSize = mode === 'overview' ? clamp(win, 5, 14) - 1 : Math.max(1, win - 2)

  const move = [
    mode === 'overview' ? null : <Button key="prev" label="◀ Prev" hotkey="p" onPress={unitBack} />,
    mode === 'overview' ? null : <Button key="next" label="Next ▶" hotkey="n" variant="primary" autoFocus onPress={unitNext} />,
    mode === 'step' && groups.length > 1 ? <Button key="file-back" label="◀ File" hotkey="b" onPress={() => goGroup(gi - 1)} /> : null,
    mode === 'step' && groups.length > 1 ? <Button key="file-next" label="File ▶" hotkey="f" onPress={() => goGroup(gi + 1)} /> : null,
    closeBtn,
  ]
  const more = [
    <Button key="view" label={`View: ${mode}`} hotkey="v" onPress={cycle} />,
    mode === 'overview' || width < SPLIT_MIN ? null : <Button key="split" label={v.split ? 'Unified' : 'Split'} hotkey="s" onPress={toggleSplit} />,
    <Button key="copy" label={mode === 'overview' ? 'Copy patch' : 'Copy diff'} hotkey="y" onPress={copy} />,
    hist.turns.length > 1 ? <Button key="older" label="◀ Older" hotkey="o" onPress={() => turnBy(1)} /> : null,
    hist.turns.length > 1 ? <Button key="newer" label="Newer ▶" hotkey="l" onPress={() => turnBy(-1)} /> : null,
    folded.length ? <Button key="fold" label={folded.every(i => v.expanded.includes(steps[i]!.id)) ? 'Fold' : 'Expand'} hotkey="e" onPress={toggleFold} /> : null,
    canScroll ? <Button key="up" label="▲" hotkey="u" onPress={() => scrollBy(-stepSize)} /> : null,
    canScroll ? <Button key="down" label="▼" hotkey="d" onPress={() => scrollBy(stepSize)} /> : null,
  ]

  const filterRow = Input ? (
    <Input key="filter" label="Show only" placeholder="liquid, *.json, sections/, !locales" value={v.filter} submitLabel="filter" onSubmit={(t: string) => setIn(c => ({ ...c, filter: t.trim(), index: 0, off: 0, top: 0 }))} />
  ) : null

  return frame([
    header(kit),
    mode === 'overview' ? null : strip(kit),
    mode === 'overview' ? null : fileLine(kit, cur),
    area.node,
    mode === 'overview' ? filterRow : null,
    <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>{move}</Box>,
    <Box flexDirection="row" flexWrap="wrap" gap={1}>{more}</Box>,
    keysLine(kit),
  ])
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

async function runCommand($: Engine, args: string): Promise<{ text: string }> {
  const cmd = parseCommand(args)
  if (cmd.kind === 'bad') return { text: cmd.text }
  if (cmd.kind === 'help') return { text: HELP }
  const flags = await readFlags($, true)
  const h = await read($, history)
  const v = await read($, view)

  if (cmd.kind === 'status') {
    const state = flags.off ? 'off in the mods switch file' : flags.hidden ? 'on, hint hidden' : 'on'
    const edits = h.turns.reduce((n, t) => n + t.steps.length, 0)
    return {
      text: `Replay Theater is ${state}. ${plural(h.turns.length, 'turn')} kept (up to ${opts.keepTurns}), ${plural(edits, 'edit')}. Layout: ${v.split ? 'side by side' : 'unified'}. Filter: ${v.filter || 'none'}. ${opts.collapse ? `Folds diffs over ${opts.collapse} lines` : 'Never folds on size'}. Hint: ${opts.showHint ? 'on' : 'off'}.`,
    }
  }
  if (flags.off) return { text: OFF_TEXT }

  if (cmd.kind === 'hide' || cmd.kind === 'show') {
    const want = cmd.kind === 'hide'
    try {
      if (!(await writeHidden($, want))) return { text: 'Could not find the home folder, so the choice was not saved.' }
    } catch (err) {
      await log($, want ? 'hide' : 'show', errText(err))
      return { text: 'Could not change ~/.claude/claude-mods/switches.json, so the choice was not saved.' }
    }
    if (want) await closeReplay($)
    return { text: want ? 'Replay Theater hidden. Type /replay show to bring the hint back.' : 'Replay Theater shown again.' }
  }

  // Anything else uses the replay. Typing /replay shows a hidden mod again, as the sample did.
  if (flags.hidden) await writeHidden($, false).catch(err => log($, 'show', errText(err)))

  if (cmd.kind === 'list') {
    if (!h.turns.length) return { text: NO_EDITS }
    const lines = [...h.turns].reverse().map((t, i) => `${i + 1}. ${turnLine(t, i)}`)
    return { text: `Turns kept, newest first:\n${lines.join('\n')}\nOpen one with /replay <number>.` }
  }
  if (cmd.kind === 'view') {
    await update($, view, c => ({ ...c, split: cmd.split, off: 0 }))
    return { text: `Replay Theater now shows diffs ${cmd.split ? `side by side (needs ${SPLIT_MIN} columns, else one column)` : 'in one column'}.` }
  }
  if (cmd.kind === 'filter') {
    await update($, view, c => ({ ...c, filter: cmd.text, index: 0, off: 0, top: 0 }))
    if (!cmd.text) return { text: 'Replay filter cleared.' }
    const turn = turnAt(h.turns, v.turn)
    const n = visibleSteps(turn, cmd.text).length
    return { text: `Replay shows only files matching "${cmd.text}": ${plural(n, 'edit')} in the turn on show. /replay filter clears it.` }
  }
  if (cmd.kind === 'copy' || cmd.kind === 'save') {
    if (!h.turns.length) return { text: NO_EDITS }
    const turn = turnAt(h.turns, cmd.kind === 'copy' ? cmd.turn : v.open ? v.turn : 0)!
    const steps = visibleSteps(turn, v.filter)
    if (!steps.length) return { text: `No file matches "${v.filter}". /replay filter clears it.` }
    const text = patchForSteps(steps)
    const what = `the patch of ${plural(steps.length, 'edit')}`
    if (cmd.kind === 'save') {
      const path = await savePatch($, text)
      return { text: path ? `Saved ${what} to ${tilde(path, await getHome($))}.` : 'Could not save the patch.' }
    }
    const r = await copyPatch($, text, what)
    return { text: r.done === 'copied' ? `Copied ${what}.` : r.done === 'saved' ? `The clipboard is out of reach. Saved ${what} to ${r.path}.` : 'Could not copy or save the patch.' }
  }

  // open
  if (!h.turns.length) return { text: 'Replay Theater: no edits to replay yet.' }
  if (cmd.turn >= h.turns.length) return { text: `Only ${plural(h.turns.length, 'turn')} kept. Type /replay list.` }
  const opened = await openReplay($, { back: cmd.turn, ...(cmd.mode ? { mode: cmd.mode } : {}) })
  const turn = turnAt(h.turns, cmd.turn)!
  return { text: opened ? `Replay Theater: ${plural(turn.steps.length, 'edit')}` : 'Replay Theater: no edits to replay yet.' }
}

// ---------------------------------------------------------------------------------------------
// The hooks
// ---------------------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  opts = readSettings(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      await $.command.register({
        name: CMD,
        description: 'Replay Theater: step through the file edits Claude made, one diff at a time',
        argumentHint: '[turn | list | files | file | filter <text> | split | unified | copy | save | status | help]',
      })
    } catch (err) {
      await log($, 'register', errText(err))
    }
    try {
      await update($, view, v => (v.filter || v.open || v.index ? v : { ...v, split: opts.split }))
      await tick($, 'start')
    } catch (err) {
      await log($, 'start', errText(err))
    }
    return result
  })

  on('command.run', { command: CMD }, async ($, e) => {
    try {
      return await runCommand($, e.args ?? '')
    } catch (err) {
      await log($, 'command', errText(err))
      return { text: 'Replay Theater hit a problem. It is written in ~/.claude/claude-mods/logs/replay-theater.log.' }
    }
  }).catch(() => ({ text: 'Replay Theater hit a problem. It is written in ~/.claude/claude-mods/logs/replay-theater.log.' }))

  // Records each edit once it has run, then hands the result on untouched. Never blocks or changes the call.
  on('tool.call', { tool: /^(Edit|Write|MultiEdit|NotebookEdit|Bash)$/ }, async ($, e, next) => {
    const tool = String(e.tool)
    if (!EDIT_TOOLS.has(tool) && tool !== 'Bash') return next(e)
    const input = e as unknown as Rec
    let isOn = false
    let ops: ShellOp[] = []
    let facts: Record<string, Fact> = {}
    try {
      isOn = !(await readFlags($)).off
      if (isOn && tool === 'Bash') {
        ops = parseShell(String(input.command ?? ''), await cwdOf($))
        if (ops.length) facts = await shellFacts($, ops)
      }
    } catch (err) {
      ops = []
      await log($, 'prepare', errText(err))
    }
    const ran = await next(e)
    if (isOn) {
      try {
        await record($, input, ran as unknown as Rec, ops, facts)
      } catch (err) {
        await log($, 'record', `${tool}: ${errText(err)}`)
      }
    }
    await tick($, 'tool')
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      try {
        const p = await read($, pending)
        if (p.steps.length || p.dropped) await update($, pending, () => emptyPending())
        await tick($, 'turn')
      } catch (err) {
        await log($, 'turn.start', errText(err))
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // At the end of a main-loop turn, its edits become a turn of the replay. Edits by helpers are part of it.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      if (!e.agentId && !(await readFlags($)).off) await commitTurn($)
      await tick($, 'turn')
    } catch (err) {
      await log($, 'turn.complete', errText(err))
    }
    return result
  }).catch(($, e, next) => next(e))

  // The band above the prompt: the hint and a button that opens the pane, drawn under the other mods' bands.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      const flags = await readFlags($)
      if (flags.off || flags.hidden) return next(e)
      const v = await read($, view)
      if (v.open && v.inBand) return await drawReplay($, e, true)
      if (!opts.showHint || e.props.hasSurvey || v.open) return next(e)
      const hist = await read($, history)
      const last = hist.turns[hist.turns.length - 1]
      if (!last) return next(e)
      const rest = await next(e)
      const { Box, Text, Button } = $.ui.resolve(e)
      const t = totals(last.steps)
      const band = (
        <Box key="replay-band" flexDirection="row" gap={2} paddingX={1}>
          <Text color="claude" bold>{hintText(t.edits)}</Text>
          <Text dimColor>{`${plural(t.files, 'file')}, +${t.add} -${t.del}`}</Text>
          <Button key="open-replay" label="Replay" hotkey="r" onPress={() => void safely($, 'open', () => openReplay($, { wait: true }))} />
        </Box>
      )
      return rest ? <Box flexDirection="column">{rest}{band}</Box> : band
    } catch (err) {
      await log($, 'band', errText(err))
      return next(e)
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    try {
      return await drawReplay($, e, false)
    } catch (err) {
      await log($, 'pane', errText(err))
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>Replay Theater hit a problem. See ~/.claude/claude-mods/logs/replay-theater.log.</Text>
    }
  }).catch(($, e, next) => next(e))

  // The person closed the pane (Escape or its close mark): keep our flag in step.
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) await safely($, 'close', () => update($, view, v => (v.open ? { ...v, open: false, inBand: false } : v)))
    return result
  }).catch(($, e, next) => next(e))
}
