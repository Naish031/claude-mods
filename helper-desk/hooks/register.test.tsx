import { expect, mock, test } from 'claude-code/testing'

import { connectorName } from './connectors'
import { describe, describeMain } from './describe'
import { openMode, scrub, shortModel, summaryOf, workTokens } from './lib'
import { applyTaskTool, mergePlan, nowLine, readPlanFile, readTodos, readToolInput, toStatus } from './plan'

/** The `on` a test body is handed. */
type On = Parameters<NonNullable<Parameters<typeof test>[2]>>[1]
type Agent = { id: string; description: string; type: string; status: string }
type Files = Record<string, string>
type Rig = ReturnType<typeof rig>

const HOME = '/Users/test'
const SWITCHES = `${HOME}/.claude/claude-mods/switches.json`
const LOG = `${HOME}/.claude/claude-mods/logs/helper-desk.log`
const OPEN = `${HOME}/.claude/claude-mods/.open-helper-desk-sess1`
const PLAN_FILE = `${HOME}/.claude/claude-mods/state/plan-sess1.json`

/** Each tool spec the mod registered. */
let specs: { name?: string; isDeferred?: boolean }[] = []

type Faults = { read?: boolean; write?: boolean; usage?: boolean; list?: boolean; open?: boolean; env?: boolean }

/** Answers every `$` call the mod makes, so a test sees only the mod: `files` stands in for the disk. */
function rig(on: On, files: Files, faults: Faults = {}) {
  const ids = Array.from({ length: 16 }, (_, i) => `agent-a${i + 1}`)
  const agents: Agent[] = []
  const opened: string[] = []
  const closed: string[] = []
  const ran: string[][] = []
  const toasts: string[] = []
  const statuses: unknown[] = []
  // A test holds a tool call open by naming its tool here; releasing the promise lets it finish.
  const holds: Record<string, Promise<unknown>> = {}
  // How often the mod looked at switches.json: it does so on every clock tick, so this shows a running timer.
  const looks = { n: 0 }

  on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.id', async () => ({ value: 'sess1' }) as never)
  on('session.usage', async () => {
    if (faults.usage) throw new Error('no ledger')
    return { value: { startedAt: 0, context: {}, rateLimits: [], cost: { usd: 0.42 } } } as never
  })
  on('command.register', async () => ({ value: undefined }) as never)
  on('tool.register', async (_$, e) => {
    specs.push(e as { name?: string; isDeferred?: boolean })
    return { value: { tool: 'mcp__helper-desk__plan' } } as never
  })
  const clock = mock.clock(on, { now: 1_000_000 })
  if (!faults.env) mock.env(on, { HOME })
  on('agent.spawn', async (_$, e) => {
    const { description, subagentType } = e as { description: string; subagentType: string }
    const id = ids[agents.length]!
    agents.push({ id, description, type: subagentType, status: 'running' })
    return { model: 'claude-opus-5-5', agentId: id } as never
  })
  on('agent.list', async () => {
    if (faults.list) throw new Error('list failed')
    return { value: agents.map(a => ({ ...a })) } as never
  })
  on('ui.open', async (_$, e) => {
    if (faults.open) throw new Error('no room')
    opened.push((e as { id: string }).id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', async (_$, e) => {
    closed.push((e as { id: string }).id)
    return { value: undefined } as never
  })
  on('ui.status', async (_$, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('ui.toast', async (_$, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  let taskN = 0
  on('tool.call', async (_$, e) => {
    // A TaskCreate answers with the new task's id, as the engine does.
    if ((e as { tool: string }).tool === 'TaskCreate') return { result: { task: { id: `task-${(taskN += 1)}`, subject: 'x' } } } as never
    await holds[(e as { tool: string }).tool]
    return { result: 'ok' } as never
  })
  // A model turn of the main chat begins.
  on('turn.start', async (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  // Beneath the plugins a pane nobody draws is empty.
  on('ui.render', async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return (<Box />) as never
  })
  on('turn.complete', async () => ({ text: '' }) as never)
  on('session.end', async () => ({ sessionId: 'sess1' }) as never)
  const submitted: string[] = []
  on('prompt.submit', async (_$, e) => {
    const text = String((e as { text: string }).text)
    submitted.push(text)
    return { text } as never
  })
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'hello', scope: 'shared' }] }) as never)
  on('fs.exists', async (_$, e) => {
    if ((e as { path: string }).path === SWITCHES) looks.n += 1
    return { value: (e as { path: string }).path in files } as never
  })
  on('fs.read', async (_$, e) => {
    if (faults.read) throw new Error('disk gone')
    const path = (e as { path: string }).path
    return { value: files[path] ?? '' } as never
  })
  on('fs.write', async (_$, e) => {
    if (faults.write) throw new Error('disk full')
    const { path, text } = e as { path: string; text: string }
    files[path] = text
    return { value: undefined } as never
  })
  on('process.run', async (_$, e) => {
    const argv = (e as { argv?: string[] }).argv ?? []
    ran.push(argv)
    if (argv[0] === 'rm') delete files[argv[argv.length - 1]!]
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  return { agents, opened, closed, ran, clock, toasts, statuses, files, submitted, holds, looks }
}

type Surface = 'desktop' | 'terminal'
type View = { find: (q: object) => Promise<any>; findAll: (q: object) => Promise<any[]> }
const start = ($: any, surface: Surface) => $.session.start({ cwd: '/Users/test/vault', surface, isInteractive: true } as never)
const callTool = ($: any) => $.tool.call as unknown as (input: unknown) => Promise<{ result?: unknown; context?: string[]; deny?: string }>
const spawn = ($: any, description: string, n: number, subagentType = 'general-purpose', model?: string) =>
  $.agent.spawn({ tool_use_id: `spawn${n}`, prompt: 'Do the job.', description, subagentType, ...(model ? { model } : {}) } as never)

const paneProps = (bodyColumns = 60) => ({ title: 'Helpers', isFocused: false, bodyColumns, placement: 'dock', scroll: {}, view: {} }) as never
const bandProps = (bodyColumns = 80) => ({ isWorking: true, hasSurvey: false, maxRows: 20, bodyColumns, scroll: {}, view: {} }) as never
type Mounted = View & { press: (q: { key: string }) => Promise<unknown>; unmount: () => Promise<unknown> }
const pane = ($: any, surface: Surface, cols = 60): Promise<Mounted> => $.ui.mount({ plugin: 'helper-desk', surface, component: 'Pane', requestId: 'helpers', props: paneProps(cols) })
const band = ($: any, surface: Surface, cols = 80): Promise<Mounted> => $.ui.mount({ plugin: 'helper-desk', surface, component: 'AbovePrompt', props: bandProps(cols) })

/** What the band says: the picture's alt text on desktop, every text on the terminal. */
async function bandSays(v: View, surface: Surface) {
  if (surface === 'desktop') {
    const svg = await v.find({ type: 'Svg' })
    return svg ? String(svg.props.alt) : ''
  }
  return (await v.findAll({ type: 'Text' })).map(t => t.text).join(' ')
}

const steps4 = (done: number, live: boolean) =>
  ['Read the brief', 'Draft the outline', 'Build the slides', 'Check the deck'].map((text, i) => ({
    text,
    status: i < done ? 'completed' : i === done && live ? 'in_progress' : 'pending',
  }))

const todos3 = [
  { content: 'Pull the numbers', status: 'completed', activeForm: 'Pulling the numbers' },
  { content: 'Write the summary', status: 'in_progress', activeForm: 'Writing the summary' },
  { content: 'Send the link', status: 'pending', activeForm: 'Sending the link' },
]

const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 30000, cache_creation_input_tokens: 2000, model: 'claude-opus-5-5' }
const compose = async ($: any, tools: string[], traits: string[] = []) =>
  (await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['desktop'], tools, outputStyle: null, traits } as never)).sections as { id: string; text: string }[]
const done = ($: any, id: string, extra: object = {}) =>
  $.turn.complete({ answer: 'ok', agentId: id, reason: 'answer', durationMs: 1, isAborted: false, turnId: `t-${id}`, ...extra } as never)

