import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Helper, HelperPhase, PlanView, Step } from '../types'
import { BAR_H, CARD_BAR_H, CRAB_FRAMES, CRAB_PX_H, CRAB_PX_W, cardBarSvg, crabSvg, hueOf, HUES, taskBarSvg } from './art'
import { describe, KIND_COLOR } from './describe'
import { clockTime, cut, flag, mix, oneLine, paletteOf, shortModel, tokenText, whole, workTokens } from './lib'
import type { Usage } from './lib'
import { applyTaskTool, doneCount, mergePlan, nowLine, planFileBody, readPlanFile, readTodos, readToolInput } from './plan'
import type { StepIn } from './plan'

// Helper Desk. Two things on screen:
//   1. A task bar above the prompt that fills as Claude ticks off its to-do list.
//   2. A side pane with one live card and one progress bar for every subagent.
// The bar follows the main chat's to-do list: TodoWrite, the task tools, or this mod's own plan tool.
// The pane follows subagents: what each one is doing, how long, how many tokens.

const NAME = 'helper-desk'
const PANE = 'helpers'
const TITLE = 'Helper Desk'
const PLAN_TOOL = 'mcp__helper-desk__plan'

const HELPERS = atom({ plugin: 'helper-desk', key: 'helpers' } as const, [] as Helper[], { shape: 'helpers-1' })
const CLOCK = atom({ plugin: 'helper-desk', key: 'clock' } as const, { tick: 0, now: 0 })
const VIEW = atom({ plugin: 'helper-desk', key: 'view' } as const, { open: [] as string[], folded: [] as string[], all: [] as string[] }, { shape: 'view-1' })
const COST = atom({ plugin: 'helper-desk', key: 'cost' } as const, { usd: null as number | null })
const OFF = atom({ plugin: 'helper-desk', key: 'off' } as const, false)
const HIDDEN = atom({ plugin: 'helper-desk', key: 'hidden' } as const, false)
const PLAN = atom({ plugin: 'helper-desk', key: 'plan' } as const, null as PlanView | null, { shape: 'plan-1' })
const SHIM = atom({ plugin: 'helper-desk', key: 'shimmer' } as const, 0)

const TICK_MS = 300
const SLOW_TICK_MS = 1000
const POLL_MS = 2000
const SHIMMER_MS = 600
// How long a switches.json reading is trusted.
const SWITCH_TTL_MS = 1000
const HISTORY = 3
const MAX_STEPS = 200
const MAX_HELPERS = 60
// Finished and stopped cards shown before "Show more".
const CARDS_SHOWN = 5
const TAG_W = 11
// Columns the crab takes beside a card; its drawing is 48 by 36 CSS pixels.
const PET_W = 8
const FRAME_TICKS = 2
const BAND_FALLBACK_COLS = 30
// Tool calls in the main chat before the first reminder, and calls since the list last changed before the next.
const NUDGE_AFTER = 2
const STALE_AFTER = 8

// Theme keys follow the person's light or dark theme; hex colours are the mod's own identity colours.
const GOOD = 'success'
const BAD = 'error'
const WARN = 'warning'
const ACCENT = 'claude'
const SPIN = ['◐', '◓', '◑', '◒']
const PULSE = ['●∙∙', '∙●∙', '∙∙●', '∙●∙']
const FAIL_HEX = '#dc2626'

const NATIVE_LIST = ['TodoWrite', 'TaskCreate']
const MIRRORED = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])

const SECTION_NATIVE =
  'The user watches your to-do list as a progress bar above the prompt. For any task with 2 or more steps, keep that list with your to-do tool: ' +
  'write every step in order with the first one in_progress before other tools, update it as each step finishes, and mark the last step completed before your final answer. ' +
  'When you write a plan for the user to approve, put its steps in the list too, all pending. A step that launches subagents is one step. ' +
  'Skip the list only for a one-line answer with no tool calls. If you are a subagent, ignore this.'
const SECTION_PLAN =
  'Your to-do list is the mcp__helper-desk__plan tool. The user watches it as a progress bar above the prompt. ' +
  'For any task that needs 2 or more steps or tool calls, call it first, before other tools, with every step in order and the first one in_progress. ' +
  'Call it again with the full list each time a step finishes or a new one starts. Mark the last step completed before your final answer. ' +
  'When you write a plan for the user to approve, save its steps with the tool too, all pending. A step that launches subagents is one step. ' +
  'Skip it only for a one-line answer with no tool calls. If you are a subagent, ignore this.'

const nudgeNew = (native: boolean) =>
  native
    ? 'Helper Desk: you have no to-do list for this task yet. Add one with TodoWrite or TaskCreate so the user sees your progress.'
    : 'Helper Desk: you have no plan for this task yet. Call mcp__helper-desk__plan now with every step in order, so the user sees your progress.'
const nudgeContinue = (native: boolean) =>
  native
    ? 'Helper Desk: the to-do list has not changed this turn. If this is a new task, write its steps. If it carries on the last one, update the list.'
    : 'Helper Desk: the plan has not changed this turn. If this is a new task, call mcp__helper-desk__plan with its steps. If it carries on the last one, send the updated list.'
const NUDGE_STALE = 'Helper Desk: the to-do list has not changed in a while. If a step finished, update the list now.'

type Handle = { cancel: () => void }

// The settings from plugin.json userConfig, read when the module registers.
const cfg = {
  palette: paletteOf(undefined),
  animate: true,
  autoOpen: true,
  nudges: true,
  toasts: true,
  holdMs: 20_000,
}

// Everything the module keeps between events. The drawn copies live in $.state.
const s = {
  home: '',
  sessionId: '',
  ready: null as Promise<void> | null,
  off: false,
  hidden: false,
  checkedAt: Number.NEGATIVE_INFINITY,
  toolMade: false,
  helpers: [] as Helper[],
  seats: 0,
  nextHue: 0,
  tickN: 0,
  strangers: new Set<string>(),
  ticker: null as Handle | null,
  poller: null as Handle | null,
  shimmer: null as Handle | null,
  hold: null as Handle | null,
  shimN: 0,
  pub: null as Promise<void> | null,
  again: false,
  io: Promise.resolve(),
  plan: null as PlanView | null,
  turnRunning: false,
  turnCalls: 0,
  turnPlanned: false,
  nudged: false,
  sincePlan: 0,
  staleNudged: false,
  sawNativeList: false,
  promptTitle: '',
}

