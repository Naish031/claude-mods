import { update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ScreenShareMode } from '../types'
import {
  PEEK_MAX,
  TOGGLE_KINDS,
  buildRules,
  onKinds,
  parseWordFile,
  readOverrides,
  readSettings,
  wordFileText,
  wordsFromArgs,
  type Overrides,
  type Settings,
  type WordFile,
} from './config'
import { hideQuestions, maskQuestions, maskTree } from './rows'
import { FADE, NAME_MODES, STYLES, cleanList, compile, hiddenRow, maskDeep, maskText, clearCache, type Compiled, type NameMode, type Style } from './mask'

// Screen Share. /screen-share hides emails, phone numbers, money amounts, names, keys and the
// like on screen while you record. It changes only what is DRAWN: the stored chat, the prompts,
// the tool inputs and what Claude reads are never touched, so Claude keeps working with the real data.
//
// Fail closed: if hiding a row throws, the row is drawn as a placeholder bar, never as raw text.
// Fail open for everything else: no prompt or tool call is ever blocked or altered by this mod.
//
// Two different things, kept apart:
//   "Screen share is ON/OFF"  what you toggle with /screen-share. Kept per machine in $.store.
//   the switch file            ~/.claude/claude-mods/switches.json with "screen-share": false turns the
//                              whole mod off (it then hides nothing and says so).

const NAME = 'screen-share'
const MODE = { plugin: 'screen-share', key: 'mode' } as const
const OFF_MODE: ScreenShareMode = { on: false, peekUntil: 0, v: 0, tick: 0 }
const FADE_MS = 150
const POLL_MS = 2000
const SWITCH_TTL_MS = 1000
const LOG_MAX = 100_000
const STATUS_ON = 'Screen share ON'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** What the hooks need to draw: the compiled rules and the glyph to draw bars with right now. */
type View = { c: Compiled; glyph: string }

type Live = {
  home: string
  ov: Overrides
  file: WordFile
  fileText: string
  compiled: Compiled
  fault: boolean
  /** What the store held for on/off at boot, used when the session state cannot be written yet. */
  savedOn: boolean
  switchOff: boolean
  switchAt: number
  switchHandled: boolean
  fadeUntil: number
}

// Module variables are lost on a hot reload, so each one can be built again from $.state, $.store and the files.
let base: Settings = readSettings({})
let live: Live | undefined
let booting: Promise<Live> | undefined
let pollTimer: Timer | undefined
let peekTimer: Timer | undefined
const lastLogged = new Map<string, number>()
// What fail-closed needs when a hook throws before it can ask: the last answer it knew.
const shadow = { on: false, peeking: false, off: false }

// ------------------------------------------------------------------ files, log, switch

const dirOf = (home: string) => `${home}/.claude/claude-mods`
const switchesPath = (home: string) => `${dirOf(home)}/switches.json`
const wordsPath = (home: string) => `${dirOf(home)}/screen-share.json`
const logPath = (home: string) => `${dirOf(home)}/logs/${NAME}.log`

async function now($: Engine): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

/** One bounded line per notable event. Never prompt text, never a hidden value. */
async function log($: Engine, line: string, throttleMs = 0) {
  try {
    const t = await now($)
    const last = lastLogged.get(line)
    if (throttleMs > 0 && last !== undefined && t - last < throttleMs) return
    lastLogged.set(line, t)
    if (lastLogged.size > 200) lastLogged.clear()
    const home = live?.home ?? (await $.env.get('HOME').catch(() => undefined)) ?? ''
    if (!home) return
    const path = logPath(home)
    let old = ''
    if (await $.fs.exists(path).catch(() => false)) old = String(await $.fs.read(path))
    else await $.process.run(['mkdir', '-p', `${dirOf(home)}/logs`])
    await $.fs.write(path, `${old}${new Date(t).toISOString()} ${line}\n`.slice(-LOG_MAX))
  } catch {
    // Logging must never break the screen.
  }
}