for (const surface of ['desktop', 'terminal'] as const) {
  // ---------- The side pane ----------

  test(`two helpers get live cards, then both finish (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { agents, opened, clock, statuses } = rig(on, {})
    await start($, surface)
    await spawn($, 'Read the research notes', 1, 'Explore', 'haiku')
    await spawn($, 'Find invoice threads', 2, 'general-purpose', 'opus')
    await clock.settle()
    expect(opened, 'pane opened by itself').toContain('helpers')

    const call = callTool($)
    await call({ tool: 'Read', tool_use_id: 'c1', file_path: '/Users/test/vault/research.md', agentId: 'agent-a1' })
    await call({ tool: 'mcp__00000000-0000-0000-0000-00000000000a__search_threads', tool_use_id: 'c2', query: 'invoice', agentId: 'agent-a2' })
    await clock.advance(5_000)

    const v = await pane($, surface)
    expect(await v.find({ text: /Read the research notes/ }), 'first description').toBeDefined()
    expect(await v.find({ text: /Find invoice threads/ }), 'second description').toBeDefined()
    expect(await v.find({ text: /Step 1 · Reading research\.md/ }), 'a Read in words').toBeDefined()
    expect(await v.find({ text: /Gmail: search threads/ }), 'a Gmail connector in words').toBeDefined()
    expect(await v.find({ type: 'Text', text: /^Running · 2\s*$/ }), 'Running heading with its count').toBeDefined()
    expect((await v.find({ key: 'head-running' }))?.props.backgroundColor, 'Running sits in a themed box').toBe('success')
    // The agent type is a tag beside the title, the model sits after it.
    expect(await v.find({ type: 'Text', text: /^\s*Explore\s*$/ }), 'type as a tag').toBeDefined()
    expect(await v.find({ type: 'Text', text: /^\s*Haiku\s*$/ }), 'model beside it').toBeDefined()
    expect(await v.find({ text: /^Time$/ }), 'time tile').toBeDefined()
    expect(await v.find({ type: 'Text', text: /^Total chat cost$/ }), 'cost label').toBeDefined()
    expect(await v.find({ text: /\$0\.42/ }), 'chat cost from the engine').toBeDefined()
    expect(await v.find({ text: /^Subagent tokens$/ }), 'no tokens tile before any usage').toBeUndefined()
    expect(statuses.length, 'the footer status line is never used').toBe(0)

    await done($, 'agent-a1', { usage })
    await clock.settle()
    expect(await v.find({ type: 'Text', text: /^Finished · 1\s*$/ }), 'Finished heading').toBeDefined()
    expect((await v.find({ key: 'head-finished' }))?.props.backgroundColor, 'Finished sits in a themed box').toBe('warning')
    expect(await v.find({ text: /^Subagent tokens$/ }), 'tokens tile once usage arrives').toBeDefined()
    // Work tokens leave out cache reads: 1000 + 500 + 2000.
    expect(await v.find({ text: /4k tokens/ }), 'card tokens leave cache reads out').toBeDefined()

    // The 2 s poll sees the second helper finish from $.agent.list().
    agents[1]!.status = 'completed'
    await clock.advance(2_100)
    expect(await v.find({ type: 'Text', text: /^Finished · 2\s*$/ }), 'both finished by the poll').toBeDefined()
    expect(await v.find({ key: 'head-running' }), 'running group gone').toBeUndefined()
  })

  test(`a helper that is stopped says why (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock } = rig(on, {})
    await start($, surface)
    await spawn($, 'Try the long job', 1)
    await spawn($, 'Try the other job', 2)
    await spawn($, 'Try the third job', 3)
    await clock.settle()
    await done($, 'agent-a1', { reason: 'aborted', isAborted: true })
    await done($, 'agent-a2', { reason: 'error' })
    await done($, 'agent-a3', { reason: 'refusal', refusal: { category: null, explanation: null } })
    await clock.settle()
    const v = await pane($, surface, 70)
    expect(await v.find({ type: 'Text', text: /^Stopped · 3\s*$/ }), 'Stopped group').toBeDefined()
    expect(await v.find({ text: /You stopped it · 0 steps/ }), 'aborted by you').toBeDefined()
    expect(await v.find({ text: /It hit an error/ }), 'an error').toBeDefined()
    expect(await v.find({ text: /The model declined/ }), 'a refusal').toBeDefined()
  })

  test(`each helper gets its own crab; only running crabs move (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock } = rig(on, {})
    await start($, surface)
    await spawn($, 'Build the landing page', 1)
    await spawn($, 'Design the graphics', 2)
    await clock.settle()
    const v = await pane($, surface)
    if (surface === 'terminal') {
      const tops = await v.findAll({ type: 'Text', text: /^ (▟█▙|▜█▛)$/ })
      expect(tops, 'two glyph crabs').toHaveLength(2)
      expect(tops[0]!.props.color !== tops[1]!.props.color, 'different colours').toBe(true)
      expect(await v.findAll({ type: 'Svg' }), 'no Svg on the terminal').toHaveLength(0)
      const before = tops[0]!.text
      await clock.advance(600)
      expect((await v.findAll({ type: 'Text', text: /^ (▟█▙|▜█▛)$/ }))[0]!.text !== before, 'a running glyph crab moves').toBe(true)
      return
    }
    const crabs = async () => (await v.findAll({ type: 'Svg' })).filter(p => String(p.props.alt).startsWith('Claude crab'))
    const [a, b] = await crabs()
    expect(String(a!.props.source).startsWith('<svg'), 'an svg document').toBe(true)
    expect(String(a!.props.source).includes('#dc2626'), 'first crab is red').toBe(true)
    expect(String(b!.props.source).includes('#ea580c'), 'second crab is orange').toBe(true)
    expect(String(a!.props.source).length < 131072, 'under the Svg limit').toBe(true)
    expect(String(a!.props.alt), 'alt names the colour').toBe('Claude crab, red')
    const frames = new Set<string>()
    for (let i = 0; i < 4; i += 1) {
      frames.add(String((await crabs())[0]!.props.source))
      await clock.advance(600)
    }
    expect(frames.size >= 2, 'a running crab cycles through frames').toBe(true)

    await done($, 'agent-a1')
    await clock.settle()
    const still = async () => String((await crabs()).find(p => String(p.props.alt).endsWith('red'))?.props.source)
    const first = await still()
    await clock.advance(1200)
    expect(await still(), 'a finished crab stands still').toBe(first)
  })

  test(`a new helper never takes a running helper's colour (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock } = rig(on, {})
    await start($, surface)
    await spawn($, 'One', 1)
    await spawn($, 'Two', 2)
    await clock.settle()
    const v = await pane($, surface)
    const colours = async () =>
      surface === 'terminal'
        ? (await v.findAll({ type: 'Text', text: /^ (▟█▙|▜█▛)$/ })).map(t => String(t.props.color))
        : (await v.findAll({ type: 'Svg' })).filter(p => String(p.props.alt).startsWith('Claude crab')).map(p => String(p.props.alt).replace('Claude crab, ', ''))
    expect(new Set(await colours()).size, 'two colours').toBe(2)
    await done($, 'agent-a1')
    await spawn($, 'Three', 3)
    await clock.settle()
    const all = await colours()
    expect(all, 'three crabs').toHaveLength(3)
    expect(new Set(all).size, 'three colours').toBe(3)
    if (surface === 'desktop') expect(all, 'third is yellow').toContain('yellow')
  })

  test(`a card's toggle shows its full step list (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock } = rig(on, {})
    await start($, surface)
    await spawn($, 'Prep the video', 1)
    await clock.settle()
    const calls = [
      { tool: 'Read', file_path: '/Users/test/vault/YouTube/videos/mods/pre-outline.md' },
      { tool: 'Bash', command: 'ls -la /tmp', description: 'List the temp folder' },
      { tool: 'mcp__00000000-0000-0000-0000-00000000000b__list_recent_files' },
      { tool: 'Skill', skill: 'video-prep' },
      { tool: 'WebFetch', url: 'https://docs.example.com/page', prompt: 'read' },
      { tool: 'Write', file_path: '/Users/test/vault/YouTube/videos/mods/research.md', content: 'x' },
    ]
    let n = 0
    for (const c of calls) await callTool($)({ ...c, tool_use_id: `c${(n += 1)}`, agentId: 'agent-a1' })
    await clock.advance(1_000)
    const v = await pane($, surface, 70)
    expect(await v.find({ text: /Step 6 · Writing research\.md/ }), 'live line').toBeDefined()
    expect(await v.find({ text: /Opening docs\.example\.com/ }), 'last steps under the live line').toBeDefined()
    expect(await v.find({ text: /pre-outline\.md/ }), 'collapsed hides older steps').toBeUndefined()
    expect((await v.find({ key: 'steps-agent-a1' }))?.text ?? '').toContain('All 6 steps')

    await v.press({ key: 'steps-agent-a1' })
    expect((await v.find({ key: 'steps-agent-a1' }))?.text ?? '').toContain('Hide steps')
    expect(await v.find({ text: /^File read$/ }), 'kind tag').toBeDefined()
    expect(await v.find({ text: /^pre-outline\.md/ }), 'first step listed').toBeDefined()
    expect(await v.find({ text: /~\/vault\/YouTube\/videos\/mods/ }), 'folder in dim text, home as ~').toBeDefined()
    expect(await v.find({ text: /^List the temp folder/ }), 'command by its description').toBeDefined()
    expect(await v.find({ text: /^Google Drive · list recent files/ }), 'connector name and tool').toBeDefined()
    expect(await v.find({ text: /^video-prep/ }), 'skill name').toBeDefined()
    expect(await v.find({ text: /^docs\.example\.com/ }), 'web host').toBeDefined()
    expect(await v.find({ text: /^File write$/ }), 'write tag').toBeDefined()
    await v.press({ key: 'steps-agent-a1' })
    expect(await v.find({ text: /^File read$/ }), 'closed again').toBeUndefined()
  })

  test(`a long list shows five finished cards, Show more, and Clear finished (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const { clock } = rig(on, {})
    await start($, surface)
    for (let i = 1; i <= 8; i += 1) await spawn($, `Job number ${i}`, i)
    await clock.settle()
    for (let i = 1; i <= 7; i += 1) {
      await clock.advance(10)
      await done($, `agent-a${i}`)
    }
    await clock.settle()
    const v = await pane($, surface, 70)
    expect(await v.find({ type: 'Text', text: /^Finished · 7\s*$/ }), 'all seven counted').toBeDefined()
    expect(await v.find({ text: /Job number 7/ }), 'the newest shows').toBeDefined()
    // The Recent list names the last ten, so the held-back card is found by its key, not by its words.
    expect(await v.find({ key: 'card-agent-a1' }), 'the oldest card is held back').toBeUndefined()
    expect(await v.find({ key: 'card-agent-a7' }), 'the newest card shows').toBeDefined()
    expect((await v.find({ key: 'more-finished' }))?.text ?? '').toContain('Show 2 more')
    await v.press({ key: 'more-finished' })
    expect(await v.find({ key: 'card-agent-a1' }), 'Show more reveals it').toBeDefined()
    expect((await v.find({ key: 'more-finished' }))?.text ?? '').toContain('Show fewer')

    await v.press({ key: 'clear' })
    await clock.settle()
    expect(await v.find({ key: 'head-finished' }), 'finished cards cleared').toBeUndefined()
    expect(await v.find({ text: /Job number 8/ }), 'the running one stays').toBeDefined()
    // A group folds on its arrow.
    await v.press({ key: 'group-running' })
    expect(await v.find({ text: /Job number 8/ }), 'folded').toBeUndefined()
  })

  test(`with animations off the pane is still (${surface})`, { timeoutMs: 30000, options: { animations: false } }, async ($, on) => {
    const { clock } = rig(on, {})
    await start($, surface)
    await spawn($, 'Build the page', 1)
    await clock.settle()
    const v = await pane($, surface)
    if (surface === 'desktop') {
      const bar = (await v.findAll({ type: 'Svg' })).find(b => b.props.alt === 'Working')!
      expect(String(bar.props.source), 'no keyframes').not.toContain('@keyframes mv')
      expect(String(bar.props.source), 'no sparkles').not.toContain('twinkle')
    }
    const read = async () => (await v.findAll({ type: 'Text' })).map(t => t.text).join('|')
    const before = await read()
    await clock.advance(700)
    expect((await read()).replace(/\d+:\d\d/g, ''), 'nothing moves between ticks').toBe(before.replace(/\d+:\d\d/g, ''))
  })

  test(`each card has one thick bar, and a finished helper revives on new work (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock } = rig(on, {})
    await start($, surface)
    await spawn($, 'Build the landing page', 1)
    await clock.settle()
    const v = await pane($, surface)
    expect(await v.find({ text: /[─━]/ }), 'no thin two-line bar').toBeUndefined()
    if (surface === 'desktop') {
      const bars = (await v.findAll({ type: 'Svg' })).filter(b => b.props.alt === 'Working')
      expect(bars, 'one bar for the card').toHaveLength(1)
      expect(bars[0]!.props.height, 'thick').toBe(10)
      expect(bars[0]!.props.source, 'sparkles twinkle').toContain('@keyframes tw')
    } else {
      expect(await v.find({ text: /^█+$/ }), 'a piece of thick blocks').toBeDefined()
    }
    await done($, 'agent-a1')
    await clock.settle()
    expect(await v.find({ type: 'Text', text: /^Finished · 1\s*$/ })).toBeDefined()
    // A teammate that picks up work again is working again.
    await callTool($)({ tool: 'Read', tool_use_id: 'c1', file_path: '/x/y.md', agentId: 'agent-a1' })
    await clock.settle()
    expect(await v.find({ type: 'Text', text: /^Running · 1\s*$/ }), 'running again').toBeDefined()
    expect(await v.find({ key: 'head-finished' }), 'no longer finished').toBeUndefined()
  })

  test(`a helper the engine killed says so, and /helpers has words for an empty desk (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock, agents, toasts } = rig(on, {})
    await start($, surface)
    const empty = await $.command.run({ command: 'helpers', args: '' } as never)
    expect(String((empty as { text?: string }).text), 'empty desk').toContain('Cards show up when Claude starts a subagent')
    await spawn($, 'Run the long job', 1)
    await clock.settle()
    agents[0]!.status = 'killed'
    await clock.advance(2_100)
    const v = await pane($, surface, 70)
    expect(await v.find({ text: /It was stopped · 0 steps/ }), 'killed by the engine').toBeDefined()
    const cleared = await $.command.run({ command: 'helpers', args: 'clear' } as never)
    expect(String((cleared as { text?: string }).text)).toContain('Cleared')
    await clock.settle()
    expect(await v.find({ key: 'head-stopped' }), 'cleared').toBeUndefined()
    await v.press({ key: 'hide' })
    expect(toasts.some(x => x.includes('Helper Desk hidden')), 'a hint says how to bring it back').toBe(true)
  })

  // ---------- The switches and hiding ----------

  test(`switches.json false: nothing is drawn, the command says off, an open request is used up (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const files: Files = {}
    const { opened, closed, clock } = rig(on, files)
    await start($, surface)
    await spawn($, 'Build the landing page', 1)
    await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(1, true) })
    await clock.settle()
    const v = await pane($, surface)
    const b = await band($, surface)
    expect(await v.find({ text: /Build the landing page/ }), 'drawn while on').toBeDefined()
    expect(await b.find({ key: 'plan-band' }), 'band while on').toBeDefined()

    files[SWITCHES] = JSON.stringify({ 'helper-desk': false })
    await clock.advance(3_100)
    expect(closed, 'pane closed').toContain('helpers')
    expect(await v.find({ text: /Build the landing page/ }), 'no card').toBeUndefined()
    expect(await v.find({ text: /helper/i }), 'nothing of its own').toBeUndefined()
    expect(await b.find({ key: 'plan-band' }), 'no band').toBeUndefined()
    expect(await b.find({ text: /Tasks|steps/ }), 'band says nothing').toBeUndefined()
    const r = await $.command.run({ command: 'helpers', args: '' } as never)
    expect(String((r as { text?: string }).text), 'command says off').toContain('Helper Desk is off')
    const said = await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p2', steps: steps4(2, true) })
    expect(String(said.result), 'the plan tool says it is off').toContain('off')
    // Other tools pass straight through, with no reminder.
    const plain = await callTool($)({ tool: 'Bash', tool_use_id: 'b1', command: 'ls' })
    expect(plain.context ?? [], 'no reminder while off').toHaveLength(0)

    // An open request is used up but opens nothing while off; on again, it opens.
    const before = opened.length
    files[OPEN] = ''
    await clock.advance(3_100)
    await callTool($)({ tool: 'Bash', tool_use_id: 'b2', command: 'ls' })
    expect(opened.length, 'no open while off').toBe(before)
    expect(OPEN in files, 'request used up while off').toBe(false)
    files[SWITCHES] = '{}'
    files[OPEN] = ''
    await clock.advance(1_100)
    await callTool($)({ tool: 'Bash', tool_use_id: 'b3', command: 'ls' })
    expect(opened.length, 'request answered once on again').toBe(before + 1)
    expect(OPEN in files, 'request file removed').toBe(false)
  })

  test(`a broken or missing switches file means on (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const files: Files = { [SWITCHES]: '{ not json' }
    const { clock } = rig(on, files)
    await start($, surface)
    await spawn($, 'Build the landing page', 1)
    await clock.settle()
    const v = await pane($, surface)
    expect(await v.find({ text: /Build the landing page/ }), 'still on').toBeDefined()
    files[SWITCHES] = '[1,2]'
    await clock.advance(1_200)
    expect(await v.find({ text: /Build the landing page/ }), 'an array is not a switch').toBeDefined()
  })

  test(`Hide writes the shared flag and closes the pane; /helpers shows it again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const files: Files = { [SWITCHES]: JSON.stringify({ 'other-mod': false }) }
    const { opened, closed, clock } = rig(on, files)
    await start($, surface)
    await spawn($, 'Build the landing page', 1)
    await clock.settle()
    expect(opened, 'opened by itself').toContain('helpers')
    const v = await pane($, surface)
    await v.press({ key: 'hide' })
    expect(JSON.parse(files[SWITCHES]!), 'Hide adds its key and keeps the others').toEqual({ 'other-mod': false, 'helper-desk:hidden': true })
    expect(closed, 'the pane closes').toContain('helpers')

    // Hidden: a new round of helpers does not open the pane, and the band stays away.
    const before = opened.length
    await done($, 'agent-a1')
    await spawn($, 'A second job', 2)
    await clock.settle()
    expect(opened.length, 'no auto open while hidden').toBe(before)
    await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(1, true) })
    await clock.settle()
    expect(await (await band($, surface)).find({ key: 'plan-band' }), 'no band while hidden').toBeUndefined()

    const r = await $.command.run({ command: 'helpers', args: '' } as never)
    expect(String((r as { text?: string }).text), 'opened').toContain('Helper Desk opened')
    expect(JSON.parse(files[SWITCHES]!), 'the flag is gone').toEqual({ 'other-mod': false })
    expect(opened.length, 'the pane opened').toBe(before + 1)
    expect(await (await band($, surface)).find({ key: 'plan-band' }), 'band back').toBeDefined()

    await $.command.run({ command: 'helpers', args: 'hide' } as never)
    expect(JSON.parse(files[SWITCHES]!)['helper-desk:hidden'], '/helpers hide').toBe(true)
  })

  test(`hidden at the start: no auto open, an open request shows it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const files: Files = { [SWITCHES]: JSON.stringify({ 'helper-desk:hidden': true }) }
    const { opened, clock } = rig(on, files)
    await start($, surface)
    await spawn($, 'Build the landing page', 1)
    await clock.settle()
    expect(opened, 'no auto open while hidden').not.toContain('helpers')
    files[SWITCHES] = '{}'
    files[OPEN] = ''
    await clock.advance(1_100)
    await callTool($)({ tool: 'Bash', tool_use_id: 'b1', command: 'ls' })
    expect(opened, 'the open request opens it').toContain('helpers')
    expect(await (await pane($, surface)).find({ text: /Build the landing page/ }), 'the card draws').toBeDefined()
  })

  test(`the pane does not open by itself when the setting says no (${surface})`, { timeoutMs: 30000, options: { auto_open_pane: false } }, async ($, on) => {
    const { opened, clock } = rig(on, {})
    await start($, surface)
    await spawn($, 'Build the landing page', 1)
    await clock.settle()
    expect(opened).toHaveLength(0)
    await $.command.run({ command: 'helpers', args: '' } as never)
    expect(opened, '/helpers still opens it').toContain('helpers')
  })

  // ---------- The task bar ----------

  test(`the plan tool writes the plan file and draws "2 of 4" (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const files: Files = {}
    const { clock } = rig(on, files)
    await start($, surface)
    const call = callTool($)
    const said = await call({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', title: 'Make the deck', steps: steps4(2, true) })
    await clock.settle()
    expect(String(said.result), 'tool answer').toBe('Plan saved: 2 of 4 steps done.')
    const saved = JSON.parse(files[PLAN_FILE]!) as { title: string; steps: { text: string; status: string; doneAt?: string }[]; updatedAt: string }
    expect(saved.title).toBe('Make the deck')
    expect(saved.steps.map(st => st.status)).toEqual(['completed', 'completed', 'in_progress', 'pending'])
    expect(typeof saved.steps[0]!.doneAt, 'done steps carry a time').toBe('string')
    expect(typeof saved.updatedAt).toBe('string')

    const v = await band($, surface)
    const says = await bandSays(v, surface)
    expect(says, 'title').toContain('Make the deck')
    expect(says, 'count').toContain('Tasks 2/4')
    expect(says, 'percent').toContain('50%')
    expect(await v.find({ type: 'Text', text: /Now: Build the slides/ }), 'current step beside the title').toBeDefined()
    if (surface === 'desktop') {
      const svg = String((await v.find({ type: 'Svg' }))!.props.source)
      expect(svg, 'purple gradient').toContain('#6d28d9')
      expect(svg, 'sparkles twinkle').toContain('@keyframes tw')
      expect(svg, 'the step in progress glows').toContain('class="lv"')
      expect(svg, 'no title text inside the drawing').not.toContain('Make the deck')
    } else {
      const cells = await v.findAll({ text: /^█$/ })
      expect(cells, 'half the bar is filled').toHaveLength(23)
      expect(cells[0]!.props.color, 'light at the start').toBe('#c4b5fd')
      expect(cells[22]!.props.color, 'deep at the head').toBe('#6d28d9')
      const live1 = String((await v.find({ text: /^▓+$/ }))!.props.color)
      await $.prompt.submit({ text: 'go on' } as never).catch(() => undefined)
      await clock.advance(700)
      const live2 = String((await v.find({ text: /^▓+$/ }))!.props.color)
      expect(live1 !== live2, 'the step in progress shimmers while a turn runs').toBe(true)
    }

    // The bar follows the plan, not subagents.
    await spawn($, 'Build the slides', 1)
    await clock.settle()
    expect(await v.find({ text: /subagent/i }), 'no subagent line').toBeUndefined()

    // The ✕ hides the bar; the next plan update brings it back.
    await v.press({ key: 'plan-dismiss' })
    expect(await v.find({ key: 'plan-band' }), 'dismissed').toBeUndefined()
    await call({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p2', title: 'Make the deck', steps: steps4(3, true) })
    await clock.settle()
    expect(await bandSays(v, surface), 'back on the next update').toContain('Tasks 3/4')
  })

  test(`the bar colour is a setting (${surface})`, { timeoutMs: 30000, options: { bar_color: 'teal' } }, async ($, on) => {
    const { clock } = rig(on, {})
    await start($, surface)
    await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(2, true) })
    await clock.settle()
    const v = await band($, surface)
    if (surface === 'desktop') {
      const svg = String((await v.find({ type: 'Svg' }))!.props.source)
      expect(svg, 'teal').toContain('#0f766e')
      expect(svg, 'not purple').not.toContain('#6d28d9')
    } else {
      expect((await v.findAll({ text: /^█$/ }))[0]!.props.color, 'teal at the start').toBe('#99f6e4')
    }
  })

  test(`TodoWrite, TaskCreate and TaskUpdate on the main chat feed the plan (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const files: Files = {}
    const { clock } = rig(on, files)
    await start($, surface)
    const call = callTool($)
    // A subagent's list is its own: it stays out of the plan.
    await call({ tool: 'TodoWrite', tool_use_id: 't0', todos: todos3, agentId: 'agent-x' })
    await clock.settle()
    expect(PLAN_FILE in files, 'no plan from a subagent').toBe(false)

    await call({ tool: 'TodoWrite', tool_use_id: 't1', todos: todos3 })
    await clock.settle()
    const saved = JSON.parse(files[PLAN_FILE]!) as { steps: { text: string }[] }
    expect(saved.steps.map(st => st.text)).toEqual(['Pull the numbers', 'Write the summary', 'Send the link'])
    const v = await band($, surface)
    expect(await bandSays(v, surface), 'band from TodoWrite').toContain('Tasks 1/3')
    expect(await v.find({ type: 'Text', text: /Now: Write the summary/ })).toBeDefined()

  })

  test(`the task tools build a list, tick it and delete from it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock, files } = rig(on, {})
    await start($, surface)
    const call = callTool($)
    await call({ tool: 'TaskCreate', tool_use_id: 'c1', subject: 'Draft the email', description: 'd' })
    await call({ tool: 'TaskCreate', tool_use_id: 'c2', subject: 'Send the email', description: 'd' })
    await clock.settle()
    const v = await band($, surface)
    expect(await bandSays(v, surface)).toContain('Tasks 0/2')
    expect(await v.find({ type: 'Text', text: /Next: Draft the email/ }), 'nothing in progress: the next step shows').toBeDefined()
    await call({ tool: 'TaskUpdate', tool_use_id: 'u1', taskId: 'task-1', status: 'in_progress' })
    await clock.settle()
    expect(await v.find({ type: 'Text', text: /Now: Draft the email/ })).toBeDefined()
    await call({ tool: 'TaskUpdate', tool_use_id: 'u2', taskId: 'task-1', status: 'completed' })
    await clock.settle()
    expect(await bandSays(v, surface)).toContain('Tasks 1/2')
    await call({ tool: 'TaskUpdate', tool_use_id: 'u3', taskId: 'task-2', status: 'deleted' })
    await clock.settle()
    expect(await bandSays(v, surface), 'a deleted task leaves the list').toContain('Tasks 1/1')
    expect(JSON.parse(files[PLAN_FILE]!).steps).toHaveLength(1)
  })

  test(`a step finishing pops up, a finished plan holds 20 s then hides (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock, toasts } = rig(on, {})
    await start($, surface)
    const plan = (steps: unknown, n: number) => callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: `p${n}`, title: 'Make the deck', steps })
    await plan(steps4(1, true), 1)
    await clock.settle()
    expect(toasts, 'no pop-up for steps already done in a new plan').toHaveLength(0)
    await plan(steps4(2, true), 2)
    await clock.settle()
    expect(toasts, 'the step that finished').toEqual(['Done: Draft the outline'])
    await plan(steps4(4, false), 3)
    await clock.settle()
    expect(toasts[toasts.length - 1], 'whole plan done').toBe('All 4 steps done.')
    const v = await band($, surface)
    expect(await bandSays(v, surface), 'held at 100%').toContain('100%')
    await clock.advance(19_000)
    expect(await v.find({ key: 'plan-band' }), 'there before 20 s').toBeDefined()
    await clock.advance(1_500)
    expect(await v.find({ key: 'plan-band' }), 'gone after 20 s').toBeUndefined()
    await plan(steps4(0, true), 4)
    await clock.settle()
    expect(await bandSays(v, surface), 'a new plan shows').toContain('Tasks 0/4')
  })

  test(`hold_seconds 0 hides a finished bar at once, toasts off stays quiet (${surface})`, { timeoutMs: 30000, options: { hold_seconds: 0, toasts: false } }, async ($, on) => {
    const { clock, toasts } = rig(on, {})
    await start($, surface)
    const plan = (steps: unknown, n: number) => callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: `p${n}`, steps })
    await plan(steps4(1, true), 1)
    await plan(steps4(2, true), 2)
    await plan(steps4(4, false), 3)
    await clock.settle()
    expect(toasts, 'no pop-ups').toHaveLength(0)
    expect(await (await band($, surface)).find({ key: 'plan-band' }), 'gone at once').toBeUndefined()
  })

  test(`the bar is not drawn while a survey holds the band (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock } = rig(on, {})
    await start($, surface)
    await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(1, true) })
    await clock.settle()
    const v = await $.ui.mount({ plugin: 'helper-desk', surface, component: 'AbovePrompt', props: { ...(bandProps() as object), hasSurvey: true } as never })
    expect(await v.find({ key: 'plan-band' })).toBeUndefined()
  })

  test(`a plan saved before a reload is picked up again (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const files: Files = {
      [PLAN_FILE]: JSON.stringify({ title: 'Old job', steps: [{ text: 'One', status: 'completed' }, { text: 'Two', status: 'in_progress' }, { text: 7 }, { text: 'Three', status: 'weird' }], updatedAt: '2026-01-01T00:00:00.000Z' }),
    }
    const { clock } = rig(on, files)
    await start($, surface)
    await clock.settle()
    const v = await band($, surface)
    const says = await bandSays(v, surface)
    expect(says, 'title').toContain('Old job')
    expect(says, 'bad steps are skipped').toContain('Tasks 1/2')
  })
}

