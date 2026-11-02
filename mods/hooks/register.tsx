import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Note } from '../types'
import {
  applyChanges,
  baseOf,
  blockKey,
  blockReason,
  buildInfo,
  cut,
  GROUP_ORDER,
  GROUP_TITLE,
  groupOf,
  hiddenKey,
  isBlocked,
  isHidden,
  isOff,
  matchesFilter,
  parentOf,
  parseInstalled,
  parseSwitches,
  pluginName,
  safeName,
  sameJson,
  signature,
  sortRows,
  splitPaths,
  STATUS_TEXT,
  undoChanges,
} from './lib'
import type { Change, Info, Installed, Json, Row, Status, SwitchRead } from './lib'

// The Mods switchboard.
// One pane lists every mod found on this Mac and writes the shared switch file,
// ~/.claude/claude-mods/switches.json, that Naish's mods read at event time:
//   "<mod>": false           the mod is off in every chat
//   "<mod>:hidden": true     the mod stays on but hides its band or pane
//   "<mod>:block": true      (this mod's own key) do not load a mod that has no switch of its own
// A mod that never reads the file cannot be switched live. The one supported way to
// stop it is to refuse it when it is admitted (the plugin.register event), which
// works at its next load, so the pane says so.

const NAME = 'mods'
const PANE = 'mods'
const TITLE = 'Mods'
const POLL_MS = 3000
const SCAN_EVERY = 3
const SCAN_MS = 9000
const NOTE_MS = 90_000
const BUTTONS_COLS = 28
const STALE_REQUEST_MS = 6 * 3600 * 1000
const MAX_OTHER_CHATS = 20
const GOOD = 'success'
const WARN = 'warning'

const NOTE_ATOM = atom({ plugin: 'mods', key: 'note' } as const, { text: '', tone: 'ok', at: 0 } as Note, { shape: 'note-1' })
const FILTER = atom({ plugin: 'mods', key: 'filter' } as const, '')
const ARMED = atom({ plugin: 'mods', key: 'armed' } as const, '')
const UNDO = atom({ plugin: 'mods', key: 'undo' } as const, '')
const REV = atom({ plugin: 'mods', key: 'rev' } as const, 0)

type Handle = { cancel: () => void }
type Admitted = { root: string; version: string; provenance: string }
type UndoEntry = { label: string; before: Record<string, unknown>; after: Record<string, unknown> }

const cfg = { modFolders: '~/Documents/Claude/claude-mods' }

// What the module keeps between events. Everything drawn comes from $.state or the file.
const s = {
  home: '',
  sid: '',
  cache: null as { at: number; rows: Row[]; sig: string } | null,
  scanFailed: false,
  inspected: new Map<string, { sig: string; info: Info | null }>(),
  admitted: new Map<string, Admitted>(),
  refused: new Set<string>(),
  io: Promise.resolve() as Promise<unknown>,
  logIo: Promise.resolve() as Promise<unknown>,
  lastLogged: new Map<string, number>(),
  switches: null as { at: number; json: Json } | null,
  lastRaw: null as string | null,
  undo: null as UndoEntry | null,
  poller: null as Handle | null,
  ticks: 0,
  noteShown: false,
}

const modsDir = () => `${s.home}/.claude/claude-mods`
const switchesFile = () => `${modsDir()}/switches.json`
const errText = (err: unknown) => String(err instanceof Error ? err.message : err).replace(/\s+/g, ' ').slice(0, 160)

// ---------- Log ----------

/** One line per notable event. Never throws, never waits for the disk, keeps the last 300 lines. */
function log($: EngineInterface, line: string, onceFor = 0) {
  if (!s.home) return
  s.logIo = s.logIo.then(async () => {
    try {
      const now = await $.clock.now()
      if (onceFor > 0) {
        const before = s.lastLogged.get(line)
        if (before !== undefined && now >= before && now - before < onceFor) return
        s.lastLogged.set(line, now)
      }
      const path = `${modsDir()}/logs/mods.log`
      const old = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
      const lines = `${old}${new Date(now).toISOString()} ${line.slice(0, 220)}\n`.split('\n')
      await $.fs.write(path, lines.slice(-301).join('\n'))
    } catch {
      // Logging must never break anything.
    }
  })
}

// ---------- Start-up facts ----------

async function init($: EngineInterface) {
  if (!s.home) {
    try {
      s.home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    } catch {
      s.home = ''
    }
  }
  if (!s.sid) s.sid = await $.session.id().catch(() => '')
}

// ---------- The switch file: read, change, write ----------

/** The file's text, null when it does not exist. Throws when it exists and cannot be read. */
async function rawSwitches($: EngineInterface): Promise<string | null> {
  if (!s.home) throw new Error('no home folder')
  const path = switchesFile()
  if (!(await $.fs.exists(path))) return null
  return String(await $.fs.read(path))
}