async function readSwitchFile($: Engine, home: string): Promise<boolean> {
  try {
    const path = switchesPath(home)
    if (!(await $.fs.exists(path))) return false
    const json = JSON.parse(String(await $.fs.read(path))) as Record<string, unknown>
    return json[NAME] === false
  } catch {
    // Missing or unreadable: the mod is on, so what was asked to be hidden stays hidden.
    return false
  }
}

async function readWordFile($: Engine, home: string): Promise<string> {
  try {
    const path = wordsPath(home)
    return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
  } catch {
    return ''
  }
}

function rulesOf(b: Pick<Live, 'ov' | 'file' | 'home'>) {
  return compile(buildRules(base, b.ov, b.file, b.home))
}

// ------------------------------------------------------------------ boot and state

async function boot($: Engine): Promise<Live> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const get = (k: string) => $.store.get(k).catch(() => undefined)
  const ov = readOverrides({ style: await get('style'), names: await get('names'), kinds: await get('kinds') })
  const fileText = await readWordFile($, home)
  const file = parseWordFile(fileText)
  const b: Live = {
    home,
    ov,
    file,
    fileText,
    compiled: compile(buildRules(base, ov, file, home)),
    fault: (await get('fault')) === 'mask',
    savedOn: (await get('on')) === true,
    switchOff: false,
    switchAt: 0,
    switchHandled: false,
    fadeUntil: 0,
  }
  b.switchOff = await readSwitchFile($, home)
  b.switchHandled = b.switchOff
  b.switchAt = await now($)
  shadow.off = b.switchOff
  // A first run on this load takes the mode this machine had; a hot reload keeps the one the session holds.
  const held = await $.state.get(MODE)
  if (held.value === undefined) {
    shadow.on = b.savedOn
    try {
      await $.state.set(MODE, { ...OFF_MODE, on: b.savedOn })
    } catch {
      // Not allowed while a row draws; modeNow() answers from the store's value until a write goes through.
    }
  } else {
    shadow.on = held.value.on
    shadow.peeking = held.value.peekUntil > (await now($))
    // A hot reload has no session.start: take the timers up again here.
    if (shadow.peeking) startPeekTimer($)
  }
  startPoll($)
  return b
}

function ready($: Engine): Promise<Live> {
  if (live) return Promise.resolve(live)
  booting ??= boot($)
    .then(b => {
      live = b
      return b
    })
    .finally(() => {
      booting = undefined
    })
  return booting
}

async function modeNow($: Engine): Promise<ScreenShareMode> {
  const { value } = await $.state.get(MODE)
  return value ?? { ...OFF_MODE, on: live?.savedOn ?? false }
}

async function writeMode($: Engine, patch: Partial<ScreenShareMode>): Promise<ScreenShareMode> {
  const next = await update($, MODE, cur => ({ ...(cur ?? OFF_MODE), ...patch, v: (cur?.v ?? 0) + 1 }))
  const t = await now($)
  shadow.on = next.on
  shadow.peeking = next.peekUntil > t
  return next
}

function redraw($: Engine) {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // The state write redraws the rows that read it anyway.
  }
}

/** The rules and glyph to hide with right now, or null when nothing is to be hidden (off, peeking, or switched off). */
async function view($: Engine): Promise<View | null> {
  const b = await ready($)
  const t = await now($)
  if (!b.switchAt || t - b.switchAt >= SWITCH_TTL_MS) {
    b.switchAt = t
    b.switchOff = await readSwitchFile($, b.home)
  }
  shadow.off = b.switchOff
  const m = await modeNow($)
  shadow.on = m.on
  shadow.peeking = m.peekUntil > t
  if (b.switchOff || !m.on || shadow.peeking) return null
  if (b.fault) throw new Error('masking fault (test switch)')
  const bars = b.compiled.rules.style === 'bar'
  return { c: b.compiled, glyph: bars && base.fade && t < b.fadeUntil ? FADE : b.compiled.rules.glyph }
}

