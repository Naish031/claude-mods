import { expect, test } from 'claude-code/testing'

import type { Inventory } from '../types'
import { cliHits, hitsOf, humanTool, isSpillPath, parseExtraCli, redact, summaryOf, type CliOptions } from './collect'
import { TILE_COLORS, isHidden, nameConnector, tileColor, tileLetters, tileSvg, tidyServerLabel, whiteContrast } from './connectors'
import { appendLog, logLine, parseFlags, parseOptions, withHidden } from './infra'
import { applyCalls, emptyInventory, inventoryText, renameConnector, withMemory } from './inventory'
import { planAfter, planFromFile, stepsOf, wrapLines } from './plan'

// Pure helpers. They never touch the engine, so each test just checks values.

const FAKE_SK = `sk${'-live-'}abcdefghijkl`
const NONE: CliOptions = { extra: '', hidden: () => false }
const ctx = { wire: new Map<string, string>(), servers: {} as Record<string, string> }
const id = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, '0')}`

test('connector names: readable servers, claude.ai ids, learned servers, numbered unknowns', async () => {
  const n = (tool: string, c = ctx) => nameConnector(tool, c).name
  expect(n('mcp__shopify__get-shop-info')).toBe('Shopify')
  expect(n('mcp__plugin_productivity_notion__notion-fetch')).toBe('Notion')
  expect(n('mcp__claude_ai_Slack__slack_search_public')).toBe('Slack')
  expect(n('mcp__claude-in-chrome__navigate')).toBe('Claude in Chrome')
  expect(n('mcp__Claude_Browser__navigate')).toBe('Browser pane')
  expect(n('mcp__plugin_engineering_github__list_issues')).toBe('GitHub')
  expect(n('mcp__acme-crm__find_lead')).toBe('Acme Crm')
  expect(n('mcp__Claude_Code_iOS_Simulator__control')).toBe('Claude Code iOS Simulator')
  expect(n('mcp__ccd_session__mark_chapter')).toBe('')
  expect(n('mcp__plugin-authoring__scan_secrets')).toBe('')
  expect(n('Bash')).toBe('')
  expect(n(`mcp__${id('1')}__list_events`)).toBe('Google Calendar')
  expect(n(`mcp__${id('1')}__notion-calendar-list-events`)).toBe('Notion')
  expect(n(`mcp__${id('2')}__create-product`)).toBe('Shopify')
  expect(n(`mcp__${id('3')}__list_repos`)).toBe('GitBot')
  expect(n(`mcp__${id('4')}__get_values`)).toBe('Google Sheets')
  expect(n(`mcp__${id('5')}__read_file_content`)).toBe('Google Drive')
  // A tool that fits no rule is named by its server's learned name, else numbered.
  expect(n(`mcp__${id('3')}__review`, { wire: new Map(), servers: { [id('3')]: 'GitBot' } })).toBe('GitBot')
  const first = nameConnector(`mcp__${id('9')}__go`, ctx)
  expect(first.name).toBe('Connector 1')
  expect(first.learn).toEqual({ server: id('9'), name: 'Connector 1' })
  const second = nameConnector(`mcp__${id('8')}__go`, { wire: new Map(), servers: { [id('9')]: 'Connector 1', [id('7')]: 'Connector 4' } })
  expect(second.name, 'numbers never repeat').toBe('Connector 5')
})

test('the app-reported server name wins, and is tidied', async () => {
  const wire = new Map([[`mcp__${id('1')}__guide`, 'claude.ai Google Docs']])
  expect(nameConnector(`mcp__${id('1')}__guide`, { wire, servers: {} }).name).toBe('Google Docs')
  expect(tidyServerLabel('claude.ai Gmail')).toBe('Gmail')
  expect(tidyServerLabel('plugin:productivity:notion')).toBe('Notion')
  expect(tidyServerLabel(id('1'))).toBe('')
  expect(isHidden('GitHub', 'terminal, github')).toBe(true)
  expect(isHidden('Gmail', 'terminal, github')).toBe(false)
  expect(isHidden('Gmail', '')).toBe(false)
})

test('tile colours: dark enough for white text, stable, with sensible letters', async () => {
  for (const c of TILE_COLORS) expect(whiteContrast(c), `${c} contrast`).toBeGreaterThanOrEqual(4.5)
  for (const key of ['shopify', 'figma', 'notion', 'slack', 'gmail', 'googlecalendar', 'googledrive', 'github', 'gitbot', 'claudeinchrome', 'browserpane', 'zzz', 'acmecrm'])
    expect(whiteContrast(tileColor(key)), `${key} contrast`).toBeGreaterThanOrEqual(4.5)
  expect(tileColor('acmecrm')).toBe(tileColor('acmecrm'))
  expect(tileLetters('Gmail')).toBe('G')
  expect(tileLetters('Google Calendar')).toBe('GC')
  expect(tileLetters('Connector 2')).toBe('C2')
  expect(tileSvg('x', '<b>&')).not.toContain('<b>')
  expect(tileSvg('gmail', 'Gmail')).toContain('<svg')
})

test('tool names read as plain words', async () => {
  expect(humanTool('mcp__plugin_demo_fireflies__fireflies_get_transcripts', 'Fireflies')).toBe('get transcripts')
  expect(humanTool('mcp__x__notion-calendar-list-events', 'Notion')).toBe('calendar list events')
  expect(humanTool('mcp__x__getThread', 'Gmail')).toBe('get thread')
  expect(humanTool('mcp__x__slack_send_message', 'Slack')).toBe('send message')
})

test('call summaries show the main argument and never a secret', async () => {
  expect(summaryOf({ query: 'offer from Sam', limit: 5 })).toBe('offer from Sam')
  expect(summaryOf({ file_path: '/Users/x/docs/offer.md' })).toBe('offer.md')
  expect(summaryOf({ limit: 5, token: 'abc', note: 'hello' })).toBe('hello')
  expect(summaryOf({ api_key: 'abc', password: 'p' })).toBe('')
  expect(summaryOf({ query: FAKE_SK })).toBe('')
  expect(summaryOf({ count: 3 })).toBe('count 3')
  expect(summaryOf({ query: 'x'.repeat(200) }).length).toBe(60)
  expect(redact(`curl -H "Authorization: Bearer abc123" --token zzz ${FAKE_SK}`)).not.toMatch(/abc123|zzz|abcdefghij/)
})

test('command line tools: command words only, not text, scripts or look-alikes', async () => {
  const names = (c: string, o: CliOptions = NONE) => cliHits(c, false, false, o).map(h => (h.kind === 'connector' ? `${h.name}|${h.tool}` : ''))
  expect(names('gh pr list --limit 5')).toEqual(['GitHub|pr list'])
  expect(names('cd x && GH_TOKEN=abc gh issue list')).toEqual(['GitHub|issue list'])
  expect(names('sudo gh auth status')).toEqual(['GitHub|auth status'])
  expect(names('npx shopify theme dev')).toEqual(['Shopify|theme dev'])
  expect(names('/opt/homebrew/bin/gh pr view 3')).toEqual(['GitHub|pr view'])
  expect(names(`gws gmail users messages list --params '{"q":"from:sam"}'`)).toEqual(['Gmail|users messages list'])
  expect(names('gws calendar events list')).toEqual(['Google Calendar|events list'])
  expect(names('gws something')).toEqual(['Google Workspace|something'])
  expect(names('echo "gh pr list"; echo gwsx; ls ~/gws')).toEqual([])
  expect(names("cat <<'EOF'\ngh pr create\nEOF")).toEqual([])
  expect(names('git commit -m "run gh pr list"')).toEqual([])
  expect(names('gh pr list | head -3 && gh pr list')).toEqual(['GitHub|pr list'])
  expect(names('gh pr list; gh issue list')).toEqual(['GitHub|pr list', 'GitHub|issue list'])
  expect(names('aws s3 ls')).toEqual([])
  expect(names('aws s3 ls', { extra: 'aws=AWS, bad cmd=x', hidden: () => false })).toEqual(['AWS|s3 ls'])
  expect(names('gh pr list', { extra: '', hidden: n => n === 'GitHub' })).toEqual([])
  expect(Object.keys(parseExtraCli('aws=AWS, firecrawl , =x, a b=c'))).toEqual(['aws', 'firecrawl'])
  expect(parseExtraCli('firecrawl')['firecrawl']?.name).toBe('firecrawl')
  const web = cliHits('curl https://example.com/a?token=abc', false, false, { extra: 'curl=Web', hidden: () => false })
  expect(web[0]?.kind === 'connector' ? web[0].summary : '').not.toContain('abc')
})

test('what each tool call adds', async () => {
  const facts = (tool: string, input: Record<string, unknown>, failed = false) => ({ tool, input, failed, helper: false })
  const k = (tool: string, input: Record<string, unknown>, failed = false) => hitsOf(facts(tool, input, failed), ctx, NONE).map(h => h.kind)
  expect(k('Read', { file_path: '/Users/x/a.md' })).toEqual(['file'])
  expect(k('Read', { file_path: '/Users/x/.claude/skills/foo/SKILL.md' })).toEqual(['skill'])
  expect(k('Read', { file_path: '/private/tmp/x' })).toEqual([])
  expect(k('Read', { file_path: '/Users/x/a.md' }, true)).toEqual([])
  expect(k('Edit', { file_path: '/Users/x/a.md' })).toEqual(['file'])
  expect(k('Write', { file_path: '/Users/x/a.md' })).toEqual(['file'])
  expect(k('NotebookEdit', { notebook_path: '/Users/x/a.ipynb' })).toEqual(['file'])
  expect(k('Skill', { skill: '/video-prep' })).toEqual(['skill'])
  expect(k('Skill', {})).toEqual([])
  expect(k('Glob', { pattern: '*' })).toEqual([])
  expect(k('mcp__helper-desk__plan', {})).toEqual([])
  expect(k('mcp__ccd_host__reveal_path', {})).toEqual([])
  const failed = hitsOf(facts('mcp__shopify__get-shop-info', {}, true), ctx, NONE)[0]
  expect(failed?.kind === 'connector' && failed.failed).toBe(true)
  expect(isSpillPath('/Users/x/.claude/projects/-Users-x/0f1e2d3c-1111-2222-3333-444455556666/tool-results/a.txt')).toBe(true)
  expect(isSpillPath('/Users/x/work/a.md')).toBe(false)
})

test('the to-do list from each plan tool, and from a plan file', async () => {
  const empty = { title: '', steps: [], updatedAt: 0 }
  const todo = planAfter(empty, 'TodoWrite', { todos: [{ content: 'A', status: 'completed', activeForm: 'Doing A' }, { content: 'B', status: 'weird' }, { nope: 1 }, null] }, undefined, 5)
  expect(todo?.steps).toEqual([{ text: 'A', status: 'completed', active: 'Doing A' }, { text: 'B', status: 'pending' }])
  expect(planAfter(empty, 'TaskCreate', { subject: ' ' }, undefined, 1)).toBeNull()
  let p = planAfter(empty, 'TaskCreate', { subject: 'One' }, { task: { id: 'x1' } }, 1)!
  p = planAfter(p, 'TaskCreate', { subject: 'Two' }, undefined, 2)!
  expect(p.steps.map(s => s.id)).toEqual(['x1', '2'])
  expect(planAfter(p, 'TaskUpdate', { taskId: 'zzz', status: 'completed' }, undefined, 3)).toBeNull()
  expect(planAfter(p, 'TaskUpdate', { taskId: 'x1', status: 'completed' }, undefined, 3)?.steps[0]?.status).toBe('completed')
  expect(planAfter(p, 'TaskUpdate', { taskId: 'x1', status: 'deleted' }, undefined, 3)?.steps.length).toBe(1)
  expect(planAfter(p, 'Bash', {}, undefined, 3)).toBeNull()
  // Positions stand in for ids when the list was built before ids were seen.
  const bare = { title: '', steps: [{ text: 'A', status: 'pending' as const }, { text: 'B', status: 'pending' as const }], updatedAt: 1 }
  expect(planAfter(bare, 'TaskUpdate', { taskId: '2', status: 'completed' }, undefined, 2)?.steps[1]?.status).toBe('completed')
  expect(stepsOf('nope', ['text'])).toEqual([])

  const file = { title: 'T', steps: [{ text: 'A', status: 'in_progress' }], updatedAt: '2026-10-16T09:00:00.000Z' }
  const older = { title: '', steps: [], updatedAt: Date.parse('2026-10-16T10:00:00.000Z') }
  expect(planFromFile(older, file)).toBeNull()
  expect(planFromFile(older, { steps: [] })).toBeNull()
  const kept = planFromFile({ title: '', steps: [{ text: 'A', status: 'pending', active: 'Doing A', id: '3' }], updatedAt: 1 }, file)
  expect(kept?.steps[0]).toEqual({ text: 'A', status: 'in_progress', active: 'Doing A', id: '3' })
})

test('wrapping keeps every line inside the width', async () => {
  const lines = wrapLines('Pull every Stripe charge for the last thirty days and match each one', 20)
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(20)
  expect(wrapLines('a'.repeat(50), 20).every(l => l.length <= 20)).toBe(true)
  expect(wrapLines('', 20)).toEqual([''])
})

test('the inventory counts once per call id, keeps tool counts, merges a guess into the real name', async () => {
  let inv: Inventory = emptyInventory('s1')
  const hit = (tool: string, failed = false, learn?: { server: string; name: string }) => ({ kind: 'connector' as const, name: learn?.name ?? 'Gmail', ...(learn ? { learn } : {}), tool, summary: '', cli: false, failed, helper: false })
  inv = applyCalls(inv, [
    { id: 'a', time: 1, hits: [hit('search threads')] },
    { id: 'a', time: 2, hits: [hit('search threads')] },
    { id: 'b', time: 3, hits: [hit('search threads', true)] },
    { id: 'c', time: 4, hits: [hit('get thread')] },
    { id: 'd', time: 5, hits: [{ kind: 'file', path: '/x/a.md', mode: 'read' }, { kind: 'file', path: '/x/a.md', mode: 'edit' }] },
    { id: 'slash:foo:#', time: 6, hits: [{ kind: 'skill', name: 'foo' }] },
    { id: 'slash:foo:#', time: 7, hits: [{ kind: 'skill', name: 'foo' }] },
    { id: 'slash:foo:1', time: 8, hits: [{ kind: 'skill', name: 'foo' }] },
  ])
  const g = inv.connectors[0]!
  expect(g.count, 'id a counted once').toBe(3)
  expect(g.failed).toBe(1)
  expect(g.tools).toEqual([{ tool: 'search threads', count: 2, failed: 1 }, { tool: 'get thread', count: 1, failed: 0 }])
  expect(inv.files[0]).toMatchObject({ path: '/x/a.md', read: true, edited: true })
  expect(inv.skills[0]?.count, 'typed twice counts twice, a repeat of the first does not').toBe(2)
  // Many calls: the call list is capped, the counts are not.
  const many = applyCalls(emptyInventory('s'), Array.from({ length: 250 }, (_, i) => ({ id: `m${i}`, time: i, hits: [hit('x')] })))
  expect(many.connectors[0]?.count).toBe(250)
  expect(many.connectors[0]?.calls.length).toBe(200)
  // A server first guessed as Connector 1 turns out to be Gmail.
  let guess = applyCalls(emptyInventory('s'), [{ id: 'g1', time: 1, hits: [hit('go', false, { server: 'srv', name: 'Connector 1' })] }])
  guess = applyCalls(guess, [{ id: 'g0', time: 0, hits: [hit('search threads')] }])
  guess = applyCalls(guess, [{ id: 'g2', time: 2, hits: [hit('go', false, { server: 'srv', name: 'Gmail' })] }])
  expect(guess.connectors.length).toBe(1)
  expect(guess.connectors[0]).toMatchObject({ name: 'Gmail', count: 3 })
  expect(renameConnector(guess.connectors, 'Nope', 'X')).toBe(guess.connectors)
})

test('memory files and always-loaded skills join the inventory', async () => {
  const inv = withMemory(emptyInventory('s'), ['/h/vault/CLAUDE.md', '/h/dev/foo/SKILL.md'])
  expect(inv.files.map(f => f.path)).toEqual(['/h/vault/CLAUDE.md'])
  expect(inv.files[0]?.auto).toBe(true)
  expect(inv.skills[0]).toMatchObject({ name: 'foo', always: true, count: 0 })
  expect(withMemory(inv, [])).toBe(inv)
})

test('the plain-text copy lists every section', async () => {
  let inv = emptyInventory('s')
  inv = applyCalls(inv, [
    { id: '1', time: 1, hits: [{ kind: 'connector', name: 'Gmail', tool: 'search threads', summary: 'q', cli: false, failed: true, helper: false }, { kind: 'file', path: '/h/a.md', mode: 'read' }, { kind: 'skill', name: 'foo' }] },
    { id: '2', time: 2, hits: [{ kind: 'connector', name: 'GitHub', tool: 'pr list', summary: '', cli: true, failed: false, helper: false }] },
    { id: '3', time: 3, hits: [], plan: { tool: 'TodoWrite', input: { todos: [{ content: 'Do', status: 'in_progress', activeForm: 'Doing' }] }, result: undefined } },
  ])
  const text = inventoryText(inv, '/h')
  for (const part of ['In this chat', 'To-do (0 of 1)', '[>] Do', 'Connectors (2)', 'Gmail: 1 call, 1 failed', 'search threads x1 (1 failed)', 'GitHub: 1 call via CLI', 'Context files (1)', '~/a.md (read)', 'Skills (1)', '/foo (1 use)'])
    expect(text, part).toContain(part)
  expect(text).not.toContain('summary')
  expect(inventoryText(emptyInventory('s'), '')).toContain('To-do: none')
})

test('the switch file: off, hidden, broken, and a write that keeps the other keys', async () => {
  expect(parseFlags('{"chat-inventory": false}')).toEqual({ off: true, hidden: false })
  expect(parseFlags('{"chat-inventory": true, "chat-inventory:hidden": true}')).toEqual({ off: false, hidden: true })
  expect(parseFlags('{"other": false}')).toEqual({ off: false, hidden: false })
  expect(parseFlags('not json')).toEqual({ off: false, hidden: false })
  expect(parseFlags('[1]')).toEqual({ off: false, hidden: false })
  expect(parseFlags('')).toEqual({ off: false, hidden: false })
  expect(JSON.parse(withHidden(undefined, true))).toEqual({ 'chat-inventory:hidden': true })
  expect(JSON.parse(withHidden('{"a":1,"chat-inventory:hidden":true}', false))).toEqual({ a: 1 })
  expect(() => withHidden('{ broken', true)).toThrow()
  expect(() => withHidden('[1]', true)).toThrow()
})

test('the log keeps 300 lines and one line per event', async () => {
  const old = Array.from({ length: 400 }, (_, i) => `l${i}`).join('\n')
  const out = appendLog(old, logLine(0, 'hidden', ''))
  expect(out.split('\n').filter(Boolean).length).toBe(300)
  expect(out.endsWith('hidden\n')).toBe(true)
  expect(logLine(0, 'copy', 'a\nb  c')).toBe('1970-01-01T00:00:00.000Z copy: a b c')
})

test('the three settings fall back to their defaults', async () => {
  expect(parseOptions(undefined)).toEqual({ autoOpen: true, hideConnectors: '', extraCliTools: '' })
  expect(parseOptions({ autoOpen: false, hideConnectors: 'A, B', extraCliTools: 'aws=AWS' })).toEqual({ autoOpen: false, hideConnectors: 'A, B', extraCliTools: 'aws=AWS' })
  expect(parseOptions({ autoOpen: 'no', hideConnectors: 3, extraCliTools: null })).toEqual({ autoOpen: true, hideConnectors: '', extraCliTools: '' })
  expect(parseOptions('x')).toEqual({ autoOpen: true, hideConnectors: '', extraCliTools: '' })
})