/** The switches as a reader sees them: a missing, broken or unreadable file means every mod is on. Kept for one second. */
async function switchesNow($: EngineInterface): Promise<Json> {
  const now = await $.clock.now().catch(() => 0)
  if (s.switches && now >= s.switches.at && now - s.switches.at < 1000) return s.switches.json
  let json: Json = {}
  try {
    json = parseSwitches(await rawSwitches($)).json
  } catch {
    json = {}
  }
  s.switches = { at: now, json }
  return json
}

/** Runs one change at a time, so two quick presses never read the same old file. */
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = s.io.then(fn)
  s.io = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function writeAtomic($: EngineInterface, path: string, text: string) {
  const tmp = `${path}.tmp-${s.sid || 'x'}`
  await $.fs.write(tmp, text)
  const moved = await $.process.run(['mv', '-f', tmp, path]).catch(() => null)
  if (!moved || moved.exitCode !== 0) {
    // No rename: write in place, then tidy up.
    await $.fs.write(path, text)
    await $.process.run(['rm', '-f', tmp]).catch(() => undefined)
  }
}

type Done = { before: Record<string, unknown>; after: Record<string, unknown>; changed: boolean; repaired: string }

/**
 * Read the whole file, let `build` decide the changes from what is in it now, write the
 * whole file. Other keys are kept as they are. A file that is not a JSON object is first
 * saved beside itself as switches.json.bad-<time>, then a new one is started. The text goes
 * to a temporary file and is renamed over the old one, then read back to check it.
 */
function change($: EngineInterface, build: (json: Json) => Change[]): Promise<Done> {
  return queued(async () => {
    await init($)
    if (!s.home) throw new Error('no home folder')
    const raw = await rawSwitches($)
    const read0: SwitchRead = parseSwitches(raw)
    let repaired = ''
    if (read0.kind === 'bad') {
      repaired = `${switchesFile()}.bad-${Math.round(await $.clock.now())}`
      await $.fs.write(repaired, raw ?? '')
      log($, 'switches.json was not a JSON object: saved a copy and started a new one')
    }
    const out = applyChanges(read0.json, build(read0.json))
    const changed = !sameJson(read0.json, out.json) || read0.kind === 'bad'
    if (!changed) return { before: out.before, after: out.after, changed: false, repaired }
    const text = `${JSON.stringify(out.json, null, 2)}\n`
    await writeAtomic($, switchesFile(), text)
    const back = parseSwitches(await rawSwitches($))
    if (back.kind !== 'ok' || !sameJson(back.json, out.json)) throw new Error('switches.json did not read back as written')
    s.switches = { at: await $.clock.now(), json: out.json }
    s.lastRaw = text
    return { before: out.before, after: out.after, changed: true, repaired }
  })
}

// ---------- Notes ----------

async function say($: EngineInterface, text: string, tone: 'ok' | 'warn' = 'ok') {
  const at = await $.clock.now().catch(() => 0)
  s.noteShown = true
  await update($, NOTE_ATOM, () => ({ text, tone, at }))
}

async function remember($: EngineInterface, label: string, done: Done) {
  s.undo = { label, before: done.before, after: done.after }
  await update($, UNDO, () => label)
}

const repairedNote = (done: Done) => (done.repaired ? ` switches.json was damaged: a copy is saved as ${baseOf(done.repaired)}.` : '')

// ---------- Finding mods ----------

type Entry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }

async function entriesOf($: EngineInterface, dir: string): Promise<Entry[]> {
  try {
    return (await $.fs.list(dir)) as Entry[]
  } catch {
    return []
  }
}

async function textOf($: EngineInterface, path: string) {
  try {
    if (!(await $.fs.exists(path))) return ''
    return String(await $.fs.read(path))
  } catch {
    return ''
  }
}

/** Folders (or links) directly inside dir; a missing dir is an empty list. */
async function subDirs($: EngineInterface, dir: string) {
  return (await entriesOf($, dir)).filter(x => !x.name.startsWith('.') && (x.kind === 'dir' || x.isLink)).map(x => `${dir}/${x.name}`)
}

const CODE = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/

