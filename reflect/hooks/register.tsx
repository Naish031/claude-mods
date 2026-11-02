import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, Register, SessionMessage } from 'claude-code'

import type { ReflectBand as Band, ReflectChat as Chat, ReflectScope as Scope } from '../types'
import {
  DEFAULTS,
  baseName,
  cleanRule,
  cleanSlug,
  dayOf,
  draftPrompt,
  draftSystem,
  expandHome,
  fingerprint,
  folderProblem,
  hasRule,
  normRule,
  parseDraft,
  parseSwitches,
  planAppend,
  readSettings,
  redact,
  removeBlock,
  ruleLine,
  ruleProblem,
  sameRule,
  scoreCorrection,
  stampOf,
  tilde,
  trimLog,
  vaultNote,
} from './core'
import type { Draft, Settings } from './core'

// Reflect: when you correct Claude, offers to save the fix as a lasting rule. See README.md.
//
// Rules this mod follows:
// - Nothing is written until the person presses a button, and the exact text is shown first.
// - CLAUDE.md is only ever appended to. A timestamped backup is made before the first write to a file in a chat.
// - Every save is journalled in $.store, so /reflect undo (or the Undo button) can take out exactly that text.
// - Off when ~/.claude/claude-mods/switches.json has "reflect": false (read at event time, cached 1 s).
// - Fail open: an error here is logged and never blocks, delays or changes a prompt or a tool call.
// - Log: ~/.claude/claude-mods/logs/reflect.log, one line per event, never the person's words.

type Engine = EngineInterface

const NAME = 'reflect'
const SAVED_MS = 20_000 // how long the saved line (with Undo) stays
const NOTE_MS = 8000 // how long an "already saved" or "removed" line stays
const JOURNAL_MAX = 30
const DEFAULT_FOLDER = '~/Documents/rules'
const CANCEL = 'Cancel'

// The band lives in $.state, so a hot reload keeps it. `shape` makes a reload decline an older layout.
const BAND = atom({ plugin: 'reflect', key: 'band' } as const, null as Band | null, { shape: 'band-1' })
const FRESH_CHAT: Chat = { muted: false, lastOfferAt: 0, skipStreak: 0, skipped: [], backedUp: [] }
const CHAT = atom({ plugin: 'reflect', key: 'chat' } as const, FRESH_CHAT, { shape: 'chat-1' })

// ---------------------------------------------------------------------------
// Module variables. A reload resets them; anything that must survive lives in $.state or $.store.

let base: Settings = DEFAULTS
let home = ''
// Bumped on every prompt, so a slow draft for an older prompt is dropped.
let gen = 0
let turnDone = true
let pending: Draft & { correction: string } | null = null
let nextId = 1
let editText = ''
let lastPrompt = ''
let swAt = -1
let swOff = false
let logChain: Promise<unknown> = Promise.resolve()

type Journal = {
  id: string
  kind: 'append' | 'file'
  path: string
  /** The exact text added (append) or the whole note (file). */
  text: string
  rule: string
  scope: Scope
  at: number
  /** The file did not exist before this save. */
  isCreate: boolean
}

const msg = (err: unknown) => String(err instanceof Error ? err.message : err).slice(0, 160)

// ---------------------------------------------------------------------------
// Home, the on/off switch, the log

async function homeDir($: Engine) {
  if (!home) home = ((await $.env.get('HOME').catch(() => undefined)) ?? '').replace(/\/+$/, '') || ($.plugin.root.split('/.claude/')[0] ?? '')
  return home
}

const modsDir = () => `${home}/.claude/claude-mods`

/** Off only when the switches file says "reflect": false. A missing or broken file means on. */
async function isOn($: Engine) {
  const now = await $.clock.now().catch(() => 0)
  if (swAt >= 0 && now >= swAt && now - swAt < 1000) return !swOff
  swAt = now
  try {
    await homeDir($)
    const path = `${modsDir()}/switches.json`
    swOff = (await $.fs.exists(path)) ? parseSwitches(String(await $.fs.read(path)))[NAME] === false : false
  } catch {
    swOff = false
  }
  if (swOff) pending = null
  return !swOff
}

/** The /reflect on/off choice, kept in the store so a reload or a new chat keeps it. */
const isEnabled = ($: Engine) => ($.store.get('enabled').catch(() => undefined) as Promise<unknown>).then(v => v !== false)

/** One line per notable event. Never throws, never holds the person's words, never a rule or a path with one in it. */
function log($: Engine, line: string): Promise<void> {
  logChain = logChain.then(async () => {
    try {
      await homeDir($)
      const path = `${modsDir()}/logs/${NAME}.log`
      const old = (await $.fs.exists(path).catch(() => false)) ? String(await $.fs.read(path)) : ''
      const at = new Date(await $.clock.now()).toISOString()
      // Error texts can name a file (a vault note's name comes from the rule), so paths are blanked.
      const safe = line.replace(/(?:~|\/)[^\s,;:)]*\/[^\s,;:)]*/g, '<path>').slice(0, 300)
      await $.fs.write(path, trimLog(old, `${at} ${safe}`))
    } catch {
      // Nowhere left to report it.
    }
  })
  return logChain as Promise<void>
}

