export type HelperPhase = 'working' | 'done' | 'failed'

export type StepKind = 'Command' | 'Connector' | 'File read' | 'File write' | 'Skill' | 'Web' | 'Subagent' | 'Tool'

export type Step = {
  kind: StepKind
  /** Short label for the step list: "Gmail · search threads", "notes.md". */
  label: string
  /** Dim text after the label: a file's folder. Empty when there is none. */
  dim: string
  /** The same step in plain words for the live line: "Reading notes.md". */
  live: string
}

export type Helper = {
  /** The id `agent.spawn` answered; tool calls and turns of its loop carry it. */
  id: string
  description: string
  /** The agent type: general-purpose, Explore, a plugin's agent. */
  type: string
  /** Display model ("Opus 5.5"), empty when not known yet. */
  model: string
  /** Effort the engine asked for on its last step, empty when not known. */
  effort: string
  phase: HelperPhase
  /** Why it stopped, in plain words, when it did not finish well. Empty otherwise. */
  note: string
  /** Clock time it started and, once over, when it ended. */
  startedAt: number
  endedAt: number
  /** How many tool calls it made in all. */
  count: number
  /** Its last 200 steps, oldest first; the last one is the live step. */
  steps: Step[]
  /** Work tokens (input, output and cache writes; cache reads left out) from finished turns. */
  tokens: number
  /** The same count for the turn in progress, from its steps so far. */
  turnTokens: number
  /** True once the engine reported any usage for it. */
  hasUsage: boolean
  /** Position in the desk, in start order. */
  seat: number
  /** Which of the 8 body colours its crab wears. */
  hue: number
}

export type PlanStatus = 'pending' | 'in_progress' | 'completed'

export type PlanStep = {
  text: string
  status: PlanStatus
  /** The task id, when the step came from the task tools. */
  id?: string
  /** ISO time the step was first seen done. */
  doneAt?: string
}

/** The chat's plan as the band draws it. */
export type PlanView = {
  title: string
  steps: PlanStep[]
  updatedAt: string
  /** True once every step is done. */
  done: boolean
  /** False once a finished plan has held its time, after a dismiss, or for an empty list. */
  shown: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'helper-desk': {
      helpers: Shaped<Helper[]>
      /** Tick count (spinner and crab frames) and the clock time of the last tick, for elapsed times. */
      clock: { tick: number; now: number }
      /** Which cards show their full step list, which groups are folded, which show every card. */
      view: Shaped<{ open: string[]; folded: string[]; all: string[] }>
      /** The chat's /cost total in US dollars, null where the host keeps none. */
      cost: { usd: number | null }
      /** True while switches.json turns the mod off. */
      off: boolean
      /** True while switches.json hides the band and the pane ("helper-desk:hidden"). */
      hidden: boolean
      /** The plan the band draws; null before the first plan. */
      plan: Shaped<PlanView | null>
      /** Shimmer tick for the step in progress; it counts only while one is in progress. */
      shimmer: number
    }
  }
}