/** Reads one folder as a mod. Unchanged files are not read again: the listing's sizes and times are the check. */
async function inspect($: EngineInterface, dir: string): Promise<Info | null> {
  const top = await entriesOf($, dir)
  const plug = await entriesOf($, `${dir}/.claude-plugin`)
  const hooks = await entriesOf($, `${dir}/hooks`)
  const stamp = (xs: Entry[]) => xs.filter(x => x.kind === 'file').map(x => `${x.name}:${x.size}:${x.mtimeMs}`).sort().join(',')
  const sig = `${stamp(top.filter(x => x.name === 'mod.json'))}|${stamp(plug)}|${stamp(hooks)}`
  const hit = s.inspected.get(dir)
  if (hit && hit.sig === sig) return hit.info

  let info: Info | null = null
  if (plug.some(x => x.name === 'plugin.json')) {
    const hooksRaw = await textOf($, `${dir}/hooks/hooks.json`)
    if (/"modules"/.test(hooksRaw)) {
      const files = hooks
        .filter(x => x.kind === 'file' && CODE.test(x.name) && !/\.test\.|\.d\.ts$/.test(x.name) && x.size <= 600_000)
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 20)
      let source = ''
      let total = 0
      for (const f of files) {
        total += f.size
        if (total > 1_500_000) break
        source += `${await textOf($, `${dir}/hooks/${f.name}`)}\n`
      }
      const modRaw = top.some(x => x.name === 'mod.json') ? await textOf($, `${dir}/mod.json`) : ''
      info = buildInfo(baseOf(dir), await textOf($, `${dir}/.claude-plugin/plugin.json`), hooksRaw, modRaw, source)
    }
  }
  s.inspected.set(dir, { sig, info })
  return info
}

/** Names of the plugins the engine shows signs of running: commands, settings rows, modules it admitted, this one. */
async function loadedNames($: EngineInterface) {
  const set = new Set<string>([$.plugin.name])
  for (const n of s.admitted.keys()) set.add(n)
  try {
    for (const c of await $.command.list()) if (c.plugin) set.add(pluginName(c.plugin))
  } catch {
    // No list: other signs still count.
  }
  try {
    for (const r of await $.config.list()) if (r.provider.plugin && r.provider.plugin !== 'engine') set.add(pluginName(r.provider.plugin))
  } catch {
    // Same.
  }
  return set
}

async function installedList($: EngineInterface): Promise<Installed[]> {
  return parseInstalled(await textOf($, `${s.home}/.claude/plugins/installed_plugins.json`))
}