function toast($: Engine, text: string) {
  try {
    $.ui.toast(text)
  } catch {
    // A toast is only a hint.
  }
}

// ---------------------------------------------------------------------------
// State and settings

const getBand = ($: Engine) => read($, BAND)
const setBand = ($: Engine, b: Band | null) => update($, BAND, () => b)
const getChat = ($: Engine) => read($, CHAT)
const patchChat = ($: Engine, fn: (c: Chat) => Chat) => update($, CHAT, c => fn(c ?? FRESH_CHAT))

/** The settings from the config menu, with what /reflect cooldown, sensitivity, project and folder stored on top. */
async function settingsNow($: Engine): Promise<Settings> {
  const s = { ...base }
  const mins = await $.store.get('cooldown').catch(() => undefined)
  if (typeof mins === 'number' && Number.isFinite(mins) && mins >= 0) s.cooldownMs = Math.min(240, mins) * 60_000
  const sens = await $.store.get('sensitivity').catch(() => undefined)
  if (sens === 'careful' || sens === 'normal' || sens === 'eager') s.sensitivity = sens
  const proj = await $.store.get('project').catch(() => undefined)
  if (typeof proj === 'boolean') s.projectScope = proj
  return s
}

async function readJournal($: Engine): Promise<Journal[]> {
  try {
    const v = await $.store.get('journal')
    return Array.isArray(v) ? (v as Journal[]).filter(j => j && typeof j.path === 'string' && typeof j.text === 'string') : []
  } catch {
    return []
  }
}

async function writeJournal($: Engine, list: Journal[]) {
  await $.store.set('journal', list.slice(-JOURNAL_MAX))
}

async function cwdOf($: Engine) {
  const c = await $.session.cwd().catch(() => '')
  return typeof c === 'string' && c.startsWith('/') ? c.replace(/\/+$/, '') : ''
}

// ---------------------------------------------------------------------------
// Reading the chat

function lastAssistantText(messages: readonly SessionMessage[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.text.trim()) return { text: m.text, at: i }
  }
  return { text: '', at: -1 }
}

/** The person's message before the reply that was corrected. */
function userBefore(messages: readonly SessionMessage[], at: number) {
  for (let i = at - 1; i >= 0; i -= 1) {
    const m = messages[i]!
    if (m.role === 'user' && m.text.trim()) return m.text
  }
  return ''
}

const oneLine = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max)

const fromPerson = (e: PromptSubmitInput) => e.origin.kind === 'composer' || e.origin.kind === 'bridge'

// ---------------------------------------------------------------------------
// Detecting, drafting and showing the offer

async function exists($: Engine, path: string) {
  return $.fs.exists(path).catch(() => false)
}

/** True when the rule is already in the global or project CLAUDE.md or was saved before: no point in offering it. */
async function isKnown($: Engine, rule: string) {
  if ((await readJournal($)).some(j => j.rule && sameRule(j.rule, rule))) return true
  const paths = [`${home}/.claude/CLAUDE.md`]
  const cwd = await cwdOf($)
  if (cwd && cwd !== home) paths.push(`${cwd}/CLAUDE.md`)
  for (const p of paths) {
    try {
      if ((await exists($, p)) && hasRule(String(await $.fs.read(p)), rule)) return true
    } catch {
      // An unreadable file cannot tell us anything.
    }
  }
  return false
}

async function show($: Engine, d: Draft & { correction: string }) {
  if (!(await isEnabled($)) || !(await isOn($))) return
  const chat = await getChat($)
  if (chat?.muted) return
  const cur = await getBand($)
  if (cur && cur.phase !== 'saved') return
  const cwd = await cwdOf($)
  const s = await settingsNow($)
  const now = await $.clock.now()
  await setBand($, {
    phase: 'offer',
    id: nextId++,
    rule: d.rule,
    slug: d.slug,
    category: d.category,
    tags: d.tags,
    correction: d.correction,
    learnedIn: cwd ? baseName(cwd) : '',
    hint: d.hint,
    canProject: s.projectScope && cwd !== '' && cwd !== home,
    scope: '',
    target: '',
    shortTarget: '',
    preview: '',
    baseKey: '',
    isCreate: false,
    entryId: '',
    verb: '',
    note: '',
    isError: false,
  })
  await patchChat($, c => ({ ...c, lastOfferAt: now }))
  await log($, `offer shown, category ${d.category}, hint ${d.hint}`)
}

