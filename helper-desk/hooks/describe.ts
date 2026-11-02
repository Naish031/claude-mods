import type { Step, StepKind } from '../types'
import { connectorName, splitTool, toolWords } from './connectors'
import { base, cut, folderOf, oneLine, scrub, tidyPath } from './lib'

/** The colour of a kind tag in the step list. Mid tones, so they read on light and dark. */
export const KIND_COLOR: Record<StepKind, string> = {
  Command: '#d97706',
  Connector: '#3b82f6',
  'File read': '#16a34a',
  'File write': '#ea580c',
  Skill: '#a855f7',
  Web: '#0891b2',
  Subagent: '#db2777',
  Tool: '#78716c',
}

/**
 * One tool call as a step: its kind, a short label for the list, and plain words for the live line.
 * `home` is only used to write paths with a ~.
 */
export function describe(tool: string, args: Record<string, unknown>, home: string): Step {
  const text = (key: string) => (typeof args[key] === 'string' ? oneLine(args[key] as string) : '')

  const onFile = (verb: string, kind: StepKind, key = 'file_path'): Step => {
    const path = typeof args[key] === 'string' ? (args[key] as string) : ''
    const name = base(path) || 'a file'
    return { kind, label: name, dim: path ? folderOf(path, home) : '', live: `${verb} ${name}` }
  }

  const plain = (kind: StepKind, label: string, live = label): Step => ({ kind, label, dim: '', live })

  if (tool.startsWith('mcp__')) {
    const { server, name: toolName } = splitTool(tool)
    const name = connectorName(server, toolName)
    const words = toolWords(toolName.replace(/__/g, '_'), name)
    return plain('Connector', `${name} · ${words}`, `${name}: ${words}`)
  }

  switch (tool) {
    case 'Read':
      return onFile('Reading', 'File read')
    case 'Write':
      return onFile('Writing', 'File write')
    case 'Edit':
    case 'MultiEdit':
      return onFile('Editing', 'File write')
    case 'NotebookEdit':
      return onFile('Editing', 'File write', 'notebook_path')
    case 'Grep':
    case 'Glob': {
      const pattern = text('pattern')
      const where = text('path')
      return {
        kind: 'File read',
        label: pattern ? `Search "${cut(pattern, 60)}"` : 'Search files',
        dim: where ? tidyPath(where, home) : '',
        live: pattern ? `Searching files for "${cut(pattern, 40)}"` : 'Searching files',
      }
    }
    case 'Bash': {
      const label = cut(scrub(text('description')), 80) || cut(scrub(text('command')), 80) || 'a command'
      return plain('Command', label, `Running: ${label}`)
    }
    case 'BashOutput':
    case 'KillShell':
    case 'TaskStop':
      return plain('Command', 'Check a background command', 'Checking a background command')
    case 'WebSearch': {
      const q = text('query')
      return plain('Web', q || 'web search', q ? `Searching the web: ${q}` : 'Searching the web')
    }
    case 'WebFetch': {
      let host = 'a web page'
      try {
        host = new URL(text('url')).host || host
      } catch {
        // Not a URL: keep the plain words.
      }
      return plain('Web', host, `Opening ${host}`)
    }
    case 'Skill': {
      const skill = text('skill')
      return plain('Skill', skill || 'a skill', `Using the ${skill || 'a'} skill`)
    }
    case 'Agent':
    case 'Task': {
      const d = text('description')
      return plain('Subagent', d || 'Start a subagent', d ? `Starting a subagent: ${d}` : 'Starting a subagent')
    }
    case 'SendMessage':
      return plain('Subagent', 'Send a message', 'Sending a message')
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      return plain('Tool', 'Update its to-do list', 'Updating its to-do list')
    case 'ToolSearch':
      return plain('Tool', 'Load tools', 'Loading tools')
    case 'AskUserQuestion':
      return plain('Tool', 'Ask a question', 'Asking a question')
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return plain('Tool', 'Write a plan', 'Writing a plan')
    default:
      return plain('Tool', tool, `Using ${tool}`)
  }
}

/** Tools that stop the main chat until the person answers. */
const WAITS = new Set(['AskUserQuestion', 'ExitPlanMode'])
export const waitsForYou = (tool: string) => WAITS.has(tool)

/**
 * A tool call of the main chat as a step. The same words as a helper's, except where the
 * tool is the chat's own: its to-do list, a helper it starts, or a question to the person.
 */
export function describeMain(tool: string, args: Record<string, unknown>, home: string, planTool: string): Step {
  const own = (kind: StepKind, label: string, live = label): Step => ({ kind, label, dim: '', live })
  if (tool === planTool) return own('Tool', 'Update the plan', 'Updating the plan')
  switch (tool) {
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      return own('Tool', 'Update the to-do list', 'Updating the to-do list')
    case 'Agent':
    case 'Task': {
      const d = typeof args.description === 'string' ? oneLine(args.description) : ''
      return own('Subagent', d || 'Start a helper', d ? `Running a helper: ${cut(d, 60)}` : 'Running a helper')
    }
    case 'AskUserQuestion':
      return own('Tool', 'Ask you a question', 'Asking you a question')
    case 'ExitPlanMode':
      return own('Tool', 'Ask you to approve the plan', 'Asking you to approve the plan')
    default:
      return describe(tool, args, home)
  }
}