async function enabledMap($: EngineInterface): Promise<Record<string, unknown>> {
  try {
    const v = (await $.settings.read({ key: 'enabledPlugins' })) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const isModDir = ($: EngineInterface, d: string) => $.fs.exists(`${d}/.claude-plugin/plugin.json`).catch(() => false)

async function scan($: EngineInterface): Promise<{ rows: Row[]; sig: string }> {
  const dirs: string[] = []
  const push = (d: string) => {
    const x = d.replace(/\/+$/, '')
    if (x && !dirs.includes(x)) dirs.push(x)
  }

  // This mod and every module the engine admitted: their folders are known for sure.
  push($.plugin.root)
  for (const a of s.admitted.values()) push(a.root)

  // Your folders: the setting, and the folder this mod itself sits in when that is a working folder.
  const folders = splitPaths(cfg.modFolders, s.home)
  const own = parentOf($.plugin.root)
  if (own && !own.includes('/.claude/plugins/') && !own.includes('/.claude/dev-mods/') && !folders.includes(own)) folders.push(own)
  for (const f of folders) {
    if (await isModDir($, f)) push(f)
    for (const d of await subDirs($, f)) push(d)
  }

  // CLAUDE_CODE_PLUGIN_DIRS: each entry is one mod's folder.
  try {
    const env = await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')
    for (const d of splitPaths(env, s.home)) push(d)
  } catch {
    // Not readable: skipped.
  }

  // The older ~/.claude/mods folder, then this chat's own mods.
  for (const d of await subDirs($, `${s.home}/.claude/mods`)) push(d)
  const chats = await subDirs($, `${s.home}/.claude/dev-mods`)
  chats.sort((a, b) => Number(baseOf(b) === s.sid) - Number(baseOf(a) === s.sid))
  const keepChats = chats.slice(0, MAX_OTHER_CHATS + 1)
  for (const c of keepChats) {
    if (await isModDir($, c)) push(c)
    for (const d of await subDirs($, c)) push(d)
  }

  // Installed from a marketplace: the install record names the folder of each one.
  const installed = await installedList($)
  for (const i of installed) push(i.dir)
  const enabled = await enabledMap($)

  const found = new Map<string, { info: Info; dir: string; copies: number }>()
  for (const dir of dirs) {
    const info = await inspect($, dir)
    if (!info) continue
    const hit = found.get(info.name)
    if (hit) hit.copies += 1
    else found.set(info.name, { info, dir, copies: 0 })
  }

  // The switchboard is always listed, even when its own folder cannot be read.
  if (!found.has($.plugin.name)) {
    const info = buildInfo($.plugin.name, JSON.stringify({ name: $.plugin.name }), '{"modules":[]}', '', '')
    if (info) found.set($.plugin.name, { info, dir: $.plugin.root, copies: 0 })
  }

  const loaded = await loadedNames($)
  const rows: Row[] = []
  for (const { info, dir, copies } of found.values()) {
    const inst = installed.find(i => i.name === info.name)
    const status: Status = loaded.has(info.name)
      ? 'loaded'
      : s.refused.has(info.name)
        ? 'blocked'
        : inst
          ? enabled[inst.key] === false
            ? 'disabled'
            : 'installed'
          : 'disk'
    const self = info.name === $.plugin.name
    rows.push({
      ...info,
      // This mod writes and reads the file itself, and has no band or pane to hide or open, whatever its code says.
      switchKind: self ? 'file' : info.switchKind,
      hide: self ? false : info.hide,
      hasPane: self ? false : info.hasPane,
      pane: self ? null : info.pane,
      opener: self ? null : info.opener,
      version: info.version || inst?.version || '',
      dir,
      group: groupOf(dir, s.sid),
      status,
      self,
      copies,
    })
  }
  const sorted = sortRows(rows)
  return { rows: sorted, sig: signature(sorted) }
}

/** The list is kept for 9 seconds, so drawing stays fast. */
async function getRows($: EngineInterface, force = false): Promise<Row[]> {
  const now = await $.clock.now()
  if (!force && s.cache && now >= s.cache.at && now - s.cache.at < SCAN_MS) return s.cache.rows
  try {
    const t0 = now
    const { rows, sig } = await scan($)
    s.cache = { at: now, rows, sig }
    if (s.scanFailed || force) {
      s.scanFailed = false
      log($, `scan: ${rows.length} mods, ${rows.filter(r => r.status === 'loaded').length} loaded, ${Math.round((await $.clock.now()) - t0)} ms`, 30_000)
    }
    return rows
  } catch (err) {
    s.scanFailed = true
    log($, `scan failed: ${errText(err)}`, 30_000)
    return s.cache?.rows ?? []
  }
}

// ---------- Acting on a mod ----------

const findRow = async ($: EngineInterface, name: string) => (await getRows($)).find(r => r.name === name)
const bump = ($: EngineInterface) => update($, REV, n => n + 1)

async function disarm($: EngineInterface) {
  if ((await read($, ARMED)) !== '') await update($, ARMED, () => '')
}

/** On/Off for a mod that reads the file; Block/Unblock for one that does not. */
async function toggle($: EngineInterface, row: Row) {
  if (!safeName(row.name)) {
    await say($, `${row.title} has a name that cannot be used as a switch.`, 'warn')
    return
  }
  if (row.switchKind === 'none') {
    const done = await change($, json => [{ key: blockKey(row.name), value: isBlocked(json, row.name) ? undefined : true }])
    const nowBlocked = done.after[blockKey(row.name)] === true
    await remember($, `${row.title} ${nowBlocked ? 'blocked' : 'unblocked'}`, done)
    log($, `${nowBlocked ? 'block' : 'unblock'} ${row.name}`)
    await say($, nowBlocked ? `${row.title} will not load next time Claude Code starts it (a new chat or a restart).` : `${row.title} will load again next time Claude Code starts it.`)
    return
  }
  if (row.self) {
    const armed = await read($, ARMED)
    const json = await switchesNow($)
    if (!isOff(json, row.name) && armed !== row.name) {
      await update($, ARMED, () => row.name)
      await say($, `This turns off the switchboard itself. Press Off again to confirm. Turn it back on with this pane, or by removing "mods": false in switches.json.`, 'warn')
      return
    }
    await update($, ARMED, () => '')
  }
  const done = await change($, json => [{ key: row.name, value: isOff(json, row.name) ? undefined : false }])
  const nowOff = done.after[row.name] === false
  await remember($, `${row.title} ${nowOff ? 'off' : 'on'}`, done)
  log($, `${nowOff ? 'off' : 'on'} ${row.name}`)
  await say($, `${row.title} is ${nowOff ? 'off' : 'on'} in every chat.${repairedNote(done)}`, done.repaired ? 'warn' : 'ok')
}

/** Asks a mod to open its pane: runs its command, or leaves the request file it watches for. Throws when it cannot. */
async function openMod($: EngineInterface, row: Row): Promise<'asked' | 'requested'> {
  if (row.opener === 'command' && row.pane && row.pane.command !== NAME) {
    const commands = await $.command.list()
    if (!commands.some(c => c.name === row.pane?.command)) throw new Error(`/${row.pane.command} is not loaded in this chat`)
    const run = { command: row.pane.command, args: row.pane.args }
    // The command waits for an idle chat, so the press does not wait for it.
    void $.command.run(run).catch(async err => {
      log($, `open ${row.name} failed: ${errText(err)}`)
      await say($, `Could not open ${row.title}: ${errText(err)}`, 'warn').catch(() => undefined)
    })
    return 'asked'
  }
  if (row.opener === 'request') {
    await init($)
    if (!s.sid) throw new Error('no session id')
    await $.fs.write(`${modsDir()}/.open-${row.name}-${s.sid}`, '')
    return 'requested'
  }
  throw new Error('it has no pane to open')
}

async function showHide($: EngineInterface, row: Row) {
  const json = await switchesNow($)
  if (isOff(json, row.name)) {
    await say($, `${row.title} is off. Turn it on first.`, 'warn')
    return
  }
  const done = await change($, now => [{ key: hiddenKey(row.name), value: isHidden(now, row.name) ? undefined : true }])
  const nowHidden = done.after[hiddenKey(row.name)] === true
  await remember($, `${row.title} ${nowHidden ? 'hidden' : 'shown'}`, done)
  log($, `${nowHidden ? 'hide' : 'show'} ${row.name}`)
  await say($, `${row.title} is ${nowHidden ? 'hidden' : 'shown'} in every chat.${repairedNote(done)}`, done.repaired ? 'warn' : 'ok')
  if (!nowHidden && row.opener) {
    try {
      await openMod($, row)
    } catch (err) {
      log($, `show ${row.name}: could not ask it to open: ${errText(err)}`)
    }
  }
}

async function open($: EngineInterface, row: Row) {
  const json = await switchesNow($)
  if (isOff(json, row.name) || isHidden(json, row.name)) {
    await say($, `${row.title} is ${isOff(json, row.name) ? 'off' : 'hidden'}. Turn it on and show it first.`, 'warn')
    return
  }
  try {
    const how = await openMod($, row)
    log($, `open ${row.name} (${how})`)
    await say($, how === 'asked' ? `Asked ${row.title} to open.` : `${row.title} opens in this chat within 3 seconds.`)
  } catch (err) {
    log($, `open ${row.name} failed: ${errText(err)}`)
    await say($, `Could not open ${row.title}: ${errText(err)}.`, 'warn')
  }
}

async function bulk($: EngineInterface, on: boolean) {
  const rows = (await getRows($)).filter(r => r.switchKind === 'file' && !r.self && safeName(r.name))
  let n = 0
  const done = await change($, json => {
    const changes: Change[] = []
    for (const r of rows) {
      if (on && isOff(json, r.name)) changes.push({ key: r.name, value: undefined })
      if (!on && !isOff(json, r.name)) changes.push({ key: r.name, value: false })
    }
    n = changes.length
    return changes
  })
  if (n === 0) {
    await say($, on ? 'Every mod is already on.' : 'Every mod is already off.')
    return
  }
  await remember($, `${on ? 'All on' : 'All off'} (${n})`, done)
  log($, `all ${on ? 'on' : 'off'}: ${n} mods`)
  await say($, `${n} ${n === 1 ? 'mod' : 'mods'} turned ${on ? 'on' : 'off'} in every chat.${repairedNote(done)}`, done.repaired ? 'warn' : 'ok')
}

async function undo($: EngineInterface) {
  const entry = s.undo
  if (!entry) {
    await say($, 'Nothing to undo.')
    return
  }
  let skipped = 0
  const done = await change($, json => {
    const r = undoChanges(json, entry)
    skipped = r.skipped
    return r.changes
  })
  s.undo = null
  await update($, UNDO, () => '')
  log($, `undo: ${entry.label}${skipped ? ` (${skipped} changed since)` : ''}`)
  await say($, skipped ? `Undid ${entry.label}, except ${skipped} that changed since.${repairedNote(done)}` : `Undid ${entry.label}.${repairedNote(done)}`, done.repaired || skipped ? 'warn' : 'ok')
}

/** Request files nobody picked up (a chat that ended) are cleaned out after 6 hours. */
async function pruneRequests($: EngineInterface) {
  try {
    const now = await $.clock.now()
    let n = 0
    for (const x of await entriesOf($, modsDir())) {
      if (x.kind !== 'file' || x.size !== 0 || !/^\.open-[A-Za-z0-9._-]+$/.test(x.name) || now - x.mtimeMs < STALE_REQUEST_MS) continue
      await $.process.run(['rm', '-f', `${modsDir()}/${x.name}`])
      n += 1
    }
    if (n) log($, `removed ${n} old open requests`)
  } catch (err) {
    log($, `cleanup failed: ${errText(err)}`, 60_000)
  }
}

// ---------- While the pane is open ----------

async function paneIsOpen($: EngineInterface) {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE)
  } catch {
    return false
  }
}