/** Asks the model for the rule. Null when it finds no lasting lesson or the draft fails the checks. */
async function draftRule($: Engine, s: Settings, text: string): Promise<Draft | null> {
  const messages = await $.session.messages()
  const last = lastAssistantText(messages)
  if (!last.text) return null
  const safe = redact(text.trim())
  const r = await $.model.complete({
    model: s.model,
    system: draftSystem(s.plainDashes),
    prompt: draftPrompt(safe, redact(last.text).slice(0, 1500), redact(userBefore(messages, last.at)).slice(0, 500)),
    maxTokens: 300,
    effort: 'low',
    timeoutMs: 30_000,
  })
  if (!r.isAnswered) throw new Error(`draft failed: ${r.reason}`)
  const d = parseDraft(r.text, s.plainDashes)
  if (!d) await log($, 'draft: no lasting lesson, or the rule failed the checks')
  return d
}

/** Runs in the background after a prompt: score the wording, maybe classify, draft, then show when the turn ends. */
async function check($: Engine, text: string, mine: number) {
  const s = await settingsNow($)
  const v = scoreCorrection(text, s.sensitivity)
  if (v.action === 'skip') return
  const chat = await getChat($)
  if (chat?.muted) return
  const now = await $.clock.now()
  const quiet = s.cooldownMs * 2 ** Math.min(chat?.skipStreak ?? 0, 3)
  if (s.cooldownMs > 0 && chat && chat.lastOfferAt > 0 && now - chat.lastOfferAt < quiet) {
    await log($, `held back: quiet time (${Math.round(quiet / 60_000)} min)`)
    return
  }
  const cur = await getBand($)
  if (cur && cur.phase !== 'saved') return
  if (v.action === 'check') {
    const kind = await $.model.classify(redact(text.trim()), ['correction', 'other'])
    if (kind !== 'correction' || mine !== gen) return
  }
  const d = await draftRule($, s, text)
  if (!d || mine !== gen) return
  if (chat?.skipped.includes(normRule(d.rule))) {
    await log($, 'held back: skipped before in this chat')
    return
  }
  if (await isKnown($, d.rule)) {
    await log($, 'held back: rule already saved')
    return
  }
  const full = { ...d, correction: oneLine(redact(text), 200) }
  if (turnDone) await show($, full)
  else pending = full
}

// ---------------------------------------------------------------------------
// The folder for rule notes

/** The folder for notes: the rules_folder setting, else the remembered answer, else ask once. Empty when none was given. */
async function pickFolder($: Engine, s: Settings): Promise<string> {
  if (s.rulesFolder) return expandHome(s.rulesFolder, home)
  const saved = await $.store.get('folder').catch(() => undefined)
  if (typeof saved === 'string' && saved.trim()) return expandHome(saved, home)
  let answer = ''
  try {
    // The dialog needs two options; any other path is typed under Other.
    answer = (await $.ui.ask('Which folder should rule notes go in?', { options: [DEFAULT_FOLDER, CANCEL], header: 'Rules folder' })).trim()
  } catch {
    // A cancelled dialog saves nothing.
    return ''
  }
  if (!answer || answer === CANCEL || (!answer.startsWith('/') && !answer.startsWith('~'))) return ''
  const dir = expandHome(answer, home)
  if (folderProblem(dir, home)) return dir // the caller reports why
  await $.store.set('folder', answer)
  return dir
}

/** Path of a note in `dir` that already says the same rule, or ''. Looks at up to 200 notes. */
async function vaultHas($: Engine, dir: string, rule: string): Promise<string> {
  try {
    if (!(await exists($, dir))) return ''
    const files = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.md')).slice(0, 200)
    for (const f of files) {
      try {
        if (hasRule(String(await $.fs.read(`${dir}/${f.name}`)), rule)) return `${dir}/${f.name}`
      } catch {
        // Skip a note that cannot be read.
      }
    }
  } catch {
    // A folder that cannot be listed has no duplicates we can see.
  }
  return ''
}

// ---------------------------------------------------------------------------
// Planning a save: what exactly would be written, and where

type Plan =
  | { ok: true; kind: 'append' | 'file'; path: string; text: string; old: string; baseKey: string; isCreate: boolean }
  | { ok: false; error: string }
  | { ok: false; dup: string }

async function planFor($: Engine, b: Band, scope: Scope, s: Settings): Promise<Plan> {
  const date = dayOf(await $.clock.now())
  if (scope === 'vault') {
    const dir = await pickFolder($, s)
    if (!dir) return { ok: false, error: 'No folder picked. Nothing saved.' }
    const bad = folderProblem(dir, home)
    if (bad) return { ok: false, error: bad }
    const dup = await vaultHas($, dir, b.rule)
    if (dup) return { ok: false, dup }
    const slug = cleanSlug(b.slug, b.rule)
    let path = `${dir}/${slug}.md`
    for (let k = 2; (await exists($, path)) && k < 100; k += 1) path = `${dir}/${slug}-${k}.md`
    const text = vaultNote({ rule: b.rule, category: b.category, tags: b.tags, learnedIn: b.learnedIn, date, why: b.correction })
    return { ok: true, kind: 'file', path, text, old: '', baseKey: '', isCreate: true }
  }
  let path: string
  if (scope === 'everywhere') path = `${home}/.claude/CLAUDE.md`
  else {
    const cwd = await cwdOf($)
    if (!cwd || cwd === home) return { ok: false, error: 'This chat has no project folder of its own.' }
    path = `${cwd}/CLAUDE.md`
  }
  const there = await exists($, path)
  let old = ''
  if (there) {
    try {
      old = String(await $.fs.read(path))
    } catch (err) {
      return { ok: false, error: `Could not read ${tilde(path, home)}: ${msg(err)}` }
    }
  }
  if (hasRule(old, b.rule)) return { ok: false, dup: path }
  const line = ruleLine({ rule: b.rule, category: b.category, learnedIn: b.learnedIn, date, withPlace: scope === 'everywhere' })
  const p = planAppend(old, line)
  if (p.error) return { ok: false, error: p.error }
  return { ok: true, kind: 'append', path, text: p.block, old, baseKey: fingerprint(old), isCreate: !there }
}

