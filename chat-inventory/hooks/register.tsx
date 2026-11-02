import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, SessionMessage } from 'claude-code'

import type { ConnectorRow, FileRow, Inventory, PaneView, PlanStep, SkillRow } from '../types'
import { hitsOf, type CallFacts, type CliOptions, type Hit } from './collect'
import { isHidden, isIdServer, splitTool, tileSvg } from './connectors'
import { applyCalls, byNewest, clockTime, emptyInventory, emptyView, inventoryText, plural, tilde, withMemory, type CallRecord } from './inventory'
import { appendLog, errText, logLine, logPath, modDir, openRequestPath, parseFlags, parseOptions, planPaths, switchesPath, withHidden, type Flags } from './infra'
import { PLAN_TOOLS, planFromFile, wrapLines } from './plan'

// Chat Inventory: a pane, "In this chat", that lists the to-do list, the connectors (with their
// calls), the files and the skills this chat used. It only watches: every hook passes the call on
// unchanged, and any failure of the mod is logged and skipped.

const PANE = 'chat-inventory'
const TITLE = 'In this chat'
const PAGE = 10 // rows shown at a time in a long list
const PAGE_CONNECTORS = 20 // the connectors list is longer before it needs Up and Down
const STEP = 5 // rows an Up or Down press moves
const TODO_LONG = 12 // a to-do list longer than this hides finished steps
const OFF_LINE = 'Turned off in the mods switch file.'
const OFF_TEXT = 'Chat Inventory is off. Turn it on in ~/.claude/claude-mods/switches.json.'
const NO_PLAN_TEXT = 'No to-do list yet. Claude makes one for jobs with 3 or more steps.'
const MAX_CHILDREN = 40 // helpers (subagents) read when an old chat is loaded

const inv = atom({ plugin: 'chat-inventory', key: 'inv' } as const, emptyInventory(), { shape: 'inv-1' })
const view = atom({ plugin: 'chat-inventory', key: 'view' } as const, emptyView(), { shape: 'view-1' })

// Module variables are lost on a reload, so they only hold things that can be found again.
const wire = new Map<string, string>() // wire tool name to the name the app shows for its server
let skillNames = new Set<string>()
let lastContext = 0
let closedForOff = false
let planCheckedAt = 0
let openCheckedAt = 0
let cliOpts: CliOptions = { extra: '', hidden: () => false }
let autoOpenOn = true

type Engine = EngineInterface
type Call = Record<string, unknown> & { tool: string; tool_use_id: string; agentId?: string }
type Press = { surface: RenderSurface }

// ---------------------------------------------------------------------------------------------
// Home folder, switch file, log file (the shared conventions of Naish's mods)
// ---------------------------------------------------------------------------------------------

let homeDir = ''
let flagCache: (Flags & { at: number }) | undefined
const lastLogged = new Map<string, number>()

/** The person's home folder, from the environment. Empty when it cannot be read. */
async function getHome($: Engine): Promise<string> {
  if (homeDir) return homeDir
  try {
    homeDir = (await $.env.get('HOME')) ?? ''
  } catch {
    homeDir = ''
  }
  return homeDir
}