async function tick($: EngineInterface) {
  if (!(await paneIsOpen($))) {
    stopPoll()
    return
  }
  s.ticks += 1
  let changed = false
  try {
    const raw = await rawSwitches($)
    if (raw !== s.lastRaw) {
      s.lastRaw = raw
      s.switches = null
      changed = true
    }
  } catch {
    // An unreadable file is tried again next time.
  }
  if (s.ticks % SCAN_EVERY === 0) {
    const before = s.cache?.sig ?? ''
    await getRows($, true)
    if ((s.cache?.sig ?? '') !== before) changed = true
  }
  if (s.noteShown) {
    const note = await read($, NOTE_ATOM)
    if (note.text && (await $.clock.now()) - note.at >= NOTE_MS) {
      s.noteShown = false
      changed = true
    }
  }
  if (changed) await bump($)
}

function stopPoll() {
  s.poller?.cancel()
  s.poller = null
}

function startPoll($: EngineInterface) {
  if (s.poller) return
  s.ticks = 0
  s.poller = $.clock.every(POLL_MS, () => {
    void tick($).catch(err => log($, `poll failed: ${errText(err)}`, 30_000))
  }) as Handle
}

// ---------- Words for /mods list, on and off ----------

const stateWord = (row: Row, json: Json) => (row.switchKind === 'none' ? (isBlocked(json, row.name) ? 'blocked' : 'on') : isOff(json, row.name) ? 'off' : 'on')