// ---------------------------------------------------------------------------
// Writing, backing up, undoing

async function backup($: Engine, path: string, old: string, scope: Scope, cwd: string): Promise<string> {
  const stamp = stampOf(await $.clock.now())
  const who = scope === 'project' ? `project-${baseName(cwd).replace(/[^A-Za-z0-9._-]+/g, '-') || 'folder'}` : 'global'
  const to = `${modsDir()}/backups/reflect/${stamp}-${who}-CLAUDE.md`
  await $.fs.write(to, old)
  if (String(await $.fs.read(to)) !== old) throw new Error('the backup did not read back as written')
  void path
  return to
}

async function markSaved($: Engine, b: Band, f: Partial<Band>, lingerMs: number) {
  const id = nextId++
  await setBand($, { ...b, ...f, phase: 'saved', id })
  $.clock.after(lingerMs, () => {
    void (async () => {
      const cur = await getBand($)
      if (cur && cur.id === id && cur.phase === 'saved') await setBand($, null)
    })().catch(err => log($, `hide failed: ${msg(err)}`))
  })
}

const failNote = async ($: Engine, b: Band, what: string, err: unknown) => {
  await log($, `${what} failed: ${msg(err)}`)
  await setBand($, { ...b, note: `Could not save: ${msg(err).replace(/\s+/g, ' ')}`, isError: true })
}

/** Step one: pick a scope, work out the exact text, and show it. Nothing is written. */
async function chooseScope($: Engine, b: Band, scope: Scope) {
  const bad = ruleProblem(b.rule)
  if (bad) return setBand($, { ...b, note: bad, isError: true })
  const s = await settingsNow($)
  const plan = await planFor($, b, scope, s)
  if (!plan.ok) {
    if ('dup' in plan) {
      await log($, `scope ${scope}: already saved`)
      return markSaved($, b, { scope, target: plan.dup, shortTarget: tilde(plan.dup, home), verb: 'Already saved in', entryId: '', note: '', isError: false }, NOTE_MS)
    }
    return setBand($, { ...b, note: plan.error, isError: true })
  }
  await setBand($, {
    ...b,
    phase: 'confirm',
    scope,
    target: plan.path,
    shortTarget: tilde(plan.path, home),
    preview: plan.text,
    baseKey: plan.baseKey,
    isCreate: plan.isCreate,
    note: '',
    isError: false,
  })
}

/** Step two: the person pressed Write it. Writes only if the text is still exactly what was shown. */
async function writeIt($: Engine, b: Band) {
  const scope = b.scope
  if (!scope) return
  const bad = ruleProblem(b.rule)
  if (bad) return setBand($, { ...b, phase: 'offer', note: bad, isError: true })
  const s = await settingsNow($)
  const plan = await planFor($, b, scope, s)
  if (!plan.ok) {
    if ('dup' in plan) return markSaved($, b, { target: plan.dup, shortTarget: tilde(plan.dup, home), verb: 'Already saved in', entryId: '', note: '', isError: false }, NOTE_MS)
    return setBand($, { ...b, note: plan.error, isError: true })
  }
  if (plan.path !== b.target || plan.text !== b.preview || plan.baseKey !== b.baseKey) {
    await log($, 'text changed since it was shown; asked again')
    return setBand($, {
      ...b,
      target: plan.path,
      shortTarget: tilde(plan.path, home),
      preview: plan.text,
      baseKey: plan.baseKey,
      isCreate: plan.isCreate,
      note: 'The file changed since you looked. Check the text again.',
      isError: false,
    })
  }
  const chat = await getChat($)
  let backupNote = ''
  let next = plan.text
  if (plan.kind === 'append') {
    if (plan.old !== '' && !chat?.backedUp.includes(plan.path)) {
      try {
        const to = await backup($, plan.path, plan.old, scope, await cwdOf($))
        await patchChat($, c => ({ ...c, backedUp: [...c.backedUp, plan.path] }))
        backupNote = `Backup of the old file: ${tilde(to, home)}`
      } catch (err) {
        return failNote($, b, 'backup', new Error(`could not back up the file first, so nothing was written (${msg(err)})`))
      }
    }
    // Look once more right before writing: if the file moved on, show the person the new text instead.
    const again = (await exists($, plan.path)) ? String(await $.fs.read(plan.path)) : ''
    if (again !== plan.old) {
      await log($, 'file changed while writing; asked again')
      return setBand($, { ...b, note: 'The file changed while you were deciding. Press Back and try again.', isError: true })
    }
    next = plan.old + plan.text
    if (!next.startsWith(plan.old)) return failNote($, b, 'append', new Error('the new text would change existing content; nothing written'))
  }
  try {
    await $.fs.write(plan.path, next)
    const back = String(await $.fs.read(plan.path))
    if (back !== next) throw new Error(`${tilde(plan.path, home)} did not read back as written${backupNote ? `. ${backupNote}` : ''}`)
  } catch (err) {
    return failNote($, b, `write ${scope}`, err)
  }
  const id = `${await $.clock.now()}-${scope}`
  const entry: Journal = { id, kind: plan.kind, path: plan.path, text: plan.text, rule: b.rule, scope, at: await $.clock.now(), isCreate: plan.isCreate }
  try {
    await writeJournal($, [...(await readJournal($)), entry])
  } catch (err) {
    await log($, `journal failed: ${msg(err)}`)
  }
  await patchChat($, c => ({ ...c, skipStreak: 0 }))
  await log($, `saved to ${scope}${backupNote ? ', backup made' : ''}${plan.isCreate ? ', new file' : ''}`)
  await markSaved($, b, { target: plan.path, shortTarget: tilde(plan.path, home), verb: 'Saved to', entryId: id, note: backupNote, isError: false, preview: '' }, SAVED_MS)
}

