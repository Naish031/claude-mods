// The inventory's state changes and its plain-text form. Pure functions: no engine calls.

import type { CallRow, ConnectorRow, FileRow, Inventory, PaneView, SkillRow, ToolCount } from '../types'
import { skillOfPath, type Hit } from './collect'
import { slug } from './connectors'
import { NO_PLAN, planAfter } from './plan'

export const MAX_CALLS = 200
export const MAX_TOOLS = 40
export const MAX_IDS = 4000
export const MAX_FILES = 500
export const MAX_SKILLS = 200
export const MAX_CONNECTORS = 100
export const MAX_SERVERS = 200

export const emptyInventory = (sid = ''): Inventory => ({
  sid,
  n: 0,
  ids: [],
  opened: false,
  connectors: [],
  files: [],
  skills: [],
  servers: {},
  plan: NO_PLAN,
})

export const emptyView = (): PaneView => ({ open: '', folded: [], tops: {}, showDone: false })

const newest = <T extends { seq: number }>(rows: T[]) => [...rows].sort((a, b) => b.seq - a.seq)
export const byNewest = newest

function bumpConnector(rows: ConnectorRow[], hit: Extract<Hit, { kind: 'connector' }>, seq: number, time: number): ConnectorRow[] {
  const key = slug(hit.name)
  const old = rows.find(r => r.key === key)
  const rest = rows.filter(r => r.key !== key)
  const call: CallRow = { tool: hit.tool, summary: hit.summary, at: time, cli: hit.cli, failed: hit.failed, helper: hit.helper }
  const tools: ToolCount[] = [...(old?.tools ?? [])]
  const at = tools.findIndex(t => t.tool === hit.tool)
  if (at >= 0) tools[at] = { ...tools[at]!, count: tools[at]!.count + 1, failed: tools[at]!.failed + (hit.failed ? 1 : 0) }
  else tools.push({ tool: hit.tool, count: 1, failed: hit.failed ? 1 : 0 })
  tools.sort((a, b) => b.count - a.count)
  const row: ConnectorRow = {
    key,
    name: hit.name,
    count: (old?.count ?? 0) + 1,
    failed: (old?.failed ?? 0) + (hit.failed ? 1 : 0),
    seq,
    cli: (old?.cli ?? false) || hit.cli,
    mcp: (old?.mcp ?? false) || !hit.cli,
    tools: tools.slice(0, MAX_TOOLS),
    calls: [...(old?.calls ?? []), call].slice(-MAX_CALLS),
  }
  return [...rest, row].slice(-MAX_CONNECTORS)
}

/** Gives a connector a new name, joining it to the row that already has that name (a guess turned out to be Gmail). */
export function renameConnector(rows: ConnectorRow[], from: string, to: string): ConnectorRow[] {
  const fromKey = slug(from)
  const toKey = slug(to)
  const a = rows.find(r => r.key === fromKey)
  if (!a || fromKey === toKey) return rows
  const b = rows.find(r => r.key === toKey)
  const rest = rows.filter(r => r.key !== fromKey && r.key !== toKey)
  if (!b) return [...rest, { ...a, key: toKey, name: to }]
  const tools = new Map<string, ToolCount>()
  for (const t of [...a.tools, ...b.tools]) {
    const had = tools.get(t.tool)
    tools.set(t.tool, { tool: t.tool, count: (had?.count ?? 0) + t.count, failed: (had?.failed ?? 0) + t.failed })
  }
  const merged: ConnectorRow = {
    key: b.key,
    name: b.name,
    count: a.count + b.count,
    failed: a.failed + b.failed,
    seq: Math.max(a.seq, b.seq),
    cli: a.cli || b.cli,
    mcp: a.mcp || b.mcp,
    tools: [...tools.values()].sort((x, y) => y.count - x.count).slice(0, MAX_TOOLS),
    calls: [...a.calls, ...b.calls].sort((x, y) => x.at - y.at).slice(-MAX_CALLS),
  }
  return [...rest, merged]
}

function bumpSkill(rows: SkillRow[], name: string, seq: number, always: boolean): SkillRow[] {
  const old = rows.find(r => r.name === name)
  const rest = rows.filter(r => r.name !== name)
  if (always) return [...rest, { name, count: old?.count ?? 0, seq: old?.seq ?? seq, always: true }]
  return [...rest, { name, count: (old?.count ?? 0) + 1, seq, always: old?.always ?? false }].slice(-MAX_SKILLS)
}

function bumpFile(rows: FileRow[], path: string, mode: 'read' | 'edit', seq: number): FileRow[] {
  const old = rows.find(r => r.path === path)
  const rest = rows.filter(r => r.path !== path)
  const row: FileRow = {
    path,
    auto: old?.auto ?? false,
    read: (old?.read ?? false) || mode === 'read',
    edited: (old?.edited ?? false) || mode === 'edit',
    seq,
  }
  const all = [...rest, row]
  if (all.length <= MAX_FILES) return all
  // Too many: drop the oldest ones that were not loaded at start.
  const drop = all.length - MAX_FILES
  const gone = new Set(
    [...all]
      .filter(f => !f.auto)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, drop)
      .map(f => f.path),
  )
  return all.filter(f => !gone.has(f.path))
}

/** One tool call, ready to count: what it adds, and the plan tool it may be. */
export type CallRecord = {
  /** The tool_use id; a call with an id already counted is skipped. */
  id: string
  /** When it ran, in milliseconds; 0 when unknown. */
  time: number
  hits: Hit[]
  plan?: { tool: string; input: Record<string, unknown>; result: unknown }
}