// ---------- The plan tool, reminders, system prompt ----------

test('the plan tool sits in front, and work without a plan gets one reminder', { timeoutMs: 30000 }, async ($, on) => {
  specs = []
  const files: Files = {}
  const { clock } = rig(on, files)
  await start($, 'desktop')
  await clock.settle()
  expect(specs[0]?.name).toBe('plan')
  expect(specs[0]?.isDeferred, 'not behind ToolSearch').toBe(false)

  const call = callTool($)
  const first = await call({ tool: 'Bash', tool_use_id: 'b1', command: 'ls' })
  expect(first.context ?? [], 'one tool call is no task: no reminder').toHaveLength(0)
  const second = await call({ tool: 'Bash', tool_use_id: 'b2', command: 'ls' })
  expect((second.context ?? []).join(' '), 'two calls and no plan: a reminder').toContain('mcp__helper-desk__plan')
  const third = await call({ tool: 'Bash', tool_use_id: 'b3', command: 'ls' })
  expect(third.context ?? [], 'only once a turn').toHaveLength(0)

  await $.prompt.submit({ text: 'Next task please' } as never).catch(() => undefined)
  await call({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(0, true) })
  const after = await call({ tool: 'Read', tool_use_id: 'r1', file_path: '/x' })
  const after2 = await call({ tool: 'Read', tool_use_id: 'r2', file_path: '/x' })
  expect([...(after.context ?? []), ...(after2.context ?? [])], 'plan made: quiet').toHaveLength(0)
  expect(PLAN_FILE in files, 'plan file written for other tools').toBe(true)
})