/** True when a row that failed to draw must be hidden, judged from the last answer known. */
const mustHide = () => shadow.on && !shadow.peeking && !shadow.off

// ------------------------------------------------------------------ drawing helpers

function hiddenTree($: Engine, e: Any, text?: unknown) {
  const { Text } = $.ui.resolve(e)
  return <Text dimColor>{hiddenRow(text, live?.compiled.rules.glyph)}</Text>
}

/** Where a hook failed, and what it drew instead. One line a minute at most per place. */
async function failed($: Engine, where: string) {
  await log($, `hiding failed in ${where}: the row was drawn as a placeholder`, 60_000)
}

/** A row's hook failed: hide it when something should be hidden, else draw it as it came. One handler for every row. */
async function hideRow($: Engine, e: Any, next: Any) {
  if (!mustHide()) return next(e)
  await failed($, String(e.component ?? 'row'))
  return hiddenTree($, e, (e.props ?? {}).text)
}

// ------------------------------------------------------------------ on, off, peek

async function setOn($: Engine, on: boolean, why: string) {
  const b = await ready($)
  stopPeekTimer()
  const t = await now($)
  b.fadeUntil = on && base.fade && b.compiled.rules.style === 'bar' ? t + FADE_MS : 0
  await writeMode($, { on, peekUntil: 0, tick: 0 })
  try {
    await $.store.set('on', on)
  } catch {
    await log($, 'could not remember on/off in the store')
  }
  await showStatus($)
  redraw($)
  if (b.fadeUntil) $.clock.after(FADE_MS, () => redraw($))
  try {
    await $.ui.toast(on ? `${STATUS_ON}: private data is hidden on screen` : 'Screen share OFF: everything shows as normal')
  } catch {
    // A toast is a nicety.
  }
  await log($, `${on ? 'on' : 'off'} (${why})`)
}

async function showStatus($: Engine) {
  try {
    const b = await ready($)
    const m = await modeNow($)
    const text = b.switchOff || !m.on ? undefined : m.peekUntil > (await now($)) ? `${STATUS_ON} (peeking)` : STATUS_ON
    await $.ui.status(text)
  } catch {
    // The status line is a nicety; the band and the mode label still show.
  }
}

function stopPeekTimer() {
  try {
    peekTimer?.cancel()
  } catch {
    // Already stopped.
  }
  peekTimer = undefined
}

async function endPeek($: Engine, why: string) {
  stopPeekTimer()
  await writeMode($, { peekUntil: 0, tick: 0 })
  await showStatus($)
  redraw($)
  try {
    await $.ui.toast('Screen share is hiding again')
  } catch {
    // Nicety.
  }
  await log($, `peek ended (${why})`)
}

function startPeekTimer($: Engine) {
  stopPeekTimer()
  try {
    peekTimer = $.clock.every(1000, () => {
      void (async () => {
        try {
          const m = await modeNow($)
          const t = await now($)
          if (!m.on || m.peekUntil <= t) await endPeek($, 'time up')
          else await writeMode($, { tick: t })
        } catch {
          // The next tick tries again.
        }
      })()
    })
  } catch {
    // No timer: the peek still ends at its time, the next row that draws checks the clock.
  }
}

async function startPeek($: Engine, seconds: number) {
  const secs = Math.max(1, Math.min(Math.floor(seconds), PEEK_MAX))
  const t = await now($)
  await writeMode($, { peekUntil: t + secs * 1000, tick: t })
  startPeekTimer($)
  await showStatus($)
  redraw($)
  try {
    await $.ui.toast(`Screen share PEEK: private data is visible for ${secs} s`)
  } catch {
    // Nicety.
  }
  await log($, `peek ${secs}s`)
  return secs
}

// ------------------------------------------------------------------ rules that change at run time

async function rebuild($: Engine) {
  const b = await ready($)
  b.compiled = rulesOf(b)
  clearCache()
  await writeMode($, {})
  redraw($)
}