const working = () => s.helpers.filter(h => h.phase === 'working').length
const mods = () => `${s.home}/.claude/claude-mods`

// ---------- Log and files ----------

/** One line per notable event. Never throws and never waits for the disk. */
function log($: EngineInterface, line: string) {
  if (!s.home) return
  s.io = s.io.then(async () => {
    try {
      const path = `${mods()}/logs/${NAME}.log`
      const old = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
      const stamp = new Date(await $.clock.now()).toISOString()
      const lines = `${old}${stamp} ${line}\n`.split('\n')
      // Keep the last 300 lines: a log nobody trims is a leak.
      await $.fs.write(path, `${lines.slice(-301).join('\n')}`)
    } catch {
      // Logging must never break the session.
    }
  })
}
const logFail = ($: EngineInterface, where: string) => (err: unknown) => log($, `${where} failed: ${String(err).slice(0, 160)}`)

async function init($: EngineInterface) {
  s.ready ??= (async () => {
    try {
      s.home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    } catch {
      s.home = ''
    }
    s.sessionId = await $.session.id().catch(() => '')
    // A reload keeps what was drawn: carry on from it.
    try {
      if (!s.helpers.length) {
        const saved = await read($, HELPERS)
        if (saved.length) {
          s.helpers = saved.map(h => ({ ...h, steps: [...h.steps] }))
          s.seats = Math.max(...s.helpers.map(h => h.seat)) + 1
          s.nextHue = (Math.max(...s.helpers.map(h => h.hue)) + 1) % HUES.length
        }
      }
      if (!s.plan) {
        s.plan = (await read($, PLAN)) ?? (await loadPlanFile($))
        // The timer that hid a finished bar did not survive the reload: a finished plan stays hidden.
        if (s.plan?.done) s.plan.shown = false
      }
    } catch (err) {
      log($, `restore failed: ${String(err).slice(0, 160)}`)
    }
  })()
  await s.ready
}

// ---------- The shared on/off switch ----------

async function readSwitchFile($: EngineInterface): Promise<Record<string, unknown>> {
  const path = `${mods()}/switches.json`
  if (!s.home || !(await $.fs.exists(path))) return {}
  const json = JSON.parse(String(await $.fs.read(path))) as unknown
  return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
}

/** Reads switches.json at most once a second, and acts on a change. A missing or broken file means on. */
async function refreshSwitch($: EngineInterface, force = false) {
  const now = await $.clock.now()
  if (!force && now - s.checkedAt < SWITCH_TTL_MS) return
  s.checkedAt = now
  let json: Record<string, unknown> = {}
  try {
    json = await readSwitchFile($)
  } catch {
    json = {}
  }
  const hidden = json[`${NAME}:hidden`] === true
  if (hidden !== s.hidden) {
    s.hidden = hidden
    await update($, HIDDEN, () => hidden)
    if (hidden) await $.ui.close({ id: PANE }).catch(() => undefined)
    syncShimmer($)
    log($, hidden ? 'hidden' : 'shown')
  }
  const off = json[NAME] === false
  if (off !== s.off) {
    s.off = off
    await update($, OFF, () => off)
    if (off) {
      await $.ui.close({ id: PANE }).catch(() => undefined)
      s.hold?.cancel()
      s.hold = null
    } else {
      await ensureTool($)
    }
    syncTimers($)
    syncShimmer($)
    log($, off ? 'switched off' : 'switched on')
  }
  await checkOpenRequest($)
}

/** A file named for this chat asks for the pane to open. It is used up even while off. */
async function checkOpenRequest($: EngineInterface) {
  if (!s.home || !s.sessionId) return
  const path = `${mods()}/.open-${NAME}-${s.sessionId}`
  if (!(await $.fs.exists(path).catch(() => false))) return
  await $.process.run(['rm', '-f', path])
  if (!s.off) await openPane($)
}

/** Writes the hidden flag into the shared file without touching the other keys. */
async function setHidden($: EngineInterface, value: boolean) {
  try {
    const json = await readSwitchFile($)
    if (value) json[`${NAME}:hidden`] = true
    else delete json[`${NAME}:hidden`]
    if (s.home) await $.fs.write(`${mods()}/switches.json`, `${JSON.stringify(json, null, 2)}\n`)
  } catch (err) {
    // An unreadable file is left as it is: the choice then lasts for this chat only.
    log($, `save hidden: ${String(err).slice(0, 160)}`)
  }
  s.hidden = value
  s.checkedAt = await $.clock.now()
  await update($, HIDDEN, () => value)
  syncShimmer($)
  if (value) await $.ui.close({ id: PANE }).catch(() => undefined)
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: TITLE })
}

// ---------- The plan tool ----------

async function ensureTool($: EngineInterface) {
  if (s.toolMade || s.off) return
  s.toolMade = true
  await $.tool
    .register({
      name: 'plan',
      description:
        'Save the plan for the job in front of you: the steps in order, each pending, in_progress or completed. ' +
        'It draws a progress bar above the prompt for the user. Send the whole list every time, like TodoWrite.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short name for the job, a few words.' },
          steps: {
            type: 'array',
            description: 'Every step, in order.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'The step in a few plain words.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['text', 'status'],
            },
          },
        },
        required: ['steps'],
      },
      // In front, not behind ToolSearch: a tool the model cannot see never gets called.
      isDeferred: false,
    })
    .catch(err => {
      s.toolMade = false
      logFail($, 'register plan tool')(err)
    })
}

// ---------- Timers ----------

async function tick($: EngineInterface) {
  s.tickN += 1
  const now = await $.clock.now()
  await update($, CLOCK, () => ({ tick: s.tickN, now }))
  await refreshSwitch($)
}

