import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { HandoffPanel as Panel, HandoffStep as Step } from '../types'
import {
  DEFAULTS,
  bar,
  cleanReply,
  digest,
  draftText,
  expandHome,
  gatherLinks,
  gatherTools,
  handoffPrompt,
  isTransient,
  newChatLink,
  offerThreshold,
  parseSwitches,
  plural,
  rankFiles,
  readSettings,
  redact,
  short,
  slugOf,
  stampOf,
  tilde,
  wordCount,
} from './core'
import type { FileHit, Gathered, Settings } from './core'

// Handoff: when a chat gets long, write a handoff of the whole chat, then copy it
// or start a fresh chat with it. See README.md for the full list of what it does.
//
// Rules this mod follows:
// - Off when ~/.claude/claude-mods/switches.json has "handoff": false (read at event time, cached 1 s).
// - Fail open: an error here is logged and never blocks, delays or changes a prompt or a tool call.
// - Log: ~/.claude/claude-mods/logs/handoff.log, one line per event, never the chat's text.

const NAME = 'handoff'
const WATCH_MS = 5000 // the only timer: looks for request files left by other mods
const TICK_MS = 200 // moves the bars while a handoff is being written
const MIN_STEP_MS = 350 // a quick step still shows its bar filling, so the rows read one by one
const WRITE_SCALE_MS = 40_000 // the writing bar creeps toward full on this time scale
const STALE_TURN_MS = 15 * 60_000 // a turn flag older than this is assumed lost
const PET_WAIT_STEPS = 120 // Claude Pet gets 60 s to answer
const MAX_MAP = 40 // chats remembered in the store

const LABELS = ['Reading the chat', 'Finding the files you used', 'Listing skills, tools and links', 'Writing the handoff', 'Saving and checking']
const SPIN = ['◐', '◓', '◑', '◒']

// One state value for the whole band: offer, steps, buttons. `shape` makes a reload decline an older layout.
const PANEL = atom({ plugin: 'handoff', key: 'panel' } as const, null as Panel | null, { shape: 'panel-1' })

// ---------------------------------------------------------------------------
// Module variables. A reload resets them; the band itself lives in $.state.

let opts: Settings = DEFAULTS
let home = ''
let ready = false // setup ran in this copy of the module
let busy = false
let runSeq = 0
let cancelledTo = 0 // runs up to this number were cancelled
let turnRunning = false
let turnAt = 0 // 0 = unknown yet
// A handoff asked for in the middle of a turn: it starts when the turn ends, because a fork while a
// tool call is open would send a tool use with no result.
let queued: { focus: string; source: string } | null = null
let lastFocus = ''
let ticker: { cancel: () => void } | null = null
let watcher: { cancel: () => void } | null = null
let running = -1
let stepAt = 0
let writeAt = 0
let writeTag = ''
let writeMs = 0
let snoozeSid = ''
let lastSid = ''
let snoozedTo = 0
let swAt = -1
let swOff = false
let logReady = false
let platform: 'mac' | 'linux' | 'win' | '' = ''

type Engine = EngineInterface
type Stored = { path: string; at: number; sid: string; isDraft: boolean }
class Stop extends Error {}

const msg = (err: unknown) => String(err instanceof Error ? err.message : err).slice(0, 200)

// ---------------------------------------------------------------------------
// Paths, the on/off switch and the log

async function findHome($: Engine) {
  const h = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined))
  if (h) return h.replace(/\/+$/, '')
  return $.plugin.root.split('/.claude/')[0] ?? ''
}

/** The id of this chat (it changes on /clear) and the home folder; both asked for each time, never trusted from a reload. */
async function ctx($: Engine) {
  if (!home) home = await findHome($)
  lastSid = (await $.session.id().catch(() => '')) || lastSid
  return lastSid
}

const modsDir = () => `${home}/.claude/claude-mods`
const switchesFile = () => `${modsDir()}/switches.json`
const logFile = () => `${modsDir()}/logs/handoff.log`
const requestsDir = () => `${modsDir()}/requests`
const petDir = () => `${home}/.claude/pet`
const saveDir = () => {
  if (!opts.saveFolder) return `${home}/.claude/handoffs`
  const p = expandHome(opts.saveFolder, home)
  return p.startsWith('/') ? p.replace(/\/+$/, '') : `${home}/${p}`.replace(/\/+$/, '')
}

/** Off only when the switches file says "handoff": false. A missing or broken file means on. */
async function isOn($: Engine) {
  const now = await $.clock.now().catch(() => 0)
  if (swAt >= 0 && now >= swAt && now - swAt < 1000) return !swOff
  swAt = now
  try {
    if (!home) home = await findHome($)
    swOff = parseSwitches(String(await $.fs.read(switchesFile())))[NAME] === false
  } catch {
    swOff = false
  }
  return !swOff
}

/** One line per notable event. Never throws. Never holds the chat's text. */
async function log($: Engine, line: string, sid = '') {
  try {
    if (!home) home = await findHome($)
    const path = logFile()
    if (!logReady) {
      await $.process.run(['mkdir', '-p', path.slice(0, path.lastIndexOf('/'))])
      logReady = true
    }
    const at = new Date(await $.clock.now()).toISOString()
    // tee -a appends in one write, so two chats logging at once do not lose lines.
    await $.process.run(['tee', '-a', path], { stdin: `${at} ${(sid || lastSid).slice(0, 8) || '--------'} ${line}\n`, timeoutMs: 5000 })
  } catch {
    // The log must never break a run.
  }
}

