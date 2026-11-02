import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'


const HOME = '/Users/test'
const SW = `${HOME}/.claude/claude-mods/switches.json`
const LOG = `${HOME}/.claude/claude-mods/logs/chat-inventory.log`
const SID = 'sid-1'
const paneProps = { title: 'In this chat', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as never

// Made-up ids. On a real account each claude.ai connector has its own random id.
const uuid = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`
// Fake secrets, spelled in two parts so no scanner takes them for real keys.
const FAKE_GH = `gh${'p_'}abcdefghijklmnop123`
const FAKE_SK = `sk${'-live-'}abcdefghijklmnop`
const GMAIL = `mcp__${uuid('a')}__`
const FIREFLIES = 'mcp__plugin_demo_fireflies__'

type Opts = {
  files?: Record<string, string>
  messages?: (agentId?: string) => unknown[]
  usage?: Record<string, unknown>
  /** What the bottom answers to a tool call; by default {result:'ok'}. */
  answer?: (e: Record<string, unknown>) => Record<string, unknown>
  copy?: boolean | 'throw'
  sid?: () => string
  failRead?: boolean
  failUsage?: boolean
  failMessages?: boolean
}

const MEMORY = [
  { path: `${HOME}/vault/CLAUDE.md`, type: 'Project', tokens: 500 },
  { path: `${HOME}/dev/browser-harness/SKILL.md`, type: 'User', tokens: 300 },
]

/** Stands for the engine beneath the mod. `files` is the fake disk. */
function setup(on: On, o: Opts = {}) {
  const files = o.files ?? {}
  const opened: string[] = []
  const runs: string[][] = []
  const toasts: string[] = []
  const logged: string[] = []
  const copied: string[] = []
  const commands: string[] = []
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async () => ({ value: { command: 'inventory' } }) as never)
  on('command.list', async () => ({ value: [] }) as never)
  on('command.run', async ($, e) => {
    commands.push((e as { command: string }).command)
    return { text: '' } as never
  })
  mock.env(on, { HOME })
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 16, 9, 0, 0) })
  on('session.id', async () => ({ value: o.sid ? o.sid() : SID }) as never)
  on('session.cwd', async () => ({ value: `${HOME}/vault` }) as never)
  on('session.end', async ($, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  on('session.messages', async ($, e) => {
    if (o.failMessages) throw new Error('no messages')
    return { value: o.messages ? o.messages((e as { agentId?: string }).agentId) : [] } as never
  })
  on('session.usage', async () => {
    if (o.failUsage) throw new Error('no usage')
    return {
      value: {
        context: {
          tokens: 1000,
          window: 1_000_000,
          breakdown: {
            memoryFiles: MEMORY,
            mcpTools: [],
            skills: { totalSkills: 1, includedSkills: 1, tokens: 10, skillFrontmatter: [{ name: 'video-prep', source: 'userSettings', tokens: 10 }] },
            ...(o.usage ?? {}),
          },
        },
      },
    } as never
  })
  on('fs.exists', async ($, e) => ({ value: (e as { path: string }).path in files }) as never)
  on('fs.read', async ($, e) => {
    if (o.failRead) throw new Error('disk on fire')
    return { value: files[(e as { path: string }).path] ?? '' } as never
  })
  on('fs.write', async ($, e) => {
    const { path, text } = e as { path: string; text: string }
    files[path] = text
    return { value: undefined } as never
  })
  on('fs.stat', async () => ({ value: { kind: 'file', size: 100, mtimeMs: 0, isLink: false } }) as never)
  on('process.run', async ($, e) => {
    const argv = [...(e as { argv: readonly string[] }).argv]
    runs.push(argv)
    if (argv[0] === 'rm') delete files[argv[2]!]
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('ui.invalidate', async () => ({ value: undefined }) as never)
  on('ui.open', async ($, e) => {
    opened.push((e as { id: string }).id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', async ($, e) => {
    opened.push(`closed:${(e as { id: string }).id}`)
    return { value: undefined } as never
  })
  on('ui.toast', async ($, e) => {
    toasts.push(String((e as { text?: string }).text ?? ''))
    return { value: undefined } as never
  })
  on('ui.log', async ($, e) => {
    logged.push(String((e as { text?: string }).text ?? ''))
    return { value: undefined } as never
  })
  on('ui.copy', async ($, e) => {
    if (o.copy === 'throw') throw new Error('no clipboard')
    copied.push((e as { text: string }).text)
    return { value: o.copy === false ? { isCopied: false, reason: 'no-clipboard' } : { isCopied: true } } as never
  })
  on('tool.call', async ($, e) => (o.answer ? o.answer(e as unknown as Record<string, unknown>) : { result: 'ok' }) as never)
  return { clock, files, opened, runs, toasts, logged, copied, commands }
}

type Call = (input: Record<string, unknown>) => Promise<Record<string, unknown>>
const caller = ($: Engine) => $.tool.call as unknown as Call

let seq = 0
const id = () => `t${(seq += 1)}`

async function start($: Engine, surface: 'desktop' | 'terminal', clock: { settle: () => Promise<void> }) {
  await ($.session.start as (i: unknown) => Promise<unknown>)({ source: 'startup', cwd: `${HOME}/vault`, surface, isInteractive: true })
  await clock.settle()
}

const mountPane = ($: Engine, surface: 'desktop' | 'terminal') =>
  $.ui.mount({ plugin: 'chat-inventory', surface, component: 'Pane', requestId: 'chat-inventory', props: paneProps } as never) as Promise<{
    find: (q: Record<string, unknown>) => Promise<{ text?: string; props: Record<string, unknown> } | undefined>
    findAll: (q: Record<string, unknown>) => Promise<{ text?: string; props: Record<string, unknown> }[]>
    press: (q: { key: string }) => Promise<unknown>
    unmount: () => Promise<void>
  }>

const SURFACES = ['desktop', 'terminal'] as const

for (const surface of SURFACES) {
  test(`lists connectors, files and skills (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on)
    await start($, surface, s.clock)
    const call = caller($)
    await call({ tool: `${GMAIL}search_threads`, tool_use_id: id(), query: 'offer' })
    await call({ tool: `${GMAIL}search_threads`, tool_use_id: id(), query: 'offer 2' })
    await call({ tool: `${FIREFLIES}fireflies_get_transcript`, tool_use_id: id(), transcriptId: 'x' })
    await call({ tool: 'Read', tool_use_id: id(), file_path: `${HOME}/x/offer.md` })
    await call({ tool: 'Skill', tool_use_id: id(), skill: 'video-prep' })
    await s.clock.settle()
    expect(s.opened, 'the pane opened by itself').toContain('chat-inventory')

    const ui = await mountPane($, surface)
    for (const text of ['Gmail', 'Fireflies', 'offer.md', 'video-prep', 'CLAUDE.md', 'auto', 'browser-harness', 'always loaded']) {
      expect(await ui.find({ text: new RegExp(text) }), `${text} shows`).toBeDefined()
    }
    expect(await ui.find({ text: /SKILL\.md/ }), 'a SKILL.md is not a context file').toBeUndefined()
    expect(await ui.find({ text: /Slack/ }), 'an unused connector does not show').toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /2 connectors? · 3 calls|2 · 3 calls/ }), 'section count says connectors and calls').toBeDefined()
    if (surface === 'desktop') {
      const logos = await ui.findAll({ type: 'Svg' })
      expect(logos.length, 'one tile per connector').toBe(2)
      expect(String(logos.find(l => String(l.props.alt).startsWith('Gmail'))?.props.alt)).toContain('2 calls')
      expect(String(logos[0]?.props.source), 'a letter tile').toContain('<svg')
    } else {
      expect(await ui.find({ type: 'Text', text: /2 calls/ }), 'Gmail has two calls').toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1 call$/ }), 'Fireflies has one call').toBeDefined()
    }
  })

  test(`connectors are named for the apps Naish uses, and any other MCP server (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on)
    await start($, surface, s.clock)
    const call = caller($)
    const named: [string, string][] = [
      [`mcp__a47ca784-28ba-41df-baa5-79961d1ffa69__get-shop-info`, 'shopify'],
      [`mcp__b5aec188-c374-48b8-9c7d-99dd89034461__get_design_context`, 'figma'],
      [`mcp__figma__get_metadata`, 'figma'],
      [`mcp__Figma__get_screenshot`, 'figma'],
      [`mcp__20d2a342-3757-4126-96c9-8596edd8e827__notion-search`, 'notion'],
      [`mcp__plugin_productivity_notion__notion-fetch`, 'notion'],
      [`mcp__57fa0fb4-1686-4a06-abd7-467d306007cd__slack_send_message`, 'slack'],
      [`mcp__plugin_productivity_slack__slack_read_channel`, 'slack'],
      [`mcp__d460bbcb-c61d-4689-86fe-bf6495e08284__search_threads`, 'gmail'],
      [`mcp__1d6f874f-4b51-49c4-885d-6850b41db024__list_events`, 'googlecalendar'],
      [`mcp__ec36a22f-32af-4dba-ae8c-705c2fc481ea__search_files`, 'googledrive'],
      [`mcp__f55055e9-49d3-4041-ae6d-10a79237dddf__get_values`, 'googlesheets'],
      [`mcp__3151f321-8eee-4593-9d4c-7298260f80b0__get_findings`, 'gitbot'],
      // `review` alone fits no rule: this server was already named GitBot by its other tool.
      [`mcp__3151f321-8eee-4593-9d4c-7298260f80b0__review`, 'gitbot'],
      [`mcp__claude-in-chrome__navigate`, 'claudeinchrome'],
      [`mcp__Claude_Browser__navigate`, 'browserpane'],
      [`mcp__plugin_engineering_github__list_issues`, 'github'],
      [`mcp__acme-crm__find_lead`, 'acmecrm'],
      [`mcp__${uuid('c5')}__do_x`, 'connector1'],
      [`mcp__${uuid('c5')}__do_z`, 'connector1'],
      [`mcp__${uuid('c6')}__do_y`, 'connector2'],
    ]
    for (const [tool] of named) await call({ tool, tool_use_id: id() })
    await call({ tool: 'mcp__ccd_session__mark_chapter', tool_use_id: id(), title: 'x' })
    await call({ tool: 'mcp__plugin-authoring__scan_secrets', tool_use_id: id() })
    await s.clock.settle()

    const ui = await mountPane($, surface)
    for (const key of new Set(named.map(n => n[1]))) expect(await ui.find({ key: `c:${key}` }), `${key} row`).toBeDefined()
    expect(await ui.find({ text: /00000000|ccd|scan secrets|Scan Secrets/i }), 'no raw id, no app tools').toBeUndefined()
    // Figma was reached through three servers and is one row with 3 calls.
    expect((await ui.find({ key: 'c:figma' }))?.text ?? '').toContain('Figma')
    expect(await ui.find({ text: /3 calls/ }), 'Figma has three calls').toBeDefined()
    await ui.press({ key: 'c:connector1' })
    expect(await ui.find({ text: /do x/ }), 'Connector 1 call').toBeDefined()
    expect(await ui.find({ text: /do z/ }), 'same server, same row').toBeDefined()
    expect(await ui.find({ text: /do y/ }), 'the other unknown server is another row').toBeUndefined()
  })

  test(`the name the app shows for a server wins over a guess (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const docs = `mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__`
    const s = setup(on, {
      usage: {
        mcpTools: [
          { name: `${docs}guide`, serverName: 'claude.ai Google Docs', tokens: 10, isLoaded: true },
          { name: `${docs}batch`, serverName: 'claude.ai Google Docs', tokens: 10, isLoaded: true },
        ],
      },
    })
    await start($, surface, s.clock)
    const call = caller($)
    await call({ tool: `${docs}guide`, tool_use_id: id() })
    await call({ tool: `${docs}batch`, tool_use_id: id() })
    await s.clock.settle()
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'c:googledocs' }), 'named from the context').toBeDefined()
    expect(await ui.find({ text: /Connector 1/ })).toBeUndefined()
  })

  test(`a connector's tools are counted and its calls listed, with failures marked (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on, { answer: e => (e.query === 'bad' ? { result: 'nope', isError: true } : { result: 'ok' }) })
    await start($, surface, s.clock)
    const call = caller($)
    await call({ tool: `${GMAIL}search_threads`, tool_use_id: id(), query: 'offer from Sam' })
    await call({ tool: `${GMAIL}search_threads`, tool_use_id: id(), query: 'bad' })
    await call({ tool: `${GMAIL}search_threads`, tool_use_id: id(), query: 'third' })
    await call({ tool: `${GMAIL}get_thread`, tool_use_id: id(), threadId: 'abc' })
    await call({ tool: `${FIREFLIES}fireflies_get_transcript`, tool_use_id: id(), transcriptId: '01M46QSH' })
    await call({ tool: `${GMAIL}search_threads`, tool_use_id: id(), query: 'by a helper', agentId: 'a1' })
    await s.clock.settle()

    const ui = await mountPane($, surface)
    expect(await ui.find({ text: /offer from Sam/ }), 'closed at first').toBeUndefined()
    expect(await ui.find({ text: /1 failed/ }), 'the failure is counted on the row').toBeDefined()
    await ui.press({ key: 'c:gmail' })
    expect(await ui.find({ text: /tools used/ }), 'breakdown heading').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^search threads$/ }), 'breakdown row').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^4/ }), 'search threads was called 4 times').toBeDefined()
    expect(await ui.find({ text: /offer from Sam/ }), 'the query shows').toBeDefined()
    expect(await ui.find({ text: /^! search threads/ }), 'the failed call is marked').toBeDefined()
    expect(await ui.find({ text: /\d\d:\d\d$/ }), 'time of day').toBeDefined()
    expect(await ui.find({ text: /helper/ }), 'a helper call is tagged').toBeDefined()
    expect(await ui.find({ text: /get transcript/ }), 'only one list open').toBeUndefined()
    await ui.press({ key: 'c:fireflies' })
    expect(await ui.find({ text: /get transcript/ }), 'Fireflies list opens').toBeDefined()
    expect(await ui.find({ text: /offer from Sam/ }), 'Gmail list closed').toBeUndefined()
    await ui.press({ key: 'c:fireflies' })
    expect(await ui.find({ text: /get transcript/ }), 'second press closes it').toBeUndefined()
  })

  test(`a long call list shows 10 rows with Up and Down (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on)
    await start($, surface, s.clock)
    const call = caller($)
    for (let i = 1; i <= 14; i += 1) await call({ tool: `${GMAIL}search_threads`, tool_use_id: id(), query: `q${i}` })
    await s.clock.settle()
    const ui = await mountPane($, surface)
    await ui.press({ key: 'c:gmail' })
    expect(await ui.find({ text: /^1 to 10 of 14$/ })).toBeDefined()
    expect(await ui.find({ text: /q14/ }), 'newest first').toBeDefined()
    expect(await ui.find({ text: /q1$/ }), 'oldest is below').toBeUndefined()
    await ui.press({ key: 'calls:gmail-down' })
    expect(await ui.find({ text: /^5 to 14 of 14$/ })).toBeDefined()
    expect(await ui.find({ text: /q1$/ }), 'oldest in view').toBeDefined()
    expect(await ui.find({ key: 'calls:gmail-down' }), 'no Down at the end').toBeUndefined()
    await ui.press({ key: 'calls:gmail-up' })
    expect(await ui.find({ text: /^1 to 10 of 14$/ })).toBeDefined()
  })

  test(`command line tools in Bash count as connectors (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on)
    await start($, surface, s.clock)
    const call = caller($)
    await call({ tool: 'Bash', tool_use_id: id(), command: `cd ~; gws gmail users messages list --params '{"userId":"me","q":"from:sam"}'` })
    await call({ tool: 'Bash', tool_use_id: id(), command: `cd ~ && gws calendar events list --params '{"calendarId":"primary"}'` })
    await call({ tool: 'Bash', tool_use_id: id(), command: `GH_TOKEN=${FAKE_GH} gh pr list --limit 5` })
    await call({ tool: 'Bash', tool_use_id: id(), command: 'shopify theme dev --store demo' })
    // Not commands: a word inside text, a script body, a look-alike name, a path.
    await call({ tool: 'Bash', tool_use_id: id(), command: 'echo gwsx; ls ~/gws; echo "run: gh issue list"' })
    await call({ tool: 'Bash', tool_use_id: id(), command: "cat <<'EOF'\ngh pr create\nEOF" })
    await call({ tool: 'Bash', tool_use_id: id(), command: 'curl -H "Authorization: Bearer sekret123" https://example.com' })
    await call({ tool: 'Read', tool_use_id: id(), file_path: `${HOME}/.claude/skills/foo/SKILL.md` })
    await s.clock.settle()

    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'c:gmail' }), 'gws gmail is Gmail').toBeDefined()
    expect(await ui.find({ key: 'c:googlecalendar' }), 'gws calendar is Google Calendar').toBeDefined()
    expect(await ui.find({ key: 'c:github' }), 'gh is GitHub').toBeDefined()
    expect(await ui.find({ key: 'c:shopify' }), 'shopify is Shopify').toBeDefined()
    expect(await ui.find({ text: /via CLI/ }), 'tagged via CLI').toBeDefined()
    expect(await ui.find({ text: /Google Workspace/ }), 'gwsx is not gws').toBeUndefined()
    // gh was run once for real (the env prefix) and once in a string and once in a script: one call.
    await ui.press({ key: 'c:github' })
    expect(await ui.find({ text: /pr list/ })).toBeDefined()
    expect(await ui.find({ text: /ghp_|abcdefghij/ }), 'a token is never shown').toBeUndefined()
    expect(await ui.find({ text: /1 call/ }), 'the string and the script were not counted').toBeDefined()
    expect(await ui.find({ text: /sekret123/ })).toBeUndefined()
    expect(await ui.find({ text: /foo/ }), 'the skill is named for its folder').toBeDefined()
    expect(await ui.find({ text: /SKILL\.md/ }), 'not a context file').toBeUndefined()
  })
}

for (const surface of SURFACES) {
  test(`files: read, changed, skipped spill files, and a 10 row window (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on)
    await start($, surface, s.clock)
    const call = caller($)
    await call({ tool: 'Read', tool_use_id: id(), file_path: `${HOME}/x/offer.md` })
    await call({ tool: 'Edit', tool_use_id: id(), file_path: `${HOME}/x/page.liquid`, old_string: 'a', new_string: 'b' })
    await call({ tool: 'Write', tool_use_id: id(), file_path: `${HOME}/x/new.ts`, content: 'x' })
    await call({ tool: 'Read', tool_use_id: id(), file_path: '/private/tmp/claude-501/x/tool-results/big.txt' })
    await call({ tool: 'Read', tool_use_id: id(), file_path: '/tmp/scratch.txt' })
    await s.clock.settle()
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: /^offer\.md/ })).toBeDefined()
    expect(await ui.find({ text: /^page\.liquid/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^changed$/ }), 'changed tag').toBeDefined()
    expect(await ui.find({ text: /big\.txt|scratch\.txt/ }), 'spill files are not context').toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^1 · 2 changed$/ }), 'files read and changed').toBeDefined()
    expect(await ui.find({ text: /~\/x|…\/x|~\/x/ }), 'home shown as ~').toBeDefined()
    await ui.unmount()

    for (let i = 1; i <= 14; i += 1) await call({ tool: 'Read', tool_use_id: id(), file_path: `${HOME}/y/note${i}.md` })
    await s.clock.settle()
    const ui2 = await mountPane($, surface)
    const shown = async () => (await ui2.findAll({ type: 'Text', text: /^note\d+\.md/ })).length
    // 14 notes + offer + page + new + CLAUDE.md = 18 files.
    expect(await shown(), 'ten rows at most').toBeLessThanOrEqual(10)
    expect(await ui2.find({ text: /^1 to 10 of 18$/ })).toBeDefined()
    expect(await ui2.find({ key: 'files-up' }), 'no Up at the top').toBeUndefined()
    expect(await ui2.find({ text: /note14\.md/ }), 'newest first').toBeDefined()
    await ui2.press({ key: 'files-down' })
    expect(await ui2.find({ text: /^6 to 15 of 18$/ })).toBeDefined()
    await ui2.press({ key: 'files-down' })
    expect(await ui2.find({ text: /^9 to 18 of 18$/ }), 'clamped at the end').toBeDefined()
    expect(await ui2.find({ text: /CLAUDE\.md/ }), 'oldest in view').toBeDefined()
    expect(await ui2.find({ key: 'files-down' })).toBeUndefined()
    await ui2.press({ key: 'files-up' })
    expect(await ui2.find({ text: /^4 to 13 of 18$/ })).toBeDefined()
  })

  test(`skills: Skill tool, typed slash command, SKILL.md read, always loaded (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on)
    await start($, surface, s.clock)
    const call = caller($)
    await call({ tool: 'Skill', tool_use_id: id(), skill: 'video-prep' })
    await call({ tool: 'Skill', tool_use_id: id(), skill: '/video-prep' })
    await call({ tool: 'Skill', tool_use_id: id(), skill: 'engineering:code-review' })
    await call({ tool: 'Read', tool_use_id: id(), file_path: `${HOME}/.claude/skills/foo/SKILL.md` })
    await $.command.run({ command: 'video-prep', args: '' } as never)
    await $.command.run({ command: 'not-a-skill', args: '' } as never)
    await $.command.run({ command: 'video-prep', args: '' } as never)
    await s.clock.settle()
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: /video-prep/ })).toBeDefined()
    expect(await ui.find({ text: /4 uses/ }), 'two Skill calls and two typed commands').toBeDefined()
    expect(await ui.find({ text: /engineering:code-review/ })).toBeDefined()
    expect(await ui.find({ text: /foo/ }), 'SKILL.md read').toBeDefined()
    expect(await ui.find({ text: /not-a-skill/ }), 'a plain command is not a skill').toBeUndefined()
    expect(await ui.find({ text: /always loaded/ })).toBeDefined()
  })

  test(`a section header arrow closes and opens it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on)
    await start($, surface, s.clock)
    const call = caller($)
    await call({ tool: 'Read', tool_use_id: id(), file_path: `${HOME}/x/offer.md` })
    await call({ tool: 'Skill', tool_use_id: id(), skill: 'video-prep' })
    await s.clock.settle()
    const ui = await mountPane($, surface)
    for (const sec of ['todo', 'connectors', 'files', 'skills']) {
      expect((await ui.find({ key: `sec-${sec}` }))?.text ?? '', `${sec} open by default`).toMatch(/^▾ /)
    }
    await ui.press({ key: 'sec-files' })
    expect((await ui.find({ key: 'sec-files' }))?.text ?? '').toMatch(/^▸ Context files/)
    expect(await ui.find({ text: /offer\.md/ }), 'files hidden').toBeUndefined()
    expect(await ui.find({ text: /video-prep/ }), 'other sections stay open').toBeDefined()
    await ui.press({ key: 'sec-files' })
    expect(await ui.find({ text: /offer\.md/ }), 'open again').toBeDefined()
  })
}

