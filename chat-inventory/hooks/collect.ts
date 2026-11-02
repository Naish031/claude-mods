// Turns one tool call into what it adds to the inventory: a connector call, a file, a skill.
// Pure functions: no engine calls, so they are easy to test.

import { nameConnector, slug, splitTool, type NameContext } from './connectors'
import { PLAN_TOOL } from './plan'

/** What one call adds. A connector hit carries its call; the name is resolved by the caller for MCP. */
export type Hit =
  | { kind: 'connector'; name: string; learn?: { server: string; name: string }; tool: string; summary: string; cli: boolean; failed: boolean; helper: boolean }
  | { kind: 'file'; path: string; mode: 'read' | 'edit' }
  | { kind: 'skill'; name: string }

/** The facts of one tool call that matter here. */
export type CallFacts = {
  tool: string
  input: Record<string, unknown>
  failed: boolean
  helper: boolean
}

export type CliOptions = {
  /** Extra command=Name pairs from the settings. */
  extra: string
  /** Names to leave out. */
  hidden: (name: string) => boolean
}

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

export const clip = (s: string, n = 60) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

/** The last part of a path, for a file or folder given as an argument. */
const lastPart = (p: string) => (/^[~/.]/.test(p) && p.includes('/') ? p.slice(p.replace(/\/+$/, '').lastIndexOf('/') + 1) : p)

// Words that name a secret. Their values are never shown, copied or logged.
const SECRET_KEY = /(token|secret|passw|apikey|api_key|authorization|credential|cookie|bearer)/i
const SECRET_VALUE = /^(sk-|ghp_|gho_|github_pat_|xox[abprs]-|AKIA|eyJ|shpat_|shpss_|Bearer\s)/

const isSecret = (key: string, value: string) => SECRET_KEY.test(key) || SECRET_VALUE.test(value.trim())