function findByWord(rows: readonly Row[], word: string) {
  const w = word.trim().toLowerCase()
  return rows.find(r => r.name.toLowerCase() === w) ?? rows.find(r => r.title.toLowerCase() === w)
}

async function commandText($: EngineInterface, arg: string): Promise<string | null> {
  const [verb = '', ...rest] = arg.split(/\s+/)
  const word = rest.join(' ')
  if (verb.toLowerCase() === 'list') {
    const rows = await getRows($, true)
    const json = await switchesNow($)
    if (!rows.length) return 'No mods found.'
    return rows.map(r => `${stateWord(r, json).padEnd(7)} ${r.name}${r.version ? ` v${r.version}` : ''}  ${STATUS_TEXT[r.status]}${r.switchKind === 'none' ? '  (no switch of its own)' : ''}`).join('\n')
  }
  if (verb.toLowerCase() === 'on' || verb.toLowerCase() === 'off') {
    const row = findByWord(await getRows($), word)
    if (!word || !row) return `No mod called "${cut(word, 40)}". Type /mods list to see them.`
    if (row.self) return 'The switchboard cannot turn itself on or off from here. Use the Mods pane.'
    const wantOff = verb.toLowerCase() === 'off'
    const json = await switchesNow($)
    const currentOff = row.switchKind === 'none' ? isBlocked(json, row.name) : isOff(json, row.name)
    if (currentOff === wantOff) return `${row.title} is already ${wantOff ? (row.switchKind === 'none' ? 'blocked' : 'off') : 'on'}.`
    await toggle($, row)
    return (await read($, NOTE_ATOM)).text
  }
  return null
}

// ---------- Hooks ----------

