export type HandoffStepStatus = 'wait' | 'run' | 'done' | 'fail'

export type HandoffStep = {
  label: string
  /** A short result on the right of the bar: "412 messages", "23 s", "waiting". */
  detail: string
  status: HandoffStepStatus
  /** 0 to 1. */
  progress: number
}

export type HandoffPanel = {
  /**
   * offer: the Refresh row. waiting: asked for, starts when the turn ends.
   * working: the steps. ready: the buttons. failed: the error, Try again and the draft.
   */
  phase: 'offer' | 'waiting' | 'working' | 'ready' | 'failed'
  /** Context size when the panel opened. */
  tokens: number
  /** Share of the model's window, 0 when unknown. */
  percent: number
  /** The offer was asked for (Show, /refresh): it stays whatever the token count. */
  forced: boolean
  steps: HandoffStep[]
  /** Spinner frame, moved by the ticker while working. */
  tick: number
  /** Where the handoff (or the draft) is saved, with ~ for the home folder. */
  file: string
  /** The same place as an absolute path. */
  path: string
  /** True when `file` is the basic draft and not the model's handoff. */
  isDraft: boolean
  words: number
  /** How many secrets were cut out before saving. */
  redacted: number
  error: string
  /** A line under the buttons: "Copied", "Starting the new chat", the pet's answer. */
  note: string
  /** The first lines of the handoff while Preview is open; empty when closed. */
  preview: string[]
}

declare module 'claude-code' {
  interface PluginState {
    handoff: { panel: Shaped<HandoffPanel | null> }
  }
}