/** Hides anything in a command line that looks like a key or token. */
export function redact(text: string): string {
  return text
    .replace(/\bbearer\s+[^\s"']+/gi, 'Bearer …')
    .replace(/(token|secret|passw\w*|api[-_]?key|authorization|bearer)(["']?\s*[=:]\s*|\s+)["']?[^\s"']+/gi, '$1 …')
    .replace(/\b(sk-|ghp_|gho_|github_pat_|xox[abprs]-|shpat_|shpss_)[A-Za-z0-9_-]{8,}/g, '…')
}

// ---------------------------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------------------------

/** Input keys worth showing, best first. */
const ARG_KEYS = [
  'query', 'q', 'search', 'searchQuery', 'keyword', 'keywords', 'url', 'file_path', 'path', 'filename', 'fileName',
  'name', 'title', 'subject', 'threadId', 'messageId', 'documentId', 'spreadsheetId', 'fileId', 'pageId', 'eventId',
  'calendarId', 'id', 'email', 'channel', 'channel_id', 'repo', 'prompt', 'skill', 'command',
]
const NOT_ARGS = new Set(['tool', 'tool_use_id', 'agentId', 'hook_event_name', 'session_id', 'transcript_path', 'cwd', 'permission_mode', 'surface', 'consent'])

/** The main argument of a call, short. */
export function summaryOf(input: Record<string, unknown>): string {
  for (const k of ARG_KEYS) {
    const v = input[k]
    if (typeof v === 'string' && v.trim() && !isSecret(k, v)) return clip(lastPart(v))
    if (typeof v === 'number') return String(v)
  }
  for (const [k, v] of Object.entries(input)) {
    if (NOT_ARGS.has(k)) continue
    if (typeof v === 'string' && v.trim() && !isSecret(k, v)) return clip(lastPart(v))
  }
  for (const [k, v] of Object.entries(input)) {
    if (NOT_ARGS.has(k) || SECRET_KEY.test(k)) continue
    if (typeof v === 'number' || typeof v === 'boolean') return clip(`${k} ${v}`)
  }
  return ''
}

/** "fireflies_get_transcripts" for connector Fireflies becomes "get transcripts"; "getThread" becomes "get thread". */
export function humanTool(tool: string, connector: string): string {
  const raw = tool.split('__').slice(2).join('__') || tool
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase())
  const own = new Set([slug(connector), ...connector.toLowerCase().split(/\s+/)])
  while (words.length > 1 && (own.has(words[0]!) || /^s\d+$/.test(words[0]!))) words.shift()
  return words.join(' ') || raw
}

// ---------------------------------------------------------------------------------------------
// Command line tools run through Bash
// ---------------------------------------------------------------------------------------------

type Cli = { name: string; mode: 'words' | 'gws' | 'run' }

/** Command line tools that count as connectors. The key is the command word. */
const CLI: Record<string, Cli> = {
  gh: { name: 'GitHub', mode: 'words' },
  shopify: { name: 'Shopify', mode: 'words' },
  gws: { name: 'Google Workspace', mode: 'gws' },
  vercel: { name: 'Vercel', mode: 'words' },
  netlify: { name: 'Netlify', mode: 'words' },
  supabase: { name: 'Supabase', mode: 'words' },
  stripe: { name: 'Stripe', mode: 'words' },
  wrangler: { name: 'Cloudflare', mode: 'words' },
  firecrawl: { name: 'Firecrawl', mode: 'words' },
  gitbot: { name: 'GitBot', mode: 'words' },
}

const GWS: Record<string, string> = {
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  drive: 'Google Drive',
  sheets: 'Google Sheets',
  docs: 'Google Docs',
}

/** Parses "firecrawl=Firecrawl, aws=AWS" into extra tools. A pair with no name is named for the command. */
export function parseExtraCli(text: string): Record<string, Cli> {
  const out: Record<string, Cli> = {}
  for (const part of text.split(',')) {
    const [cmd, ...rest] = part.split('=')
    const word = (cmd ?? '').trim()
    if (!/^[A-Za-z0-9._+-]+$/.test(word)) continue
    const name = rest.join('=').trim() || word
    out[word] = { name, mode: 'words' }
  }
  return out
}

/**
 * The command with quoted text and heredoc bodies blanked out (same length), so a word inside
 * a string or a script is never taken for a command.
 */
function mask(command: string): string {
  // Heredoc bodies first, so an apostrophe inside a script cannot confuse the quote tracking below.
  let text = command
  for (const m of [...command.matchAll(/<<-?\s*['"]?(\w+)['"]?/g)]) {
    const tag = m[1]!
    const bodyStart = text.indexOf('\n', m.index! + m[0].length)
    if (bodyStart < 0) continue
    const rest = text.slice(bodyStart)
    const end = new RegExp(`\\n[ \\t]*${tag}[ \\t]*(?=\\n|$)`).exec(rest)
    const stop = end ? bodyStart + end.index : text.length
    text = text.slice(0, bodyStart) + text.slice(bodyStart, stop).replace(/[^\n]/g, '_') + text.slice(stop)
  }
  const chars = text.split('')
  let i = 0
  let quote = ''
  while (i < chars.length) {
    const c = chars[i]!
    if (quote) {
      if (c === '\\' && quote === '"') {
        chars[i] = '_'
        if (i + 1 < chars.length) chars[i + 1] = '_'
        i += 2
        continue
      }
      if (c === quote) quote = ''
      else if (c !== '\n') chars[i] = '_'
      i += 1
      continue
    }
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === "'" || c === '"') quote = c
    i += 1
  }
  return chars.join('')
}

/** Words that may stand before the real command. */
const PREFIX = new Set(['sudo', 'time', 'command', 'env', 'nohup', 'exec', 'then', 'do', 'else', '!', 'npx', 'bunx', 'pnpx'])

/** Segments of a command line: where each starts and ends, split at ; & | newline ( ` and $(. */
function segments(masked: string): [number, number][] {
  const out: [number, number][] = []
  let start = 0
  const re = /;|&&|\|\||[|&\n(`]|\$\(/g
  for (const m of masked.matchAll(re)) {
    out.push([start, m.index!])
    start = m.index! + m[0].length
  }
  out.push([start, masked.length])
  return out
}

/** The main argument of a command line tool call: a query or id in --params, else a url, else the rest of the line. */
function cliSummary(rest: string): string {
  const m = /\\?"(q|query|id|fileId|spreadsheetId|documentId|calendarId|url)\\?"\s*:\s*\\?"([^"\\]+)/.exec(rest)
  if (m) return clip(redact(m[2]!))
  const url = /https?:\/\/[^\s"']+/.exec(rest)
  if (url) return clip(redact(url[0]))
  return clip(redact(rest.replace(/<<-?\s*'?\w+'?/, '').replace(/^\s*(?:[a-z][a-zA-Z-]*\s*)+/, '')))
}

/** Connector calls inside one Bash command line. */
export function cliHits(command: string, failed: boolean, helper: boolean, opts: CliOptions): Hit[] {
  const table = { ...CLI, ...parseExtraCli(opts.extra) }
  const masked = mask(command)
  const out: Hit[] = []
  const done = new Set<string>()
  for (const [from, to] of segments(masked)) {
    const real = command.slice(from, to)
    const words = real.trim().split(/\s+/)
    // The command word is found in the masked text, so a word inside a string or a script is never one.
    const seen = masked.slice(from, to).trim().split(/\s+/)
    let idx = 0
    while (idx < seen.length && (PREFIX.has(seen[idx]!) || /^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(seen[idx]!))) idx += 1
    const first = seen[idx]
    if (!first || /^_+$/.test(first)) continue
    const cmd = first.replace(/^.*\//, '')
    const cli = Object.prototype.hasOwnProperty.call(table, cmd) ? table[cmd] : undefined
    if (!cli) continue
    const rest = words.slice(idx + 1).join(' ')
    let name = cli.name
    let tool = ''
    if (cli.mode === 'gws') {
      const svc = /^\s*([a-z]+)/.exec(rest)?.[1] ?? ''
      name = GWS[svc] ?? 'Google Workspace'
      const sub = rest
        .trim()
        .split(/\s+/)
        .filter(w => /^[a-z][a-zA-Z]*$/.test(w))
      tool = (GWS[svc] ? sub.slice(1) : sub).slice(0, 3).join(' ') || svc || 'run'
    } else {
      tool =
        rest
          .trim()
          .split(/\s+/)
          .filter(w => /^[a-z][a-z0-9-]*$/.test(w))
          .slice(0, 2)
          .join(' ')
          .replace(/-/g, ' ') || 'run'
    }
    if (opts.hidden(name)) continue
    const summary = cliSummary(rest)
    const id = `${name}|${tool}|${summary}`
    if (done.has(id)) continue
    done.add(id)
    out.push({ kind: 'connector', name, tool, summary, cli: true, failed, helper })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Files and skills
// ---------------------------------------------------------------------------------------------

/** Claude's own spill files (big tool results, temp copies, its project cache) are not context the person gave it. */
export const isSpillPath = (p: string) =>
  /\/tool-results\/|^\/private\/tmp\/|^\/private\/var\/folders\/|^\/tmp\/|\/\.claude\/projects\/[^/]+\/[0-9a-f-]{36}\//.test(p)

export const skillOfPath = (p: string) => /\/([^/]+)\/SKILL\.md$/.exec(p)?.[1] ?? ''

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** What one tool call adds to the lists. */
export function hitsOf(call: CallFacts, ctx: NameContext, opts: CliOptions): Hit[] {
  const { tool, input, failed, helper } = call
  // A plan tool is the To-do section, not a connector.
  if (tool === PLAN_TOOL) return []
  if (tool.startsWith('mcp__')) {
    const named = nameConnector(tool, ctx)
    if (!named.name || opts.hidden(named.name)) return []
    return [
      {
        kind: 'connector',
        name: named.name,
        ...(named.learn ? { learn: named.learn } : {}),
        tool: humanTool(tool, named.name),
        summary: summaryOf(input),
        cli: false,
        failed,
        helper,
      },
    ]
  }
  if (tool === 'Bash' && typeof input.command === 'string') return cliHits(input.command, failed, helper, opts)
  if (tool === 'Read' && str(input.file_path)) {
    const fp = str(input.file_path)
    // A skill file read on purpose is a skill, named for its folder.
    const skill = skillOfPath(fp)
    if (skill) return failed ? [] : [{ kind: 'skill', name: skill }]
    if (failed || isSpillPath(fp)) return []
    return [{ kind: 'file', path: fp, mode: 'read' }]
  }
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const fp = str(input.file_path) || str(input.notebook_path)
    if (!fp || failed || isSpillPath(fp)) return []
    return [{ kind: 'file', path: fp, mode: 'edit' }]
  }
  if (tool === 'Skill' && str(input.skill)) return failed ? [] : [{ kind: 'skill', name: str(input.skill).replace(/^\//, '') }]
  return []
}

/** The name of a connector's MCP server, for a wire tool name. Exported for the tests. */
export const serverOf = (tool: string) => splitTool(tool).server