const PLAN_FILE = `${HOME}/.claude/claude-mods/plans/plan-${SID}.json`

for (const surface of SURFACES) {
  test(`a TodoWrite call draws the to-do rows with the right marks (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on)
    await start($, surface, s.clock)
    const call = caller($)
    await call({
      tool: 'TodoWrite',
      tool_use_id: id(),
      todos: [
        { content: 'Read the brief', status: 'completed', activeForm: 'Reading the brief' },
        { content: 'Write the code', status: 'in_progress', activeForm: 'Writing the code' },
        { content: 'Run the checks', status: 'pending', activeForm: 'Running the checks' },
      ],
    })
    await s.clock.settle()
    expect(s.opened, 'a plan opens the pane').toContain('chat-inventory')
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: /^▾ To-do$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1 of 3$/ }), 'count on the right').toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: /^✓$/ })).length).toBe(1)
    expect((await ui.findAll({ type: 'Text', text: /^●$/ })).length).toBe(1)
    expect((await ui.findAll({ type: 'Text', text: /^○$/ })).length).toBe(1)
    const done = await ui.find({ type: 'Text', text: /^Read the brief$/ })
    expect(done?.props.strikethrough).toBe(true)
    expect(done?.props.dimColor).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^Writing the code$/ }))?.props.bold, 'active form, bold').toBe(true)
    expect(await ui.find({ text: /^Run the checks$/ })).toBeDefined()
    expect(await ui.find({ text: /No to-do list yet/ })).toBeUndefined()
  })

  test(`TaskCreate and TaskUpdate keep the list, by id, with deletes (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    let n = 0
    const s = setup(on, { answer: e => (e.tool === 'TaskCreate' ? { result: { task: { id: String((n += 1) + 10), subject: String(e.subject) } } } : { result: 'ok' }) })
    await start($, surface, s.clock)
    const call = caller($)
    await call({ tool: 'TaskCreate', tool_use_id: id(), subject: 'First', description: 'd', activeForm: 'Doing first' })
    await call({ tool: 'TaskCreate', tool_use_id: id(), subject: 'Second', description: 'd' })
    await call({ tool: 'TaskCreate', tool_use_id: id(), subject: 'Third', description: 'd' })
    await call({ tool: 'TaskUpdate', tool_use_id: id(), taskId: '11', status: 'in_progress' })
    await call({ tool: 'TaskUpdate', tool_use_id: id(), taskId: '12', status: 'deleted' })
    await call({ tool: 'TaskUpdate', tool_use_id: id(), taskId: '13', subject: 'Third, reworded' })
    await call({ tool: 'TaskUpdate', tool_use_id: id(), taskId: '99', status: 'completed' })
    await s.clock.settle()
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /^Doing first$/ }), 'in progress shows its active form').toBeDefined()
    expect(await ui.find({ text: /^Second$/ }), 'deleted').toBeUndefined()
    expect(await ui.find({ text: /^Third, reworded$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^0 of 2$/ })).toBeDefined()
  })

  test(`a plan file on disk is drawn, long steps wrap, a long list hides done steps (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const long = 'Pull every Stripe charge for the last thirty days and match each one to a Circle member by email'
    const steps = [
      { text: 'Find the members', status: 'completed' },
      { text: 'Score them', status: 'completed' },
      { text: long, status: 'in_progress' },
      { text: 'Build the sheet', status: 'pending' },
    ]
    const files: Record<string, string> = { [PLAN_FILE]: JSON.stringify({ title: 'Churn check', steps, updatedAt: '2026-10-16T09:06:00.000Z' }) }
    const s = setup(on, { files })
    await start($, surface, s.clock)
    await caller($)({ tool: 'Read', tool_use_id: id(), file_path: `${HOME}/x/a.md` })
    await s.clock.settle()
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /^2 of 4$/ })).toBeDefined()
    expect(await ui.find({ text: /Churn check/ }), 'title').toBeDefined()
    const lines = await ui.findAll({ type: 'Text', text: /Stripe|Circle|email/ })
    expect(lines.length, 'the long step wraps').toBeGreaterThan(1)
    for (const l of lines) expect(String(l.text ?? '').length, 'each line fits').toBeLessThanOrEqual(42)
    await ui.unmount()

    // 15 steps: finished ones fold away until asked for.
    const many = Array.from({ length: 15 }, (_, i) => ({ text: `Step ${i + 1}`, status: i < 8 ? 'completed' : 'pending' }))
    s.files[PLAN_FILE] = JSON.stringify({ title: '', steps: many, updatedAt: '2026-10-16T10:00:00.000Z' })
    await s.clock.advance(2500)
    await caller($)({ tool: 'Read', tool_use_id: id(), file_path: `${HOME}/x/b.md` })
    await s.clock.settle()
    const ui2 = await mountPane($, surface)
    expect(await ui2.find({ type: 'Text', text: /^Step 1$/ }), 'done steps hidden').toBeUndefined()
    expect(await ui2.find({ type: 'Text', text: /^Step 9$/ })).toBeDefined()
    expect(await ui2.find({ key: 'todo-done' }), 'a button to show them').toBeDefined()
    await ui2.press({ key: 'todo-done' })
    expect(await ui2.find({ type: 'Text', text: /^Step 1$/ }), 'shown again').toBeDefined()
  })

  test(`the plan tool of a helper mod fills the list; helpers' own plans do not (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on)
    await start($, surface, s.clock)
    const call = caller($)
    await call({ tool: 'mcp__helper-desk__plan', tool_use_id: id(), title: 'Launch', steps: [{ text: 'Draft', status: 'in_progress' }, { text: 'Send' }] })
    await call({ tool: 'TodoWrite', tool_use_id: id(), agentId: 'a1', todos: [{ content: 'Helper step', status: 'pending', activeForm: 'x' }] })
    await s.clock.settle()
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: /Launch/ })).toBeDefined()
    expect(await ui.find({ text: /^Draft$/ })).toBeDefined()
    expect(await ui.find({ text: /Helper step/ }), 'a helper cannot replace the chat plan').toBeUndefined()
    expect(await ui.find({ key: 'c:helperdesk' }), 'the plan tool is no connector').toBeUndefined()
  })

  test(`an empty chat shows one dim line for the to-do list and None used yet (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on)
    await start($, surface, s.clock)
    const ui = await mountPane($, surface)
    const empty = await ui.find({ type: 'Text', text: /^No to-do list yet\./ })
    expect(empty?.props.dimColor).toBe(true)
    expect(await ui.find({ text: /None used yet/ })).toBeDefined()
    expect(await ui.find({ text: /of \d+$/ }), 'no count without a plan').toBeUndefined()
    expect(s.opened, 'nothing used, so no pane opened by itself').not.toContain('chat-inventory')
  })
}

for (const surface of SURFACES) {
  test(`switched off in switches.json: nothing is counted or drawn, and it comes back on (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on, { files: { [SW]: JSON.stringify({ 'chat-inventory': false, other: 1 }) } })
    await start($, surface, s.clock)
    const call = caller($)
    const ran = await call({ tool: `${GMAIL}search_threads`, tool_use_id: id(), query: 'offer' })
    await s.clock.settle()
    expect(ran.result, 'the call itself is untouched').toBe('ok')
    expect(s.opened, 'no pane opens by itself').not.toContain('chat-inventory')
    expect(s.opened, 'an open pane is closed').toContain('closed:chat-inventory')
    const said = (await $.command.run({ command: 'inventory', args: '' } as never)) as { text?: string }
    expect(said.text ?? '').toContain('is off')
    expect(s.opened.filter(x => x === 'chat-inventory').length, '/inventory does not open it while off').toBe(0)
    const ui = await mountPane($, surface)
    expect(await ui.find({ text: /Connectors|Gmail|Skills|To-do/ }), 'nothing of its own').toBeUndefined()
    expect(await ui.find({ text: /Turned off/ }), 'one off line').toBeDefined()
    await ui.unmount()

    // Switched on again: counting resumes and an open request opens the pane.
    s.files[SW] = JSON.stringify({ other: 1 })
    s.files[`${HOME}/.claude/claude-mods/.open-chat-inventory-${SID}`] = ''
    await s.clock.advance(1500)
    await call({ tool: `${GMAIL}search_threads`, tool_use_id: id(), query: 'again' })
    await s.clock.settle()
    expect(s.opened, 'the pane opened').toContain('chat-inventory')
    expect(s.runs.some(r => r[0] === 'rm'), 'the request file was removed').toBe(true)
    expect(Object.keys(s.files)).not.toContain(`${HOME}/.claude/claude-mods/.open-chat-inventory-${SID}`)
    const ui2 = await mountPane($, surface)
    expect(await ui2.find({ key: 'c:gmail' }), 'the first call was not counted, the second was').toBeDefined()
    expect(await ui2.find({ text: /1 call/ })).toBeDefined()
    expect(JSON.parse(s.files[SW]!), 'the switch file was not touched').toEqual({ other: 1 })
  })

  test(`a broken or missing switch file means on (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on, { files: { [SW]: '{not json' } })
    await start($, surface, s.clock)
    await caller($)({ tool: `${GMAIL}search_threads`, tool_use_id: id() })
    await s.clock.settle()
    expect(s.opened).toContain('chat-inventory')
    expect(await (await mountPane($, surface)).find({ key: 'c:gmail' })).toBeDefined()
  })

  test(`Hide writes a flag next to the other switches, closes the pane and stops auto-open (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on, { files: { [SW]: JSON.stringify({ 'brain-dump': false }) } })
    await start($, surface, s.clock)
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'hide' }), 'a Hide button').toBeDefined()
    await ui.press({ key: 'hide' })
    await s.clock.settle()
    expect(JSON.parse(s.files[SW]!), 'flag written, other keys kept').toEqual({ 'brain-dump': false, 'chat-inventory:hidden': true })
    expect(s.opened, 'the pane closed').toContain('closed:chat-inventory')
    expect(s.toasts.join(' ')).toContain('/inventory')
    await caller($)({ tool: `${GMAIL}search_threads`, tool_use_id: id() })
    await s.clock.settle()
    expect(s.opened.filter(x => x === 'chat-inventory').length, 'no auto-open while hidden').toBe(0)

    // /inventory shows it again and clears the flag.
    const said = (await $.command.run({ command: 'inventory', args: '' } as never)) as { text?: string }
    expect(said.text ?? '').toContain('Opened')
    expect(JSON.parse(s.files[SW]!), '/inventory clears the flag').toEqual({ 'brain-dump': false })
    expect(s.opened).toContain('chat-inventory')
    // /inventory hide hides it from the keyboard.
    await $.command.run({ command: 'inventory', args: 'hide' } as never)
    expect(JSON.parse(s.files[SW]!)['chat-inventory:hidden']).toBe(true)
  })

  test(`the pane opens by itself once; the setting can stop it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on)
    await start($, surface, s.clock)
    const call = caller($)
    await call({ tool: `${GMAIL}search_threads`, tool_use_id: id() })
    await call({ tool: `${GMAIL}search_threads`, tool_use_id: id() })
    await call({ tool: 'Read', tool_use_id: id(), file_path: `${HOME}/a.md` })
    await s.clock.settle()
    expect(s.opened.filter(x => x === 'chat-inventory').length, 'once only').toBe(1)
  })
}

for (const surface of SURFACES) {
  test(`a /clear starts the inventory again; a resumed chat is counted once (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    let sid = SID
    const history = [
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'old1', tool: `${GMAIL}search_threads`, input: { query: 'old' } }] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'old2', tool: 'Read', input: { file_path: `${HOME}/old/notes.md` } }] },
      { role: 'user', text: '<command-name>/video-prep</command-name>', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'old3', tool: 'Agent', input: {}, agentId: 'ag1' }] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'old4', tool: 'TaskCreate', input: { subject: 'Resumed step', description: 'd' }, result: { task: { id: '7', subject: 'Resumed step' } } }],
      },
    ]
    const child = [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'kid1', tool: `${FIREFLIES}fireflies_search`, input: { query: 'kid' } }] }]
    let messages: unknown[] = history
    const s = setup(on, { sid: () => sid, messages: a => (a === 'ag1' ? child : messages) })
    await start($, surface, s.clock)
    await s.clock.settle()
    expect(s.opened, 'a resumed chat does not pop the pane open again').not.toContain('chat-inventory')

    const countOf = async () => {
      const ui = await mountPane($, surface)
      const text = [
        (await ui.find({ key: 'c:gmail' })) ? 'gmail' : '',
        (await ui.find({ key: 'c:fireflies' })) ? 'fireflies' : '',
        (await ui.find({ text: /notes\.md/ })) ? 'notes' : '',
        (await ui.find({ text: /Resumed step/ })) ? 'step' : '',
        (await ui.find({ text: /video-prep/ })) ? 'skill' : '',
      ]
      const calls = await ui.findAll({ type: 'Text', text: /^1 call$/ })
      await ui.unmount()
      return { text: text.filter(Boolean).join(' '), oneCall: calls.length }
    }
    const first = await countOf()
    expect(first.text, 'history, helper calls, the plan and the typed skill').toBe('gmail fireflies notes step skill')

    // The module loads again (a reload, or a second start) over the same chat: nothing counts twice.
    await start($, surface, s.clock)
    await caller($)({ tool: `${GMAIL}search_threads`, tool_use_id: 'old1', query: 'old' })
    await s.clock.settle()
    const ui = await mountPane($, surface)
    await ui.press({ key: 'c:gmail' })
    expect(await ui.find({ type: 'Text', text: /^1$/ }), 'Gmail still has one call').toBeDefined()
    expect(await ui.find({ text: /^0 of 1$/ }), 'one resumed step, not two').toBeDefined()
    expect(await ui.find({ text: /^1 use$/ }), 'the typed skill counted once').toBeDefined()
    await ui.unmount()

    // /clear: the chat ends with reason clear, the process goes on under a new id.
    await $.session.end({ reason: 'clear', sessionId: SID, resume: {} } as never)
    messages = []
    sid = 'sid-2'
    await s.clock.settle()
    const ui2 = await mountPane($, surface)
    expect(await ui2.find({ key: 'c:gmail' }), 'the old calls are gone').toBeUndefined()
    expect(await ui2.find({ text: /notes\.md/ })).toBeUndefined()
    expect(await ui2.find({ text: /No to-do list yet/ })).toBeDefined()
    await ui2.unmount()
    await caller($)({ tool: `${GMAIL}search_threads`, tool_use_id: id(), query: 'fresh' })
    await s.clock.settle()
    const ui3 = await mountPane($, surface)
    expect(await ui3.find({ type: 'Text', text: /1 call$/ }), 'a new chat counts from one').toBeDefined()
    expect(s.files[LOG] ?? '', 'the reset is logged').toContain('reset')
  })

  test(`a changed chat id without a session.end still starts again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    let sid = SID
    const s = setup(on, { sid: () => sid })
    await start($, surface, s.clock)
    const call = caller($)
    await call({ tool: `${GMAIL}search_threads`, tool_use_id: id() })
    await call({ tool: `${GMAIL}search_threads`, tool_use_id: id() })
    sid = 'sid-9'
    await call({ tool: `${FIREFLIES}fireflies_search`, tool_use_id: id() })
    await s.clock.settle()
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'c:gmail' }), 'the other chat is gone').toBeUndefined()
    expect(await ui.find({ key: 'c:fireflies' })).toBeDefined()
  })
}

for (const surface of SURFACES) {
  test(`Copy puts the inventory on the clipboard as text; /inventory copy does too (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on)
    await start($, surface, s.clock)
    const call = caller($)
    await call({ tool: `${GMAIL}search_threads`, tool_use_id: id(), query: 'offer' })
    await call({ tool: `${GMAIL}get_thread`, tool_use_id: id(), threadId: 'a' })
    await call({ tool: 'Read', tool_use_id: id(), file_path: `${HOME}/x/offer.md` })
    await call({ tool: 'Skill', tool_use_id: id(), skill: 'video-prep' })
    await call({ tool: 'TodoWrite', tool_use_id: id(), todos: [{ content: 'Do it', status: 'completed', activeForm: 'Doing it' }] })
    await s.clock.settle()
    const ui = await mountPane($, surface)
    await ui.press({ key: 'copy' })
    await s.clock.settle()
    const text = s.copied[0] ?? ''
    expect(text).toContain('In this chat')
    expect(text).toContain('Gmail: 2 calls')
    expect(text).toContain('search threads x1')
    expect(text).toContain('~/x/offer.md (read)')
    expect(text).toContain('/video-prep (1 use)')
    expect(text).toContain('[x] Do it')
    expect(text).toContain('~/vault/CLAUDE.md (loaded at start)')
    expect(s.toasts.join(' ')).toContain('Copied')
    expect(text, 'the queries are not in the copy').not.toContain('offer\n')
    const said = (await $.command.run({ command: 'inventory', args: 'copy' } as never)) as { text?: string }
    expect(said.text ?? '').toContain('Copied')
    expect(s.copied.length).toBe(2)
  })

  for (const copy of [false, 'throw'] as const) {
    test(`when the clipboard is out of reach (${String(copy)}) the list is printed in the chat (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const s = setup(on, { copy })
      await start($, surface, s.clock)
      await caller($)({ tool: `${GMAIL}search_threads`, tool_use_id: id() })
      await s.clock.settle()
      const ui = await mountPane($, surface)
      await ui.press({ key: 'copy' })
      await s.clock.settle()
      expect(s.logged.join('\n'), 'printed to copy by hand').toContain('Gmail: 1 call')
      expect(s.toasts.join(' ')).toContain('clipboard')
      expect(s.files[LOG] ?? '', 'the failure is logged').toContain('copy')
      const said = (await $.command.run({ command: 'inventory', args: 'copy' } as never)) as { text?: string }
      expect(said.text ?? '', 'the command says where the list went').toContain('printed above')
    })
  }

  test(`calls that were refused are not counted; secrets are never shown or logged (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const s = setup(on, { answer: e => (e.query === 'blocked' ? { deny: 'no' } : { result: 'ok' }) })
    await start($, surface, s.clock)
    const call = caller($)
    await call({ tool: `${GMAIL}search_threads`, tool_use_id: id(), query: 'blocked' })
    await call({ tool: `${FIREFLIES}fireflies_login`, tool_use_id: id(), password: 'hunter2', api_token: 'abc123secret' })
    await call({ tool: `${FIREFLIES}fireflies_lookup`, tool_use_id: id(), query: FAKE_SK })
    await s.clock.settle()
    const ui = await mountPane($, surface)
    expect(await ui.find({ key: 'c:gmail' }), 'a refused call did not happen').toBeUndefined()
    await ui.press({ key: 'c:fireflies' })
    expect(await ui.find({ text: /hunter2|abc123secret|sk-live/ }), 'no secret on screen').toBeUndefined()
    await $.command.run({ command: 'inventory', args: 'hide' } as never)
    expect(s.files[LOG] ?? '', 'the log has no secrets or queries').not.toMatch(/hunter2|abc123|sk-live|blocked/)
  })
}