async function readCost($: EngineInterface) {
  try {
    const u = await $.session.usage()
    const usd = typeof u.cost?.usd === 'number' ? u.cost.usd : null
    await update($, COST, c => (c.usd === usd ? c : { usd }))
  } catch {
    // No cost ledger here: the tile stays hidden.
  }
}

async function poll($: EngineInterface) {
  if (!working()) return
  const list = await $.agent.list()
  const now = await $.clock.now()
  let changed = false
  for (const a of list) {
    const h = s.helpers.find(x => x.id === a.id)
    if (!h || h.phase !== 'working') continue
    // The list may lag a turn's end, so it only ever moves a card out of working.
    if (a.status === 'completed' || a.status === 'idle') {
      h.phase = 'done'
      h.endedAt = now
      changed = true
    } else if (a.status === 'failed' || a.status === 'killed') {
      h.phase = 'failed'
      h.note = a.status === 'killed' ? 'It was stopped' : 'It failed'
      h.endedAt = now
      changed = true
    }
    if (!h.description && a.description) {
      h.description = a.description
      changed = true
    }
  }
  if (changed) await schedulePublish($)
  await readCost($)
  await refreshSwitch($)
}

function syncTimers($: EngineInterface) {
  if (working() > 0 && !s.off) {
    s.ticker ??= $.clock.every(cfg.animate ? TICK_MS : SLOW_TICK_MS, () => {
      void tick($).catch(logFail($, 'tick'))
    })
    s.poller ??= $.clock.every(POLL_MS, () => {
      void poll($).catch(logFail($, 'poll'))
    })
  } else {
    s.ticker?.cancel()
    s.poller?.cancel()
    s.ticker = null
    s.poller = null
  }
}

/** The terminal's shimmer runs only while a shown plan has a step in progress and a turn is running. */
function syncShimmer($: EngineInterface) {
  const need = cfg.animate && !s.off && !s.hidden && s.turnRunning && !!s.plan?.shown && s.plan.steps.some(st => st.status === 'in_progress')
  if (need) {
    s.shimmer ??= $.clock.every(SHIMMER_MS, () => {
      s.shimN += 1
      void update($, SHIM, () => s.shimN).catch(() => undefined)
    })
  } else {
    s.shimmer?.cancel()
    s.shimmer = null
  }
}

// ---------- Subagents ----------

async function publish($: EngineInterface) {
  const copy = s.helpers.map(h => ({ ...h, steps: [...h.steps] }))
  await update($, HELPERS, () => copy)
  const now = await $.clock.now()
  await update($, CLOCK, () => ({ tick: s.tickN, now }))
  syncTimers($)
}

/** Redraws once now, and once more if more arrived meanwhile, so a burst of tool calls costs few redraws. */
function schedulePublish($: EngineInterface): Promise<void> {
  if (s.pub) {
    s.again = true
    return s.pub
  }
  s.pub = (async () => {
    do {
      s.again = false
      await publish($)
    } while (s.again)
  })().finally(() => {
    s.pub = null
  })
  return s.pub
}

/** The next body colour in order that no running helper wears; with all 8 taken, the next in order. */
function pickHue() {
  const used = new Set(s.helpers.filter(h => h.phase === 'working').map(h => h.hue % HUES.length))
  let hue = s.nextHue % HUES.length
  for (let i = 0; i < HUES.length; i += 1) {
    const h = (s.nextHue + i) % HUES.length
    if (!used.has(h)) {
      hue = h
      break
    }
  }
  s.nextHue = hue + 1
  return hue
}

/** A long chat keeps the newest helpers: finished cards past the cap are dropped, oldest first. */
function trimHelpers() {
  while (s.helpers.length > MAX_HELPERS) {
    const at = s.helpers.findIndex(h => h.phase !== 'working')
    if (at < 0) return
    s.helpers.splice(at, 1)
  }
}

async function addHelper($: EngineInterface, id: string, description: string, type: string, model: string) {
  const known = s.helpers.find(h => h.id === id)
  if (known) {
    // Found first through its own tool calls: fill in what the spawn knows.
    if (description) known.description = description
    if (type) known.type = type
    if (model && !known.model) known.model = model
    await schedulePublish($)
    return
  }
  const wasIdle = working() === 0
  s.helpers.push({
    id,
    description: description || 'Subagent',
    type: type || 'subagent',
    model,
    effort: '',
    phase: 'working',
    note: '',
    startedAt: await $.clock.now(),
    endedAt: 0,
    count: 0,
    steps: [],
    tokens: 0,
    turnTokens: 0,
    hasUsage: false,
    seat: s.seats,
    hue: pickHue(),
  })
  s.seats += 1
  trimHelpers()
  log($, `helper started: ${type || 'subagent'}`)
  await schedulePublish($)
  // The pane opens by itself when a new round of helpers starts.
  if (wasIdle && cfg.autoOpen && !s.hidden) void openPane($).catch(logFail($, 'open pane'))
}

/** A helper this mod missed (a reload, a race) is taken from $.agent.list(). */
async function adopt($: EngineInterface, id: string) {
  if (s.helpers.some(h => h.id === id) || s.strangers.has(id)) return
  const a = (await $.agent.list()).find(x => x.id === id)
  if (!a) {
    // The engine's own forks carry ids no list names: leave them out.
    s.strangers.add(id)
    return
  }
  await addHelper($, id, a.description, a.type, '')
}

async function noteTool($: EngineInterface, id: string, step: Step) {
  if (!s.helpers.some(h => h.id === id)) await adopt($, id)
  const h = s.helpers.find(x => x.id === id)
  if (!h) return
  h.count += 1
  h.steps = [...h.steps, step].slice(-MAX_STEPS)
  // A teammate that finished a turn and picks up work again is working again.
  if (h.phase !== 'working') {
    h.phase = 'working'
    h.note = ''
    h.endedAt = 0
  }
  await schedulePublish($)
}

async function noteStep($: EngineInterface, id: string, model: string, effort: string, usage: Usage | null) {
  if (!s.helpers.some(h => h.id === id)) await adopt($, id)
  const h = s.helpers.find(x => x.id === id)
  if (!h) return
  if (model) h.model = shortModel(model)
  if (effort) h.effort = effort
  if (usage) {
    h.turnTokens += workTokens(usage)
    h.hasUsage = true
  }
  await schedulePublish($)
}

