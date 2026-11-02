import type { PlanStatus, PlanStep, PlanView } from '../types'
import { cut, oneLine } from './lib'

// The to-do list logic, with no engine in it: merge a new list into the old one,
// read the tools that carry a list, and check what the plan tool is sent.

export const MAX_STEPS = 100
const MAX_TEXT = 200

export const STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed']

export type StepIn = { text: string; status: PlanStatus; id?: string }

/** The status words a model may use, in the three the mod keeps. */
const STATUS_WORDS: Record<string, PlanStatus> = {
  pending: 'pending',
  todo: 'pending',
  not_started: 'pending',
  open: 'pending',
  in_progress: 'in_progress',
  inprogress: 'in_progress',
  active: 'in_progress',
  running: 'in_progress',
  doing: 'in_progress',
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  finished: 'completed',
}

export function toStatus(v: unknown): PlanStatus | undefined {
  if (typeof v !== 'string') return undefined
  return STATUS_WORDS[v.trim().toLowerCase().replace(/[\s-]+/g, '_')]
}

export const doneCount = (steps: readonly { status: PlanStatus }[]) => steps.filter(s => s.status === 'completed').length

export const isAllDone = (steps: readonly { status: PlanStatus }[]) => steps.length > 0 && doneCount(steps) === steps.length

export type Merged = {
  plan: PlanView
  /** A first plan, or a new one after a finished plan. */
  fresh: boolean
  /** Steps that went from not done to done in this update. */
  justDone: string[]
  /** The plan was not done before and is now. */
  becameDone: boolean
}

/**
 * Takes a whole new list. Steps are matched to the old ones by id, else by text, so a step keeps
 * the time it was first seen done. A list with work left in it after a finished plan is a new plan.
 */
export function mergePlan(prev: PlanView | null, title: string | undefined, incoming: StepIn[], nowIso: string, fallbackTitle: string): Merged {
  const allDone = isAllDone(incoming)
  const fresh = !prev || (prev.done && !allDone)
  const old = fresh || !prev ? [] : prev.steps
  const used = new Set<number>()
  const findOld = (st: StepIn) => {
    const i = old.findIndex((o, k) => !used.has(k) && (st.id ? o.id === st.id : o.text === st.text))
    if (i >= 0) used.add(i)
    return i >= 0 ? old[i] : undefined
  }
  const justDone: string[] = []
  const steps: PlanStep[] = incoming.map(st => {
    const was = findOld(st)
    const step: PlanStep = { text: st.text, status: st.status, ...(st.id ? { id: st.id } : {}) }
    if (st.status === 'completed') {
      step.doneAt = was?.status === 'completed' && was.doneAt ? was.doneAt : nowIso
      if (was?.status !== 'completed' && !fresh) justDone.push(st.text)
    }
    return step
  })
  const wasDone = !!prev && prev.done && !fresh
  const plan: PlanView = {
    title: title?.trim() || (fresh || !prev ? fallbackTitle : prev.title),
    steps,
    updatedAt: nowIso,
    done: allDone,
    shown: steps.length > 0,
  }
  return { plan, fresh, justDone, becameDone: allDone && !wasDone }
}

/** One step as the plan tool may send it: an object, or just the words of a step still to do. */
function readStep(raw: unknown): StepIn | string {
  if (typeof raw === 'string') {
    const text = oneLine(raw)
    return text ? { text: cut(text, MAX_TEXT), status: 'pending' } : 'Plan not saved: a step is empty.'
  }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const text = typeof o.text === 'string' ? oneLine(o.text) : typeof o.content === 'string' ? oneLine(o.content) : ''
  if (!text) return 'Plan not saved: every step needs its text.'
  const status = o.status === undefined ? 'pending' : toStatus(o.status)
  if (!status) return `Plan not saved: "${cut(text, 40)}" needs a status of pending, in_progress or completed.`
  return { text: cut(text, MAX_TEXT), status }
}

/** The plan tool's own input: the steps and a title, or one line that says what is wrong. */
export function readToolInput(args: Record<string, unknown>): { title?: string; steps: StepIn[]; clipped: boolean } | string {
  if (!Array.isArray(args.steps)) return 'Plan not saved: send steps as a list of { text, status }.'
  const steps: StepIn[] = []
  for (const raw of args.steps as unknown[]) {
    const st = readStep(raw)
    if (typeof st === 'string') return st
    steps.push(st)
  }
  const title = typeof args.title === 'string' ? cut(oneLine(args.title), 60) : undefined
  return { title, steps: steps.slice(0, MAX_STEPS), clipped: steps.length > MAX_STEPS }
}