/** Reads the switch file. A missing or broken file means the mod is on. Cached for one second. */
async function readFlags($: Engine, force = false): Promise<Flags> {
  let now = 0
  try {
    now = await $.clock.now()
  } catch {
    // No clock: read every time.
  }
  if (!force && flagCache && now - flagCache.at < 1000 && now >= flagCache.at) return flagCache
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

/** Sets or clears the hidden flag in the shared switch file. Returns false when there is no home folder. */
async function writeHidden($: Engine, value: boolean): Promise<boolean> {
  const home = await getHome($)
  if (!home) return false
  const path = switchesPath(home)
  const text = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined
  const next = withHidden(text, value)
  await $.fs.write(path, next)
  flagCache = { ...parseFlags(next), at: await $.clock.now() }
  return true
}

/** Appends one line to the log. Never throws. The same line is written at most once every 30 seconds. */
async function log($: Engine, event: string, detail = '') {
  try {
    const home = await getHome($)
    if (!home) return
    const now = await $.clock.now()
    const key = `${event}|${detail}`
    const before = lastLogged.get(key)
    if (before !== undefined && now - before < 30_000 && now >= before) return
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

// ---------------------------------------------------------------------------------------------
// Chat identity: a new chat (after /clear or a resume) starts a new inventory
// ---------------------------------------------------------------------------------------------

/** Starts a new inventory when the chat is not the one the state belongs to. Returns true when it did. */
async function ensureChat($: Engine, sid: string): Promise<boolean> {
  const cur = await read($, inv)
  if (cur.sid === sid) return false
  const isOther = cur.sid !== ''
  await update($, inv, l => (l.sid === sid ? l : l.sid === '' ? { ...l, sid } : emptyInventory(sid)))
  if (isOther) {
    await update($, view, () => emptyView())
    await log($, 'new chat', 'the inventory started again')
  }
  return isOther
}

async function resetAll($: Engine) {
  await update($, inv, () => emptyInventory())
  await update($, view, () => emptyView())
  planCheckedAt = 0
}

// ---------------------------------------------------------------------------------------------
// What the app knows: memory files loaded at start, skill names, the server name of each MCP tool
// ---------------------------------------------------------------------------------------------

async function loadContext($: Engine) {
  const now = await $.clock.now()
  lastContext = now
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  if (!b) return
  const names = new Set(skillNames)
  for (const s of b.skills?.skillFrontmatter ?? []) names.add(s.name)
  skillNames = names
  for (const t of b.mcpTools ?? []) if (t.name && t.serverName) wire.set(t.name, t.serverName)
  const paths = (b.memoryFiles ?? []).map(m => m.path).filter(Boolean)
  const sid = await $.session.id()
  await update($, inv, l => withMemory(l.sid === sid || l.sid === '' ? { ...l, sid } : l, paths))
}

/** Asks for the context again, at most once every 30 seconds. */
function refreshContext($: Engine) {
  void (async () => {
    try {
      const now = await $.clock.now()
      if (now - lastContext < 30_000 && now >= lastContext) return
      await loadContext($)
    } catch (err) {
      await log($, 'context', errText(err))
    }
  })()
}

/** True when a typed slash command is a skill. */
async function isSkill($: Engine, name: string): Promise<boolean> {
  if (!skillNames.size) await loadContext($).catch(() => undefined)
  if (skillNames.has(name)) return true
  if (skillNames.size) return false
  const cmds = await $.command.list()
  return cmds.some(c => c.name === name && c.source === 'user')
}

// ---------------------------------------------------------------------------------------------
// Counting a call
// ---------------------------------------------------------------------------------------------

const factsOf = (call: Call, failed: boolean): CallFacts => ({ tool: call.tool, input: call, failed, helper: Boolean(call.agentId) })

/** True when a hit names a claude.ai connector by guess rather than by what the app reported. */
const isGuess = (tool: string, hit: Hit) =>
  hit.kind === 'connector' && !hit.cli && isIdServer(splitTool(tool).server) && !wire.has(tool)

async function openPane($: Engine) {
  const placed = await $.ui.open({ id: PANE, title: TITLE })
  if (!placed.isPlaced) await log($, 'open', `waits: ${placed.reason}`)
}

/** Opens the pane the first time the chat uses something, unless it is hidden or off. */
async function autoOpen($: Engine) {
  if (!autoOpenOn) return
  const flags = await readFlags($)
  if (flags.hidden || flags.off) return
  let first = false
  await update($, inv, l => {
    first = !l.opened
    return l.opened ? l : { ...l, opened: true }
  })
  if (first) await openPane($)
}

/** Reads the shared plan file for this chat; it wins when it is newer than what the pane has. Never throws. */
async function readPlanFile($: Engine, sid: string) {
  try {
    const now = await $.clock.now()
    if (now - planCheckedAt < 2000 && now >= planCheckedAt) return
    planCheckedAt = now
    const home = await getHome($)
    if (!home) return
    for (const path of planPaths(home, sid)) {
      if (!(await $.fs.exists(path))) continue
      const json = JSON.parse(String(await $.fs.read(path))) as Record<string, unknown>
      await update($, inv, l => {
        const next = planFromFile(l.plan, json)
        return next ? { ...l, plan: next } : l
      })
    }
  } catch (err) {
    await log($, 'plan file', errText(err))
  }
}

/** Counts one finished tool call. Never throws. */
async function countCall($: Engine, call: Call, ran: Record<string, unknown>) {
  try {
    if (ran.deny !== undefined) return // a refused call did not happen
    const sid = await $.session.id()
    const isNew = await ensureChat($, sid)
    if (isNew) void seed($)
    const failed = ran.isError === true
    const cur = await read($, inv)
    const hits = hitsOf(factsOf(call, failed), { wire, servers: cur.servers }, cliOpts)
    const isPlan = PLAN_TOOLS.has(call.tool) && !call.agentId && !failed
    if (hits.some(h => isGuess(call.tool, h))) refreshContext($)
    if (!hits.length && !isPlan) {
      await readPlanFile($, sid)
      return
    }
    const time = await $.clock.now()
    const record: CallRecord = {
      id: call.tool_use_id ?? '',
      time,
      hits,
      ...(isPlan ? { plan: { tool: call.tool, input: call, result: ran.result } } : {}),
    }
    await update($, inv, l => applyCalls(l.sid === sid ? l : { ...emptyInventory(sid) }, [record]))
    await readPlanFile($, sid)
    await autoOpen($)
  } catch (err) {
    await log($, 'tool.call', errText(err))
  }
}

// ---------------------------------------------------------------------------------------------
// Loading a chat that already has history (a resume, or a reload of this mod)
// ---------------------------------------------------------------------------------------------

/** Tool_use id to the time its message was written, from this chat's transcript file. */
async function callTimes($: Engine, home: string, sid: string): Promise<Map<string, number>> {
  const times = new Map<string, number>()
  try {
    const cwd = await $.session.cwd()
    const path = `${home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sid}.jsonl`
    if (!(await $.fs.exists(path))) return times
    const stat = await $.fs.stat(path)
    if (stat.size > 4_000_000) return times // a read is limited to 4 MiB; leave times blank
    const text = String(await $.fs.read(path))
    for (const line of text.split('\n')) {
      if (!line.includes('"tool_use"')) continue
      const ts = /"timestamp":"([^"]+)"/.exec(line)?.[1]
      const ms = ts ? Date.parse(ts) : NaN
      if (!Number.isFinite(ms)) continue
      for (const m of line.matchAll(/"type":"tool_use","id":"([^"]+)"/g)) times.set(m[1]!, ms)
    }
  } catch {
    // Older calls show no time.
  }
  return times
}

const SLASH_RE = /<command-name>\/?([\w:.-]+)<\/command-name>|^\/([\w:.-]+)/

/** Counts what the chat already did, from its transcript. Calls already counted are skipped by their id. */
async function seed($: Engine) {
  try {
    const sid = await $.session.id()
    await ensureChat($, sid)
    // The server names and skill names come first, so history is named the same way live calls are.
    await loadContext($).catch(err => log($, 'context', errText(err)))
    const main = await $.session.messages()
    if (!Array.isArray(main)) return
    const all: SessionMessage[] = [...main]
    let children = 0
    for (const m of main) {
      for (const u of m.toolUses) {
        if (!u.agentId || children >= MAX_CHILDREN) continue
        children += 1
        const child = await $.session.messages({ agentId: u.agentId })
        if (Array.isArray(child)) all.push(...child)
      }
    }
    const home = await getHome($)
    const hasTools = all.some(m => m.toolUses.length)
    const times = hasTools && home ? await callTimes($, home, sid) : new Map<string, number>()
    const mainIds = new Set(main.flatMap(m => m.toolUses.map(u => u.tool_use_id)))
    const cur = await read($, inv)
    const servers = { ...cur.servers }
    const records: CallRecord[] = []
    const slashSeen = new Map<string, number>()
    for (const m of all) {
      if (m.role === 'user' && typeof m.text === 'string') {
        const found = SLASH_RE.exec(m.text.trim())
        const name = found?.[1] ?? found?.[2]
        if (name && (await isSkill($, name))) {
          const k = (slashSeen.get(name) ?? 0) + 1
          slashSeen.set(name, k)
          records.push({ id: `slash:${name}:${k}`, time: 0, hits: [{ kind: 'skill', name }] })
        }
      }
      for (const u of m.toolUses) {
        const failed = u.isError === true
        const call = { ...u.input, tool: u.tool, tool_use_id: u.tool_use_id, ...(mainIds.has(u.tool_use_id) ? {} : { agentId: 'helper' }) } as Call
        const hits = hitsOf(factsOf(call, failed), { wire, servers }, cliOpts)
        for (const h of hits) if (h.kind === 'connector' && h.learn) servers[h.learn.server] = h.learn.name
        const isPlan = PLAN_TOOLS.has(u.tool) && mainIds.has(u.tool_use_id) && !failed
        if (!hits.length && !isPlan) continue
        records.push({
          id: u.tool_use_id,
          time: times.get(u.tool_use_id) ?? 0,
          hits,
          ...(isPlan ? { plan: { tool: u.tool, input: u.input, result: u.result } } : {}),
        })
      }
    }
    if (records.length) {
      await update($, inv, l => {
        const next = applyCalls(l.sid === sid ? l : emptyInventory(sid), records)
        // A chat that already used things does not pop the pane open again.
        return { ...next, opened: true }
      })
      await log($, 'seeded', `${records.length} calls from the transcript`)
    }
    await readPlanFile($, sid)
  } catch (err) {
    await log($, 'seed', errText(err))
  }
}

// ---------------------------------------------------------------------------------------------
// Switch, hide, copy
// ---------------------------------------------------------------------------------------------

/** Closes the pane once when the mod is switched off, and lets it open again when it is back on. */
async function syncOff($: Engine): Promise<boolean> {
  const { off } = await readFlags($)
  if (off && !closedForOff) {
    closedForOff = true
    await $.ui.close({ id: PANE }).catch(() => undefined)
    await log($, 'off', 'switched off in switches.json; the pane was closed')
  } else if (!off && closedForOff) {
    closedForOff = false
    await log($, 'on', 'switched back on')
  }
  return off
}

/** Honours an open request file left for this chat (written by a mods switch panel). */
async function takeOpenRequest($: Engine) {
  const now = await $.clock.now()
  if (now - openCheckedAt < 1000 && now >= openCheckedAt) return
  openCheckedAt = now
  const home = await getHome($)
  if (!home) return
  const sid = await $.session.id()
  const path = openRequestPath(home, sid)
  if (!(await $.fs.exists(path))) return
  await $.process.run(['rm', '-f', path])
  await openPane($)
}

async function setHidden($: Engine, value: boolean) {
  try {
    if (!(await writeHidden($, value))) await log($, 'hide', 'no home folder: the flag was not saved')
  } catch (err) {
    await log($, value ? 'hide' : 'show', errText(err))
  }
  if (value) await $.ui.close({ id: PANE }).catch(() => undefined)
  await log($, value ? 'hidden' : 'shown')
}

/** Copies the inventory as text. Where the clipboard is out of reach, prints it in the chat to copy by hand. */
async function copyInventory($: Engine, surface: RenderSurface | undefined): Promise<'copied' | 'shown'> {
  const home = await getHome($)
  const text = inventoryText(await read($, inv), home)
  let isCopied = false
  try {
    isCopied = (await $.ui.copy({ text, ...(surface ? { surface } : {}) })).isCopied
  } catch (err) {
    await log($, 'copy', errText(err))
  }
  if (isCopied) {
    await log($, 'copied')
    $.ui.toast('Copied the list.')
    return 'copied'
  }
  await log($, 'copy', 'the clipboard was out of reach; the list was printed in the chat')
  $.ui.log(text)
  $.ui.toast('Could not reach the clipboard. The list is in the chat: select and copy it.')
  return 'shown'
}

// ---------------------------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const settings = parseOptions(options)
  autoOpenOn = settings.autoOpen
  cliOpts = { extra: settings.extraCliTools, hidden: name => isHidden(name, settings.hideConnectors) }

  on('session.start', async ($, e, next) => {
    homeDir = ''
    flagCache = undefined
    lastLogged.clear()
    wire.clear()
    skillNames = new Set()
    lastContext = 0
    closedForOff = false
    planCheckedAt = 0
    openCheckedAt = 0
    try {
      await $.command.register({ name: 'inventory', description: 'Show what this chat used: to-do list, connectors, files, skills', argumentHint: '[copy | hide]', immediate: true })
      await readFlags($, true)
      void seed($).catch(err => log($, 'start', errText(err)))
    } catch (err) {
      await log($, 'session.start', errText(err))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A /clear or a switch to another chat starts the inventory again.
  on('session.end', async ($, e, next) => {
    try {
      if (e.reason === 'clear' || e.reason === 'resume') {
        await resetAll($)
        await log($, 'reset', `the chat ended (${e.reason}); the inventory started again`)
      }
    } catch (err) {
      await log($, 'session.end', errText(err))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'inventory' }, async ($, e) => {
    const flags = await readFlags($, true)
    if (flags.off) return { text: OFF_TEXT }
    const arg = e.args.trim().toLowerCase()
    if (arg === 'hide') {
      await setHidden($, true)
      return { text: 'Chat Inventory hidden. Type /inventory to show it again.' }
    }
    if (arg === 'copy') {
      const sid = await $.session.id()
      if (await ensureChat($, sid)) await seed($)
      const done = await copyInventory($, undefined)
      return { text: done === 'copied' ? 'Copied what this chat used.' : 'The clipboard is out of reach here, so the list is printed above. Select it to copy.' }
    }
    if (flags.hidden) await setHidden($, false)
    try {
      const sid = await $.session.id()
      if (await ensureChat($, sid)) void seed($)
      await openPane($)
      void loadContext($).catch(err => log($, 'context', errText(err)))
      void readPlanFile($, sid)
    } catch (err) {
      await log($, 'command', errText(err))
      return { text: 'Could not open the pane. The error is in the log.' }
    }
    return { text: 'Opened the In this chat pane.' }
  })

  // A skill the person typed as a slash command.
  on('command.run', async ($, e, next) => {
    const ran = await next(e)
    try {
      if (e.command === 'inventory') return ran
      if ((await syncOff($)) || !(await isSkill($, e.command))) return ran
      const sid = await $.session.id()
      await ensureChat($, sid)
      const record: CallRecord = { id: `slash:${e.command}:#`, time: await $.clock.now(), hits: [{ kind: 'skill', name: e.command }] }
      await update($, inv, l => applyCalls(l.sid === sid ? l : emptyInventory(sid), [record]))
      await autoOpen($)
    } catch (err) {
      await log($, 'command', errText(err))
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Every tool call, in the main chat and in helpers: the call runs first, then it is counted.
  on('tool.call', async ($, e, next) => {
    let off = false
    try {
      off = await syncOff($)
    } catch (err) {
      await log($, 'switch', errText(err))
    }
    if (off) return next(e)
    const ran = await next(e)
    await countCall($, e as unknown as Call, ran as unknown as Record<string, unknown>)
    try {
      await takeOpenRequest($)
    } catch (err) {
      await log($, 'open request', errText(err))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const width = Math.max(20, e.props.bodyColumns)
    const inner = width - 4
    const flags = await readFlags($).catch(() => ({ off: false, hidden: false }))
    if (flags.off) return <Text dimColor>{OFF_LINE}</Text>
    const list: Inventory = await read($, inv)
    const v: PaneView = await read($, view)
    const home = await getHome($)
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined

    const setView = (change: (cur: PaneView) => PaneView) => void safely($, 'press', () => update($, view, change))
    const toggleFold = (id: string) => setView(cur => ({ ...cur, folded: cur.folded.includes(id) ? cur.folded.filter(x => x !== id) : [...cur.folded, id] }))
    const moveTop = (id: string, total: number, by: number, page: number) =>
      setView(cur => {
        const last = Math.max(0, total - page)
        const at = Math.min(last, Math.max(0, Math.min(cur.tops[id] ?? 0, last) + by))
        return { ...cur, tops: { ...cur.tops, [id]: at } }
      })

    const header = (key: string, title: string, right: string, isOpen: boolean) => (
      <Box key="h" flexDirection="row" justifyContent="space-between" width={inner}>
        <Button key={`sec-${key}`} plain onPress={() => toggleFold(key)}>
          {`${isOpen ? '▾' : '▸'} ${title}`}
        </Button>
        {right ? <Text dimColor>{right}</Text> : null}
      </Box>
    )
    const none = <Text dimColor>None used yet</Text>
    const section = (key: string, title: string, right: string, body: unknown) => {
      const isOpen = !v.folded.includes(key)
      return (
        <Box key={key} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={width} flexShrink={0}>
          {header(key, title, right, isOpen)}
          {isOpen ? (body as never) : null}
        </Box>
      )
    }
    const row = (key: string, left: unknown, right: unknown) => (
      <Box key={key} flexDirection="row" justifyContent="space-between" width={inner} height={1} gap={1}>
        <Box flexShrink={1} flexGrow={1} height={1} overflow="hidden">
          {left as never}
        </Box>
        {right ? <Box flexShrink={0}>{right as never}</Box> : null}
      </Box>
    )

    /** A long list shows PAGE rows at a time, with Up and Down under it. */
    const windowed = <T,>(id: string, rows: T[], draw: (r: T, i: number) => unknown, page = PAGE): unknown[] => {
      if (rows.length <= page) return rows.map(draw)
      const last = rows.length - page
      const top = Math.min(v.tops[id] ?? 0, last)
      const shown = rows.slice(top, top + page)
      const atTop = top === 0
      const atEnd = top >= last
      return [
        ...shown.map((r, i) => draw(r, top + i)),
        <Box key={`${id}-nav`} flexDirection="row" justifyContent="space-between" width={inner} gap={1}>
          <Text dimColor wrap="truncate-end">{`${top + 1} to ${top + shown.length} of ${rows.length}`}</Text>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {atTop ? <Text dimColor>▴ Up</Text> : <Button key={`${id}-up`} plain onPress={() => moveTop(id, rows.length, -STEP, page)}>▴ Up</Button>}
            {atEnd ? <Text dimColor>▾ Down</Text> : <Button key={`${id}-down`} plain onPress={() => moveTop(id, rows.length, STEP, page)}>▾ Down</Button>}
          </Box>
        </Box>,
      ]
    }

    // ---- Connectors: one row each; pressing a name opens its tools and calls.
    const conns = byNewest(list.connectors)
    const callList = (c: ConnectorRow) => {
      const calls = [...c.calls].reverse()
      const shownTools = c.tools.slice(0, 8)
      const hiddenTools = c.tools.length - shownTools.length
      return (
        <Box key={`calls:${c.key}`} flexDirection="column" width={inner} marginBottom={1}>
          <Text dimColor wrap="truncate-end">{`${c.name}: tools used`}</Text>
          {shownTools.map(t =>
            row(
              `tool:${c.key}:${t.tool}`,
              <Text wrap="truncate-end">{t.tool}</Text>,
              <Text>
                <Text dimColor>{`${t.count}`}</Text>
                {t.failed ? <Text color="error">{`  ${t.failed} failed`}</Text> : null}
              </Text>,
            ),
          )}
          {hiddenTools > 0 ? <Text dimColor>{`+${plural(hiddenTools, 'more tool')}`}</Text> : null}
          <Box marginTop={1} flexDirection="column" width={inner}>
            <Text dimColor wrap="truncate-end">{`${c.name}: calls, newest first`}</Text>
            {windowed(`calls:${c.key}`, calls, (call, i) =>
              row(
                `call:${c.key}:${i}`,
                <Text wrap="truncate-end" {...(call.failed ? { color: 'error' as const } : {})}>
                  {call.failed ? '! ' : ''}
                  {call.tool}
                  {call.summary ? <Text dimColor>{`  ${call.summary}`}</Text> : null}
                </Text>,
                <Text dimColor>{`${call.cli ? 'CLI ' : ''}${call.helper ? 'helper ' : ''}${clockTime(call.at)}`.trim() || ' '}</Text>,
              ),
            ) as never}
          </Box>
        </Box>
      )
    }
    const connRow = (c: ConnectorRow) => {
      const isOpen = v.open === c.key
      const tag = c.cli && !c.mcp ? ' via CLI' : c.cli ? ' MCP + CLI' : ''
      // A Button holds one string, so the dim tag is a Text beside it.
      const name = (
        <Box key={`n:${c.key}`} flexDirection="row" gap={1} flexShrink={1}>
          <Button key={`c:${c.key}`} plain onPress={() => setView(cur => ({ ...cur, open: cur.open === c.key ? '' : c.key }))}>
            {`${isOpen ? '▾' : '▸'} ${c.name}`}
          </Button>
          {tag ? <Text dimColor>{tag.trim()}</Text> : null}
        </Box>
      )
      const count = (
        <Text>
          <Text color="claude">{plural(c.count, 'call')}</Text>
          {c.failed ? <Text color="error">{`  ${c.failed} failed`}</Text> : null}
        </Text>
      )
      return (
        <Box key={`r:${c.key}`} flexDirection="column" width={inner}>
          {Svg ? (
            <Box flexDirection="row" alignItems="center" justifyContent="space-between" width={inner} gap={1}>
              <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1}>
                <Svg source={tileSvg(c.key, c.name)} alt={`${c.name}, ${plural(c.count, 'call')}`} width={24} height={24} />
                {name}
              </Box>
              <Box flexShrink={0}>{count}</Box>
            </Box>
          ) : (
            row(`l:${c.key}`, name, count)
          )}
          {isOpen ? callList(c) : null}
        </Box>
      )
    }
    const connectorBody = conns.length ? windowed('connectors', conns, connRow, PAGE_CONNECTORS) : [none]
    const totalCalls = conns.reduce((a, c) => a + c.count, 0)

    // ---- Files.
    const files = byNewest(list.files)
    const fileRow = (f: FileRow) => {
      const cut = f.path.lastIndexOf('/')
      const name = f.path.slice(cut + 1)
      const full = tilde(cut > 0 ? f.path.slice(0, cut) : '/', home)
      // One line per file: a long folder wrapped and drew over the row above on desktop.
      const parts = full.split('/').filter(Boolean)
      const folder = full.length > 28 && parts.length > 1 ? `…/${parts[parts.length - 1]}` : full
      const tag = f.auto ? (
        <Text color="suggestion">auto</Text>
      ) : f.edited ? (
        <Text color="warning">changed</Text>
      ) : null
      return row(
        `f:${f.path}`,
        <Text wrap="truncate-end">
          {name}
          <Text dimColor>{`  ${folder}`}</Text>
        </Text>,
        tag,
      )
    }
    const readCount = files.filter(f => f.read && !f.auto).length
    const editCount = files.filter(f => f.edited).length
    const fileLine = row(
      'fread',
      <Text dimColor>Files read</Text>,
      <Text dimColor>{editCount ? `${readCount} · ${editCount} changed` : String(readCount)}</Text>,
    )
    const fileBody = files.length ? [fileLine, ...windowed('files', files, fileRow)] : [none]

    // ---- Skills.
    const skills = byNewest(list.skills)
    const skillRow = (s: SkillRow) =>
      row(
        `s:${s.name}`,
        <Text wrap="truncate-end">
          <Text color="claude">/</Text>
          {s.name}
        </Text>,
        <Text>
          {s.always ? <Text color="suggestion">always loaded</Text> : null}
          {s.always && s.count ? <Text dimColor>{'  '}</Text> : null}
          {s.count ? <Text dimColor>{plural(s.count, 'use')}</Text> : null}
        </Text>,
      )
    const skillBody = skills.length ? windowed('skills', skills, skillRow) : [none]

    // ---- To-do: one row per step, the mark in a fixed column and the text wrapped beside it.
    const plan = list.plan
    const textCols = inner - 2
    const doneSteps = plan.steps.filter(st => st.status === 'completed').length
    const isLong = plan.steps.length > TODO_LONG
    const todoRow = (st: PlanStep, i: number) => {
      const done = st.status === 'completed'
      const now = st.status === 'in_progress'
      const lines = wrapLines(now && st.active ? st.active : st.text, textCols)
      return (
        <Box key={`todo:${i}`} flexDirection="row" width={inner} flexShrink={0}>
          <Box width={2} flexShrink={0}>
            {done ? <Text color="success">✓</Text> : now ? <Text color="claude">●</Text> : <Text dimColor>○</Text>}
          </Box>
          <Box flexDirection="column" width={textCols} flexShrink={0}>
            {lines.map((line, j) => (
              <Text key={`l${j}`} wrap="truncate-end" dimColor={done} strikethrough={done} bold={now}>
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      )
    }
    const shownSteps = plan.steps.map((st, i) => ({ st, i })).filter(({ st }) => !isLong || v.showDone || st.status !== 'completed')
    const todoBody = plan.steps.length
      ? [
          ...(plan.title ? wrapLines(plan.title, inner).map((line, j) => <Text key={`pt${j}`} dimColor wrap="truncate-end">{line}</Text>) : []),
          ...shownSteps.map(({ st, i }) => todoRow(st, i)),
          isLong && doneSteps ? (
            <Button key="todo-done" plain dimColor onPress={() => setView(cur => ({ ...cur, showDone: !cur.showDone }))}>
              {v.showDone ? `▴ Hide ${doneSteps} done` : `▾ Show ${doneSteps} done`}
            </Button>
          ) : null,
        ]
      : wrapLines(NO_PLAN_TEXT, inner).map((line, j) => <Text key={`np${j}`} dimColor wrap="truncate-end">{line}</Text>)

    return (
      <Box flexDirection="column" width={width}>
        <Box key="top" flexDirection="row" justifyContent="flex-end" width={width} gap={2}>
          <Button key="copy" label="Copy" dimColor onPress={p => void safely($, 'copy', () => copyInventory($, (p as Press).surface))} />
          <Button key="hide" label="Hide" dimColor onPress={() => void setHidden($, true).then(() => $.ui.toast('Chat Inventory hidden. Type /inventory to show it.'))} />
        </Box>
        {section('todo', 'To-do', plan.steps.length ? `${doneSteps} of ${plan.steps.length}` : '', todoBody)}
        {section('connectors', 'Connectors', conns.length ? `${conns.length} · ${plural(totalCalls, 'call')}` : '0', connectorBody)}
        {section('files', 'Context files', String(files.length), fileBody)}
        {section('skills', 'Skills', String(skills.length), skillBody)}
      </Box>
    )
  })
}