test('a plan not touched in a while gets a stale reminder; a new prompt resets the count', { timeoutMs: 30000 }, async ($, on) => {
  const { clock } = rig(on, {})
  await start($, 'desktop')
  const call = callTool($)
  await call({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(1, true) })
  await clock.settle()
  let note = ''
  for (let i = 0; i < 8; i += 1) {
    const r = await call({ tool: 'Grep', tool_use_id: `g${i}`, pattern: 'x' })
    if (r.context?.length) note = r.context.join(' ')
  }
  expect(note, 'the stale reminder').toContain('has not changed in a while')
})

test('reminders can be turned off, and a denied call never gets one', { timeoutMs: 30000, options: { nudges: false } }, async ($, on) => {
  const { clock } = rig(on, {})
  await start($, 'desktop')
  const call = callTool($)
  for (let i = 0; i < 4; i += 1) expect((await call({ tool: 'Bash', tool_use_id: `b${i}`, command: 'ls' })).context ?? []).toHaveLength(0)
  const sections = await compose($, [])
  expect(sections.some(x => x.id === 'helper-desk:plan'), 'no system prompt section').toBe(false)
  await clock.settle()
})

test('the system prompt section names the right list tool, and skips teammates, bare runs and the off state', { timeoutMs: 30000 }, async ($, on) => {
  const files: Files = {}
  const { clock } = rig(on, files)
  let tools: string[] = ['Bash', 'Read']
  let traits: string[] = []
  await start($, 'desktop')
  const section = async () => (await compose($, tools, traits)).find(x => x.id === 'helper-desk:plan')
  expect((await section())?.text, 'no to-do tool: the plan tool').toContain('mcp__helper-desk__plan')
  tools = ['Bash', 'TodoWrite']
  const native = (await section())?.text ?? ''
  expect(native, 'TodoWrite offered: use it').toContain('to-do tool')
  expect(native, 'and the plan tool is not pushed').not.toContain('mcp__helper-desk__plan')
  expect(native, 'subagents are told to ignore it').toContain('subagent')
  traits = ['teammate']
  expect(await section(), 'no section for a teammate').toBeUndefined()
  traits = ['bare']
  expect(await section(), 'no section for a bare run').toBeUndefined()
  traits = []
  files[SWITCHES] = JSON.stringify({ 'helper-desk': false })
  await clock.advance(1_200)
  expect(await section(), 'no section while off').toBeUndefined()
})

test('a native to-do list changes the reminder wording', { timeoutMs: 30000 }, async ($, on) => {
  const { clock } = rig(on, {})
  await start($, 'desktop')
  await clock.settle()
  const call = callTool($)
  await call({ tool: 'TodoWrite', tool_use_id: 't1', todos: todos3 })
  await $.prompt.submit({ text: 'Do a second thing' } as never).catch(() => undefined)
  await call({ tool: 'Bash', tool_use_id: 'b1', command: 'ls' })
  const r = await call({ tool: 'Bash', tool_use_id: 'b2', command: 'ls' })
  const said = (r.context ?? []).join(' ')
  expect(said, 'a live plan not touched this turn').toContain('has not changed this turn')
  expect(said, 'names TodoWrite, not the plan tool').toContain('update the list')
  expect(said).not.toContain('mcp__helper-desk__plan')
})

test('the plan tool checks what it is sent, and is easy on odd status words', { timeoutMs: 30000 }, async ($, on) => {
  const { clock } = rig(on, {})
  await start($, 'desktop')
  const call = callTool($)
  const say = async (input: object) => String((await call({ tool: 'mcp__helper-desk__plan', tool_use_id: 'x', ...input })).result)
  expect(await say({}), 'no steps').toContain('send steps as a list')
  expect(await say({ steps: [{ status: 'pending' }] }), 'no text').toContain('every step needs its text')
  expect(await say({ steps: [{ text: 'Go', status: 'maybe' }] }), 'bad status').toContain('needs a status of pending, in_progress or completed')
  expect(await say({ steps: ['  ', 'x'] }), 'an empty string step').toContain('a step is empty')
  expect(await say({ steps: ['One', { text: 'Two', status: 'in-progress' }, { text: 'Three', status: 'Done' }] }), 'strings and loose words are accepted').toBe('Plan saved: 1 of 3 steps done.')
  const many = Array.from({ length: 130 }, (_, i) => ({ text: `Step ${i}`, status: 'pending' }))
  expect(await say({ steps: many }), 'long lists are cut').toContain('first 100')
  // A subagent's call is told the plan is the main chat's.
  const sub = await call({ tool: 'mcp__helper-desk__plan', tool_use_id: 'y', steps: steps4(0, true), agentId: 'agent-a1' })
  expect(String(sub.result)).toContain('Only the main chat')
  await clock.settle()
})

