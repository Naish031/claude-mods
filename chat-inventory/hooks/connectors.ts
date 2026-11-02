// Names a connector from an MCP tool name (mcp__<server>__<tool>), and picks a simple badge for it.
//
// Order of trust:
//   1. The name the app shows for that tool's server (read from the context breakdown).
//   2. A readable server name in the tool name (mcp__notion__search), tidied.
//   3. A claude.ai connector, whose server is a random id: named by what its tools are called.
//   4. A learned name: an earlier call of the same server was named by rule 3.
//   5. "Connector 1", "Connector 2" ... one number per unknown server. Never the raw id.

/** Readable server names whose capitals a simple title-case would get wrong. Keys are lower case. */
const NAMED: Record<string, string> = {
  shopify: 'Shopify',
  figma: 'Figma',
  notion: 'Notion',
  slack: 'Slack',
  gmail: 'Gmail',
  github: 'GitHub',
  gitbot: 'GitBot',
  linear: 'Linear',
  stripe: 'Stripe',
  hubspot: 'HubSpot',
  posthog: 'PostHog',
  clickup: 'ClickUp',
  pagerduty: 'PagerDuty',
  datadog: 'Datadog',
  atlassian: 'Atlassian',
  asana: 'Asana',
  monday: 'monday.com',
  intercom: 'Intercom',
  pendo: 'Pendo',
  sentry: 'Sentry',
  vercel: 'Vercel',
  supabase: 'Supabase',
  'google-workspace': 'Google Workspace',
  'google-calendar': 'Google Calendar',
  'google-drive': 'Google Drive',
  'google-sheets': 'Google Sheets',
  'google-docs': 'Google Docs',
  'claude-in-chrome': 'Claude in Chrome',
  claude_browser: 'Browser pane',
  'claude-browser': 'Browser pane',
}

/** Servers that belong to the app itself, not to anything the person connected. */
const INTERNAL = /^(ccd_|plugin-authoring$)/i

/**
 * Tool name rules for claude.ai connectors, first match wins. Written from the tools each
 * connector offers; a tool that fits no rule is named by the learned server name instead.
 */
const BY_TOOL: [RegExp, string][] = [
  [/^notion-/i, 'Notion'],
  [/^slack_/i, 'Slack'],
  [/^(get_design_context|get_figjam|use_figma|get_figma_skill|get_variable_defs|create_design_system_rules|search_design_system|send_code_to_figma|add_code_connect_map|get_code_connect|send_code_connect|get_context_for_code_connect|get_motion_context|html_to_figma|generate_figma_design)|figma|code_connect|shader|generative_plugin|^weave_/i, 'Figma'],
  [/graphql|shop|store-previews|(^|[-_])(products?|collections?|discounts?|inventory|orders?|customers?|catalog)([-_]|$)|digital-product|business-names|domain-names|collective/i, 'Shopify'],
  [/^(get_findings|get_fix_prompt|get_rule|list_rules|list_recent_reviews|list_repos|resync)$/i, 'GitBot'],
  [/^(append_values|batch_clear_values|copy_sheet_to_another_spreadsheet|get_spreadsheet|get_values|insert_dimension|update_formulas|update_spreadsheet|update_values)$/i, 'Google Sheets'],
  [/^(list_calendars|list_events|get_event|create_event|update_event|delete_event|respond_to_event|suggest_time|search_events)$/i, 'Google Calendar'],
  [/^(list_recent_files|search_files|read_file_content|download_file_content|get_file_metadata|get_file_permissions|share_file|trash_file|copy_file|create_file|update_file)$/i, 'Google Drive'],
  [
    /^(search_threads|get_thread|get_message|list_drafts|get_draft|create_draft|update_draft|delete_draft|list_labels|create_label|update_label|delete_label|(un)?label_(thread|message)|(un)?trash_(thread|message)|(un)?mark_(thread|message)_spam|apply_sensitive_(thread|message)_label|update_message_labels|forward|reply|send_message)$/i,
    'Gmail',
  ],
]