/** The list a TodoWrite call carries. */
export function readTodos(args: Record<string, unknown>): StepIn[] {
  const todos = Array.isArray(args.todos) ? (args.todos as unknown[]) : []
  const steps: StepIn[] = []
  for (const t of todos) {
    const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>
    const text = typeof o.content === 'string' ? oneLine(o.content) : ''
    if (text) steps.push({ text: cut(text, MAX_TEXT), status: toStatus(o.status) ?? 'pending' })
  }
  return steps.slice(0, MAX_STEPS)
}

const asIn = (steps: readonly PlanStep[]): StepIn[] => steps.map(s => ({ text: s.text, status: s.status, ...(s.id ? { id: s.id } : {}) }))

/**
 * What the task tools do to the list. Returns the whole new list, or undefined when the call changes nothing.
 * `result` is what the tool answered; TaskCreate's holds the new task's id.
 */
export function applyTaskTool(prev: PlanView | null, tool: 'TaskCreate' | 'TaskUpdate', args: Record<string, unknown>, result: unknown): StepIn[] | undefined {
  // A finished plan is over: the next task starts a new list.
  const current = prev && !prev.done ? asIn(prev.steps) : []
  if (tool === 'TaskCreate') {
    const text = typeof args.subject === 'string' ? oneLine(args.subject) : ''
    if (!text) return undefined
    const out = (result ?? {}) as { task?: { id?: unknown } }
    const id = typeof out.task?.id === 'string' ? out.task.id : undefined
    const created: StepIn = { text: cut(text, MAX_TEXT), status: 'pending', ...(id ? { id } : {}) }
    return [...current, created].slice(0, MAX_STEPS)
  }
  const id = typeof args.taskId === 'string' ? args.taskId : ''
  const all = prev ? asIn(prev.steps) : []
  const at = id ? all.findIndex(s => s.id === id) : -1
  const subject = typeof args.subject === 'string' ? oneLine(args.subject) : ''
  if (args.status === 'deleted') return at >= 0 ? all.filter((_, k) => k !== at) : undefined
  const status = toStatus(args.status)
  if (at < 0) {
    // A task made before this mod loaded: it joins the list only when the call names it.
    return subject ? [...current, { text: cut(subject, MAX_TEXT), status: status ?? 'pending', ...(id ? { id } : {}) }].slice(0, MAX_STEPS) : undefined
  }
  if (!subject && !status) return undefined
  all[at] = { ...all[at]!, ...(subject ? { text: cut(subject, MAX_TEXT) } : {}), ...(status ? { status } : {}) }
  return all
}

/** The words under the bar: what is in progress, what is next, or that all is done. */
export function nowLine(plan: Pick<PlanView, 'steps'>) {
  const n = plan.steps.length
  const active = plan.steps.find(s => s.status === 'in_progress')
  const next = plan.steps.find(s => s.status === 'pending')
  if (active) return `Now: ${active.text}`
  if (n > 0 && doneCount(plan.steps) === n) return 'All steps done'
  return next ? `Next: ${next.text}` : ''
}

/** What goes into the plan file other tools read: the steps without the ids. */
export function planFileBody(plan: PlanView) {
  return {
    title: plan.title,
    steps: plan.steps.map(s => ({ text: s.text, status: s.status, ...(s.doneAt ? { doneAt: s.doneAt } : {}) })),
    updatedAt: plan.updatedAt,
  }
}

/** Reads a plan file back, tolerating anything odd in it. */
export function readPlanFile(raw: unknown): PlanView | null {
  if (!raw || typeof raw !== 'object') return null
  const json = raw as { title?: unknown; steps?: unknown; updatedAt?: unknown }
  const steps: PlanStep[] = []
  for (const st of Array.isArray(json.steps) ? (json.steps as unknown[]) : []) {
    const o = (st && typeof st === 'object' ? st : {}) as Record<string, unknown>
    const status = toStatus(o.status)
    if (typeof o.text !== 'string' || !o.text.trim() || !status) continue
    steps.push({ text: cut(oneLine(o.text), MAX_TEXT), status, ...(typeof o.doneAt === 'string' ? { doneAt: o.doneAt } : {}) })
  }
  const done = isAllDone(steps)
  return {
    title: typeof json.title === 'string' && json.title.trim() ? cut(oneLine(json.title), 60) : 'Plan',
    steps: steps.slice(0, MAX_STEPS),
    updatedAt: typeof json.updatedAt === 'string' ? json.updatedAt : '',
    done,
    shown: steps.length > 0 && !done,
  }
}