/** Takes exactly what a save added back out. `id` empty means the most recent save. */
async function undoSave($: Engine, id: string): Promise<{ ok: boolean; text: string; path: string }> {
  const list = await readJournal($)
  const entry = id ? list.find(j => j.id === id) : list[list.length - 1]
  if (!entry) return { ok: false, text: 'Nothing to undo: no saved rule on record.', path: '' }
  const short = tilde(entry.path, home)
  const forget = () => writeJournal($, list.filter(j => j.id !== entry.id))
  if (!(await exists($, entry.path))) {
    await forget()
    return { ok: true, text: `${short} is already gone. Nothing to remove.`, path: entry.path }
  }
  const cur = String(await $.fs.read(entry.path))
  if (entry.kind === 'file') {
    if (cur !== entry.text) return { ok: false, text: `${short} was edited since it was saved, so it was left alone.`, path: entry.path }
    const r = await $.process.run(['rm', '--', entry.path], { timeoutMs: 5000 })
    if (r.exitCode !== 0) return { ok: false, text: `Could not remove ${short}.`, path: entry.path }
  } else {
    const rest = removeBlock(cur, entry.text)
    if (rest === null) return { ok: false, text: `Could not find the saved text in ${short}. It may have been edited, so nothing changed.`, path: entry.path }
    if (entry.isCreate && rest === '') {
      const r = await $.process.run(['rm', '--', entry.path], { timeoutMs: 5000 })
      if (r.exitCode !== 0) return { ok: false, text: `Could not remove ${short}.`, path: entry.path }
    } else {
      await $.fs.write(entry.path, rest)
      if (String(await $.fs.read(entry.path)) !== rest) return { ok: false, text: `${short} did not read back as expected after the undo.`, path: entry.path }
    }
  }
  await forget()
  await log($, `undo: removed a ${entry.scope} save`)
  return { ok: true, text: `Removed from ${short}.`, path: entry.path }
}