export const register: Register = (on, options) => {
  const folders = (options as Record<string, unknown>).mod_folders
  if (typeof folders === 'string') cfg.modFolders = folders

  // Every module the engine is about to load passes here. Most pass. A mod with no switch of
  // its own that the person blocked in the pane does not load. If anything here fails, the module loads.
  on('plugin.register', async ($, e, next) => {
    try {
      await init($)
      const json = await switchesNow($)
      const why = blockReason({ name: e.name, tier: e.tier }, json, $.plugin.name)
      if (why) {
        s.refused.add(e.name)
        s.admitted.delete(e.name)
        log($, `blocked ${e.name} at load`)
        return { refuse: why }
      }
      s.refused.delete(e.name)
      s.admitted.set(e.name, { root: e.root, version: e.version ?? '', provenance: e.provenance })
    } catch (err) {
      log($, `load check failed: ${errText(err)}`, 30_000)
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    try {
      await init($)
      await $.command.register({
        name: 'mods',
        description: 'Open the Mods pane: turn each mod on or off, or show or hide it, in every chat',
        argumentHint: '[list | on <mod> | off <mod>]',
        immediate: true,
      })
      s.lastRaw = await rawSwitches($).catch(() => null)
      if (await paneIsOpen($)) startPoll($)
      log($, 'session start')
    } catch (err) {
      log($, `session start failed: ${errText(err)}`)
    }
    return next(e)
  })

  on('command.run', { command: 'mods' }, async ($, e) => {
    try {
      await init($)
      const arg = String((e as { args?: string }).args ?? '').trim()
      if (arg) {
        const json = await switchesNow($)
        if (isOff(json, NAME)) return { text: 'Mods is off. Remove "mods": false from ~/.claude/claude-mods/switches.json to turn it on.' }
        const text = await commandText($, arg)
        if (text !== null) return { text }
      }
      await pruneRequests($)
      await getRows($, true)
      s.lastRaw = await rawSwitches($).catch(() => null)
      const opened = await $.ui.open({ id: PANE, title: TITLE })
      startPoll($)
      await bump($)
      log($, 'open pane')
      if (opened && opened.isPlaced === false) return { text: 'The Mods pane is waiting for room. Widen the window, or type /mods list.' }
      return { text: 'Opened the Mods pane.' }
    } catch (err) {
      log($, `command failed: ${errText(err)}`)
      return { text: 'Could not open the Mods pane. See ~/.claude/claude-mods/logs/mods.log' }
    }
  })

  // Presses come here, not to onPress: a closure lives for one drawing only.
  on('ui.press', { plugin: 'mods' }, async ($, e, next) => {
    const el = e.element
    const m = /^(toggle|show|open)-(.+)$/.exec(el)
    if (!m && el !== 'all-on' && el !== 'all-off' && el !== 'undo') return next(e)
    const verb = m?.[1] ?? el
    const name = m?.[2] ?? ''
    let title = name
    try {
      await init($)
      if (!(verb === 'toggle' && name === NAME)) await disarm($)
      if (el === 'all-on' || el === 'all-off') {
        await bulk($, el === 'all-on')
      } else if (el === 'undo') {
        await undo($)
      } else {
        const row = await findRow($, name)
        if (!row) return { element: el }
        title = row.title
        if (verb === 'toggle') await toggle($, row)
        else if (verb === 'show' && row.hide && row.switchKind === 'file') await showHide($, row)
        else if (verb === 'open' && row.hasPane && row.opener) await open($, row)
      }
    } catch (err) {
      log($, `${verb} ${name} failed: ${errText(err)}`)
      await say($, `Could not change ${title}. See ~/.claude/claude-mods/logs/mods.log`, 'warn').catch(() => undefined)
    }
    return { element: el }
  })

  on('ui.input', { plugin: 'mods', element: 'filter' }, async ($, e, next) => {
    try {
      await update($, FILTER, () => String(e.value).slice(0, 80))
    } catch (err) {
      log($, `filter failed: ${errText(err)}`, 30_000)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Input = 'Input' in ui ? (ui as { Input: typeof ui.Button }).Input : null
    const noop = () => undefined
    const cols = Math.max(24, Number((e.props as { bodyColumns?: number }).bodyColumns) || 60)
    const stacked = cols < 48
    const left = stacked ? cols : Math.max(10, cols - BUTTONS_COLS)

    const note = await read($, NOTE_ATOM)
    const filter = await read($, FILTER)
    const armed = await read($, ARMED)
    const undoLabel = await read($, UNDO)
    await read($, REV)
    const now = await $.clock.now()

    let json: Json = {}
    let fileProblem = ''
    try {
      const parsed = parseSwitches(await rawSwitches($))
      json = parsed.json
      if (parsed.kind === 'bad') fileProblem = 'switches.json is damaged. The next change saves a copy and starts a new one. Until then every mod counts as on.'
    } catch (err) {
      fileProblem = `Cannot read switches.json: ${errText(err)}`
    }

    const noteView =
      note.text && now - note.at < NOTE_MS ? (
        <Text color={note.tone === 'warn' ? WARN : GOOD} wrap="wrap">
          {note.text}
        </Text>
      ) : null

    // The switchboard itself is off: nothing but the way back.
    if (isOff(json, NAME)) {
      return (
        <Box flexDirection="column" width={cols}>
          <Text bold>Mods is off</Text>
          <Text dimColor wrap="wrap">
            The list, the switches and the block at load are paused. Mods that are off stay off.
          </Text>
          <Box marginTop={1}>
            <Button key={`toggle-${NAME}`} variant="primary" onPress={noop}>
              Turn Mods back on
            </Button>
          </Box>
          {noteView ? <Box marginTop={1}>{noteView}</Box> : null}
        </Box>
      )
    }

    const all = await getRows($)
    const rows = all.filter(r => matchesFilter(r, filter))
    const offCount = all.filter(r => (r.switchKind === 'none' ? isBlocked(json, r.name) : isOff(json, r.name))).length

    const rowViews = rows.map(m => {
      const block = m.switchKind === 'none'
      const off = block ? isBlocked(json, m.name) : isOff(json, m.name)
      const hidden = !block && isHidden(json, m.name)
      const dim = off
      const pendingReload = block && ((off && !s.refused.has(m.name) && m.status === 'loaded') || (!off && s.refused.has(m.name)))
      const tip = m.commands.map(c => `/${c}`).join(', ')
      const chip = [m.version ? `v${m.version}` : '', STATUS_TEXT[m.status], m.copies ? `${m.copies + 1} copies found` : ''].filter(Boolean).join(' · ')
      const hint =
        m.status === 'disabled'
          ? "Turned off in Claude Code's plugin settings. Use /plugin to enable it."
          : block
            ? pendingReload
              ? 'Takes effect the next time it loads: a new chat or a restart.'
              : off
                ? 'Blocked: it will not load. Unblock to let it load again.'
                : 'No switch of its own, so it cannot be turned off live. Block stops it loading next time.'
            : m.status === 'disk'
              ? 'Not installed. The switch is saved for when it is.'
              : ''
      const openUp = !!m.hasPane && !!m.opener
      const canOpen = openUp && !off && !hidden && (m.status === 'loaded' || m.opener === 'request')

      const about = (
        <Box flexDirection="column" width={left}>
          <Text bold dimColor={dim} wrap="truncate-end">
            {cut(m.self ? `${m.title} (this switchboard)` : m.title, left)}
          </Text>
          {m.what ? (
            <Text dimColor wrap="truncate-end">
              {cut(m.what, left)}
            </Text>
          ) : null}
          {tip ? (
            <Text dimColor italic wrap="truncate-end">
              {cut(tip, left)}
            </Text>
          ) : null}
          <Text dimColor wrap="truncate-end">
            {cut(chip, left)}
          </Text>
          {hint ? (
            <Text color={pendingReload ? WARN : undefined} dimColor={!pendingReload} wrap="wrap">
              {hint}
            </Text>
          ) : null}
        </Box>
      )

      const buttons = (
        <Box flexDirection="row" gap={1}>
          {openUp ? (
            canOpen ? (
              <Button key={`open-${m.name}`} onPress={noop}>
                Open
              </Button>
            ) : (
              <Text dimColor>Open</Text>
            )
          ) : null}
          {m.hide && !block ? (
            off ? (
              <Text dimColor>{hidden ? 'Hidden' : 'Shown'}</Text>
            ) : (
              <Button key={`show-${m.name}`} onPress={noop}>
                {hidden ? <Text dimColor>Hidden</Text> : <Text color={GOOD}>Shown</Text>}
              </Button>
            )
          ) : null}
          <Button key={`toggle-${m.name}`} onPress={noop}>
            {off ? (
              block ? (
                <Text color={WARN}>Blocked</Text>
              ) : (
                <Text dimColor>Off</Text>
              )
            ) : m.self && armed === NAME ? (
              <Text color={WARN}>Off?</Text>
            ) : (
              <Text color={GOOD}>On</Text>
            )}
          </Button>
        </Box>
      )

      return (
        <Box key={`row-${m.name}`} flexDirection={stacked ? 'column' : 'row'} justifyContent="space-between" gap={stacked ? 0 : 1} marginTop={1}>
          {about}
          {buttons}
        </Box>
      )
    })

    // Group headings, only where there is more than one group on screen.
    const present = GROUP_ORDER.filter(g => rows.some(r => r.group === g))
    const body: unknown[] = []
    for (const g of present) {
      if (present.length > 1) {
        body.push(
          <Box key={`group-${g}`} marginTop={1}>
            <Text dimColor bold>
              {GROUP_TITLE[g]}
            </Text>
          </Box>,
        )
      }
      for (const m of rows) if (m.group === g) body.push(rowViews[rows.indexOf(m)])
    }

    const onCount = all.length - offCount
    const summary = all.length ? `${all.length} ${all.length === 1 ? 'mod' : 'mods'} found · ${onCount} on · ${offCount} off` : 'No mods found yet'

    return (
      <Box flexDirection="column" width={cols}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text dimColor wrap="truncate-end">
            {cut(summary, Math.max(10, cols - 18))}
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="all-on" onPress={noop}>
              All on
            </Button>
            <Button key="all-off" onPress={noop}>
              All off
            </Button>
          </Box>
        </Box>
        {Input && (all.length >= 6 || filter) ? (
          <Box marginTop={1}>
            <Input key="filter" label="Filter" placeholder="name or word" value={filter} onInput={noop} onSubmit={noop} />
          </Box>
        ) : null}
        {fileProblem ? (
          <Box marginTop={1}>
            <Text color={WARN} wrap="wrap">
              {fileProblem}
            </Text>
          </Box>
        ) : null}
        {all.length === 0 ? (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              {s.scanFailed ? 'Could not look for mods. See ~/.claude/claude-mods/logs/mods.log' : 'Mods in your mod folders, installed from a marketplace, or made in this chat show up here by themselves.'}
            </Text>
          </Box>
        ) : null}
        {all.length > 0 && rows.length === 0 ? (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">{`Nothing matches "${cut(filter, 30)}".`}</Text>
          </Box>
        ) : null}
        {body as never}
        <Box marginTop={1} flexDirection="column">
          {noteView}
          {undoLabel ? (
            <Button key="undo" onPress={noop}>
              {`Undo: ${undoLabel}`}
            </Button>
          ) : null}
          <Text dimColor wrap="wrap">
            Off means off in every chat. Hidden keeps it on but out of sight. A change reaches a mod at its next event, within a second or two.
          </Text>
          <Text dimColor wrap="wrap">
            New mods appear here by themselves.
          </Text>
        </Box>
      </Box>
    )
  })
}
