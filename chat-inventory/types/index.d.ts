/** One call a connector made in this chat. */
export type CallRow = {
  /** Plain tool name: "search threads". */
  tool: string
  /** The main argument, short: a query, an id, a file name. Shown on screen only, never logged. */
  summary: string
  /** Milliseconds since the epoch; 0 when unknown. */
  at: number
  /** True for a command line tool run through Bash. */
  cli: boolean
  /** True when the tool reported an error. */
  failed: boolean
  /** True when a helper (subagent) made the call. */
  helper: boolean
}

/** How many times one tool of a connector was called. */
export type ToolCount = {
  tool: string
  count: number
  failed: number
}

/** One connector, with every call it made. */
export type ConnectorRow = {
  /** Press address and icon key: "gmail", "googlecalendar". */
  key: string
  name: string
  count: number
  failed: number
  /** Order of last use: higher is newer. */
  seq: number
  /** Used through a command line tool in Bash. */
  cli: boolean
  /** Used through an MCP tool. */
  mcp: boolean
  /** One row per tool, most called first; capped. */
  tools: ToolCount[]
  /** Newest last; capped. */
  calls: CallRow[]
}

/** One skill, with how many times this chat used it. */
export type SkillRow = {
  name: string
  count: number
  seq: number
  /** Loaded at start through a memory file (a CLAUDE.md import). */
  always: boolean
}

/** One file in the chat's context. */
export type FileRow = {
  /** Absolute path. */
  path: string
  /** A memory file the chat loaded at start (CLAUDE.md, AGENTS.md, MEMORY.md). */
  auto: boolean
  /** Claude read it with the Read tool. */
  read: boolean
  /** Claude changed it with Edit, Write or NotebookEdit. */
  edited: boolean
  seq: number
}

/** One step of this chat's to-do list. */
export type PlanStep = {
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  /** TodoWrite's present-tense form, shown while the step is in progress. */
  active?: string
  /** TaskCreate's id, so TaskUpdate finds the step. */
  id?: string
}

/** The to-do list: from Claude's own plan tools or a shared plan file. Newest wins. */
export type Plan = {
  title: string
  steps: PlanStep[]
  /** Milliseconds since the epoch of the last change; 0 for none. */
  updatedAt: number
}

/** Everything this chat used. Kept per chat; a /clear empties it. */
export type Inventory = {
  /** The chat this belongs to. A different id means a new chat: start again. */
  sid: string
  /** Counter that gives each new thing its "newest" order. */
  n: number
  /** Ids of tool calls already counted, so a reload or a resume never counts twice. Capped. */
  ids: string[]
  /** True once the pane was opened by itself, or the chat already had history. */
  opened: boolean
  connectors: ConnectorRow[]
  files: FileRow[]
  skills: SkillRow[]
  /** MCP server id to the connector name learned for it. */
  servers: Record<string, string>
  plan: Plan
}

/** What the person has opened or scrolled in the pane. */
export type PaneView = {
  /** Key of the connector whose call list is open; '' for none. */
  open: string
  /** Sections the person closed: todo, connectors, files, skills. */
  folded: string[]
  /** First row shown in each long list, by list id. */
  tops: Record<string, number>
  /** True while finished to-do steps are shown in a long list. */
  showDone: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'chat-inventory': {
      inv: Shaped<Inventory>
      view: Shaped<PaneView>
    }
  }
}
