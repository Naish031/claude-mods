/** One hunk of a diff, as the Edit and Write tools report it: a start line and the lines, each led by a space, plus or minus. */
export type ReplayHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Each line starts with ' ' (kept), '+' (added) or '-' (removed). */
  lines: string[]
}

export type ReplayKind = 'edit' | 'create' | 'rewrite' | 'delete' | 'rename' | 'binary' | 'notebook' | 'unchanged'

/** One recorded change to one file. It holds the diff only, never the whole file. */
export type ReplayStep = {
  /** The tool call's id, with #2, #3 for the parts of a MultiEdit. */
  id: string
  /** Edit, Write, MultiEdit, NotebookEdit or Bash (a remove or move). */
  tool: string
  /** The path as shown: relative to the folder, or ~/ for the home folder. */
  file: string
  /** The full path, for a patch. */
  abs: string
  /** Where a renamed file came from, as shown. Empty otherwise. */
  from: string
  kind: ReplayKind
  /** A few words: "replace all, 3 places", "new file", "you changed it first". */
  note: string
  hunks: ReplayHunk[]
  add: number
  del: number
  /** Diff lines that were not kept (a very long diff). */
  more: number
  /** True when the line numbers are the file's own. False for a snippet whose place is not known. */
  known: boolean
  /** True when a helper (subagent) made the change. */
  helper: boolean
  /** What kind of file: "Liquid section", "JSON template". Empty when plain. */
  label: string
  /** The highlighter language, or empty to guess from the path. */
  lang: string
  /** Why the diff starts folded: "minified or very long lines", "large change". Empty when it does not. */
  why: string
  /** Milliseconds since the epoch. */
  at: number
}

export type ReplayTurn = {
  /** 1 for the first turn with edits since the session started. */
  n: number
  at: number
  steps: ReplayStep[]
  /** Edits past the per-turn limit that were counted but not kept. */
  dropped: number
}

export type ReplayHistory = {
  turns: ReplayTurn[]
  /** The number the next turn gets. */
  seq: number
}

/** Edits of the turn that is running now. They become a ReplayTurn when it ends. */
export type ReplayPending = {
  steps: ReplayStep[]
  dropped: number
  /** Characters of diff kept so far, to hold a huge turn to a budget. */
  chars: number
}

export type ReplayMode = 'step' | 'file' | 'overview'

export type ReplayView = {
  /** The pane (or the band, when no pane fits) is showing. */
  open: boolean
  /** True when the replay is drawn in the band above the prompt. */
  inBand: boolean
  /** 0 is the newest turn kept, 1 the one before. */
  turn: number
  mode: ReplayMode
  /** The step on show, counted in the list the filter leaves. */
  index: number
  /** The first diff line (or side-by-side row) on show. */
  off: number
  /** True for side by side. */
  split: boolean
  /** Which files to show: a word, a *.glob, or several separated by commas. A leading ! leaves matches out. */
  filter: string
  /** Steps whose folded diff the person opened. */
  expanded: string[]
  /** The first file listed in the overview. */
  top: number
}

declare module 'claude-code' {
  interface PluginState {
    'replay-theater': {
      history: Shaped<ReplayHistory>
      pending: Shaped<ReplayPending>
      view: Shaped<ReplayView>
    }
  }
}