async function saveWords($: Engine, b: Live): Promise<boolean> {
  try {
    const dir = dirOf(b.home)
    const text = wordFileText(b.file)
    if (!(await $.fs.exists(wordsPath(b.home)).catch(() => false))) await $.process.run(['mkdir', '-p', dir])
    await $.fs.write(wordsPath(b.home), text)
    b.fileText = text
    return true
  } catch {
    await log($, 'could not write the words file')
    return false
  }
}

/** What the poll sees change: the words file, and the switch file. Runs every 2 s and costs two small reads. */
async function pollOnce($: Engine) {
  const b = await ready($)
  const text = await readWordFile($, b.home)
  if (text !== b.fileText) {
    b.fileText = text
    b.file = parseWordFile(text)
    await rebuild($)
    await log($, 'words file changed, rules rebuilt')
  }
  const off = await readSwitchFile($, b.home)
  b.switchOff = off
  b.switchAt = await now($)
  shadow.off = off
  if (off !== b.switchHandled) {
    b.switchHandled = off
    const m = await modeNow($)
    stopPeekTimer()
    if (off && m.on) {
      try {
        await $.ui.toast('Screen share is OFF: the mod is switched off in switches.json, so nothing is hidden')
      } catch {
        // Nicety.
      }
    }
    await showStatus($)
    await writeMode($, { peekUntil: 0, tick: 0 })
    redraw($)
    await log($, off ? 'switched off in the switch file: nothing is hidden' : 'switched on again in the switch file')
  }
}

function startPoll($: Engine) {
  if (pollTimer) return
  try {
    pollTimer = $.clock.every(POLL_MS, () => {
      void pollOnce($).catch(() => undefined)
    })
  } catch {
    // The 1 s switch read at draw time still works without the poll.
  }
}

// ------------------------------------------------------------------ the command

const HELP = [
  'Screen share. /screen-share toggles it. Also:',
  'on | off | status',
  'peek [seconds]   show the real text for a few seconds (hide ends it)',
  'add <words>      always hide these words or names, "mask" works too',
  'remove <words>   stop hiding them, "unmask" works too',
  'allow <words>    never hide these; unallow <words> to undo',
  'words            how many words are listed',
  `style ${STYLES.join('|')}`,
  `names ${NAME_MODES.join('|')}`,
  `cat <${TOGGLE_KINDS.join('|')}> on|off`,
  'test             show a sample of what is hidden',
  'reset            clear style, names and category overrides',
].join('\n')

const SAMPLE =
  'Mail jane.doe@acme.com or call +44 7700 900123. Invoice total $4,250.00 for Priya Sharma. Key: sk-ant-api03-EXAMPLEEXAMPLEEXAMPLE12. Card 4111 1111 1111 1111. 2026, 182k tokens, v2.1.309 stay.'

async function describe($: Engine): Promise<string> {
  const b = await ready($)
  const m = await modeNow($)
  const t = await now($)
  const r = b.compiled.rules
  const state = b.switchOff
    ? 'OFF: this mod is switched off in ~/.claude/claude-mods/switches.json, so it hides nothing'
    : !m.on
      ? 'OFF'
      : m.peekUntil > t
        ? `ON, peeking for ${Math.ceil((m.peekUntil - t) / 1000)} more s (private data is visible)`
        : 'ON'
  const kinds = onKinds(r.kinds).join(', ') || 'nothing'
  return [
    `Screen share is ${state}.`,
    `Hiding: ${kinds}. Style: ${r.style}. Names: ${r.names}.`,
    `Always-mask words: ${r.deny.length}. Never-mask words: ${r.allow.length}.`,
    'Only the screen changes. Claude and the chat still hold the real data.',
  ].join('\n')
}

