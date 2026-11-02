// Gives an MCP connector the same readable name on every account.
//
// A tool is named mcp__<server>__<tool>. A server with a real name (notion, fireflies) is named for
// itself. A claude.ai connector has a random id for a server, and the id differs per account, so
// those are named by what their tools are called. Anything unknown gets a tidy label, never a raw id.

/** Servers with a real name, keyed in lower case. */
const SERVER_NAMES: Record<string, string> = {
  gmail: 'Gmail',
  'google-workspace': 'Google Workspace',
  'google-calendar': 'Google Calendar',
  'google-drive': 'Google Drive',
  'google-sheets': 'Google Sheets',
  'claude-in-chrome': 'Chrome',
  claude_browser: 'Browser',
  'plugin-authoring': 'Plugin authoring',
  'scheduled-tasks': 'Scheduled tasks',
  'mcp-registry': 'Connector registry',
  'chat-relay': 'Chat Relay',
  vidiq: 'vidIQ',
  posthog: 'PostHog',
  pandadoc: 'PandaDoc',
  hubspot: 'HubSpot',
  github: 'GitHub',
  youtube: 'YouTube',
  'circle-community': 'Circle',
}

// A server name has no spaces and no capitals worth keeping, so these catch the rest by prefix.
const SERVER_PREFIX: [RegExp, string][] = [[/^ccd_/i, 'Claude app']]

/** The tool-name families one app uses. First match wins, so the narrow ones go first. */
const FAMILIES: [RegExp, string][] = [
  [/^fireflies_/i, 'Fireflies'],
  [/^notion-/i, 'Notion'],
  [/^vidiq_/i, 'vidIQ'],
  [/^slack_/i, 'Slack'],
  [/^composio_/i, 'Composio'],
  [/^(ads_studio|ai_influencer|scene_builder_3d|shorts_studio|tiktok)_/i, 'Higgsfield'],
  [/^ads_/i, 'Meta Ads'],
  [/^(availability|event_types|meetings|routing_forms|scheduling_links|shares|locations|users|organizations)-|calendly/i, 'Calendly'],
  [
    /^(search_threads|get_thread|get_message|list_drafts|get_draft|create_draft|update_draft|delete_draft|list_labels|create_label|update_label|delete_label|(un)?label_(thread|message)|(un)?trash_(thread|message)|(un)?mark_(thread|message)_spam|apply_sensitive_(thread|message)_label|update_message_labels|forward|reply)$/i,
    'Gmail',
  ],
  [/^(list_calendars|respond_to_event|suggest_time|search_events|create_event|update_event|delete_event|get_event|list_events)$/i, 'Google Calendar'],
  [/^(list_recent_files|search_files|read_file_content|download_file_content|get_file_metadata|get_file_permissions|share_file|trash_file|copy_file|create_file|update_file)$/i, 'Google Drive'],
  [/^(get_spreadsheet|get_values|update_values|append_values|batch_clear_values|update_formulas|insert_dimension|update_spreadsheet|copy_sheet_to_another_spreadsheet)$/i, 'Google Sheets'],
  [/(subscriber|broadcast|sequence|landing_page|snippet|growth_stats|email_template|creator_profile|email_stats)/i, 'Kit'],
  [/(community_member|space_group|(^|_)spaces?(_|$)|space_member|course_(lesson|section)|access_group|member_tag|tagged_member|live_room|gamification|paywall|flagged_content|filter_kit|post_summary|advanced_search)/i, 'Circle'],
  [/(^|-)actors?(-|$)|apify|(^|-)dataset(-|$)|key-value-store/i, 'Apify'],
  [/-records?(-|$)|^semantic-search-|call-recording|^run-basic-report$|-workspace-(members|teams)$|-list-entry-|attribute-definitions$/i, 'Attio'],
  [/^(scenarios?|scenario-[a-z-]+|data-stores?|data-store-records|data-structures?|hooks|hook-[a-z-]+|executions|credential-requests|app-modules?|connections|connection-[a-z-]+)_/i, 'Make'],
  [/^(apply_migration|execute_sql|list_migrations|list_tables|list_extensions|generate_typescript_types|get_advisors|get_publishable_keys|get_project_url|deploy_edge_function|list_edge_functions|get_edge_function|create_edge_function_secret)$/i, 'Supabase'],
  [/deployment|vercel|edge_config|project_domain|sandboxes|named_sandbox|toolbar_|rolling_release|_drains?$|kms_/i, 'Vercel'],
  [/^(get_design_context|get_figjam|use_figma|get_figma_skill|get_variable_defs|create_design_system_rules|search_design_system|send_code_to_figma|add_code_connect_map|get_motion_context)$|code_connect|shader|generative_plugin|^weave_/i, 'Figma'],
  [
    /^(get-shop-info|switch-shop|(create|update|get|list|search)[-_](product|products|collection|collections|order|orders|customers|discount)|bulk-update-product-status|add-to-collection|set-inventory|get-inventory-levels|graphql_(query|mutation|schema)|validate_graphql_codeblocks|search_docs_chunks|run-analytics-query|[a-z-]*digital-product[a-z-]*|generate-(business|domain)-names|find-(mock-shop-catalogs|sample-product)|import-mock-shop-catalog)$/i,
    'Shopify',
  ],
  [/^(find_(person|company|decision_maker)_emails?|verify_email|report_bad_email)$/i, 'AnyMailFinder'],
  [/^(match|enrich)-(business|prospects)$|^fetch-(entities|businesses-events|prospects-events|entities-statistics)$/i, 'Vibe Prospecting'],
  [/^(getTranscripts|getVideoDetails|searchVideos|getChannelStatistics|getVideoComments|getTrendingVideos|getChannelTopVideos|getVideoCategories)$/, 'YouTube'],
]

/** The label for a connector that cannot be told from its server or its tools. */
export const OTHER = 'Connector'

const titleCase = (s: string) =>
  s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')

/** A random id rather than a name: 8 hex characters, a dash, then more hex and dashes. */
export const isIdServer = (server: string) => /^[0-9a-f]{8}-[0-9a-f-]*$/i.test(server)

// A server named by one of its tools keeps that name for the tools that fit no family.
const learned = new Map<string, string>()

/** The server and tool parts of mcp__<server>__<tool>. */
export function splitTool(tool: string): { server: string; name: string } {
  const [, server = '', ...rest] = tool.split('__')
  return { server, name: rest.join('__') }
}

/** The readable name of an MCP server, given one of its tool names. */
export function connectorName(server: string, toolName: string): string {
  if (!isIdServer(server)) {
    const bare = server.replace(/^plugin_[^_]+_/, '').replace(/^claude_ai_/i, '') || server
    const prefixed = SERVER_PREFIX.find(([re]) => re.test(bare))
    if (prefixed) return prefixed[1]
    return SERVER_NAMES[bare.toLowerCase()] ?? titleCase(bare)
  }
  const hit = FAMILIES.find(([re]) => re.test(toolName))
  if (hit) {
    learned.set(server, hit[1])
    return hit[1]
  }
  return learned.get(server) ?? OTHER
}

/** "slack_search_public" from Slack reads "search public"; "getVideoDetails" reads "get video details". */
export function toolWords(tool: string, connector: string) {
  const words = tool
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase())
  if (words.length > 1 && words[0] === connector.split(' ')[0]!.toLowerCase()) words.shift()
  return words.join(' ')
}