const END_NOTE: Record<string, string> = {
  aborted: 'You stopped it',
  error: 'It hit an error',
  refusal: 'The model declined',
}

async function finish($: EngineInterface, id: string, reason: string, usage: Usage | null) {
  const h = s.helpers.find(x => x.id === id)
  if (!h) return
  // The turn's own sum wins over the steps counted so far.
  h.tokens += usage ? workTokens(usage) : h.turnTokens
  h.turnTokens = 0
  if (usage) h.hasUsage = true
  const failed = reason !== 'answer'
  h.phase = failed ? 'failed' : 'done'
  h.note = failed ? (END_NOTE[reason] ?? 'It stopped early') : ''
  h.endedAt = await $.clock.now()
  log($, `helper ${failed ? 'stopped' : 'done'}: ${h.type}, ${h.count} steps`)
  await schedulePublish($)
  await readCost($)
}

async function clearFinished($: EngineInterface) {
  s.helpers = s.helpers.filter(h => h.phase === 'working')
  await update($, VIEW, v => ({ ...v, open: v.open.filter(id => s.helpers.some(h => h.id === id)) }))
  await schedulePublish($)
}

// ---------- The plan ----------

const planPath = () => `${mods()}/state/plan-${s.sessionId}.json`

function writePlanFile($: EngineInterface) {
  if (!s.plan || !s.sessionId || !s.home) return
  const body = `${JSON.stringify(planFileBody(s.plan), null, 2)}\n`
  s.io = s.io.then(async () => {
    try {
      await $.fs.write(planPath(), body)
    } catch (err) {
      log($, `write plan: ${String(err).slice(0, 160)}`)
    }
  })
}

/** A reload or resume carries on with the plan this chat already saved. */
async function loadPlanFile($: EngineInterface): Promise<PlanView | null> {
  if (!s.sessionId || !s.home) return null
  try {
    if (!(await $.fs.exists(planPath()))) return null
    return readPlanFile(JSON.parse(String(await $.fs.read(planPath()))))
  } catch (err) {
    log($, `load plan: ${String(err).slice(0, 160)}`)
    return null
  }
}

async function drawPlan($: EngineInterface) {
  const value = s.plan ? { ...s.plan, steps: s.plan.steps.map(st => ({ ...st })) } : null
  await update($, PLAN, () => value)
  syncShimmer($)
}

function say($: EngineInterface, text: string) {
  if (!cfg.toasts) return
  try {
    $.ui.toast(cut(text, 140))
  } catch {
    // A toast is only a hint.
  }
}

/** Takes a whole new list, keeps done times, pops up what just finished, saves and draws. */
async function applyPlan($: EngineInterface, title: string | undefined, incoming: StepIn[]) {
  const nowIso = new Date(await $.clock.now()).toISOString()
  const prev = s.plan
  const m = mergePlan(prev, title, incoming, nowIso, s.promptTitle || 'Plan')
  const plan = m.plan
  if (!plan.steps.length) {
    plan.shown = false
    s.hold?.cancel()
    s.hold = null
  } else if (plan.done && m.becameDone) {
    s.hold?.cancel()
    s.hold = null
    say($, plan.steps.length === 1 ? 'All steps done.' : `All ${plan.steps.length} steps done.`)
    plan.shown = cfg.holdMs > 0
    if (cfg.holdMs > 0) {
      s.hold = $.clock.after(cfg.holdMs, () => {
        s.hold = null
        if (s.plan) s.plan.shown = false
        void drawPlan($).catch(logFail($, 'hide plan'))
      })
    }
  } else if (!plan.done) {
    s.hold?.cancel()
    s.hold = null
    plan.shown = true
    if (m.justDone.length) say($, `Done: ${m.justDone.join(', ')}`)
  } else {
    // The same finished list sent again: the bar stays as it was.
    plan.shown = prev?.shown ?? false
  }
  s.plan = plan
  log($, `plan: ${doneCount(plan.steps)} of ${plan.steps.length} steps done`)
  writePlanFile($)
  await drawPlan($)
}

/** The plan tool's own call: check the input, save it, answer in one line. */
async function planFromTool($: EngineInterface, args: Record<string, unknown>) {
  const input = readToolInput(args)
  if (typeof input === 'string') return input
  await applyPlan($, input.title, input.steps)
  const done = doneCount(input.steps)
  return `Plan saved: ${done} of ${input.steps.length} steps done.${input.clipped ? ' Only the first 100 steps were kept.' : ''}`
}

/** TodoWrite, TaskCreate and TaskUpdate on the main chat feed the same plan. */
async function mirror($: EngineInterface, tool: string, args: Record<string, unknown>, r: unknown) {
  const res = (r as { result?: unknown; isError?: boolean; deny?: string } | undefined) ?? {}
  if (res.deny || res.isError) return
  if (tool === 'TodoWrite') {
    await applyPlan($, undefined, readTodos(args))
    return
  }
  const list = applyTaskTool(s.plan, tool as 'TaskCreate' | 'TaskUpdate', args, res.result)
  if (list) await applyPlan($, undefined, list)
}

async function dismissPlan($: EngineInterface) {
  if (s.plan) s.plan.shown = false
  s.hold?.cancel()
  s.hold = null
  await drawPlan($)
}

/** A reminder after a tool's result, read by the model only. */
function withNudge<R>(r: R): R {
  s.turnCalls += 1
  s.sincePlan += 1
  const live = !!s.plan && !s.plan.done && s.plan.steps.length > 0
  let note: string | null = null
  if (!s.turnPlanned && !s.nudged && s.turnCalls >= NUDGE_AFTER) {
    s.nudged = true
    note = live ? nudgeContinue(s.sawNativeList) : nudgeNew(s.sawNativeList)
  } else if (live && !s.staleNudged && s.sincePlan >= STALE_AFTER) {
    s.staleNudged = true
    note = NUDGE_STALE
  }
  if (!note || !r || typeof r !== 'object' || 'deny' in (r as object)) return r
  const had = (r as { context?: readonly string[] }).context ?? []
  return { ...r, context: [...had, note] }
}