/** Keeps the log from growing for ever: past 512 KB it moves to handoff.log.1. */
async function rotateLog($: Engine) {
  try {
    const s = await $.fs.stat(logFile())
    if (s.size > 512 * 1024) await $.process.run(['mv', '-f', logFile(), `${logFile()}.1`])
  } catch {
    // No log yet.
  }
}

async function osName($: Engine) {
  if (platform) return platform
  try {
    const r = await $.process.run(['uname', '-s'], { timeoutMs: 3000 })
    platform = r.exitCode !== 0 ? 'win' : /Darwin/i.test(r.stdout) ? 'mac' : 'linux'
  } catch {
    platform = 'win'
  }
  return platform
}

/** Puts text on the clipboard: the surface's own copy first, then the machine's clipboard tool. */
async function clipboard($: Engine, text: string, surface?: string) {
  try {
    const r = await $.ui.copy(surface ? ({ text, surface } as never) : { text })
    if (r.isCopied) return true
  } catch {
    // Fall through to the machine's tool.
  }
  const os = await osName($)
  const tools =
    os === 'mac' ? [['pbcopy']] : os === 'win' ? [['clip']] : [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']]
  for (const argv of tools) {
    try {
      const r = await $.process.run(argv, { stdin: text, timeoutMs: 5000 })
      if (r.exitCode === 0) return true
    } catch {
      // Try the next tool.
    }
  }
  return false
}

/** Opens a file or a link with the machine's own opener. True when it was accepted. */
async function opener($: Engine, target: string) {
  const os = await osName($)
  const argv = os === 'mac' ? ['open', target] : os === 'win' ? ['cmd', '/c', 'start', '', target] : ['xdg-open', target]
  try {
    return (await $.process.run(argv, { timeoutMs: 10_000 })).exitCode === 0
  } catch {
    return false
  }
}

function toast($: Engine, text: string) {
  try {
    $.ui.toast(text)
  } catch {
    // A toast is only a hint.
  }
}

// ---------------------------------------------------------------------------
// The panel

const freshSteps = (): Step[] => LABELS.map(label => ({ label, detail: 'waiting', status: 'wait', progress: 0 }))

const blank = (phase: Panel['phase'], tokens: number, percent: number, forced = false): Panel => ({
  phase,
  tokens,
  percent,
  forced,
  steps: freshSteps(),
  tick: 0,
  file: '',
  path: '',
  isDraft: false,
  words: 0,
  redacted: 0,
  error: '',
  note: '',
  preview: [],
})

const getPanel = ($: Engine) => read($, PANEL)
const setPanel = ($: Engine, p: Panel | null) => update($, PANEL, () => p)
const patchPanel = ($: Engine, fn: (p: Panel) => Panel) => update($, PANEL, p => (p ? fn(p) : p))
const setNote = ($: Engine, note: string) => patchPanel($, p => ({ ...p, note }))
const setStep = (p: Panel, i: number, change: Partial<Step>): Panel => ({ ...p, steps: p.steps.map((s, k) => (k === i ? { ...s, ...change } : s)) })

async function usageNow($: Engine) {
  try {
    const { context } = await $.session.usage()
    return { tokens: context.tokens ?? 0, percent: context.percent ?? 0, window: context.window ?? 0 }
  } catch {
    return { tokens: 0, percent: 0, window: 0 }
  }
}

/** Moves the spinner and the running step's bar. */
async function tick($: Engine) {
  const now = await $.clock.now()
  await patchPanel($, p => {
    if (p.phase !== 'working') return p
    const steps = p.steps.map((s, k) => {
      if (k !== running || s.status !== 'run') return s
      if (k === 3) {
        const t = now - writeAt
        return { ...s, progress: Math.min(0.95, 1 - Math.exp(-t / WRITE_SCALE_MS)), detail: `${Math.round(t / 1000)} s${writeTag}` }
      }
      return { ...s, progress: Math.min(0.9, (now - stepAt) / MIN_STEP_MS) }
    })
    return { ...p, steps, tick: p.tick + 1 }
  })
}

// ---------------------------------------------------------------------------
// Per-chat memory (snooze, last handoff), kept in the store as small bounded maps

async function readMap($: Engine, key: string): Promise<Record<string, unknown>> {
  try {
    const v = await $.store.get(key)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function writeMap($: Engine, key: string, sid: string, value: unknown) {
  try {
    const m = await readMap($, key)
    delete m[sid]
    m[sid] = value
    for (const k of Object.keys(m).slice(0, Math.max(0, Object.keys(m).length - MAX_MAP))) delete m[k]
    await $.store.set(key, m)
  } catch {
    // Not remembering is fine.
  }
}

async function loadSnooze($: Engine, sid: string) {
  if (snoozeSid === sid) return
  snoozeSid = sid
  const v = (await readMap($, 'snooze'))[sid]
  snoozedTo = typeof v === 'number' ? v : 0
}

async function saveSnooze($: Engine, sid: string) {
  await writeMap($, 'snooze', sid, snoozedTo)
}

/** The user answered the offer: ask again only after the chat has grown by the snooze amount. */
async function answered($: Engine, tokens: number) {
  const sid = await ctx($)
  await loadSnooze($, sid)
  const now = (await usageNow($)).tokens
  snoozedTo = Math.max(snoozedTo, Math.max(tokens, now) + opts.snooze)
  await saveSnooze($, sid)
}

async function remember($: Engine, sid: string, path: string, isDraft: boolean) {
  const entry: Stored = { path, at: await $.clock.now(), sid, isDraft }
  try {
    await $.store.set('last', entry)
  } catch {
    // Not remembering is fine.
  }
}

async function lastSaved($: Engine): Promise<Stored | undefined> {
  try {
    const v = (await $.store.get('last')) as Partial<Stored> | undefined
    if (v && typeof v.path === 'string' && (await $.fs.exists(v.path))) return { path: v.path, at: v.at ?? 0, sid: v.sid ?? '', isDraft: v.isDraft === true }
  } catch {
    // None.
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Gathering

async function gitSummary($: Engine) {
  try {
    const r = await $.process.run(['git', 'status', '--short', '--branch'], { timeoutMs: 5000 })
    if (r.exitCode !== 0) return ''
    const lines = r.stdout.split('\n').filter(Boolean)
    const branch = (lines[0] ?? '').replace(/^##\s*/, '')
    const changed = lines.slice(1)
    if (changed.length === 0) return `${branch}; no uncommitted changes`
    return `${branch}; ${plural(changed.length, 'uncommitted change')}: ${changed.slice(0, 8).map(l => l.trim()).join(', ')}${changed.length > 8 ? ', ...' : ''}`
  } catch {
    return ''
  }
}

async function existingFiles($: Engine, messages: readonly SessionMessage[]) {
  const kept: FileHit[] = []
  for (const f of rankFiles(messages, home).slice(0, 70)) {
    if (kept.length >= 30) break
    if (await $.fs.exists(f.path).catch(() => false)) kept.push(f)
  }
  return kept
}

async function ensureSaveDir($: Engine) {
  const dir = saveDir()
  try {
    await $.process.run(['mkdir', '-p', dir])
    await $.process.run(['chmod', '700', dir])
  } catch {
    // fs.write creates the folder anyway.
  }
  return dir
}

/** Writes a file only the user can read (a handoff holds the chat's content). */
async function writePrivate($: Engine, path: string, text: string) {
  await $.fs.write(path, text)
  await $.process.run(['chmod', '600', path]).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// The run

function why(r: { reason?: string; status?: number }) {
  if (r.reason === 'api-error') return r.status === 529 || r.status === 429 ? `The model is busy (${r.status}).` : `The model call failed (${r.status ?? 'no status'}).`
  if (r.reason === 'empty-reply') return 'The model sent back nothing.'
  if (r.reason === 'aborted') return 'The model call was cut off.'
  if (r.reason === 'nothing-to-fork') return 'There is nothing to hand off yet. Send a message first.'
  return `No handoff came back (${r.reason ?? 'unknown'}).`
}

/** Saves the final handoff under a name that cannot overwrite an earlier one, and checks it by reading it back. */
async function saveHandoff($: Engine, text: string) {
  const dir = await ensureSaveDir($)
  const base = `${dir}/${stampOf(await $.clock.now())}-${slugOf(text)}`
  let path = `${base}.md`
  for (let n = 2; n < 50 && (await $.fs.exists(path).catch(() => false)); n += 1) path = `${base}-${n}.md`
  await writePrivate($, path, `${text}\n`)
  if (String(await $.fs.read(path)).trim() !== text.trim()) throw new Error('The saved file does not match what was written.')
  return path
}

async function run($: Engine, how: { focus: string; source: string }) {
  if (busy) return
  const sid = await ctx($)
  const first = await usageNow($)
  if (turnRunning) {
    queued = how
    await setPanel($, blank('waiting', first.tokens, first.percent))
    await log($, `queued until the turn ends (${how.source})`, sid)
    return
  }
  busy = true
  queued = null
  lastFocus = how.focus
  const id = ++runSeq
  const stopped = () => id <= cancelledTo
  // A cancelled run stops writing to the band; a newer run owns it.
  const put = (fn: (p: Panel) => Panel) => (stopped() ? Promise.resolve(undefined) : patchPanel($, fn))
  let draftPath = ''
  let t0 = 0
  await setPanel($, blank('working', first.tokens, first.percent))
  ticker?.cancel()
  ticker = $.clock.every(TICK_MS, () => {
    void tick($).catch(() => undefined)
  })

  async function step<T>(i: number, work: () => Promise<T>, detail: (v: T) => string): Promise<T> {
    if (stopped() || !(await isOn($))) throw new Stop()
    running = i
    stepAt = await $.clock.now()
    if (i === 3) {
      writeAt = stepAt
      writeTag = ''
    }
    await put(p => setStep(p, i, { status: 'run', progress: 0.02, detail: '' }))
    const value = await work()
    // The writing step is the one a cancel does not discard: its answer is already paid for (see below).
    if (stopped() && i !== 3) throw new Stop()
    const left = MIN_STEP_MS - ((await $.clock.now()) - stepAt)
    if (left > 0 && i !== 3) await $.clock.sleep(left)
    await put(p => setStep(p, i, { status: 'done', progress: 1, detail: detail(value) }))
    return value
  }

  try {
    t0 = await $.clock.now()
    const cwd = await $.session.cwd()
    const raw = await step(
      0,
      () => $.session.messages(),
      ms => (Array.isArray(ms) ? `${plural(ms.length, 'message')}${ms.length >= 4096 ? ' (newest)' : ''}` : '0 messages'),
    )
    const messages: readonly SessionMessage[] = Array.isArray(raw) ? raw : []
    if (messages.length === 0) throw new Error('This chat has no messages to hand off yet.')
    const files = await step(1, () => existingFiles($, messages), fs => plural(fs.length, 'file'))
    const found = await step(
      2,
      async () => ({ tools: gatherTools(messages), links: gatherLinks(messages), git: await gitSummary($) }),
      f => `${plural(f.tools.length, 'tool')}, ${plural(f.links.length, 'link')}`,
    )
    const g: Gathered = { messages, isTrimmed: messages.length >= 4096, files, ...found, cwd, sid, home }

    // A plain draft first: a failed or slow model step still leaves something to start from.
    const dir = await ensureSaveDir($)
    draftPath = `${dir}/${stampOf(await $.clock.now())}-draft.md`
    const draft = redact(draftText(g))
    await writePrivate($, draftPath, draft.text)
    await put(p => ({ ...p, file: tilde(draftPath, home), path: draftPath, isDraft: true }))
    await log($, `start ${short(first.tokens)} ${messages.length} messages, ${files.length} files, source ${how.source}, draft ${tilde(draftPath, home)}`, sid)

    const settings = { maxWords: opts.maxWords, extra: opts.extra, focus: how.focus }
    const reply = await step(
      3,
      async () => {
        const request = { prompt: handoffPrompt(g, settings) }
        let r = (await $.model.fork(request)) as { isAnswered: boolean; text?: string; reason?: string; status?: number }
        if (!r.isAnswered && isTransient(r) && !stopped()) {
          writeTag = ', trying again'
          await $.clock.sleep(3000)
          r = (await $.model.fork(request)) as typeof r
        }
        if (!r.isAnswered && r.reason === 'nothing-to-fork' && !stopped()) {
          // The chat cannot be reused (a resume, a /clear): send a trimmed copy to a model instead.
          writeTag = ', from a trimmed copy'
          r = (await $.model.complete({
            model: opts.fallbackModel,
            prompt: handoffPrompt(g, settings, digest(messages)),
            maxTokens: Math.min(30_000, Math.max(4000, opts.maxWords * 3)),
            timeoutMs: 240_000,
          })) as typeof r
        }
        // Thrown inside the step, so the writing row shows the failure and not a tick.
        if (!r.isAnswered) throw new Error(why(r))
        writeMs = (await $.clock.now()) - writeAt
        return r.text ?? ''
      },
      () => `${Math.round(writeMs / 1000)} s${writeTag}`,
    )


    const cleaned = redact(cleanReply(reply))
    if (cleaned.text.length < 40) throw new Error('The handoff came back too short.')

    if (stopped() || !(await isOn($))) {
      // Cancelled while the model was writing: the answer is already paid for, so keep it.
      const saved = await saveHandoff($, cleaned.text)
      await remember($, sid, saved, false)
      await log($, `cancelled, but the model had finished: saved ${tilde(saved, home)}`, sid)
      toast($, `Handoff cancelled, but it was already written. Saved at ${tilde(saved, home)}.`)
      return
    }

    const saved = await step(4, () => saveHandoff($, cleaned.text), p => tilde(p, home).split('/').pop() ?? '')
    const words = wordCount(cleaned.text)
    await put(p => ({ ...p, phase: 'ready', file: tilde(saved, home), path: saved, isDraft: false, words, redacted: cleaned.count, note: '' }))
    await remember($, sid, saved, false)
    const ms = (await $.clock.now()) - t0
    await log($, `ok ${tilde(saved, home)} ${words} words, ${cleaned.count} secrets removed, ${Math.round(ms / 1000)} s${writeTag}`, sid)
    // The full handoff replaces the draft.
    if (draftPath) await $.process.run(['rm', '-f', draftPath]).catch(() => undefined)
  } catch (err) {
    if (err instanceof Stop || stopped()) {
      await log($, `stopped${draftPath ? `, draft kept at ${tilde(draftPath, home)}` : ''}`, sid)
    } else {
      const reason = msg(err)
      await put(p => ({
        ...p,
        phase: 'failed',
        steps: p.steps.map((s, k) => (k === running && s.status === 'run' ? { ...s, status: 'fail', detail: 'failed' } : s)),
        error: reason,
        note: draftPath ? 'A basic draft is saved. Open it, copy it, start a chat with it, or try again.' : '',
      }))
      if (draftPath) await remember($, sid, draftPath, true)
      await log($, `failed at step ${running + 1}: ${reason}`, sid)
    }
  } finally {
    if (runSeq === id) {
      ticker?.cancel()
      ticker = null
      running = -1
      busy = false
    }
  }
}

async function cancel($: Engine) {
  const had = busy || queued !== null
  queued = null
  if (busy) {
    cancelledTo = runSeq
    busy = false
    running = -1
    ticker?.cancel()
    ticker = null
  }
  await setPanel($, null)
  if (had) await log($, 'cancelled by the user')
}

// ---------------------------------------------------------------------------
// The offer

async function showOffer($: Engine) {
  const p = await getPanel($)
  // Steps running, or a handoff ready or failed: that panel is already up.
  if (busy || (p && p.phase !== 'offer')) return
  const u = await usageNow($)
  await setPanel($, blank('offer', u.tokens, u.percent, true))
}

async function checkOffer($: Engine) {
  if (busy) return
  const sid = await ctx($)
  const p = await getPanel($)
  if (p && p.phase !== 'offer') return
  // An offer asked for by /refresh stays until it is answered.
  if (p?.forced) return
  if (!opts.autoOffer) {
    if (p) await setPanel($, null)
    return
  }
  const u = await usageNow($)
  const at = offerThreshold(opts.offerAt, u.window)
  await loadSnooze($, sid)
  // A compaction or /clear brings the count down: the offer starts over.
  if (u.tokens < at && snoozedTo > 0) {
    snoozedTo = 0
    await saveSnooze($, sid)
  }
  if (u.tokens >= Math.max(at, snoozedTo)) {
    if (!p || Math.abs(p.tokens - u.tokens) >= 1000) await setPanel($, blank('offer', u.tokens, u.percent))
  } else if (p) {
    await setPanel($, null)
  }
}

/** Looks for request files other mods leave (Cache Clock, a switchboard), then checks the offer. */
async function watch($: Engine) {
  if (!(await isOn($))) return
  const now = await $.clock.now()
  if (turnRunning && turnAt === 0) turnAt = now
  if (turnRunning && now - turnAt > STALE_TURN_MS) {
    turnRunning = false
    turnAt = 0
  }
  const sid = await ctx($)
  if (!sid) return
  const runFiles = [`${requestsDir()}/handoff-${sid}`, `${home}/.claude/handoffs/.request-${sid}`]
  const showFiles = [`${requestsDir()}/handoff-show-${sid}`, `${home}/.claude/mods/.open-handoff-${sid}`]
  let asked = false
  for (const f of runFiles) {
    if (await $.fs.exists(f).catch(() => false)) {
      await $.process.run(['rm', '-f', f]).catch(() => undefined)
      asked = true
    }
  }
  let shown = false
  for (const f of showFiles) {
    if (await $.fs.exists(f).catch(() => false)) {
      await $.process.run(['rm', '-f', f]).catch(() => undefined)
      shown = true
    }
  }
  if (asked && !busy) {
    await log($, 'asked by another mod (request file)', sid)
    void run($, { focus: '', source: 'request file' }).catch(() => undefined)
    return
  }
  if (shown) await showOffer($)
  if (!turnRunning && queued && !busy) {
    const q = queued
    void run($, q).catch(() => undefined)
    return
  }
  await checkOffer($)
}

async function setup($: Engine) {
  ready = true
  const sid = await ctx($)
  const tries: [string, () => Promise<unknown>][] = [
    [
      '/handoff',
      () =>
        $.command.register({
          name: 'handoff',
          description: 'Write a handoff of this chat now, then copy it or start a new chat with it',
          argumentHint: '[last | what to focus on]',
        }),
    ],
    ['/refresh', () => $.command.register({ name: 'refresh', description: 'Show the Refresh panel now, to move this work to a fresh chat', immediate: true })],
    [
      'the refresh tool',
      () =>
        $.tool.register({
          name: 'refresh',
          description:
            'Open the Refresh panel above the prompt: it writes a handoff of this whole chat (what was asked, done, decided, files to open, next steps) and offers Copy and Start new chat. Use when the user asks to refresh, hand off, or move this work to a new chat. It starts when your turn ends.',
          inputSchema: {
            type: 'object',
            properties: { focus: { type: 'string', description: 'Optional: what the handoff should focus on.' } },
          },
        }),
    ],
  ]
  for (const [label, fn] of tries) await fn().catch(err => log($, `could not add ${label}: ${msg(err)}`, sid))
  // A reload while the steps ran leaves a dead band behind: turn it into a plain "failed" the user can act on.
  const p = await getPanel($)
  if (p && (p.phase === 'working' || p.phase === 'waiting') && !busy && !queued) {
    await setPanel($, {
      ...p,
      phase: 'failed',
      steps: p.steps.map(s => (s.status === 'run' ? { ...s, status: 'fail', detail: 'stopped' } : s)),
      error: 'The mod was reloaded while the handoff was being written.',
      note: p.path ? 'A basic draft is saved. Open it, copy it, or try again.' : '',
    })
  }
  watcher?.cancel()
  watcher = $.clock.every(WATCH_MS, () => {
    void watch($).catch(() => undefined)
  })
  await rotateLog($)
  if (await isOn($)) await checkOffer($).catch(err => log($, `offer check failed: ${msg(err)}`, sid))
}

// ---------------------------------------------------------------------------
// Buttons

async function readHandoff($: Engine, path: string) {
  try {
    return String(await $.fs.read(path)).trim()
  } catch {
    return ''
  }
}

async function copyHandoff($: Engine, surface: string) {
  const p = await getPanel($)
  if (!p?.path) return
  const text = await readHandoff($, p.path)
  if (!text) return setNote($, 'The saved file could not be read. Use Open file instead.')
  const ok = await clipboard($, text, surface)
  if (ok) await answered($, p.tokens)
  await setNote($, ok ? 'Copied. Paste it into a new chat.' : 'Copy failed. Use Open file instead.')
  await log($, `copy ${ok ? 'ok' : 'failed'}`)
}

async function petAlive($: Engine) {
  try {
    const j = JSON.parse(String(await $.fs.read(`${petDir()}/pet.json`))) as { at?: number }
    return (await $.clock.now()) - (j.at ?? 0) < 10_000
  } catch {
    return false
  }
}

// Claude Pet starts the chat in the app (its Send button) and stays on it. Without the pet, the app's own
// link fills a new chat and you press Return. Without the app, the handoff is copied.
async function startNew($: Engine, surface: string) {
  const p = await getPanel($)
  if (!p?.path) return
  const text = await readHandoff($, p.path)
  if (!text) return setNote($, 'The saved file could not be read. Use Open file instead.')
  const cwd = await $.session.cwd()
  await answered($, p.tokens)
  if (opts.usePet && (await petAlive($))) {
    await setNote($, 'Starting the new chat...')
    const id = `handoff-${await $.clock.now()}`
    await $.fs.write(`${petDir()}/requests/${id}.json`, JSON.stringify({ id, at: await $.clock.now(), action: 'newchat', text, folder: cwd, stay: true }))
    const done = `${petDir()}/requests/${id}.done`
    for (let k = 0; k < PET_WAIT_STEPS; k += 1) {
      await $.clock.sleep(500)
      if (await $.fs.exists(done).catch(() => false)) {
        const answer = String(await $.fs.read(done)).trim()
        await $.process.run(['rm', '-f', done]).catch(() => undefined)
        await setNote($, answer || 'Claude Pet started the new chat.')
        await log($, 'new chat started through Claude Pet')
        return
      }
    }
    await setNote($, 'Claude Pet did not answer. Use Copy instead.')
    await log($, 'Claude Pet did not answer')
    return
  }
  const link = newChatLink({ text, path: p.path, cwd, sameFolder: opts.sameFolder })
  if (await opener($, link.url)) {
    await setNote(
      $,
      link.isPointer
        ? 'A new chat is open. The handoff is long, so the chat is told to read the saved file. Press Return there to start it.'
        : 'A new chat is filled in with the handoff. Press Return there to start it.',
    )
    await log($, `new chat opened through the app link${link.isPointer ? ' (long handoff: pointer to the file)' : ''}`)
    return
  }
  // No app to take the link (a plain terminal): copy it, so nothing is lost.
  const ok = await clipboard($, text, surface)
  await setNote($, ok ? 'No Claude app took the link. The handoff is copied: run /clear, then paste it.' : 'Could not open a new chat or copy. Use Open file.')
  await log($, `app link not accepted; copy ${ok ? 'ok' : 'failed'}`)
}

async function openFile($: Engine) {
  const p = await getPanel($)
  if (!p?.path) return
  const ok = await opener($, p.path)
  if (!ok) await setNote($, `Could not open it. It is at ${p.file}.`)
}

async function togglePreview($: Engine) {
  const p = await getPanel($)
  if (!p?.path) return
  if (p.preview.length > 0) return void (await patchPanel($, x => ({ ...x, preview: [] })))
  const lines = (await readHandoff($, p.path))
    .split('\n')
    .filter(l => l.trim())
    .slice(0, 14)
    .map(l => (l.length > 200 ? `${l.slice(0, 199)}...` : l))
  await patchPanel($, x => ({ ...x, preview: lines.length ? lines : ['(empty)'] }))
}

async function closePanel($: Engine) {
  const p = await getPanel($)
  if (p && p.phase !== 'offer') await answered($, p.tokens)
  await setPanel($, null)
}

/** "Turn off": the automatic offer is a setting, so it is switched off there and shows in /config. */
async function turnOffAuto($: Engine) {
  const p = await getPanel($)
  await setPanel($, null)
  if (p) await answered($, p.tokens)
  toast($, 'Automatic offer turned off. Type /refresh to show it again, or switch it back on in /config.')
  try {
    const r = await $.config.set({ key: 'handoff.auto_offer', value: false })
    if ('deny' in r && r.deny) toast($, `Could not turn it off (${r.deny}). It will ask again later instead.`)
    else await log($, 'automatic offer turned off')
  } catch (err) {
    toast($, 'Could not turn it off in /config. It will ask again later instead.')
    await log($, `could not turn the offer off: ${msg(err)}`)
  }
}

async function showLast($: Engine) {
  const last = await lastSaved($)
  if (!last) return false
  const text = await readHandoff($, last.path)
  const u = await usageNow($)
  await setPanel($, {
    ...blank('ready', u.tokens, u.percent),
    steps: freshSteps().map(s => ({ ...s, status: 'done', progress: 1, detail: 'done' })),
    file: tilde(last.path, home),
    path: last.path,
    isDraft: last.isDraft,
    words: wordCount(text),
    note: last.isDraft ? 'This is a basic draft: the model never finished.' : '',
  })
  return true
}

// ---------------------------------------------------------------------------
// Hooks

const OFF_TEXT = 'Handoff is off. Turn it on by removing "handoff": false from ~/.claude/claude-mods/switches.json.'

export const register: Register = (on, options) => {
  opts = readSettings(options)

  on('session.start', async ($, e, next) => {
    try {
      await setup($)
    } catch (err) {
      await log($, `setup failed: ${msg(err)}`)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // A /clear starts a new chat under a new id: a handoff in flight belongs to the old one.
    queued = null
    if (busy && e.reason === 'clear') {
      cancelledTo = runSeq
      busy = false
      running = -1
      ticker?.cancel()
      ticker = null
    }
    turnRunning = false
    const result = await next(e)
    try {
      if (e.reason === 'clear') await setPanel($, null)
    } catch (err) {
      await log($, `end cleanup failed: ${msg(err)}`)
    }
    return result
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnRunning = true
      turnAt = 0
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) turnRunning = false
    const result = await next(e)
    if (e.agentId !== undefined) return result
    void (async () => {
      if (!(await isOn($))) return
      if (!ready) await setup($)
      if (queued) {
        const q = queued
        queued = null
        await run($, q)
      } else {
        await checkOffer($)
      }
    })().catch(err => log($, `after-turn check failed: ${msg(err)}`))
    return result
  })

  on('command.run', { command: 'refresh' }, async $ => {
    try {
      if (!(await isOn($))) return { text: OFF_TEXT }
      if (!ready) await setup($)
      await showOffer($)
      const wasOff = !opts.autoOffer
      if (wasOff) {
        // /refresh brings the automatic offer back, as the toast on Turn off promised.
        void $.config.set({ key: 'handoff.auto_offer', value: true }).catch(err => log($, `could not turn the offer on: ${msg(err)}`))
      }
      return { text: `Refresh panel shown above the prompt.${wasOff ? ' The automatic offer is back on.' : ''} Press Not now to put it away.` }
    } catch (err) {
      await log($, `/refresh failed: ${msg(err)}`)
      return { text: 'Handoff hit an error. See ~/.claude/claude-mods/logs/handoff.log.' }
    }
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    try {
      if (!(await isOn($))) return { text: OFF_TEXT }
      if (!ready) await setup($)
      const arg = (e.args ?? '').trim()
      if (busy) return { text: 'A handoff is already being written. Watch the panel above the prompt.' }
      if (arg.toLowerCase() === 'last') {
        return { text: (await showLast($)) ? 'Showing your last saved handoff above the prompt.' : 'No saved handoff yet.' }
      }
      void run($, { focus: arg.slice(0, 500), source: 'command' }).catch(err => log($, `run crashed: ${msg(err)}`))
      return { text: 'Writing the handoff. Watch the panel above the prompt.' }
    } catch (err) {
      await log($, `/handoff failed: ${msg(err)}`)
      return { text: 'Handoff hit an error. See ~/.claude/claude-mods/logs/handoff.log.' }
    }
  })

  // One unfiltered hook: a typed tool matcher makes tsc recurse through the connector types.
  on('tool.call', async ($, e, next) => {
    if ((e.tool as string) !== 'mcp__handoff__refresh') return next(e)
    if (!(await isOn($))) return { result: 'Handoff is off. Tell the user to turn it on in ~/.claude/claude-mods/switches.json.' } as never
    const focus = String((e as unknown as { focus?: unknown }).focus ?? '').slice(0, 500)
    queued = { focus, source: 'model' }
    const u = await usageNow($)
    await setPanel($, blank('waiting', u.tokens, u.percent))
    return { result: 'The Refresh panel opens above the prompt and the handoff starts when this turn ends. Tell the user in one short line, then end your turn.' } as never
  }).catch(($, e, next) =>
    next.called ? next(e) : ({ result: 'The handoff mod hit an error and did not start. Tell the user to type /handoff.' } as never),
  )

  // Presses go to this hook, not to onPress: a closure lives for one drawing, and the band redraws
  // five times a second while the steps run.
  on('ui.press', { plugin: 'handoff' }, async ($, e) => {
    try {
      if (!(await isOn($))) return { element: e.element }
      if (!ready) await setup($)
      const surface = e.surface as string
      switch (e.element) {
        case 'refresh':
        case 'retry':
          void run($, { focus: e.element === 'retry' ? lastFocus : '', source: 'button' }).catch(err => log($, `run crashed: ${msg(err)}`))
          break
        case 'later': {
          const p = await getPanel($)
          await setPanel($, null)
          await answered($, p?.tokens ?? 0)
          break
        }
        case 'hide':
          await turnOffAuto($)
          break
        case 'cancel':
          await cancel($)
          break
        case 'copy':
          await copyHandoff($, surface)
          break
        case 'start':
          void startNew($, surface).catch(err => log($, `start failed: ${msg(err)}`))
          break
        case 'open':
          await openFile($)
          break
        case 'preview':
          await togglePreview($)
          break
        case 'close':
          await closePanel($)
          break
      }
    } catch (err) {
      await log($, `press ${String(e.element)} failed: ${msg(err)}`)
    }
    return { element: e.element }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(await isOn($))) return next(e)
    const p = await getPanel($)
    if (!p || e.props.hasSurvey) return next(e)
    // The offer waits out a running turn; the steps and the result do not.
    if (p.phase === 'offer' && e.props.isWorking) return next(e)
    const rest = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const noop = () => undefined
    const cols = typeof e.props.bodyColumns === 'number' && e.props.bodyColumns > 0 ? e.props.bodyColumns : 80
    // Colors come from the theme, so they stay readable in light and dark.
    const ACCENT = 'claude'
    const GOOD = 'success'
    const BAD = 'error'

    if (p.phase === 'offer') {
      const pct = p.percent > 0 ? ` (${Math.round(p.percent)}% of the window)` : ''
      return (
        <Box flexDirection="column">
          {rest}
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
            <Text>
              <Text color={ACCENT}>●</Text>
              <Text dimColor> Chat is at {short(p.tokens)} tokens{pct}. Refresh moves this work to a new chat with a full handoff.</Text>
            </Text>
            <Box flexDirection="row" gap={1}>
              <Button key="refresh" label="Refresh" variant="primary" hotkey="r" onPress={noop} />
              <Button key="later" label="Not now" hotkey="n" role="dismiss" onPress={noop} />
              <Button key="hide" label="Turn off" hotkey="o" onPress={noop} />
            </Box>
          </Box>
        </Box>
      )
    }

    const active = p.steps.findIndex(s => s.status === 'run')
    const stepNo = active >= 0 ? active + 1 : Math.min(5, p.steps.filter(s => s.status === 'done').length + 1)
    const title =
      p.phase === 'waiting'
        ? 'Handoff queued: it starts when this turn ends'
        : p.phase === 'working'
          ? `Refreshing: step ${stepNo} of ${p.steps.length}`
          : p.phase === 'ready'
            ? `Handoff ready: ${p.words.toLocaleString('en-US')} words${p.redacted > 0 ? `, ${plural(p.redacted, 'secret')} removed` : ''}`
            : 'The handoff did not finish'
    const narrow = cols < 60
    const labelW = Math.min(32, Math.max(18, Math.floor(cols * 0.36)))
    const barW = narrow ? 0 : Math.max(6, Math.min(18, cols - labelW - 2 - 16 - 4))

    const rows =
      p.phase === 'waiting'
        ? []
        : p.steps.map((s, i) => {
            const icon =
              s.status === 'done' ? (
                <Text color={GOOD}>✓</Text>
              ) : s.status === 'fail' ? (
                <Text color={BAD}>✗</Text>
              ) : s.status === 'run' ? (
                <Text color={ACCENT}>{SPIN[p.tick % SPIN.length]}</Text>
              ) : (
                <Text dimColor>○</Text>
              )
            const b = bar(s.progress, barW)
            const color = s.status === 'fail' ? BAD : s.status === 'done' ? GOOD : ACCENT
            const detail = s.status === 'run' && !s.detail ? `${Math.round(s.progress * 100)}%` : s.detail
            return (
              <Box key={`step-${i}`} flexDirection="row" gap={1}>
                <Box width={2}>{icon}</Box>
                <Box width={labelW}>
                  <Text dimColor={s.status === 'wait'} wrap="truncate-end">
                    {i + 1}. {s.label}
                  </Text>
                </Box>
                {barW > 0 ? (
                  <Text>
                    <Text color={color}>{b.on}</Text>
                    <Text dimColor>{b.off}</Text>
                  </Text>
                ) : null}
                <Box flexShrink={1}>
                  <Text dimColor wrap="truncate-end">
                    {detail}
                  </Text>
                </Box>
              </Box>
            )
          })

    return (
      <Box flexDirection="column">
        {rest}
        <Box flexDirection="column">
          <Text bold color={p.phase === 'failed' ? BAD : p.phase === 'ready' ? GOOD : ACCENT}>
            {title}
          </Text>
          {rows}
          {p.phase === 'waiting' || p.phase === 'working' ? (
            <Box flexDirection="row" gap={1}>
              <Button key="cancel" label="Cancel" hotkey="x" role="dismiss" onPress={noop} />
            </Box>
          ) : null}
          {p.phase === 'ready' ? (
            <Box flexDirection="column">
              <Text dimColor wrap="truncate-middle">
                Saved to {p.file}
              </Text>
              {p.preview.map((line, i) => (
                <Box key={`pv-${i}`}>
                  <Text dimColor wrap="truncate-end">
                    {line}
                  </Text>
                </Box>
              ))}
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                <Button key="copy" label="Copy handoff prompt" variant="primary" hotkey="c" onPress={noop} />
                <Button key="start" label="Start new chat with it" variant="secondary" hotkey="s" onPress={noop} />
                <Button key="preview" label={p.preview.length > 0 ? 'Hide preview' : 'Preview'} hotkey="p" onPress={noop} />
                <Button key="open" label="Open file" hotkey="o" onPress={noop} />
                <Button key="close" label="Close" hotkey="x" role="dismiss" onPress={noop} />
              </Box>
            </Box>
          ) : null}
          {p.phase === 'failed' ? (
            <Box flexDirection="column">
              <Text color={BAD}>{p.error}</Text>
              {p.file ? (
                <Text dimColor wrap="truncate-middle">
                  Draft saved to {p.file}
                </Text>
              ) : null}
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                <Button key="retry" label="Try again" variant="primary" hotkey="t" onPress={noop} />
                {p.path ? <Button key="copy" label="Copy draft" hotkey="c" onPress={noop} /> : null}
                {p.path ? <Button key="start" label="Start new chat with draft" hotkey="s" onPress={noop} /> : null}
                {p.path ? <Button key="open" label="Open draft" hotkey="o" onPress={noop} /> : null}
                <Button key="close" label="Close" hotkey="x" role="dismiss" onPress={noop} />
              </Box>
            </Box>
          ) : null}
          {p.note ? <Text dimColor>{p.note}</Text> : null}
        </Box>
      </Box>
    )
  })
}