async function runCommand($: Engine, args: string): Promise<string> {
  const b = await ready($)
  b.switchOff = await readSwitchFile($, b.home)
  shadow.off = b.switchOff
  if (b.switchOff)
    return 'Screen share is switched off in ~/.claude/claude-mods/switches.json ("screen-share": false), so it hides nothing. Remove that line, or set it to true, to use it.'
  const raw = args.trim()
  const head = raw.split(/\s+/)[0] ?? ''
  const sub = head.toLowerCase()
  const rest = raw.slice(head.length).trim()
  const m = await modeNow($)

  switch (sub) {
    case '':
      await setOn($, !m.on, 'command')
      return !m.on ? 'Screen share ON. Private data is hidden on screen. Claude still reads the real data. Run /screen-share again to turn it off.' : 'Screen share OFF. Everything shows as normal.'
    case 'on':
    case 'start':
    case 'enable':
      await setOn($, true, 'command')
      return 'Screen share ON. Private data is hidden on screen. Claude still reads the real data.'
    case 'off':
    case 'stop':
    case 'disable':
      await setOn($, false, 'command')
      return 'Screen share OFF. Everything shows as normal.'
    case 'status':
      return describe($)
    case 'peek': {
      if (!m.on) return 'Screen share is off, so everything shows already.'
      const asked = rest ? Number(rest) : base.peekSeconds
      if (!Number.isFinite(asked) || asked < 1) return `Use /screen-share peek <seconds>, 1 to ${PEEK_MAX}.`
      const secs = await startPeek($, asked)
      return `Peeking: private data is visible for ${secs} s, then hidden again. /screen-share hide ends it now.`
    }
    case 'hide':
    case 'unpeek':
      if (m.peekUntil <= (await now($))) return 'Nothing to hide: no peek is running.'
      await endPeek($, 'command')
      return 'Hiding again.'
    case 'add':
    case 'mask': {
      const words = wordsFromArgs(rest)
      if (words.length === 0) return 'Use /screen-share add <word or name>. Separate several with commas.'
      b.file = { ...b.file, mask: cleanList([...b.file.mask, ...words]) }
      if (!(await saveWords($, b))) return 'Could not save the word. See the log: ~/.claude/claude-mods/logs/screen-share.log.'
      await rebuild($)
      await log($, `always-mask list now ${b.file.mask.length} words`)
      return `Added ${words.length} to the always-mask list (${b.file.mask.length} in all). It is hidden from now on, in every chat.`
    }
    case 'remove':
    case 'unmask': {
      const drop = new Set(wordsFromArgs(rest).map(w => w.toLowerCase()))
      const before = b.file.mask.length
      b.file = { ...b.file, mask: b.file.mask.filter(w => !drop.has(w.toLowerCase())) }
      if (b.file.mask.length === before) return 'None of those were on the always-mask list in the words file. Words set in the config menu are changed there.'
      if (!(await saveWords($, b))) return 'Could not save. See the log.'
      await rebuild($)
      return `Removed ${before - b.file.mask.length}. ${b.file.mask.length} left in the words file.`
    }
    case 'allow': {
      const words = wordsFromArgs(rest)
      if (words.length === 0) return 'Use /screen-share allow <word or name>. It is never hidden by the automatic rules.'
      b.file = { ...b.file, allow: cleanList([...b.file.allow, ...words]) }
      if (!(await saveWords($, b))) return 'Could not save. See the log.'
      await rebuild($)
      return `Allowed ${words.length} (${b.file.allow.length} in all). The automatic rules will not hide them. Words on the always-mask list are still hidden.`
    }
    case 'unallow': {
      const drop = new Set(wordsFromArgs(rest).map(w => w.toLowerCase()))
      const before = b.file.allow.length
      b.file = { ...b.file, allow: b.file.allow.filter(w => !drop.has(w.toLowerCase())) }
      if (b.file.allow.length === before) return 'None of those were on the never-mask list in the words file.'
      if (!(await saveWords($, b))) return 'Could not save. See the log.'
      await rebuild($)
      return `Removed ${before - b.file.allow.length}. ${b.file.allow.length} left in the words file.`
    }
    case 'words':
    case 'list':
      return `The words file holds ${b.file.mask.length} always-mask and ${b.file.allow.length} never-mask words (the words are not printed). Edit ~/.claude/claude-mods/screen-share.json to see or change them by hand.`
    case 'style': {
      const v = rest.toLowerCase()
      if (!(STYLES as readonly string[]).includes(v)) return `Use /screen-share style ${STYLES.join(' | ')}.`
      b.ov = { ...b.ov, style: v as Style }
      await $.store.set('style', v)
      await rebuild($)
      return `Style is now ${v}.`
    }
    case 'names': {
      const v = rest.toLowerCase()
      if (!(NAME_MODES as readonly string[]).includes(v)) return `Use /screen-share names ${NAME_MODES.join(' | ')}. off: never. context: only where the text says it is a person. smart: also two words that look like a first and last name.`
      b.ov = { ...b.ov, names: v as NameMode }
      await $.store.set('names', v)
      await rebuild($)
      return `Names are now: ${v}.`
    }
    case 'cat':
    case 'category': {
      const [k = '', flag = ''] = rest.toLowerCase().split(/\s+/)
      const kind = TOGGLE_KINDS.find(x => x === k || `${x}s` === k)
      if (!kind || (flag !== 'on' && flag !== 'off')) return `Use /screen-share cat <${TOGGLE_KINDS.join('|')}> on|off.`
      b.ov = { ...b.ov, kinds: { ...(b.ov.kinds ?? {}), [kind]: flag === 'on' } }
      await $.store.set('kinds', b.ov.kinds ?? {})
      await rebuild($)
      return `Hiding ${kind}: ${flag}.`
    }
    case 'reset':
      b.ov = {}
      await $.store.delete('style').catch(() => undefined)
      await $.store.delete('names').catch(() => undefined)
      await $.store.delete('kinds').catch(() => undefined)
      await rebuild($)
      return 'Style, names and category overrides are cleared. The config menu settings apply again.'
    case 'test':
      return `Sample, as hidden with your settings:\n${maskText(SAMPLE, b.compiled)}`
    case 'help':
    case '?':
      return HELP
    default:
      return `Unknown option. ${HELP}`
  }
}

