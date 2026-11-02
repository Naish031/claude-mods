// The to-do list: built from Claude's own plan tools (TodoWrite, TaskCreate, TaskUpdate), from the
// plan tool a mod may register, and from a shared plan file. Pure functions.

import type { Plan, PlanStep } from '../types'

/** A plan tool that a helper mod may register; its call carries a title and steps. */
export const PLAN_TOOL = 'mcp__helper-desk__plan'
export const PLAN_TOOLS = new Set([PLAN_TOOL, 'TodoWrite', 'TaskCreate', 'TaskUpdate'])

export const NO_PLAN: Plan = { title: '', steps: [], updatedAt: 0 }

const STATUSES = new Set(['pending', 'in_progress', 'completed'])
const statusOf = (v: unknown): PlanStep['status'] => (typeof v === 'string' && STATUSES.has(v) ? (v as PlanStep['status']) : 'pending')
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')

/** Steps from a list of objects, reading the text from the first key that has it. */
export function stepsOf(raw: unknown, textKeys: string[]): PlanStep[] {
  if (!Array.isArray(raw)) return []
  const out: PlanStep[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const text = textKeys.map(k => str(o[k])).find(Boolean) ?? ''
    if (!text) continue
    const active = str(o.activeForm)
    out.push({ text, status: statusOf(o.status), ...(active ? { active } : {}) })
  }
  return out
}

/**
 * The plan after one call to a plan tool, or null when the call changes nothing.
 * `result` is the tool's own answer when known (TaskCreate's id comes from it).
 */
export function planAfter(cur: Plan, tool: string, input: Record<string, unknown>, result: unknown, time: number): Plan | null {
  if (tool === 'TodoWrite') return { title: cur.title, steps: stepsOf(input.todos, ['content']), updatedAt: time }
  if (tool === PLAN_TOOL) {
    const title = typeof input.title === 'string' ? input.title.trim() : cur.title
    return { title, steps: stepsOf(input.steps, ['text']), updatedAt: time }
  }
  if (tool === 'TaskCreate') {
    const text = str(input.subject)
    if (!text) return null
    const made = (result as { task?: { id?: unknown } } | undefined)?.task?.id
    const id = typeof made === 'string' || typeof made === 'number' ? String(made) : String(cur.steps.length + 1)
    const active = str(input.activeForm)
    return { ...cur, steps: [...cur.steps, { text, status: 'pending', id, ...(active ? { active } : {}) }], updatedAt: time }
  }
  if (tool === 'TaskUpdate') {
    const id = str(input.taskId)
    let at = cur.steps.findIndex(st => st.id === id)
    // Ids that were never seen (the list was built before this mod loaded) fall back to position.
    if (at < 0 && /^\d+$/.test(id) && !cur.steps.some(st => st.id)) at = Number(id) - 1
    const old = cur.steps[at]
    if (!old) return null
    if (input.status === 'deleted') return { ...cur, steps: cur.steps.filter((_, i) => i !== at), updatedAt: time }
    const text = str(input.subject) || old.text
    const active = str(input.activeForm) || old.active
    const status = input.status === undefined ? old.status : statusOf(input.status)
    const steps = cur.steps.map((st, i) => (i === at ? { ...st, text, status, ...(active ? { active } : {}) } : st))
    return { ...cur, steps, updatedAt: time }
  }
  return null
}

/** A plan file's own time: an ISO string or a number of milliseconds; NaN when it has none. */
export function fileTime(json: Record<string, unknown>): number {
  const v = json.updatedAt
  if (typeof v === 'string') return Date.parse(v)
  if (typeof v === 'number') return v
  return NaN
}

/**
 * The plan a shared plan file describes, or null when the file is no newer than `cur`.
 * Keeps TodoWrite's present-tense text and TaskCreate's ids for steps the file also has.
 */
export function planFromFile(cur: Plan, json: Record<string, unknown>): Plan | null {
  const at = fileTime(json)
  if (!Number.isFinite(at) || at <= cur.updatedAt) return null
  const steps = stepsOf(json.steps, ['text']).map(st => {
    const was = cur.steps.find(o => o.text === st.text)
    return { ...st, ...(was?.active && !st.active ? { active: was.active } : {}), ...(was?.id ? { id: was.id } : {}) }
  })
  const title = typeof json.title === 'string' ? json.title.trim() : ''
  return { title, steps, updatedAt: at }
}

/** Splits text into lines no wider than `width` columns, breaking at spaces. */
export function wrapLines(text: string, width: number): string[] {
  const w = Math.max(8, width)
  const lines: string[] = []
  let cur = ''
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    let rest = word
    while (rest.length > w) {
      if (cur) lines.push(cur)
      cur = ''
      lines.push(rest.slice(0, w))
      rest = rest.slice(w)
    }
    if (!rest) continue
    if (!cur) cur = rest
    else if (cur.length + 1 + rest.length <= w) cur += ` ${rest}`
    else {
      lines.push(cur)
      cur = rest
    }
  }
  if (cur || !lines.length) lines.push(cur)
  return lines
}