/** A /clear starts the desk over: new chat, new id, nothing carried across. */
async function resetDesk($: EngineInterface) {
  s.ticker?.cancel()
  s.poller?.cancel()
  s.shimmer?.cancel()
  s.hold?.cancel()
  s.ticker = s.poller = s.shimmer = s.hold = null
  s.helpers = []
  s.seats = 0
  s.nextHue = 0
  s.plan = null
  s.strangers.clear()
  s.turnRunning = false
  s.turnCalls = 0
  s.turnPlanned = false
  s.nudged = false
  s.sincePlan = 0
  s.staleNudged = false
  s.promptTitle = ''
  s.ready = null
  s.sessionId = ''
  await update($, HELPERS, () => [])
  await update($, PLAN, () => null)
  await update($, VIEW, () => ({ open: [], folded: [], all: [] }))
  await update($, COST, () => ({ usd: null }))
}

export const register: Register = (on, options) => {
  cfg.palette = paletteOf(options.bar_color)
  cfg.animate = flag(options.animations, true)
  cfg.autoOpen = flag(options.auto_open_pane, true)
  cfg.nudges = flag(options.nudges, true)
  cfg.toasts = flag(options.toasts, true)
  cfg.holdMs = whole(options.hold_seconds, 20, 0, 600) * 1000

  // ---------- Hooks ----------

  on('session.start', async ($, e, next) => {
    try {
      await init($)
      await refreshSwitch($, true)
      await $.command.register({
        name: 'helpers',
        description: 'Show the Helper Desk: the task progress bar and one live card per subagent',
        argumentHint: '[hide | clear]',
        immediate: true,
      })
      await ensureTool($)
      if (s.helpers.length) syncTimers($)
      await drawPlan($)
      log($, 'session start')
    } catch (err) {
      log($, `session start failed: ${String(err).slice(0, 160)}`)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      if (e.reason === 'clear') {
        await resetDesk($)
        log($, 'cleared')
      }
    } catch (err) {
      log($, `clear failed: ${String(err).slice(0, 160)}`)
    }
    return next(e)
  })

  on('command.run', { command: 'helpers' }, async ($, e) => {
    try {
      await init($)
      await refreshSwitch($, true)
      if (s.off) return { text: `${TITLE} is off. Remove "${NAME}": false from ~/.claude/claude-mods/switches.json to turn it on.` }
      const arg = String((e as { args?: string }).args ?? '').trim().toLowerCase()
      if (arg === 'hide') {
        await setHidden($, true)
        return { text: `${TITLE} hidden. Type /helpers to show it again.` }
      }
      if (arg === 'clear') {
        await clearFinished($)
        return { text: 'Cleared the finished cards.' }
      }
      if (s.hidden) await setHidden($, false)
      await openPane($)
      return { text: s.helpers.length ? `${TITLE} opened.` : `${TITLE} opened. Cards show up when Claude starts a subagent.` }
    } catch (err) {
      log($, `command failed: ${String(err).slice(0, 160)}`)
      return { text: `${TITLE} could not open. Try again.` }
    }
  })

  on('ui.press', { plugin: NAME }, async ($, e, next) => {
    try {
      await init($)
      if (s.off) return next(e)
      const el = e.element
      if (el === 'hide') {
        await setHidden($, true)
        try {
          $.ui.toast(`${TITLE} hidden. Type /helpers to show it.`)
        } catch {
          // The toast is only a hint.
        }
        return { element: el }
      }
      if (el === 'clear') {
        await clearFinished($)
        return { element: el }
      }
      if (el === 'plan-dismiss') {
        await dismissPlan($)
        return { element: el }
      }
      const toggle = (field: 'open' | 'folded' | 'all', id: string) =>
        update($, VIEW, v => ({ ...v, [field]: v[field].includes(id) ? v[field].filter(x => x !== id) : [...v[field], id] }))
      if (el.startsWith('steps-')) {
        await toggle('open', el.slice('steps-'.length))
        return { element: el }
      }
      if (el.startsWith('group-')) {
        await toggle('folded', el.slice('group-'.length))
        return { element: el }
      }
      if (el.startsWith('more-')) {
        await toggle('all', el.slice('more-'.length))
        return { element: el }
      }
    } catch (err) {
      log($, `press failed: ${String(err).slice(0, 160)}`)
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    try {
      await init($)
      await refreshSwitch($)
      const id = (r as { agentId?: string }).agentId
      if (id && !s.off) {
        void addHelper($, id, e.description || 'Subagent', e.subagentType || 'subagent', shortModel(e.model ?? (r as { model?: string }).model ?? '')).catch(logFail($, 'spawn'))
      }
    } catch (err) {
      log($, `spawn failed: ${String(err).slice(0, 160)}`)
    }
    return r
  }).catch(($, e, next) => next(e))

  // One hook for every tool: a hook typed to one tool makes the compiler walk every connector's types.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const args = e as unknown as Record<string, unknown>
    const agentId = e.agentId
    try {
      await init($)
      await refreshSwitch($)
    } catch (err) {
      log($, `tool hook failed: ${String(err).slice(0, 160)}`)
    }
    if (tool === PLAN_TOOL) {
      if (s.off) return { result: `${TITLE} is off, so no plan was saved. Carry on without it.` } as never
      if (agentId) return { result: 'Only the main chat keeps a plan. Carry on with your task.' } as never
      let said = 'Plan not saved: something went wrong. Carry on.'
      try {
        said = await planFromTool($, args)
      } catch (err) {
        log($, `plan failed: ${String(err).slice(0, 160)}`)
      }
      s.turnPlanned = true
      s.sincePlan = 0
      s.staleNudged = false
      return { result: said } as never
    }
    if (s.off) return next(e)
    if (agentId) {
      try {
        void noteTool($, agentId, describe(tool, args, s.home)).catch(logFail($, 'tool'))
      } catch (err) {
        log($, `describe failed: ${String(err).slice(0, 160)}`)
      }
      return next(e)
    }
    if (MIRRORED.has(tool)) {
      const r = await next(e)
      s.turnPlanned = true
      s.sincePlan = 0
      s.staleNudged = false
      if (NATIVE_LIST.includes(tool)) s.sawNativeList = true
      void mirror($, tool, args, r).catch(logFail($, `mirror ${tool}`))
      return r
    }
    const r = await next(e)
    return cfg.nudges ? withNudge(r) : r
  }).catch(($, e, next) => next(e))

  // A new prompt is a new task: the reminders count from zero.
  on('prompt.submit', async ($, e, next) => {
    try {
      await init($)
      await refreshSwitch($)
      s.turnCalls = 0
      s.turnPlanned = false
      s.nudged = false
      s.sincePlan = 0
      s.staleNudged = false
      s.turnRunning = true
      // The first words of a person's own prompt name a plan that has no title of its own.
      const typed = oneLine(String(e.text ?? ''))
      if (typed && !typed.startsWith('/') && !e.command && !e.isMeta) s.promptTitle = cut(typed, 36)
      syncShimmer($)
    } catch (err) {
      log($, `prompt hook failed: ${String(err).slice(0, 160)}`)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A short section of the system prompt, only while the mod is on.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    try {
      await init($)
      await refreshSwitch($)
      if (s.off || !cfg.nudges || e.traits.includes('teammate') || e.traits.includes('bare')) return r
      const native = e.tools.some(t => NATIVE_LIST.includes(t))
      if (native) s.sawNativeList = true
      return { sections: [...r.sections, { id: 'helper-desk:plan', text: native ? SECTION_NATIVE : SECTION_PLAN, scope: 'session' as const }] }
    } catch (err) {
      log($, `compose failed: ${String(err).slice(0, 160)}`)
      return r
    }
  })

  // Each model request of a helper: its model, effort and token counts.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    try {
      const id = e.agentId
      if (id && !s.off) {
        const effort = e.effort === undefined ? '' : String(e.effort)
        void noteStep($, id, e.model, effort, (r.usage ?? null) as Usage | null).catch(logFail($, 'step'))
      }
    } catch (err) {
      log($, `step hook failed: ${String(err).slice(0, 160)}`)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      const id = e.agentId
      if (!id) {
        s.turnRunning = false
        syncShimmer($)
      } else if (!s.off && s.helpers.some(h => h.id === id)) {
        void finish($, id, e.isAborted ? 'aborted' : e.reason, (e.usage ?? null) as Usage | null).catch(logFail($, 'turn'))
      }
    } catch (err) {
      log($, `turn hook failed: ${String(err).slice(0, 160)}`)
    }
    return r
  })

  // ---------- Drawing: the side pane ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const isOff = await read($, OFF)
    if (isOff || s.off) return next(e)
    const { animate, palette } = cfg
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // Svg draws on desktop, the editor and mobile; the terminal gets glyphs.
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : null
    const list = await read($, HELPERS)
    const clk = await read($, CLOCK)
    const view = await read($, VIEW)
    const cost = await read($, COST)
    const width = Math.max(32, e.props.bodyColumns)
    // Inside a card: its border and padding take 4 columns, the crab PET_W more.
    const cw = width - 4 - PET_W

    const running = list.filter(hp => hp.phase === 'working')
    const finished = list.filter(hp => hp.phase === 'done').sort((a, b) => b.endedAt - a.endedAt)
    const stopped = list.filter(hp => hp.phase === 'failed').sort((a, b) => b.endedAt - a.endedAt)

    // Header tiles: only numbers the engine gave.
    const tiles: { label: string; value: string }[] = []
    if (cost.usd !== null) tiles.push({ label: 'Total chat cost', value: `$${cost.usd.toFixed(2)}` })
    if (list.some(hp => hp.hasUsage)) tiles.push({ label: 'Subagent tokens', value: tokenText(list.reduce((n, hp) => n + hp.tokens + hp.turnTokens, 0)) })
    if (list.length) {
      const start = Math.min(...list.map(hp => hp.startedAt))
      const end = running.length ? Math.max(clk.now, ...running.map(hp => hp.startedAt)) : Math.max(...list.map(hp => hp.endedAt))
      tiles.push({ label: 'Time', value: clockTime(end - start) })
    }
    const tileW = tiles.length ? Math.floor((width - (tiles.length - 1)) / tiles.length) : width

    // A running crab steps through its frames on the clock tick; a finished one stands still.
    const frameOf = (hp: Helper) => (hp.phase === 'working' && animate ? Math.floor(clk.tick / FRAME_TICKS) % CRAB_FRAMES : 0)

    const pet = (hp: Helper) => {
      const hue = hueOf(hp.hue)
      const frame = frameOf(hp)
      if (Svg) {
        return (
          <Box key={`pet-${hp.id}`} width={PET_W} flexShrink={0}>
            <Svg source={crabSvg(hp.hue, frame)} alt={`Claude crab, ${hue.name}`} width={CRAB_PX_W} height={CRAB_PX_H} />
          </Box>
        )
      }
      return (
        <Box key={`pet-${hp.id}`} width={PET_W} flexShrink={0} flexDirection="column">
          <Text color={hue.color}>{frame % 2 ? ' ▜█▛' : ' ▟█▙'}</Text>
          <Text color={hue.color}>{frame % 2 ? ' ▘ ▝' : '  ▘▝'}</Text>
        </Box>
      )
    }

    const card = (hp: Helper) => {
      const hue = hueOf(hp.hue)
      const live = hp.phase === 'working'
      const isOpen = view.open.includes(hp.id)
      const mark = live ? '●' : hp.phase === 'done' ? '✓' : '✗'
      const markColor = hp.phase === 'failed' ? BAD : GOOD
      const time = clockTime((live ? Math.max(clk.now, hp.startedAt) : hp.endedAt) - hp.startedAt)
      const meta = [hp.hasUsage ? `${tokenText(hp.tokens + hp.turnTokens)} tokens` : '', time].filter(Boolean).join(' · ')
      const who = [hp.type, hp.model, hp.effort].filter(Boolean).join(' · ')
      const current = hp.steps[hp.steps.length - 1]
      const stepsWord = `${hp.count} step${hp.count === 1 ? '' : 's'}`
      const spin = animate ? SPIN[clk.tick % SPIN.length]! : '●'
      const pulse = animate ? PULSE[clk.tick % PULSE.length]! : '●∙∙'
      const lead = live
        ? `Step ${hp.count} · ${current?.live ?? 'Getting started'}`
        : hp.phase === 'done'
          ? `Done · ${stepsWord}`
          : `${hp.note || 'Stopped before it finished'} · ${stepsWord}`
      // Room for the spinner and pulse on a live line.
      const leadW = Math.max(6, cw - (live ? 2 + pulse.length + 1 : 0))
      const history = (live ? hp.steps.slice(0, -1) : hp.steps).slice(-HISTORY)
      const rowW = cw - TAG_W
      // About 6.5 CSS pixels a column, as the crab's 48 pixels fill its 8.
      const barPx = Math.max(60, Math.floor(cw * 6.5))
      const barAlt = live ? 'Working' : hp.phase === 'done' ? 'Done' : 'Stopped'

      // The terminal bar: one thick row of blocks, full when over, a sliding piece while working.
      const blocks = (() => {
        if (!live) return ['', '█'.repeat(cw), ''] as const
        const piece = Math.max(3, Math.floor(cw / 4))
        const total = cw + piece
        const head = animate ? ((clk.tick + hp.seat * 5 + piece) % total) - piece : Math.floor((cw - piece) / 2)
        const from = Math.max(0, head)
        const to = Math.min(cw, head + piece)
        return ['░'.repeat(from), '█'.repeat(Math.max(0, to - from)), '░'.repeat(cw - Math.max(from, to))] as const
      })()

      return (
        <Box
          key={`card-${hp.id}`}
          flexDirection="row"
          width={width}
          marginBottom={1}
          borderStyle="round"
          borderColor={live ? hue.color : undefined}
          borderDimColor={!live}
          paddingX={1}
          paddingY={1}
          gap={0}
        >
          {pet(hp)}
          <Box flexDirection="column" width={cw}>
            <Box flexDirection="row" justifyContent="space-between" width={cw}>
              <Box width={cw - 2}>
                <Text bold wrap="truncate-end">
                  {cut(hp.description, cw - 2)}
                </Text>
              </Box>
              <Text bold color={markColor}>
                {mark}
              </Text>
            </Box>
            <Box flexDirection="row" justifyContent="space-between" width={cw}>
              <Text dimColor wrap="truncate-end">
                {cut(who, Math.max(4, cw - meta.length - 1))}
              </Text>
              <Text dimColor>{meta}</Text>
            </Box>
            <Box flexDirection="row" width={cw} marginTop={1}>
              {live ? (
                <Text bold color={ACCENT}>
                  {`${spin} `}
                </Text>
              ) : null}
              <Box width={leadW}>
                <Text bold={live} color={live ? ACCENT : hp.phase === 'done' ? GOOD : BAD} wrap="truncate-end">
                  {cut(lead, leadW)}
                </Text>
              </Box>
              {live ? <Text color={ACCENT}>{` ${pulse}`}</Text> : null}
            </Box>
            {!isOpen &&
              history.map((st, i) => (
                <Text key={`hp-${hp.id}-${i}`} dimColor wrap="truncate-end">
                  {cut(`  ${st.live}`, cw)}
                </Text>
              ))}
            {Svg ? (
              <Box key={`bar-${hp.id}`} width={cw} marginTop={1}>
                <Svg source={cardBarSvg(hp.phase, hue.color, barPx, hp.seat, FAIL_HEX, animate)} alt={barAlt} width={barPx} height={CARD_BAR_H} />
              </Box>
            ) : (
              <Text key={`bar-${hp.id}`} wrap="truncate-end">
                <Text dimColor>{blocks[0]}</Text>
                <Text color={hp.phase === 'failed' ? FAIL_HEX : hue.color}>{blocks[1]}</Text>
                <Text dimColor>{blocks[2]}</Text>
              </Text>
            )}
            {hp.steps.length ? (
              <Button key={`steps-${hp.id}`} plain dimColor onPress={() => undefined}>
                {isOpen ? '▾ Hide steps' : `▸ All ${hp.count} step${hp.count === 1 ? '' : 's'}`}
              </Button>
            ) : null}
            {isOpen ? (
              <Box key={`list-${hp.id}`} flexDirection="column" width={cw}>
                {hp.count > hp.steps.length ? <Text dimColor>{`${hp.count - hp.steps.length} older steps not kept`}</Text> : null}
                {hp.steps.map((st, i) => {
                  // The label wins the row; the folder gives way first.
                  const room = rowW - st.label.length - 2
                  const dim = !st.dim || st.label.length >= rowW || room < 4 ? '' : st.dim.length > room ? `…${st.dim.slice(-(room - 1))}` : st.dim
                  return (
                    <Box key={`s-${hp.id}-${i}`} flexDirection="row" width={cw}>
                      <Box width={TAG_W}>
                        <Text color={KIND_COLOR[st.kind]}>{st.kind}</Text>
                      </Box>
                      <Box width={rowW}>
                        <Text wrap="truncate-end">
                          {cut(st.label, rowW)}
                          {dim ? <Text dimColor>{`  ${dim}`}</Text> : null}
                        </Text>
                      </Box>
                    </Box>
                  )
                })}
              </Box>
            ) : null}
          </Box>
        </Box>
      )
    }

    // A heading per group: a filled bar the full width, its title and count, and an arrow that folds the group.
    const group = (id: string, title: string, members: Helper[], fill: string, capped: boolean) => {
      if (!members.length) return null
      const folded = view.folded.includes(id)
      const label = `${title} · ${members.length}`
      const room = Math.max(label.length, width - 6)
      const showAll = view.all.includes(id)
      const shown = capped && !showAll ? members.slice(0, CARDS_SHOWN) : members
      const hiddenCount = members.length - shown.length
      return (
        <Box key={`grp-${id}`} flexDirection="column" width={width} marginTop={1}>
          <Box key={`head-${id}`} flexDirection="row" width={width} backgroundColor={fill} paddingX={1} marginBottom={1}>
            <Button key={`group-${id}`} plain onPress={() => undefined}>
              <Text bold color="inverseText" backgroundColor={fill}>
                {folded ? '▸ ' : '▾ '}
              </Text>
            </Button>
            <Text bold color="inverseText" backgroundColor={fill} wrap="truncate-end">
              {label.padEnd(room)}
            </Text>
          </Box>
          {folded ? null : shown.map(card)}
          {folded || !capped || members.length <= CARDS_SHOWN ? null : (
            <Button key={`more-${id}`} plain dimColor onPress={() => undefined}>
              {showAll ? '▴ Show fewer' : `▾ Show ${hiddenCount} more`}
            </Button>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        <Box key="header" flexDirection="row" justifyContent="space-between" gap={1} width={width} marginBottom={1}>
          <Text bold color={running.length ? ACCENT : list.length ? GOOD : undefined}>
            {list.length ? `${list.length} subagent${list.length === 1 ? '' : 's'} in this chat` : 'No subagents yet'}
          </Text>
          <Box flexDirection="row" gap={2}>
            {finished.length + stopped.length ? <Button key="clear" label="Clear finished" dimColor onPress={() => undefined} /> : null}
            <Button key="hide" label="Hide" dimColor onPress={() => undefined} />
          </Box>
        </Box>
        {tiles.length ? (
          <Box key="tiles" flexDirection="row" gap={1} width={width} marginBottom={1}>
            {tiles.map(t => (
              <Box key={`tile-${t.label}`} flexDirection="column" borderStyle="round" paddingX={1} paddingY={1} width={tileW}>
                <Text dimColor wrap="truncate-end">
                  {t.label}
                </Text>
                <Text bold color={ACCENT} wrap="truncate-end">
                  {t.value}
                </Text>
              </Box>
            ))}
          </Box>
        ) : null}
        {list.length ? null : <Text dimColor>Cards show up here when Claude starts a subagent.</Text>}
        {group('running', 'Running', running, GOOD, false)}
        {group('finished', 'Finished', finished, WARN, true)}
        {group('stopped', 'Stopped', stopped, BAD, true)}
      </Box>
    )
  })

  // ---------- Drawing: the task bar above the prompt ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (s.off || s.hidden || e.props.hasSurvey) return next(e)
    const isOff = await read($, OFF)
    const isHidden = await read($, HIDDEN)
    const p = await read($, PLAN)
    if (isOff || isHidden || !p || !p.shown || !p.steps.length) return next(e)
    // Other mods' bands draw above this one. Claude Code's own placeholder is never nested.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const rest = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    const { animate, palette } = cfg
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const cols = typeof e.props.bodyColumns === 'number' && e.props.bodyColumns > 0 ? Math.floor(e.props.bodyColumns) : 0
    const n = p.steps.length
    const done = doneCount(p.steps)
    const pct = `${Math.round((done / n) * 100)}%`
    const label = `Tasks ${done}/${n}`
    const line = nowLine(p)
    const live = p.steps.some(st => st.status === 'in_progress')
    const dismiss = <Button key="plan-dismiss" label="✕" plain dimColor role="dismiss" onPress={() => undefined} />
    const w = cols || BAND_FALLBACK_COLS

    let body: unknown
    if (e.surface !== 'terminal' && 'Svg' in els) {
      const { Svg } = els
      // About 8 CSS pixels a column; the rest is the dismiss button and its gap.
      const px = Math.max(180, Math.min(1600, (cols || 100) * 8 - 56))
      body = (
        <Box key="plan-body" flexDirection="column">
          <Box key="plan-head" flexDirection="row" justifyContent="space-between" gap={1}>
            <Box flexShrink={1}>
              <Text wrap="truncate-end">
                <Text color={palette.mid}>● </Text>
                <Text bold>{p.title}</Text>
                {line ? <Text dimColor>{`  ${line}`}</Text> : null}
              </Text>
            </Box>
            <Text dimColor>{pct}</Text>
          </Box>
          <Box key="plan-row" flexDirection="row" alignItems="center" gap={1}>
            <Svg key="plan-svg" source={taskBarSvg({ done, steps: n, live, width: px, palette, animate })} alt={`${p.title}: ${label}, ${pct}`} width={px} height={BAR_H} />
            {dismiss}
          </Box>
        </Box>
      )
    } else {
      // The terminal: dot, title, a gradient of blocks, the step in progress shimmering, count, percent.
      const tick = await read($, SHIM)
      const titleW = Math.max(6, Math.min(28, p.title.length, Math.floor(w / 3)))
      const barW = Math.max(6, w - titleW - label.length - pct.length - 10)
      const fillC = Math.round((barW * done) / n)
      const liveC = live ? Math.max(0, Math.round((barW * Math.min(n, done + 1)) / n) - fillC) : 0
      const cells = Array.from({ length: fillC }, (_, i) => mix(palette.light, palette.deep, fillC > 1 ? i / (fillC - 1) : 1))
      body = (
        <Box key="plan-body" flexDirection="column">
          <Box key="plan-row" flexDirection="row" gap={1} width={w}>
            <Text color={palette.deep}>●</Text>
            <Box width={titleW} flexShrink={0}>
              <Text bold wrap="truncate-end">
                {cut(p.title, titleW)}
              </Text>
            </Box>
            <Text key="plan-bar">
              {cells.map((c, i) => (
                <Text key={`f-${i}`} color={c}>
                  █
                </Text>
              ))}
              {liveC ? <Text color={tick % 2 ? palette.mid : palette.light}>{'▓'.repeat(liveC)}</Text> : null}
              <Text dimColor>{'░'.repeat(Math.max(0, barW - fillC - liveC))}</Text>
            </Text>
            <Text bold color={palette.mid}>
              {label}
            </Text>
            <Text dimColor>{pct}</Text>
            {dismiss}
          </Box>
          {line ? (
            <Text key="plan-now" dimColor wrap="truncate-end">
              {cut(line, w)}
            </Text>
          ) : null}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {rest as never}
        <Box key="plan-band" flexDirection="column">
          {body as never}
        </Box>
      </Box>
    )
  })
}