// ------------------------------------------------------------------ register

export const register: Register = (on, options) => {
  base = readSettings((options ?? {}) as Record<string, string | number | boolean | readonly string[]>)

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'screen-share',
        description: 'Screen share on or off: hides emails, phone numbers, amounts, names and keys on screen (Claude still reads the real data)',
        argumentHint: '[on|off|status|peek|add <word>|allow <word>|style|names|cat|test]',
        // Works at once, also while Claude is busy, instead of after the turn.
        immediate: true,
      })
    } catch {
      // The mod hides on screen without its command; switching it needs the command.
    }
    try {
      await ready($)
      startPoll($)
      const m = await modeNow($)
      if (m.peekUntil > (await now($))) startPeekTimer($)
      await showStatus($)
    } catch {
      await log($, 'start failed; rows are still checked as they draw')
    }
    return next(e)
  })

  on('command.run', { command: 'screen-share' }, async ($, e) => {
    try {
      const text = await runCommand($, String((e as { args?: string }).args ?? ''))
      return { text }
    } catch {
      await log($, 'command failed')
      return { text: 'Screen share could not do that. See ~/.claude/claude-mods/logs/screen-share.log.' }
    }
  })

  on('ui.press', { plugin: 'screen-share', element: 'off' }, async ($, e) => {
    try {
      await setOn($, false, 'button')
    } catch {
      await log($, 'off button failed')
    }
    return { element: e.element }
  })
  on('ui.press', { plugin: 'screen-share', element: 'peek' }, async ($, e) => {
    try {
      await startPeek($, base.peekSeconds)
    } catch {
      await log($, 'peek button failed')
    }
    return { element: e.element }
  })
  on('ui.press', { plugin: 'screen-share', element: 'hide' }, async ($, e) => {
    try {
      await endPeek($, 'button')
    } catch {
      await log($, 'hide button failed')
    }
    return { element: e.element }
  })

  // ---- the transcript rows. Each reads the mode while drawing, so a switch redraws every row that read it.
  // The props pass as they came when nothing is private. A hook that fails hides its row.

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const v = await view($)
    if (!v) return next(e)
    const text = maskText(e.props.text, v.c, v.glyph)
    if (e.props.from || e.props.task) {
      // A message another agent or a task sent keeps the engine's framing only for a plain string; draw our own row.
      const { Text } = $.ui.resolve(e)
      return <Text dimColor={!e.props.isExpanded}>{text}</Text>
    }
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  }).catch(hideRow)

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const v = await view($)
    if (!v) return next(e)
    const text = maskText(e.props.text, v.c, v.glyph)
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  }).catch(hideRow)

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const v = await view($)
    if (!v) return next(e)
    const text = maskText(e.props.text, v.c, v.glyph)
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  }).catch(hideRow)

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const v = await view($)
    if (!v) return next(e)
    const input = maskDeep(e.props.input, v.c, v.glyph)
    const output = maskDeep(e.props.output, v.c, v.glyph)
    if (input === e.props.input && output === e.props.output) return next(e)
    return next({ ...e, props: { ...e.props, input, output } })
  }).catch(hideRow)

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const v = await view($)
    if (!v) return next(e)
    if (e.props.isErrored) {
      // The engine draws an error's text from its own copy, not from `output`, so it cannot be masked in place: draw it here.
      const { Text } = $.ui.resolve(e)
      const o = e.props.output
      const text = typeof o === 'string' ? maskText(o, v.c, v.glyph) : hiddenRow(undefined, v.glyph)
      return <Text color="error">{text}</Text>
    }
    const output = maskDeep(e.props.output, v.c, v.glyph)
    return output === e.props.output ? next(e) : next({ ...e, props: { ...e.props, output } })
  }).catch(hideRow)

  // The folded group line only counts calls ("Read 3 files"); the calls are masked for any surface that draws a detail from them.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const v = await view($)
    if (!v) return next(e)
    const calls = maskDeep(e.props.calls, v.c, v.glyph)
    return calls === e.props.calls ? next(e) : next({ ...e, props: { ...e.props, calls } })
  }).catch(hideRow)

  // The spinner's words on the desktop name the file being written ("Creating notes.md").
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const v = await view($)
    if (!v) return next(e)
    const word = maskText(e.props.word, v.c, v.glyph)
    const message = e.props.message === null ? null : maskText(e.props.message, v.c, v.glyph)
    return word === e.props.word && message === e.props.message ? next(e) : next({ ...e, props: { ...e.props, word, message } })
  }).catch(hideRow)

  on('ui.render', { component: 'InfoNotice' }, async ($, e, next) => {
    const v = await view($)
    if (!v) return next(e)
    const text = maskText(e.props.text, v.c, v.glyph)
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  }).catch(hideRow)

  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const v = await view($)
    if (!v) return next(e)
    const questions = maskQuestions(e.props.questions, v.c, v.glyph)
    return next({ ...e, props: { ...e.props, questions } })
  }).catch(async ($, e, next) => {
    if (!mustHide()) return next(e)
    // Still answerable, but nothing in it is readable: every question and description is a placeholder.
    const questions = hideQuestions(e.props.questions)
    return next({ ...e, props: { ...e.props, questions } })
  })

  // Other mods' panes and bands: their text is walked, their layout is left alone.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    const v = await view($)
    const tree = await next(e)
    return v && base.maskPanels ? maskTree(tree, v.c, v.glyph) : tree
  }).catch(hideRow)

  // The indicator: a band above the prompt that says it is on, with Peek and Turn off.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const b = await ready($)
    if (b.switchOff) return next(e)
    const m = await modeNow($)
    if (!m.on) return next(e)
    const t = await now($)
    const peeking = m.peekUntil > t
    let rest = await next(e)
    const v = await view($)
    if (v && base.maskPanels) rest = maskTree(rest, v.c, v.glyph)
    const { Box, Text, Button } = $.ui.resolve(e)
    const noop = () => undefined
    const narrow = e.props.bodyColumns < 56
    const detail = narrow ? '' : ` ${onKinds(b.compiled.rules.kinds).length} kinds hidden, style ${b.compiled.rules.style}. Claude still reads the real data.`
    return (
      <Box flexDirection="column">
        {rest}
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
          {peeking ? (
            <Text wrap="truncate-end">
              <Text color="error" weight="bold">● PEEKING {Math.max(1, Math.ceil((m.peekUntil - t) / 1000))}s: private data is visible</Text>
            </Text>
          ) : (
            <Text wrap="truncate-end">
              <Text color="warning" weight="bold">● SCREEN SHARE ON</Text>
              <Text dimColor>{detail}</Text>
            </Text>
          )}
          <Box flexDirection="row" gap={1}>
            {peeking ? (
              <Button key="hide" label="Hide now" onPress={noop} />
            ) : (
              <Button key="peek" label={`Peek ${base.peekSeconds}s`} onPress={noop} />
            )}
            <Button key="off" label="Turn off" onPress={noop} />
          </Box>
        </Box>
      </Box>
    )
  }).catch(async ($, e, next) => {
    if (!mustHide()) return next(e)
    // Something failed: drop the other bands (they may hold private text) and keep the indicator.
    const { Text } = $.ui.resolve(e)
    return <Text color="warning" weight="bold">● SCREEN SHARE ON (the band was hidden after an error)</Text>
  })

  // A label at the right of the prompt footer, so the state shows even when the band is collapsed.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const b = await ready($)
    const m = await modeNow($)
    if (b.switchOff || !m.on) return next(e)
    const label = m.peekUntil > (await now($)) ? 'screen share PEEK' : 'screen share ON'
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  }).catch(async ($, e, next) => next(e))

  // ---- text other mods put on screen through $.ui: toasts, log lines, notices and native notifications.

  on('ui.toast', async ($, e, next) => {
    const v = await view($)
    return v ? next({ ...e, text: maskText(e.text, v.c, v.glyph) }) : next(e)
  }).catch(async (_$, e, next) => (mustHide() ? next({ ...e, text: hiddenRow(e.text) }) : next(e)))

  on('ui.log', async ($, e, next) => {
    const v = await view($)
    return v ? next({ ...e, text: maskText(e.text, v.c, v.glyph) }) : next(e)
  }).catch(async (_$, e, next) => (mustHide() ? next({ ...e, text: hiddenRow(e.text) }) : next(e)))

  on('ui.notice', async ($, e, next) => {
    const v = await view($)
    return v && typeof e.text === 'string' ? next({ ...e, text: maskText(e.text, v.c, v.glyph) }) : next(e)
  }).catch(async (_$, e, next) => (mustHide() && typeof e.text === 'string' ? next({ ...e, text: hiddenRow(e.text) }) : next(e)))

  on('ui.status', async ($, e, next) => {
    const v = await view($)
    return v && typeof e.text === 'string' ? next({ ...e, text: maskText(e.text, v.c, v.glyph) }) : next(e)
  }).catch(async (_$, e, next) => (mustHide() && typeof e.text === 'string' ? next({ ...e, text: hiddenRow(e.text) }) : next(e)))

  on('ui.notify', async ($, e, next) => {
    const v = await view($)
    if (!v) return next(e)
    const title = typeof e.title === 'string' ? maskText(e.title, v.c, v.glyph) : e.title
    return next({ ...e, text: maskText(e.text, v.c, v.glyph), title })
  }).catch(async (_$, e, next) => (mustHide() ? next({ ...e, text: hiddenRow(e.text), title: undefined }) : next(e)))

  // The dim suggestion in the prompt box is made from the chat and Tab writes it into the box: hide it rather than draw bars there.
  on('prompt.suggest', async ($, e, next) => {
    if (!base.hideSuggestions) return next(e)
    const v = await view($)
    return v ? { isShown: false } : next(e)
  }).catch(async (_$, e, next) => (mustHide() && base.hideSuggestions ? { isShown: false } : next(e)))
}