/** The inventory after a batch of calls. Pure, so a retried update gives the same answer. */
export function applyCalls(inv: Inventory, calls: CallRecord[]): Inventory {
  let { connectors, files, skills, n, ids, plan } = inv
  const servers = { ...inv.servers }
  const seen = new Set(ids)
  const added: string[] = []
  for (const call of calls) {
    let id = call.id
    // "slash:name:#" asks for the next free number, so a skill typed twice counts twice and a reload counts neither again.
    if (id.endsWith(':#')) {
      const prefix = id.slice(0, -1)
      let used = 0
      for (const x of seen) if (x.startsWith(prefix)) used += 1
      id = `${prefix}${used + 1}`
    }
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
      added.push(id)
    }
    for (const hit of call.hits) {
      n += 1
      if (hit.kind === 'connector') {
        const guess = hit.learn ? servers[hit.learn.server] : undefined
        if (hit.learn && guess && guess !== hit.learn.name && /^Connector \d+$/.test(guess)) connectors = renameConnector(connectors, guess, hit.learn.name)
        connectors = bumpConnector(connectors, hit, n, call.time)
        if (hit.learn && Object.keys(servers).length < MAX_SERVERS) servers[hit.learn.server] = hit.learn.name
      } else if (hit.kind === 'skill') skills = bumpSkill(skills, hit.name, n, false)
      else files = bumpFile(files, hit.path, hit.mode, n)
    }
    if (call.plan) {
      const next = planAfter(plan, call.plan.tool, call.plan.input, call.plan.result, Math.max(call.time, plan.updatedAt + 1))
      if (next) plan = next
    }
  }
  return { ...inv, n, connectors, files, skills, servers, plan, ids: [...ids, ...added].slice(-MAX_IDS) }
}

/** The inventory with the memory files and always-loaded skills a chat started with. */
export function withMemory(inv: Inventory, memoryPaths: string[]): Inventory {
  const skills = memoryPaths.map(skillOfPath).filter(Boolean)
  const paths = memoryPaths.filter(p => !skillOfPath(p))
  if (!paths.length && !skills.length) return inv
  let n = inv.n
  const have = new Set(inv.files.map(f => f.path))
  const added: FileRow[] = paths
    .filter(p => !have.has(p))
    .map(p => {
      n += 1
      return { path: p, auto: true, read: false, edited: false, seq: -1000 + n }
    })
  const files = inv.files.filter(f => !skillOfPath(f.path)).map(f => (paths.includes(f.path) ? { ...f, auto: true } : f))
  let rows = inv.skills
  for (const name of skills) {
    n += 1
    rows = bumpSkill(rows, name, -2000 + n, true)
  }
  return { ...inv, n, files: [...files, ...added], skills: rows }
}

/** True when the chat has used anything yet. */
export const hasActivity = (inv: Inventory) =>
  inv.connectors.length > 0 || inv.files.some(f => !f.auto) || inv.skills.some(s => !s.always) || inv.plan.steps.length > 0

// ---------------------------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------------------------

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const pad = (n: number) => String(n).padStart(2, '0')
export const clockTime = (ms: number) => {
  if (!ms) return ''
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A path with the home folder written as ~. */
export const tilde = (p: string, home: string) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p)

const MARK = { completed: 'x', in_progress: '>', pending: ' ' } as const

/** The whole inventory as plain text, for the clipboard. */
export function inventoryText(inv: Inventory, home: string): string {
  const out: string[] = ['In this chat', '']
  const { plan } = inv
  const done = plan.steps.filter(s => s.status === 'completed').length
  out.push(plan.steps.length ? `To-do (${done} of ${plan.steps.length})${plan.title ? `: ${plan.title}` : ''}` : 'To-do: none')
  for (const s of plan.steps) out.push(`  [${MARK[s.status]}] ${s.text}`)
  out.push('')
  const conns = newest(inv.connectors)
  out.push(conns.length ? `Connectors (${conns.length})` : 'Connectors: none')
  for (const c of conns) {
    const via = c.cli && !c.mcp ? ' via CLI' : c.cli ? ' via MCP and CLI' : ''
    const failed = c.failed ? `, ${c.failed} failed` : ''
    out.push(`  ${c.name}: ${plural(c.count, 'call')}${failed}${via}`)
    for (const t of c.tools) out.push(`    ${t.tool} x${t.count}${t.failed ? ` (${t.failed} failed)` : ''}`)
  }
  out.push('')
  const files = newest(inv.files)
  out.push(files.length ? `Context files (${files.length})` : 'Context files: none')
  for (const f of files) {
    const tags = [f.auto ? 'loaded at start' : '', f.edited ? 'changed' : f.read ? 'read' : ''].filter(Boolean)
    out.push(`  ${tilde(f.path, home)}${tags.length ? ` (${tags.join(', ')})` : ''}`)
  }
  out.push('')
  const skills = newest(inv.skills)
  out.push(skills.length ? `Skills (${skills.length})` : 'Skills: none')
  for (const s of skills) {
    const tags = [s.always ? 'always loaded' : '', s.count ? plural(s.count, 'use') : ''].filter(Boolean)
    out.push(`  /${s.name}${tags.length ? ` (${tags.join(', ')})` : ''}`)
  }
  return out.join('\n')
}