/** Opens a file with the machine's own opener. */
async function opener($: Engine, target: string) {
  for (const argv of [['open', target], ['xdg-open', target]]) {
    try {
      if ((await $.process.run(argv, { timeoutMs: 10_000 })).exitCode === 0) return true
    } catch {
      // Try the next one.
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Skip, mute, edit

async function skip($: Engine, b: Band | null) {
  if (b && (b.phase === 'offer' || b.phase === 'edit' || b.phase === 'confirm')) {
    const key = normRule(b.rule)
    await patchChat($, c => ({ ...c, skipStreak: c.skipStreak + 1, skipped: [...c.skipped, key].slice(-20) }))
    await log($, 'skipped')
  }
  await setBand($, null)
}

async function applyEdit($: Engine, b: Band, text: string) {
  const s = await settingsNow($)
  const rule = cleanRule(text, s.plainDashes)
  const bad = ruleProblem(rule)
  if (bad) return setBand($, { ...b, phase: 'edit', note: bad, isError: true })
  const changed = !sameRule(rule, b.rule) || rule !== b.rule
  await setBand($, { ...b, phase: 'offer', rule, slug: changed ? cleanSlug('', rule) : b.slug, note: '', isError: false })
  await log($, 'rule edited')
}

// ---------------------------------------------------------------------------
// Registration

export const register: Register = (on, options) => {
  base = readSettings(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      await homeDir($)
      await $.command.register({
        name: NAME,
        description:
          'Reflect: no argument turns it on or off. on, off, status, undo (take out the last saved rule), list, add [rule], mute (quiet for this chat), folder [path] (no path forgets the remembered folder), cooldown <minutes>, sensitivity <careful|normal|eager>, project <on|off>',
        argumentHint: '[undo | list | add | mute | status | folder]',
      })
      await log($, 'session start')
    } catch (err) {
      await log($, `session start failed: ${msg(err)}`)
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    try {
      // A /clear is a new chat: the old offer, the quiet time and the mute do not carry over.
      if (e.reason === 'clear') {
        pending = null
        await setBand($, null)
        await update($, CHAT, () => FRESH_CHAT)
      }
    } catch (err) {
      await log($, `session end failed: ${msg(err)}`)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      // Only the person's own prompts: never a notification, a schedule, another session, a plugin or a slash command.
      if (fromPerson(e) && !e.command && !e.isMeta && !e.text.trim().startsWith('/')) {
        lastPrompt = e.text.trim()
        if (await isOn($)) {
          gen += 1
          turnDone = false
          pending = null
          const mine = gen
          const text = e.text
          // A new prompt makes an unanswered offer stale. A saved line is left to fade.
          try {
            const b = await getBand($)
            if (b && b.phase !== 'saved') await setBand($, null)
          } catch (err) {
            await log($, `clear failed: ${msg(err)}`)
          }
          if (await isEnabled($)) void check($, text, mine).catch(err => log($, `check failed: ${msg(err)}`))
        }
      }
    } catch (err) {
      await log($, `prompt hook failed: ${msg(err)}`)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId === undefined) {
        turnDone = true
        if (pending && (await isOn($))) {
          const d = pending
          pending = null
          void show($, d).catch(err => log($, `show failed: ${msg(err)}`))
        }
      }
    } catch (err) {
      await log($, `turn hook failed: ${msg(err)}`)
    }
    return result
  })

  on('command.run', { command: NAME }, async ($, e) => {
    await homeDir($)
    const parts = e.args.trim().split(/\s+/).filter(Boolean)
    const arg = (parts[0] ?? '').toLowerCase()
    const rest = e.args.trim().slice(parts[0]?.length ?? 0).trim()
    const switchedOff = !(await isOn($))

    try {
      if (arg === 'undo') {
        const b = await getBand($)
        const r = await undoSave($, b?.phase === 'saved' ? b.entryId : '')
        if (r.ok && b?.phase === 'saved') await setBand($, null)
        return { text: r.text }
      }
      if (arg === 'status') {
        const s = await settingsNow($)
        const chat = await getChat($)
        const folder = s.rulesFolder || (await $.store.get('folder').catch(() => undefined))
        const n = (await readJournal($)).length
        return {
          text: `Reflect is ${switchedOff ? 'off in the mods switchboard' : (await isEnabled($)) ? 'on' : 'off'}. Offers: ${s.sensitivity}. Quiet time: ${Math.round(s.cooldownMs / 60_000)} min. Chat: ${chat?.muted ? 'muted' : 'not muted'}. Save to project: ${s.projectScope ? 'on' : 'off'}. Rules folder: ${typeof folder === 'string' && folder ? folder : 'asked at the first Save to vault'}. Saves you can undo: ${n}.`,
        }
      }
      if (switchedOff) return { text: 'Reflect is off. Turn it on with /mods.' }

      if (arg === 'list') {
        const list = (await readJournal($)).slice(-5).reverse()
        if (list.length === 0) return { text: 'No rules saved yet.' }
        return { text: `Recent rules (newest first):\n${list.map(j => `- ${dayOf(j.at)} ${j.scope}: ${oneLine(j.rule, 80)} (${tilde(j.path, home)})`).join('\n')}` }
      }
      if (arg === 'folder') {
        if (rest) {
          const dir = expandHome(rest, home)
          const bad = folderProblem(dir, home)
          if (bad) return { text: bad }
          await $.store.set('folder', rest)
          return { text: `Rules folder remembered: ${rest}${base.rulesFolder ? `. The rules_folder setting (${base.rulesFolder}) still wins.` : ''}` }
        }
        await $.store.delete('folder')
        return {
          text: base.rulesFolder
            ? `Remembered folder cleared. Save to vault still uses the rules_folder setting: ${base.rulesFolder}`
            : 'Remembered folder cleared. Reflect asks again at the next Save to vault.',
        }
      }
      if (arg === 'mute') {
        const chat = await getChat($)
        const muted = !chat?.muted
        await patchChat($, c => ({ ...c, muted }))
        if (muted) await setBand($, null)
        return { text: muted ? 'Reflect is quiet for this chat. /reflect mute turns it back on.' : 'Reflect will offer again in this chat.' }
      }
      if (arg === 'cooldown') {
        const n = Number(parts[1])
        if (!Number.isFinite(n) || n < 0 || n > 240) return { text: 'Use /reflect cooldown <minutes>, from 0 to 240.' }
        await $.store.set('cooldown', n)
        return { text: `Quiet time between offers is now ${n} min.` }
      }
      if (arg === 'sensitivity') {
        const v = (parts[1] ?? '').toLowerCase()
        if (v !== 'careful' && v !== 'normal' && v !== 'eager') return { text: 'Use /reflect sensitivity careful | normal | eager.' }
        await $.store.set('sensitivity', v)
        return { text: `Reflect offers are now ${v}.` }
      }
      if (arg === 'project') {
        const v = (parts[1] ?? '').toLowerCase()
        if (v !== 'on' && v !== 'off') return { text: 'Use /reflect project on | off.' }
        await $.store.set('project', v === 'on')
        return { text: `Save to project is now ${v}.` }
      }
      if (arg === 'add') {
        if (rest) {
          const s = await settingsNow($)
          const rule = cleanRule(rest, s.plainDashes)
          const bad = ruleProblem(rule)
          if (bad) return { text: bad }
          const cur = await getBand($)
          if (cur && cur.phase !== 'saved') return { text: 'Finish or skip the offer on screen first.' }
          await setBand($, null)
          await show($, { rule, slug: cleanSlug('', rule), category: 'other', tags: [], hint: 'everywhere', correction: 'added by hand with /reflect add' })
          return { text: 'Check the rule above the prompt box, then choose where to save it.' }
        }
        if (!lastPrompt) return { text: 'Nothing to draft from. Type /reflect add followed by the rule.' }
        const s = await settingsNow($)
        const mine = gen
        void (async () => {
          const d = await draftRule($, s, lastPrompt)
          if (!d || mine !== gen) return toast($, 'Reflect found no lasting lesson in your last message.')
          const cur = await getBand($)
          if (cur && cur.phase !== 'saved') return
          await show($, { ...d, correction: oneLine(redact(lastPrompt), 200) })
        })().catch(err => log($, `add failed: ${msg(err)}`))
        return { text: 'Drafting a rule from your last message. It appears above the prompt box.' }
      }
      if (arg === 'on' || arg === 'off' || arg === '') {
        const enabled = arg === 'on' ? true : arg === 'off' ? false : !(await isEnabled($))
        await $.store.set('enabled', enabled)
        if (!enabled) {
          pending = null
          await setBand($, null)
        }
        return { text: enabled ? 'Reflect is on. Corrections get a Save this as a rule? offer.' : 'Reflect is off. Type /reflect to turn it back on.' }
      }
      return { text: 'Use /reflect, or /reflect undo | list | add [rule] | mute | status | folder [path] | cooldown <min> | sensitivity <level> | project <on|off>.' }
    } catch (err) {
      await log($, `command ${arg || 'toggle'} failed: ${msg(err)}`)
      return { text: `Reflect could not do that: ${msg(err)}` }
    }
  })

  on('ui.press', { plugin: NAME }, async ($, e) => {
    try {
      if (!(await isOn($))) return { element: e.element }
      await homeDir($)
      const b = await getBand($)
      if (!b) return { element: e.element }
      const key = String(e.element)
      const busy = b.phase === 'offer' || b.phase === 'edit' || b.phase === 'confirm'
      if (busy && b.phase === 'offer' && (key === 'everywhere' || key === 'project' || key === 'vault')) await chooseScope($, b, key)
      else if (busy && b.phase === 'confirm' && key === 'write') await writeIt($, b)
      else if (busy && b.phase === 'confirm' && key === 'back') await setBand($, { ...b, phase: 'offer', note: '', isError: false })
      else if (busy && b.phase === 'offer' && key === 'edit') {
        editText = b.rule
        await setBand($, { ...b, phase: 'edit', note: '', isError: false })
      } else if (busy && b.phase === 'edit' && key === 'use') await applyEdit($, b, editText || b.rule)
      else if (busy && b.phase === 'edit' && key === 'cancel') await setBand($, { ...b, phase: 'offer', note: '', isError: false })
      else if (busy && key === 'skip') await skip($, b)
      else if (busy && key === 'mute') {
        await patchChat($, c => ({ ...c, muted: true }))
        await setBand($, null)
        await log($, 'muted for this chat')
        toast($, 'Reflect is quiet for this chat. /reflect mute turns it back on.')
      } else if (b.phase === 'saved' && key === 'open' && b.target) {
        if (!(await opener($, b.target))) await setBand($, { ...b, note: 'Could not open the file.', isError: true })
      } else if (b.phase === 'saved' && key === 'undo' && b.entryId) {
        const r = await undoSave($, b.entryId)
        if (r.ok) await markSaved($, b, { verb: 'Removed from', entryId: '', note: '', isError: false }, NOTE_MS)
        else await setBand($, { ...b, note: r.text, isError: true })
      }
    } catch (err) {
      await log($, `press ${String(e.element)} failed: ${msg(err)}`)
      try {
        const b = await getBand($)
        if (b) await setBand($, { ...b, note: `Something went wrong: ${msg(err)}`, isError: true })
      } catch {
        // Nothing more to do.
      }
    }
    return { element: e.element }
  })

  on('ui.input', { plugin: NAME, element: 'rule' }, async ($, e) => {
    try {
      if (e.kind === 'change') editText = e.value
      else if (await isOn($)) {
        await homeDir($)
        const b = await getBand($)
        if (b && b.phase === 'edit') await applyEdit($, b, e.value)
      }
    } catch (err) {
      await log($, `edit failed: ${msg(err)}`)
    }
    return { element: 'rule', value: e.value }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking || !(await isOn($)) || !(await isEnabled($))) return next(e)
    const b = await getBand($)
    if (!b) return next(e)
    const rest = await next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // Mobile draws no text field, so the Edit button is left out there.
    const Input = (ui as unknown as { Input?: typeof ui.Button }).Input as unknown as
      | ((p: { key: string; value: string; rows: number; label: string; submitLabel: string; autoFocus: true; onInput: () => void; onSubmit: () => void }) => never)
      | undefined
    const noop = () => undefined
    // Colors come from the theme, so they stay readable in light and dark.
    const ACCENT = 'claude'
    const GOOD = 'success'
    const BAD = 'error'
    const note = b.note ? <Text color={b.isError ? BAD : undefined} dimColor={!b.isError}>{b.note}</Text> : null

    if (b.phase === 'saved') {
      return (
        <Box flexDirection="column">
          {rest}
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
            <Text wrap="truncate-middle">
              <Text color={GOOD}>✓</Text>
              <Text> {b.verb} </Text>
              <Text dimColor>{b.shortTarget}</Text>
            </Text>
            {b.verb !== 'Removed from' ? <Button key="open" label="Open" hotkey="o" onPress={noop} /> : null}
            {b.entryId ? <Button key="undo" label="Undo" hotkey="u" onPress={noop} /> : null}
          </Box>
          {note}
        </Box>
      )
    }

    if (b.phase === 'edit' && Input) {
      return (
        <Box flexDirection="column">
          {rest}
          <Box flexDirection="column">
            <Text>
              <Text color={ACCENT}>●</Text>
              <Text bold> Edit the rule</Text>
              <Text dimColor> (Enter to use it)</Text>
            </Text>
            <Input key="rule" label="Rule:" value={b.rule} rows={2} submitLabel="use" autoFocus onInput={noop} onSubmit={noop} />
            <Box flexDirection="row" gap={1}>
              <Button key="use" label="Use this" variant="primary" hotkey="u" onPress={noop} />
              <Button key="cancel" label="Cancel" role="dismiss" hotkey="c" onPress={noop} />
            </Box>
            {note}
          </Box>
        </Box>
      )
    }

    if (b.phase === 'confirm') {
      const lines = b.preview.replace(/^\n+/, '').replace(/\n+$/, '').split('\n')
      return (
        <Box flexDirection="column">
          {rest}
          <Box flexDirection="column">
            <Text>
              <Text color={ACCENT}>●</Text>
              <Text bold> {b.isCreate ? `Create ${b.shortTarget} with this?` : `Add this to the end of ${b.shortTarget}?`}</Text>
            </Text>
            <Text dimColor>{b.scope === 'vault' ? 'A new note. No existing file is touched.' : 'Nothing already in the file changes.'}</Text>
            <Box flexDirection="column" paddingLeft={2}>
              {lines.map((line, i) => (
                <Text key={`l-${i}`} wrap="truncate-end">
                  {line === '' ? ' ' : line}
                </Text>
              ))}
            </Box>
            <Box flexDirection="row" gap={1}>
              <Button key="write" label="Write it" variant="primary" hotkey="w" onPress={noop} />
              <Button key="back" label="Back" hotkey="b" onPress={noop} />
              <Button key="skip" label="Skip" role="dismiss" hotkey="s" onPress={noop} />
            </Box>
            {note}
          </Box>
        </Box>
      )
    }

    const projectFirst = b.hint === 'project' && b.canProject
    return (
      <Box flexDirection="column">
        {rest}
        <Box flexDirection="column">
          <Text>
            <Text color={ACCENT}>●</Text>
            <Text bold> Save this as a rule?</Text>
            <Text dimColor> {b.category}{b.learnedIn ? `, from ${b.learnedIn}` : ''}</Text>
          </Text>
          <Text>"{b.rule}"</Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key="everywhere" label="Save everywhere" variant={projectFirst ? 'secondary' : 'primary'} hotkey="e" onPress={noop} />
            {b.canProject ? <Button key="project" label="Save to project" variant={projectFirst ? 'primary' : 'secondary'} hotkey="p" onPress={noop} /> : null}
            <Button key="vault" label="Save to vault" variant="secondary" hotkey="v" onPress={noop} />
            {Input ? <Button key="edit" label="Edit" hotkey="d" onPress={noop} /> : null}
            <Button key="skip" label="Skip" role="dismiss" hotkey="s" onPress={noop} />
            <Button key="mute" label="Not for this chat" hotkey="m" onPress={noop} />
          </Box>
          {note}
        </Box>
      </Box>
    )
  })
}