test('fail open: a broken disk, chat id, context or transcript never changes a tool call', { timeoutMs: 30000 }, async ($, on) => {
  let idFails = false
  const s = setup(on, { failRead: true, failUsage: true, failMessages: true, sid: () => {
    if (idFails) throw new Error('no id')
    return SID
  } })
  await start($, 'desktop', s.clock)
  const call = caller($)
  const ran = await call({ tool: `${GMAIL}search_threads`, tool_use_id: id(), query: 'x' })
  expect(ran.result, 'the result is the engine result, untouched').toBe('ok')
  idFails = true
  const again = await call({ tool: 'Read', tool_use_id: id(), file_path: `${HOME}/a.md` })
  expect(again.result).toBe('ok')
  const said = (await $.command.run({ command: 'inventory', args: '' } as never)) as { text?: string }
  expect(typeof said.text).toBe('string')
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ text: /Connectors/ }), 'the pane still draws').toBeDefined()
})

test('fail open: a bad plan file or bad input does not stop counting', { timeoutMs: 30000 }, async ($, on) => {
  const s = setup(on, { files: { [PLAN_FILE]: '{ broken' } })
  await start($, 'terminal', s.clock)
  const call = caller($)
  await call({ tool: 'Bash', tool_use_id: id(), command: 42 })
  await call({ tool: 'Read', tool_use_id: id() })
  await call({ tool: 'Skill', tool_use_id: id(), skill: 7 })
  await call({ tool: 'TodoWrite', tool_use_id: id(), todos: 'nope' })
  const ran = await call({ tool: `${GMAIL}search_threads`, tool_use_id: id() })
  await s.clock.settle()
  expect(ran.result).toBe('ok')
  expect(await (await mountPane($, 'terminal')).find({ key: 'c:gmail' })).toBeDefined()
  expect(s.files[LOG] ?? '', 'the bad plan file is logged').toContain('plan file')
})

test('the log keeps its own lines only, newest 300, and an unreadable home turns logging off quietly', { timeoutMs: 30000 }, async ($, on) => {
  const old = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
  const s = setup(on, { files: { [LOG]: old } })
  await start($, 'desktop', s.clock)
  await $.command.run({ command: 'inventory', args: 'hide' } as never)
  const lines = (s.files[LOG] ?? '').split('\n').filter(Boolean)
  expect(lines.length).toBeLessThanOrEqual(300)
  expect(lines[lines.length - 1]).toContain('hidden')
  expect(lines[lines.length - 1]).toMatch(/^2026-10-16T09:00:00\.000Z /)
})