const titleCase = (s: string) =>
  s
    .split(/[-_\s.]+/)
    .filter(Boolean)
    .map(w => (w === w.toLowerCase() ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ')

/** A random id rather than a name: 8 hex characters, a dash, then more hex and dashes. */
export const isIdServer = (server: string) => /^[0-9a-f]{8}-[0-9a-f-]*$/i.test(server)

/** The server and tool parts of an MCP tool name: mcp__<server>__<tool>. */
export function splitTool(tool: string): { server: string; name: string } {
  const [, server = '', ...rest] = tool.split('__')
  return { server, name: rest.join('__') }
}

/** Lower case letters and digits only: the key a connector is kept and pressed under. */
export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

/** A server name as the app shows it ("claude.ai Gmail", "plugin:productivity:notion") made plain ("Gmail", "Notion"). */
export function tidyServerLabel(label: string): string {
  let name = label.trim()
  name = name.replace(/^claude\.ai[\s:_-]+/i, '').replace(/^plugin:[^:]+:/i, '').replace(/^plugin_[^_]+_/i, '')
  name = name.replace(/^claude_ai_/i, '')
  if (!name || isIdServer(name)) return ''
  return NAMED[name.toLowerCase()] ?? (/[A-Z]/.test(name) && /\s/.test(name) ? name : titleCase(name))
}

/** The friendly name of a readable server name found in a tool name. */
export function serverNameOf(server: string): string {
  const stripped = server.replace(/^plugin_[^_]+_/, '').replace(/^claude_ai_/i, '') || server
  return NAMED[stripped.toLowerCase()] ?? NAMED[server.toLowerCase()] ?? titleCase(stripped)
}

export type NameContext = {
  /** Wire tool name to the name the app shows for its server (from the context breakdown). */
  wire: ReadonlyMap<string, string>
  /** Server id to the name learned earlier in this chat. */
  servers: Readonly<Record<string, string>>
}

export type Named = {
  /** The connector's name; '' when the tool is not a connector's (an internal app tool). */
  name: string
  /** A server id and the name to remember for it. */
  learn?: { server: string; name: string }
}

/** Names the connector behind an MCP tool call. */
export function nameConnector(tool: string, ctx: NameContext): Named {
  if (!tool.startsWith('mcp__')) return { name: '' }
  const { server, name: toolName } = splitTool(tool)
  if (!server || INTERNAL.test(server)) return { name: '' }
  const shown = ctx.wire.get(tool)
  if (shown) {
    const tidy = tidyServerLabel(shown)
    if (tidy) return isIdServer(server) ? { name: tidy, learn: { server, name: tidy } } : { name: tidy }
  }
  if (!isIdServer(server)) return { name: serverNameOf(server) }
  const hit = BY_TOOL.find(([re]) => re.test(toolName))
  if (hit) return { name: hit[1], learn: { server, name: hit[1] } }
  const known = ctx.servers[server]
  if (known) return { name: known }
  const numbered = Math.max(0, ...Object.values(ctx.servers).map(n => Number(/^Connector (\d+)$/.exec(n)?.[1] ?? 0))) + 1
  const label = `Connector ${numbered}`
  return { name: label, learn: { server, name: label } }
}

/** True when a connector name is in the person's hide list (names separated by commas). */
export function isHidden(name: string, list: string): boolean {
  const key = slug(name)
  return list
    .split(',')
    .map(slug)
    .filter(Boolean)
    .includes(key)
}

// ---------------------------------------------------------------------------------------------
// Badges. Original letter tiles: white on a dark colour, so they read on a light or a dark theme.
// ---------------------------------------------------------------------------------------------

/** Every tile colour is dark enough for white text (4.5:1 or better). */
export const TILE_COLORS = [
  '#9a3412', // rust
  '#1d4ed8', // blue
  '#15803d', // green
  '#7e22ce', // purple
  '#0f766e', // teal
  '#be123c', // rose
  '#4d4d4d', // graphite
  '#a16207', // ochre
  '#4338ca', // indigo
  '#a21caf', // magenta
] as const

/** Colours chosen for the connectors Naish uses, so they look the same every time. */
const FIXED: Record<string, string> = {
  shopify: '#15803d',
  figma: '#7e22ce',
  notion: '#4d4d4d',
  slack: '#a21caf',
  gmail: '#be123c',
  googlecalendar: '#1d4ed8',
  googledrive: '#a16207',
  googlesheets: '#0f766e',
  github: '#4d4d4d',
  gitbot: '#4338ca',
  claudeinchrome: '#1d4ed8',
  browserpane: '#0f766e',
}

const hash = (s: string) => {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}

export const tileColor = (key: string) => FIXED[key] ?? TILE_COLORS[hash(key) % TILE_COLORS.length]!

/** One or two letters for the tile: "Gmail" is G, "Google Calendar" is GC, "Connector 2" is C2. */
export function tileLetters(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean)
  const first = words[0]?.[0]?.toUpperCase() ?? '?'
  if (words.length < 2) return first
  const second = words[1]![0]!.toUpperCase()
  return `${first}${second}`
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A 24 by 24 rounded tile with the connector's letters, as SVG markup. */
export function tileSvg(key: string, name: string): string {
  const letters = esc(tileLetters(name))
  const size = letters.length > 2 ? 10 : 12
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">' +
    `<rect width="24" height="24" rx="6" fill="${tileColor(key)}"/>` +
    `<text x="12" y="16.2" text-anchor="middle" font-family="-apple-system, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="700" fill="#ffffff">${letters}</text>` +
    '</svg>'
  )
}

/** WCAG contrast ratio of white text on a hex colour. Used by the tests. */
export function whiteContrast(hex: string): number {
  const ch = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const lum = 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5)
  return 1.05 / (lum + 0.05)
}