test('a plan with no title takes the first words of the prompt; a finished plan makes room for a new one', { timeoutMs: 30000 }, async ($, on) => {
  const files: Files = {}
  const { clock } = rig(on, files)
  await start($, 'desktop')
  await $.prompt.submit({ text: 'Please build the quarterly deck for the board meeting' } as never).catch(() => undefined)
  const call = callTool($)
  await call({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(1, true) })
  await clock.settle()
  const first = JSON.parse(files[PLAN_FILE]!) as { title: string }
  expect(first.title, 'prompt words').toBe('Please build the quarterly deck for…')
  await call({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p2', steps: steps4(4, false) })
  await call({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p3', title: 'Second job', steps: [{ text: 'Only step', status: 'in_progress' }] })
  await clock.settle()
  const second = JSON.parse(files[PLAN_FILE]!) as { title: string; steps: unknown[] }
  expect(second.title).toBe('Second job')
  expect(second.steps).toHaveLength(1)
  // A slash command never names a plan.
  await $.prompt.submit({ text: '/helpers' } as never).catch(() => undefined)
})

// ---------- Subagent accounting ----------

test('turn steps add the helper\'s model, effort and work tokens; a turn end replaces the running sum', { timeoutMs: 30000 }, async ($, on) => {
  const { clock } = rig(on, {})
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: { ...usage } } as never
  })
  await start($, 'desktop')
  await spawn($, 'Count the things', 1, 'Explore')
  await clock.settle()
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 2, agentId: 'agent-a1' } as never)
  for await (const _chunk of stream) void _chunk
  await clock.settle()
  const v = await pane($, 'desktop', 70)
  expect(await v.find({ type: 'Text', text: /^\s*Explore\s*$/ }), 'type as a tag').toBeDefined()
  expect(await v.find({ text: /Sonnet 5\.5 · high/ }), 'model and effort').toBeDefined()
  expect(await v.find({ text: /4k tokens/ }), 'tokens so far, cache reads left out').toBeDefined()
  await done($, 'agent-a1', { usage: { ...usage, input_tokens: 5000, output_tokens: 1000, cache_creation_input_tokens: 0 } })
  await clock.settle()
  expect(await v.find({ text: /6k tokens/ }), 'the turn total replaces the running sum').toBeDefined()
})

test('an unknown agent id is adopted from the agent list; the engine\'s own forks are left out', { timeoutMs: 30000 }, async ($, on) => {
  const { clock, agents } = rig(on, {})
  await start($, 'desktop')
  agents.push({ id: 'agent-z', description: 'Found late', type: 'Plan', status: 'running' })
  const call = callTool($)
  await call({ tool: 'Grep', tool_use_id: 'g1', pattern: 'needle', path: '/Users/test/vault', agentId: 'agent-z' })
  await call({ tool: 'Grep', tool_use_id: 'g2', pattern: 'needle', agentId: 'fork-1' })
  await clock.settle()
  const v = await pane($, 'desktop', 70)
  expect(await v.find({ text: /Found late/ }), 'adopted').toBeDefined()
  expect(await v.find({ text: /Searching files for "needle"/ }), 'its search in words').toBeDefined()
  expect(await v.find({ type: 'Text', text: /^Running · 1\s*$/ }), 'the fork is not a card').toBeDefined()
})

test('a /clear starts the desk over', { timeoutMs: 30000 }, async ($, on) => {
  const files: Files = {}
  const { clock } = rig(on, files)
  await start($, 'desktop')
  await spawn($, 'Build the landing page', 1)
  await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(1, true) })
  await clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 'sess1', resume: {} } as never)
  await clock.settle()
  const v = await pane($, 'desktop')
  expect(await v.find({ text: /Build the landing page/ }), 'cards gone').toBeUndefined()
  expect(await v.find({ text: /No subagents yet/ }), 'empty desk').toBeDefined()
  expect(await (await band($, 'desktop')).find({ key: 'plan-band' }), 'band gone').toBeUndefined()
})

// ---------- Fail open and the log ----------

test('a broken disk, ledger and agent list never block a tool call or a prompt', { timeoutMs: 30000 }, async ($, on) => {
  const { clock, submitted } = rig(on, {}, { read: true, write: true, usage: true, list: true, open: true })
  await start($, 'desktop')
  await spawn($, 'Build the landing page', 1)
  const call = callTool($)
  const bash = await call({ tool: 'Bash', tool_use_id: 'b1', command: 'ls' })
  expect(bash.result, 'the tool still ran').toBe('ok')
  expect(bash.deny, 'and was not refused').toBeUndefined()
  await call({ tool: 'Read', tool_use_id: 'c1', file_path: '/x', agentId: 'agent-a1' })
  await clock.advance(5_000)
  const said = await call({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(1, true) })
  expect(String(said.result), 'the plan still saved in memory').toBe('Plan saved: 1 of 4 steps done.')
  // The prompt goes on exactly as typed.
  await $.prompt.submit({ text: 'Keep this text exactly' } as never)
  expect(submitted, 'prompt text unchanged').toEqual(['Keep this text exactly'])
  const v = await pane($, 'desktop')
  expect(await v.find({ text: /Build the landing page/ }), 'the pane still draws').toBeDefined()
})

test('with no home folder known the mod still works and writes nothing', { timeoutMs: 30000 }, async ($, on) => {
  const files: Files = {}
  const { clock } = rig(on, files, { env: true })
  await start($, 'desktop')
  await spawn($, 'Build the landing page', 1)
  await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(1, true) })
  await clock.settle()
  expect(Object.keys(files), 'no file written without a home').toHaveLength(0)
  expect(await bandSays(await band($, 'desktop'), 'desktop'), 'the bar still draws').toContain('Tasks 1/4')
})

test('the log has one line per event, with no prompt text and no task words', { timeoutMs: 30000 }, async ($, on) => {
  const files: Files = {}
  const { clock } = rig(on, files)
  await start($, 'desktop')
  await $.prompt.submit({ text: 'SECRET-PROMPT-WORDS please' } as never).catch(() => undefined)
  await spawn($, 'SECRET-TASK-WORDS', 1)
  await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', title: 'SECRET-TITLE', steps: [{ text: 'SECRET-STEP', status: 'pending' }] })
  await done($, 'agent-a1')
  await clock.settle()
  const log = files[LOG] ?? ''
  expect(log, 'a log was written').toContain('session start')
  expect(log).toContain('helper started')
  expect(log).toContain('plan: 0 of 1 steps done')
  expect(log).not.toContain('SECRET')
  expect(log.split('\n').every(l => l === '' || /^\d{4}-\d\d-\d\dT/.test(l)), 'each line starts with a time').toBe(true)
})

test('the log keeps its last 300 lines', { timeoutMs: 30000 }, async ($, on) => {
  const old = Array.from({ length: 400 }, (_, i) => `2026-01-01T00:00:00.000Z old ${i}`).join('\n')
  const files: Files = { [LOG]: `${old}\n` }
  const { clock } = rig(on, files)
  await start($, 'desktop')
  await clock.settle()
  const lines = (files[LOG] ?? '').split('\n').filter(Boolean)
  expect(lines.length <= 301, 'trimmed').toBe(true)
  expect(lines[lines.length - 1], 'newest last').toContain('session start')
})

test('switched off at the start, the plan tool is not registered; switching on registers it', { timeoutMs: 30000 }, async ($, on) => {
  specs = []
  const files: Files = { [SWITCHES]: JSON.stringify({ 'helper-desk': false }) }
  const { clock } = rig(on, files)
  await start($, 'desktop')
  await clock.settle()
  expect(specs, 'nothing added to the model\'s tools while off').toHaveLength(0)
  files[SWITCHES] = '{}'
  await clock.advance(1_200)
  await callTool($)({ tool: 'Bash', tool_use_id: 'b1', command: 'ls' })
  await clock.settle()
  expect(specs, 'registered once on').toHaveLength(1)
})

test('a finished plan restored after a reload stays hidden', { timeoutMs: 30000 }, async ($, on) => {
  const files: Files = { [PLAN_FILE]: JSON.stringify({ title: 'Done job', steps: [{ text: 'One', status: 'completed' }], updatedAt: 'x' }) }
  const { clock } = rig(on, files)
  await start($, 'desktop')
  await clock.settle()
  expect(await (await band($, 'desktop')).find({ key: 'plan-band' })).toBeUndefined()
})

// ---------- Version 0.2: the main card, open_pane, titles and tags, results, Recent, the bar chip ----------

const turnStart = ($: any, extra: object = {}) => $.turn.start({ text: 'go', turnId: 'tm1', ...extra } as never)
const mainDone = ($: any, extra: object = {}) =>
  $.turn.complete({ answer: 'ok', reason: 'answer', durationMs: 1, isAborted: false, turnId: 'tm1', ...extra } as never)
/** Every text of a drawing, joined, so a test asks "does the screen say this". */
const said = async (v: View) => (await v.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
const countOf = (all: string, word: string) => all.split(word).length - 1
/** A release for a held tool call, and the hold itself. */
const hold = (holds: Record<string, Promise<unknown>>, tool: string) => {
  let release = () => undefined as void
  holds[tool] = new Promise<void>(r => {
    release = () => r()
  })
  return release
}
/** A model request of the main chat, run to its end. */
async function modelStep($: any) {
  for await (const chunk of $.turn.step({ turnId: 'tm1', index: 0, model: 'claude-opus-5-5', messageCount: 2 } as never)) void chunk
}
const bareStep = (on: On) =>
  on('turn.step', async function* () {
    return { turnId: 'tm1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...usage } } as never
  })

for (const surface of ['desktop', 'terminal'] as const) {
  // ---------- The main chat's card ----------

  test(`the main card is always there, and says Idle with nothing running (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock } = rig(on, {})
    await start($, surface)
    await clock.settle()
    const v = await pane($, surface)
    const all = await said(v)
    expect(all, 'the card has its name').toContain('Claude (this chat)')
    expect(all, 'a state word, not just a colour').toContain('Idle')
    expect(all, 'the empty state in plain words').toContain('Nothing running. Claude is idle.')
    expect(all, 'the helpers heading still says there are none').toContain('No subagents yet')
    expect(await v.find({ type: 'Svg', alt: 'Claude is working' }), 'no live dot while idle').toBeUndefined()
    expect(all, 'idle has no live word').not.toContain('Working')
  })

  test(`the main card follows a turn: what it acts on, the state, the time, the tools, the last steps, then Idle (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const { clock, holds } = rig(on, {})
    bareStep(on)
    await start($, surface)
    const call = callTool($)
    await turnStart($)
    await modelStep($)
    await clock.settle()
    const v = await pane($, surface, 70)
    let all = await said(v)
    expect(all, 'working').toContain('Working')
    expect(all, 'between tools it thinks').toContain('Thinking')
    expect(all, 'not idle while it works').not.toContain('Nothing running')

    // A tool call that is still running is the live line, with its folder dim beside it.
    const release = hold(holds, 'Read')
    const reading = call({ tool: 'Read', tool_use_id: 'm1', file_path: '/Users/test/vault/hooks/register.tsx' })
    await clock.advance(65_000)
    all = await said(v)
    expect(all, 'what it reads').toContain('Reading register.tsx')
    expect(all, 'its folder, home as ~').toContain('~/vault/hooks')
    expect(all, 'elapsed time of the turn, live').toContain('1:05')
    expect(all, 'tools used this turn').toContain('1 tool this turn')
    if (surface === 'desktop') {
      const dot = await v.find({ type: 'Svg', alt: 'Claude is working' })
      expect(dot, 'a live dot on the desktop').toBeDefined()
      expect(String(dot!.props.source), 'the ring pulses').toContain('@keyframes rg')
      expect(String(dot!.props.source), 'and stops for a person who asks for less motion').toContain('prefers-reduced-motion')
    } else {
      expect(await v.findAll({ type: 'Svg' }), 'no Svg on the terminal').toHaveLength(0)
    }
    release()
    await reading
    await clock.settle()
    all = await said(v)
    expect(all, 'finished steps are listed with a tick').toContain('✓ Reading register.tsx')
    expect(all, 'and Claude is back to thinking').toContain('Thinking')

    // Other tool calls read in plain words, the chat's own to-do and plan tools too.
    await call({ tool: 'Bash', tool_use_id: 'm2', command: 'npm test', description: 'Run the tests' })
    await call({ tool: 'Edit', tool_use_id: 'm3', file_path: '/Users/test/vault/theme.liquid', old_string: 'a', new_string: 'b' })
    await call({ tool: 'TodoWrite', tool_use_id: 'm4', todos: todos3 })
    await call({ tool: 'Agent', tool_use_id: 'm5', description: 'Count mod files', prompt: 'x', subagent_type: 'Explore' })
    await clock.settle()
    all = await said(v)
    expect(all).toContain('✓ Running: Run the tests')
    expect(all).toContain('✓ Editing theme.liquid')
    expect(all).toContain('✓ Updating the to-do list')
    expect(all).toContain('✓ Running a helper: Count mod files')
    expect(all, 'tools counted').toContain('5 tools this turn')

    // The turn ends: Idle, with the turn's length and tool count kept.
    await clock.advance(5_000)
    await mainDone($)
    await clock.settle()
    all = await said(v)
    expect(all, 'idle').toContain('Idle')
    expect(all, 'no longer working').not.toContain('Working')
    expect(all, 'the last turn is summed up').toMatch(/Last turn 1:1\d · 5 tools/)
    expect(all, 'the last steps stay on the card').toContain('✓ Editing theme.liquid')
    expect(await v.find({ type: 'Svg', alt: 'Claude is working' }), 'the dot is gone').toBeUndefined()
  })

  test(`the main card says Waiting for you while a question is open (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock, holds } = rig(on, {})
    await start($, surface)
    await turnStart($)
    const release = hold(holds, 'AskUserQuestion')
    const asking = callTool($)({ tool: 'AskUserQuestion', tool_use_id: 'q1', questions: [] })
    await clock.advance(1_000)
    const v = await pane($, surface, 70)
    let all = await said(v)
    expect(all, 'waiting, in words').toContain('Waiting for you')
    expect(all, 'and what for').toContain('Asking you a question')
    expect(all, 'not called working').not.toContain('Working')
    release()
    await asking
    await clock.settle()
    all = await said(v)
    expect(all, 'back to work').toContain('Working')
    expect(all).not.toContain('Waiting for you')
    // A plan to approve is a wait too.
    const release2 = hold(holds, 'ExitPlanMode')
    const planning = callTool($)({ tool: 'ExitPlanMode', tool_use_id: 'q2', plan: 'x' })
    await clock.advance(1_000)
    expect(await said(v), 'a plan waits for you').toContain('Asking you to approve the plan')
    release2()
    await planning
  })

  test(`the main card keeps the last five steps and counts them all, however many there are (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const { clock } = rig(on, {})
    await start($, surface)
    await turnStart($)
    const call = callTool($)
    for (let i = 1; i <= 30; i += 1) await call({ tool: 'Read', tool_use_id: `r${i}`, file_path: `/Users/test/vault/f${i}.md` })
    await clock.settle()
    const v = await pane($, surface, 70)
    const all = await said(v)
    expect(all, 'all thirty counted').toContain('30 tools this turn')
    for (const n of [26, 27, 28, 29, 30]) expect(all, `step ${n} shows`).toContain(`✓ Reading f${n}.md`)
    expect(all, 'older steps are dropped').not.toContain('Reading f25.md')
    expect(countOf(all, '✓ Reading'), 'five rows').toBe(5)
  })

  test(`the main card hides secrets in a command, as a helper's card does (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock, holds, files } = rig(on, {})
    await start($, surface)
    await turnStart($)
    const release = hold(holds, 'Bash')
    const running = callTool($)({
      tool: 'Bash',
      tool_use_id: 'b1',
      command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://x.dev?api_key=hunter22 sk-ABCDEFGHIJKLMNOP12',
    })
    await clock.advance(1_000)
    const v = await pane($, surface, 90)
    const all = await said(v)
    expect(all, 'it shows the command').toContain('Running: curl')
    for (const secret of ['abcdefghijklmnop', 'hunter22', 'ABCDEFGHIJKLMNOP']) expect(all, secret).not.toContain(secret)
    release()
    await running
    // A model-written description with a token in it is cleaned too.
    await callTool($)({ tool: 'Bash', tool_use_id: 'b2', command: 'x', description: 'Deploy with token=SECRETVALUE123' })
    await clock.settle()
    expect(await said(v)).not.toContain('SECRETVALUE123')
    expect(files[LOG] ?? '', 'and nothing of it reaches the log').not.toContain('SECRET')
  })

  test(`each turn counts from zero, and a tool that ends after its turn does not wake the card (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock, holds } = rig(on, {})
    await start($, surface)
    const call = callTool($)
    await turnStart($)
    await call({ tool: 'Read', tool_use_id: 'a1', file_path: '/Users/test/vault/a.md' })
    await call({ tool: 'Read', tool_use_id: 'a2', file_path: '/Users/test/vault/b.md' })
    await mainDone($)
    await turnStart($, { turnId: 'tm2' })
    await clock.settle()
    const v = await pane($, surface, 70)
    expect(await said(v), 'a new turn starts at zero').toContain('0 tools this turn')

    const release = hold(holds, 'Grep')
    const late = call({ tool: 'Grep', tool_use_id: 'a3', pattern: 'x' })
    await clock.advance(500)
    await mainDone($, { turnId: 'tm2' })
    await clock.settle()
    release()
    await late
    await clock.settle()
    const all = await said(v)
    expect(all, 'still idle after a late tool end').toContain('Idle')
    expect(all).not.toContain('Working')
  })

  test(`a /clear and the switch-off both put the main card back to idle (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const files: Files = {}
    const { clock, holds } = rig(on, files)
    await start($, surface)
    await turnStart($)
    await callTool($)({ tool: 'Read', tool_use_id: 'a1', file_path: '/Users/test/vault/a.md' })
    await clock.settle()
    const v = await pane($, surface, 70)
    expect(await said(v)).toContain('Working')
    await $.session.end({ reason: 'clear', sessionId: 'sess1', resume: {} } as never)
    await clock.settle()
    let all = await said(v)
    expect(all, 'idle after /clear').toContain('Idle')
    expect(all, 'with nothing left of the old turn').not.toContain('Reading a.md')
    expect(all).not.toContain('tool')
    expect(all, 'the empty desk again').toContain('Nothing running. Claude is idle.')

    // Switched off: nothing is tracked or drawn, and calls pass through untouched.
    await start($, surface)
    await turnStart($, { turnId: 'tm3' })
    await callTool($)({ tool: 'Read', tool_use_id: 'a2', file_path: '/Users/test/vault/b.md' })
    await clock.settle()
    expect(await said(v), 'working again').toContain('Reading b.md')
    files[SWITCHES] = JSON.stringify({ 'helper-desk': false })
    await clock.advance(3_100)
    expect(await v.find({ text: /Claude \(this chat\)/ }), 'no card while off').toBeUndefined()
    const release = hold(holds, 'Bash')
    const off = callTool($)({ tool: 'Bash', tool_use_id: 'b1', command: 'ls' })
    await clock.advance(100)
    release()
    const r = await off
    expect(r.result, 'the tool ran').toBe('ok')
    expect(r.context ?? [], 'with no reminder').toHaveLength(0)
    await mainDone($, { turnId: 'tm3' })
    files[SWITCHES] = '{}'
    // With nothing running there is no timer: the next prompt or tool call notices the switch.
    await clock.advance(3_100)
    await $.prompt.submit({ text: 'and on again' } as never).catch(() => undefined)
    await clock.settle()
    all = await said(v)
    expect(all, 'on again, the card starts from idle').toContain('Idle')
    expect(all, 'and does not remember the step from before').not.toContain('Reading b.md')
  })

  test(`no timer runs when nothing is running, and the clock runs while the main chat works (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const { clock, looks } = rig(on, {})
    await start($, surface)
    await spawn($, 'Short job', 1)
    await clock.settle()
    await done($, 'agent-a1')
    await clock.advance(5_000)
    const quiet = looks.n
    await clock.advance(10_000)
    expect(looks.n, 'idle: no timer looks at anything').toBe(quiet)

    await turnStart($)
    await clock.advance(5_000)
    expect(looks.n > quiet, 'the main chat is working: the clock runs').toBe(true)
    await mainDone($)
    await clock.settle()
    const after = looks.n
    await clock.advance(10_000)
    expect(looks.n, 'the turn is over: the clock stops').toBe(after)
  })

  test(`with animations off the main card is still: a glyph, not a pulse (${surface})`, { timeoutMs: 30000, options: { animations: false } }, async ($, on) => {
    const { clock } = rig(on, {})
    await start($, surface)
    await turnStart($)
    await clock.settle()
    const v = await pane($, surface)
    expect(await said(v), 'still working, in words').toContain('Working')
    expect(await v.find({ type: 'Svg', alt: 'Claude is working' }), 'no pulsing picture').toBeUndefined()
    const before = (await said(v)).replace(/\d+:\d\d/g, '')
    await clock.advance(2_100)
    expect((await said(v)).replace(/\d+:\d\d/g, ''), 'nothing moves but the clock').toBe(before)
  })

  // ---------- open_pane ----------

  test(`open_pane "with a task or helper" (the default) opens at the first plan, once per chat (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { opened, clock } = rig(on, {})
    await start($, surface)
    await clock.settle()
    expect(opened, 'nothing yet').toHaveLength(0)
    await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(0, true) })
    await clock.settle()
    expect(opened, 'the first plan opens it').toEqual(['helpers'])
    await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p2', steps: steps4(1, true) })
    await spawn($, 'A helper', 1)
    await clock.settle()
    expect(opened, 'once per chat').toHaveLength(1)
  })

  test(`a to-do list from TodoWrite opens the pane too (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { opened, clock } = rig(on, {})
    await start($, surface)
    await callTool($)({ tool: 'TodoWrite', tool_use_id: 't1', todos: todos3 })
    await clock.settle()
    expect(opened).toEqual(['helpers'])
  })

  test(`the pane opens by itself once per chat, so one the person closed stays closed; /helpers brings it back (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { opened, clock } = rig(on, {})
    await start($, surface)
    await spawn($, 'First helper', 1)
    await clock.settle()
    expect(opened).toHaveLength(1)
    // The person closes the pane (the mod is not asked): more helpers and plans do not open it again.
    await done($, 'agent-a1')
    await spawn($, 'Second helper', 2)
    await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(0, true) })
    await clock.settle()
    expect(opened, 'not asked again').toHaveLength(1)
    await $.command.run({ command: 'helpers', args: '' } as never)
    expect(opened, '/helpers opens it').toHaveLength(2)
    // A /clear is a new chat: the pane may open by itself again.
    await $.session.end({ reason: 'clear', sessionId: 'sess1', resume: {} } as never)
    await start($, surface)
    await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p2', steps: steps4(0, true) })
    await clock.settle()
    expect(opened, 'a new chat opens it again').toHaveLength(3)
  })

  test(`open_pane "with helpers only" ignores plans and opens with a helper (${surface})`, { timeoutMs: 30000, options: { open_pane: 'with helpers only' } }, async ($, on) => {
    const { opened, clock } = rig(on, {})
    await start($, surface)
    await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(0, true) })
    await clock.settle()
    expect(opened, 'a plan does not open it').toHaveLength(0)
    await spawn($, 'A helper', 1)
    await clock.settle()
    expect(opened, 'a helper does').toEqual(['helpers'])
  })

  test(`open_pane "never" opens nothing, the old switch set to off says never too, /helpers still works (${surface})`, { timeoutMs: 30000, options: { open_pane: 'never' } }, async ($, on) => {
    const { opened, clock } = rig(on, {})
    await start($, surface)
    await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(0, true) })
    await spawn($, 'A helper', 1)
    await clock.settle()
    expect(opened).toHaveLength(0)
    await $.command.run({ command: 'helpers', args: '' } as never)
    expect(opened, '/helpers still opens it').toEqual(['helpers'])
  })

  test(`the old auto_open_pane switch still counts: off means never, even beside the new picker (${surface})`, { timeoutMs: 30000, options: { auto_open_pane: false, open_pane: 'with a task or helper' } }, async ($, on) => {
    const { opened, clock } = rig(on, {})
    await start($, surface)
    await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(0, true) })
    await spawn($, 'A helper', 1)
    await clock.settle()
    expect(opened).toHaveLength(0)
  })

  test(`the old auto_open_pane switch set to on changes nothing (${surface})`, { timeoutMs: 30000, options: { auto_open_pane: true } }, async ($, on) => {
    const { opened, clock } = rig(on, {})
    await start($, surface)
    await spawn($, 'A helper', 1)
    await clock.settle()
    expect(opened).toEqual(['helpers'])
  })

  test(`a pane that could not open is tried again with the next helper (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { opened, clock } = rig(on, {}, { open: true })
    await start($, surface)
    await spawn($, 'A helper', 1)
    await spawn($, 'Another helper', 2)
    await clock.settle()
    expect(opened, 'no room, nothing opened, nothing broke').toHaveLength(0)
    expect(await (await pane($, surface)).find({ text: /A helper/ }), 'the card still draws').toBeDefined()
  })

  // ---------- Helper cards: title, tag, result, duration ----------

  test(`a helper's own description is the title and its agent type a tag (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock } = rig(on, {})
    await start($, surface)
    await spawn($, 'Count mod files', 1, 'Explore', 'haiku')
    await clock.settle()
    const v = await pane($, surface, 70)
    const title = await v.find({ type: 'Text', text: /^Count mod files$/ })
    expect(title, 'the description is the title').toBeDefined()
    expect(title!.props.bold, 'in bold').toBe(true)
    expect(String(title!.text), 'with no type in it').not.toContain('Explore')
    const tag = await v.find({ type: 'Text', text: /^\s*Explore\s*$/ })
    expect(tag, 'the type is a tag').toBeDefined()
    expect(tag!.props.backgroundColor, 'a chip with its own background').toBeTruthy()
    expect(tag!.props.bold, 'lighter than the title').not.toBe(true)
    expect(await said(v), 'and the state is a word').toContain('Working')
  })

  test(`a finished card shows the first line of the result, how long it took, and a state word (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const files: Files = {}
    const { clock } = rig(on, files)
    await start($, surface)
    await spawn($, 'Count mod files', 1, 'Explore')
    await spawn($, 'Check the keys', 2)
    await spawn($, 'Write a long note', 3)
    await spawn($, 'Fail at it', 4)
    await clock.settle()
    await clock.advance(7_000)
    await done($, 'agent-a1', { answer: '## Found 12 mod files in 3 folders.\nSecond line that stays out.' })
    await done($, 'agent-a2', { answer: '\n\n**Used** token=abc123 and sk-ABCDEFGHIJKLMNOP12 to read it' })
    await done($, 'agent-a3', { answer: `${'x'.repeat(400)} tail` })
    await done($, 'agent-a4', { reason: 'error', answer: 'Half an answer' })
    await clock.settle()
    const v = await pane($, surface, 90)
    const all = await said(v)
    expect(all, 'first line of the result, markdown marks gone').toContain('Found 12 mod files in 3 folders.')
    expect(all, 'not the second line').not.toContain('Second line')
    expect(all, 'how long it took').toContain('took 0:07')
    expect(all, 'a state word on a finished card').toContain('Done')
    expect(all, 'secrets are hidden').toContain('••••')
    for (const secret of ['abc123', 'ABCDEFGHIJKLMNOP']) expect(all, secret).not.toContain(secret)
    const longest = Math.max(...(await v.findAll({ type: 'Text', text: /^x+/ })).map(t => String(t.text).length))
    expect(longest <= 160, 'a long line is clipped').toBe(true)
    expect(all, 'a stopped card says why, not what it half said').toContain('It hit an error')
    expect(all, 'and shows no result').not.toContain('Half an answer')
    // The result is on screen only.
    expect(files[LOG] ?? '', 'never in the log').not.toContain('mod files')
    expect(files[LOG] ?? '').not.toContain('xxxx')
  })

  test(`a helper that picks up new work loses its old result (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock } = rig(on, {})
    await start($, surface)
    await spawn($, 'Teammate job', 1)
    await clock.settle()
    await done($, 'agent-a1', { answer: 'Old result line' })
    await clock.settle()
    const v = await pane($, surface, 70)
    expect(await said(v)).toContain('Old result line')
    await callTool($)({ tool: 'Read', tool_use_id: 'c1', file_path: '/x/y.md', agentId: 'agent-a1' })
    await clock.settle()
    expect(await said(v), 'working again, no stale result').not.toContain('Old result line')
  })

  // ---------- Recent ----------

  test(`Recent keeps the last ten helpers that ended, newest first; Clear finished empties it (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const { clock } = rig(on, {})
    await start($, surface)
    for (let i = 1; i <= 12; i += 1) await spawn($, `Recent job ${i}`, i, i === 12 ? 'Plan' : 'Explore')
    await clock.settle()
    for (let i = 1; i <= 11; i += 1) {
      await clock.advance(10)
      await done($, `agent-a${i}`, { answer: `Result of job ${i}` })
    }
    // The twelfth ends badly: stopped helpers are in Recent too.
    await clock.advance(10)
    await done($, 'agent-a12', { reason: 'aborted', isAborted: true })
    await clock.settle()
    const v = await pane($, surface, 70)
    expect(await v.find({ type: 'Text', text: /^Recent · 10\s*$/ }), 'ten, not twelve').toBeDefined()
    const rows = (await v.findAll({ type: 'Box' })).map(b => String(b.props.key ?? '')).filter(k => k.startsWith('recent-'))
    expect(rows, 'ten rows, the newest first').toEqual(Array.from({ length: 10 }, (_, i) => `recent-agent-a${12 - i}`))
    expect(await v.find({ key: 'recent-agent-a2' }), 'the oldest two have left the list').toBeUndefined()
    const all = await said(v)
    expect(all, 'each row has its result').toContain('Done · Result of job 11')
    expect(all, 'a stopped one says why').toContain('You stopped it')
    expect(await v.find({ type: 'Text', text: /^Finished · 11\s*$/ }), 'the Finished group still keeps every card').toBeDefined()

    // Folding the group hides its rows.
    await v.press({ key: 'group-recent' })
    expect(await v.find({ key: 'recent-agent-a12' }), 'folded').toBeUndefined()
    await v.press({ key: 'group-recent' })
    await v.press({ key: 'clear' })
    await clock.settle()
    expect(await v.find({ key: 'head-recent' }), 'Clear finished empties Recent').toBeUndefined()
    expect(await v.find({ key: 'recent-agent-a12' })).toBeUndefined()
  })

  test(`a running helper is not in Recent (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock } = rig(on, {})
    await start($, surface)
    await spawn($, 'Still going', 1)
    await clock.settle()
    const v = await pane($, surface, 70)
    expect(await v.find({ key: 'head-recent' }), 'no Recent group with nothing finished').toBeUndefined()
  })

  // ---------- The task bar ----------

  test(`the task bar says how many helpers work and what the newest one does, then what Claude does (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const { clock, holds } = rig(on, {})
    await start($, surface)
    const call = callTool($)
    await call({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', title: 'Make the deck', steps: steps4(1, true) })
    await clock.settle()
    const b = await band($, surface, 100)
    expect(await said(b), 'nothing running: no chip').not.toContain('working')

    await spawn($, 'Read the notes', 1, 'Explore')
    await spawn($, 'Build the slides', 2)
    await clock.settle()
    await call({ tool: 'Read', tool_use_id: 'c1', file_path: '/Users/test/vault/notes.md', agentId: 'agent-a1' })
    await call({ tool: 'Write', tool_use_id: 'c2', file_path: '/Users/test/vault/deck.md', content: 'x', agentId: 'agent-a2' })
    await clock.settle()
    let all = await said(b)
    expect(await b.find({ type: 'Text', text: /2 helpers working/ }), 'the chip').toBeDefined()
    expect(all, 'the newest helper and its live line').toContain('Build the slides · Writing deck.md')
    expect(all, 'the plan step is still there').toContain('Now: Draft the outline')
    expect(all, 'the percentage is still there').toContain('25%')

    await done($, 'agent-a2')
    await clock.settle()
    expect(await b.find({ type: 'Text', text: /1 helper working/ }), 'one helper, singular').toBeDefined()
    expect(await said(b), 'the live line is the other helper now').toContain('Read the notes · Reading notes.md')
    await done($, 'agent-a1')
    await clock.settle()
    expect(await said(b), 'no helpers: no chip').not.toContain('helper working')

    // No helpers: the bar shows Claude's own live line.
    await turnStart($)
    const release = hold(holds, 'Bash')
    const running = call({ tool: 'Bash', tool_use_id: 'm1', command: 'npm test' })
    await clock.advance(500)
    all = await said(b)
    expect(all, "Claude's own line").toContain('Claude · Running: npm test')
    expect(all, 'no chip for Claude alone').not.toContain('working')
    release()
    await running
    await mainDone($)
    await clock.settle()
    expect(await said(b), 'idle: the bar is just the bar').not.toContain('Claude ·')
  })

  test(`the bar says when Claude waits for you (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock, holds } = rig(on, {})
    await start($, surface)
    await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(1, true) })
    await turnStart($)
    const release = hold(holds, 'AskUserQuestion')
    const asking = callTool($)({ tool: 'AskUserQuestion', tool_use_id: 'q1', questions: [] })
    await clock.advance(500)
    expect(await said(await band($, surface, 100)), 'waiting is on the bar').toContain('Claude · waiting for you · Asking you a question')
    release()
    await asking
  })

  test(`the bar draws no activity line with no plan, hidden, or switched off (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const files: Files = {}
    const { clock } = rig(on, files)
    await start($, surface)
    await turnStart($)
    await spawn($, 'A helper', 1)
    await clock.settle()
    const b = await band($, surface, 100)
    expect(await b.find({ key: 'plan-band' }), 'no plan, no band').toBeUndefined()
    await callTool($)({ tool: 'mcp__helper-desk__plan', tool_use_id: 'p1', steps: steps4(1, true) })
    await clock.settle()
    expect(await said(b)).toContain('1 helper working')
    files[SWITCHES] = JSON.stringify({ 'helper-desk': false })
    await clock.advance(3_100)
    expect(await b.find({ key: 'plan-band' }), 'off: nothing').toBeUndefined()
  })

  // ---------- Fail open ----------

  test(`a broken disk, ledger, list and pane never block the main chat's calls, and the card still draws (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { clock, submitted } = rig(on, {}, { read: true, write: true, usage: true, list: true, open: true })
    await start($, surface)
    await turnStart($)
    const r = await callTool($)({ tool: 'Bash', tool_use_id: 'b1', command: 'ls' })
    expect(r.result, 'the call ran').toBe('ok')
    expect(r.deny, 'and was not refused').toBeUndefined()
    await $.prompt.submit({ text: 'Keep this text exactly' } as never)
    expect(submitted, 'the prompt is untouched').toEqual(['Keep this text exactly'])
    await mainDone($)
    await clock.settle()
    const all = await said(await pane($, surface))
    expect(all, 'the card still draws').toContain('Claude (this chat)')
    expect(all, 'with the step it saw').toContain('Running: ls')
  })
}

test('the main card cannot be woken by a tool when there is no home folder and no clock luck', { timeoutMs: 30000 }, async ($, on) => {
  const { clock } = rig(on, {}, { env: true })
  await start($, 'desktop')
  await turnStart($)
  const r = await callTool($)({ tool: 'Read', tool_use_id: 'a1', file_path: '/Users/test/a.md' })
  expect(r.result).toBe('ok')
  await clock.settle()
  expect(await said(await pane($, 'desktop')), 'drawn without a home folder').toContain('Reading a.md')
})

test('the log never holds a path, a command or a result from the main chat', { timeoutMs: 30000 }, async ($, on) => {
  const files: Files = {}
  const { clock } = rig(on, files)
  await start($, 'desktop')
  await turnStart($)
  await callTool($)({ tool: 'Read', tool_use_id: 'a1', file_path: '/Users/test/SECRET-PATH/secret-file.md' })
  await callTool($)({ tool: 'Bash', tool_use_id: 'a2', command: 'echo SECRET-COMMAND' })
  await spawn($, 'SECRET-TASK', 1)
  await done($, 'agent-a1', { answer: 'SECRET-RESULT' })
  await mainDone($)
  await clock.settle()
  const log = files[LOG] ?? ''
  expect(log, 'a log was written').toContain('helper started')
  expect(log.toUpperCase()).not.toContain('SECRET')
})

// ---------- Pure parts of 0.2 ----------

test('a result summary is the first line with words in it, clean and short', async () => {
  expect(summaryOf('## Found 12 files\nmore')).toBe('Found 12 files')
  expect(summaryOf('\n\n---\n```\n**Bold** start')).toBe('Bold start')
  expect(summaryOf('- a list item\n- another')).toBe('a list item')
  expect(summaryOf('> quoted')).toBe('quoted')
  expect(summaryOf('')).toBe('')
  expect(summaryOf(undefined)).toBe('')
  expect(summaryOf('***\n---')).toBe('')
  expect(summaryOf('my_token=abcdefgh and TOKEN=xyz12345')).not.toContain('xyz12345')
  expect(summaryOf('x'.repeat(500)).length).toBe(160)
  expect(summaryOf('x'.repeat(500), 40).length).toBe(40)
  expect(summaryOf('Gebäude gezählt: 12')).toBe('Gebäude gezählt: 12')
})

test('open_pane reads the picker, and an old switch set to off wins', async () => {
  expect(openMode(undefined, undefined)).toBe('with a task or helper')
  expect(openMode('with helpers only', undefined)).toBe('with helpers only')
  expect(openMode('never', undefined)).toBe('never')
  expect(openMode('nonsense', undefined), 'an odd value falls back to the default').toBe('with a task or helper')
  expect(openMode(undefined, false), 'old off').toBe('never')
  expect(openMode('with helpers only', false), 'old off beats the picker').toBe('never')
  expect(openMode('never', true), 'old on changes nothing').toBe('never')
  expect(openMode(undefined, true)).toBe('with a task or helper')
})

test('the main chat\'s tool calls read in plain words', async () => {
  const plan = 'mcp__helper-desk__plan'
  expect(describeMain(plan, {}, HOME, plan).live).toBe('Updating the plan')
  expect(describeMain('TodoWrite', {}, HOME, plan).live).toBe('Updating the to-do list')
  expect(describeMain('Agent', { description: 'Count mod files' }, HOME, plan).live).toBe('Running a helper: Count mod files')
  expect(describeMain('Agent', {}, HOME, plan).live).toBe('Running a helper')
  expect(describeMain('AskUserQuestion', {}, HOME, plan).live).toBe('Asking you a question')
  expect(describeMain('ExitPlanMode', {}, HOME, plan).live).toBe('Asking you to approve the plan')
  expect(describeMain('Read', { file_path: '/Users/test/a/b.md' }, HOME, plan), 'anything else reads as for a helper').toEqual(describe('Read', { file_path: '/Users/test/a/b.md' }, HOME))
  expect(describeMain('Bash', { command: 'run --token=hunter22abc' }, HOME, plan).live).not.toContain('hunter22abc')
  expect(describe('Bash', { command: 'x', description: 'Use password=hunter22abc' }, HOME).label, 'a description is cleaned too').not.toContain('hunter22abc')
})

// ---------- Pure parts ----------

test('connector names never show a raw id', async () => {
  const kit = '00000000-0000-0000-0000-0000000000c1'
  expect(connectorName(kit, 'list_landing_pages')).toBe('Kit')
  expect(connectorName(kit, 'list_posts'), 'a server named by an earlier tool keeps the name').toBe('Kit')
  expect(connectorName('00000000-0000-0000-0000-0000000000c2', 'list_spaces')).toBe('Circle')
  expect(connectorName('00000000-0000-0000-0000-0000000000c3', 'notion-search')).toBe('Notion')
  expect(connectorName('00000000-0000-0000-0000-0000000000c6', 'get-shop-info')).toBe('Shopify')
  expect(connectorName('00000000-0000-0000-0000-0000000000c5', 'do_something_new')).toBe('Connector')
  expect(connectorName('plugin_demo_fireflies', 'fireflies_search')).toBe('Fireflies')
  expect(connectorName('claude_ai_Slack', 'slack_search_public')).toBe('Slack')
  expect(connectorName('plugin_productivity_notion', 'notion-fetch')).toBe('Notion')
  expect(connectorName('ccd_session', 'mark_chapter')).toBe('Claude app')
  expect(connectorName('some-new-server', 'x')).toBe('Some New Server')
  expect(describe('mcp__plugin_productivity_slack__slack_search_public', {}, HOME).label).toBe('Slack · search public')
})

test('tool calls read in plain words, and secrets in commands are hidden', async () => {
  expect(describe('Read', { file_path: '/Users/test/a/b.md' }, HOME)).toEqual({ kind: 'File read', label: 'b.md', dim: '~/a', live: 'Reading b.md' })
  expect(describe('Edit', {}, HOME).live, 'a missing path').toBe('Editing a file')
  expect(describe('WebFetch', { url: 'not a url' }, HOME).label).toBe('a web page')
  expect(describe('Agent', { description: 'Check the logs' }, HOME).kind).toBe('Subagent')
  expect(describe('TaskUpdate', {}, HOME).label).toBe('Update its to-do list')
  expect(describe('Weird', {}, HOME).live).toBe('Using Weird')
  const step = describe('Bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://x.dev?api_key=hunter22 sk-ABCDEFGHIJKLMNOP12' }, HOME)
  expect(step.label).not.toContain('abcdefghijklmnop')
  expect(step.label).not.toContain('hunter22')
  expect(step.label).not.toContain('ABCDEFGHIJKLMNOP')
  expect(scrub('TOKEN=abc123 run')).toBe('TOKEN=•••• run')
  expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(shortModel('haiku')).toBe('Haiku')
  expect(shortModel('gpt-x')).toBe('gpt-x')
  expect(workTokens({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 9999, cache_creation_input_tokens: 1 })).toBe(16)
})

test('the plan merge keeps done times, matches by id, and starts a new plan after a finished one', async () => {
  const t1 = '2026-01-01T00:00:00.000Z'
  const t2 = '2026-01-01T00:05:00.000Z'
  const a = mergePlan(null, 'Job', [{ text: 'A', status: 'completed' }, { text: 'B', status: 'in_progress' }], t1, 'Plan')
  expect(a.fresh).toBe(true)
  expect(a.justDone, 'a first list toasts nothing').toEqual([])
  const b = mergePlan(a.plan, undefined, [{ text: 'A', status: 'completed' }, { text: 'B', status: 'completed' }], t2, 'Plan')
  expect(b.justDone).toEqual(['B'])
  expect(b.plan.steps[0]!.doneAt, 'A keeps the time it was first done').toBe(t1)
  expect(b.becameDone).toBe(true)
  expect(b.plan.title, 'the title carries over').toBe('Job')
  const again = mergePlan(b.plan, undefined, [{ text: 'A', status: 'completed' }, { text: 'B', status: 'completed' }], t2, 'Plan')
  expect(again.becameDone, 'the same finished list is not news').toBe(false)
  const next = mergePlan(b.plan, undefined, [{ text: 'C', status: 'pending' }], t2, 'Fallback')
  expect(next.fresh).toBe(true)
  expect(next.plan.title).toBe('Fallback')
  const byId = mergePlan(a.plan, undefined, [{ text: 'Renamed', status: 'completed', id: 'k' }], t2, 'Plan')
  expect(byId.plan.steps[0]!.id).toBe('k')
  const dup = mergePlan(null, undefined, [{ text: 'Same', status: 'completed' }, { text: 'Same', status: 'pending' }], t1, 'Plan')
  expect(dup.plan.steps.map(s => s.status)).toEqual(['completed', 'pending'])
  expect(nowLine({ steps: [] })).toBe('')
  expect(nowLine({ steps: [{ text: 'x', status: 'completed' }] })).toBe('All steps done')
  expect(toStatus('Not started')).toBe('pending')
  expect(toStatus(7)).toBeUndefined()
  expect(readToolInput({ steps: 'no' })).toContain('Plan not saved')
  expect(readTodos({ todos: [{ content: '  ', status: 'pending' }, { content: 'ok' }] })).toEqual([{ text: 'ok', status: 'pending' }])
  expect(readPlanFile('junk')).toBeNull()
  expect(applyTaskTool(null, 'TaskUpdate', { taskId: 'zzz', status: 'completed' }, undefined), 'an unknown task with no subject').toBeUndefined()
  expect(applyTaskTool(null, 'TaskUpdate', { taskId: 'zzz', subject: 'Late', status: 'completed' }, undefined), 'an unknown task with a subject joins').toEqual([{ text: 'Late', status: 'completed', id: 'zzz' }])
})
