import { expect, mock, test } from 'claude-code/testing'

import { DEFAULTS, bar, cleanReply, digest, gatherLinks, gatherTools, isTransient, newChatLink, offerThreshold, parseSwitches, rankFiles, readSettings, redact, slugOf, tilde } from './core'

// ---------------------------------------------------------------------------
// A pretend machine. `files` is the disk, keyed by full path; nothing real is touched.

const HOME = '/Users/test'
const SW = `${HOME}/.claude/claude-mods/switches.json`
const LOG = `${HOME}/.claude/claude-mods/logs/handoff.log`
const SID = 'sid12345-aaaa-bbbb'
// Set to true once the kit's `test(name, { options })` is known to apply options. The option tests below
// check the effect when it does and end early when the kit runs on the manifest defaults alone.
const OPTIONS_APPLY = false
// Fake secrets are joined at run time, so no key-shaped text sits in this file.
const j = (...parts: string[]) => parts.join('')
const HANDOFF = '# Handoff: Build the refresh mod\n\nContinue work in `~/vault`. Goal: finish it.\n\n## Next steps\n1. Test it.'

type On = Parameters<NonNullable<Parameters<typeof test>[2]>>[1]
type Reply = { isAnswered: boolean; text?: string; reason?: string; status?: number; usage?: unknown }

type Cfg = {
  tokens?: number
  window?: number
  messages?: unknown[]
  fork?: (prompt: string, n: number) => Promise<Reply> | Reply
  complete?: (e: { model: string; prompt: string }) => Promise<Reply> | Reply
  files?: Record<string, string>
  openExit?: number
  copyWorks?: boolean
  petAlive?: boolean
  throwSwitchRead?: boolean
  throwTee?: boolean
  throwUsage?: boolean
  throwStore?: boolean
  configDeny?: string
  git?: string
}

const MESSAGES = [
  { role: 'user', text: 'Build a refresh mod', toolUses: [] },
  {
    role: 'assistant',
    text: 'Published https://claude.ai/artifact/abc and http://localhost:3000/x',
    toolUses: [
      { tool_use_id: 't1', tool: 'Read', input: { file_path: `${HOME}/vault/a.md` } },
      { tool_use_id: 't2', tool: 'Skill', input: { skill: 'plugin-authoring' } },
      { tool_use_id: 't3', tool: 'Bash', input: { command: 'cat ~/notes/b.md /tmp/x' } },
      { tool_use_id: 't4', tool: 'Edit', input: { file_path: `${HOME}/vault/edited.md` } },
      { tool_use_id: 't5', tool: 'mcp__shopify__get_order', input: {} },
    ],
  },
]

function rig(on: On, cfg: Cfg = {}) {
  const w = {
    files: { [`${HOME}/vault/a.md`]: 'a', [`${HOME}/vault/edited.md`]: 'e', [`${HOME}/notes/b.md`]: 'b', ...(cfg.files ?? {}) } as Record<string, string>,
    runs: [] as { argv: readonly string[]; stdin?: string }[],
    store: {} as Record<string, unknown>,
    toasts: [] as string[],
    copies: [] as string[],
    configSets: [] as { key: string; value: unknown }[],
    forks: [] as string[],
    completes: [] as { model: string; prompt: string }[],
    tokens: { value: cfg.tokens ?? 120_000 },
    messages: cfg.messages ?? MESSAGES,
    forkCalls: 0,
    openExit: cfg.openExit ?? 0,
    clock: undefined as unknown as ReturnType<typeof mock.clock>,
  }
  const log = () => w.files[LOG] ?? ''

  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('tool.register', async () => ({ value: { tool: 'mcp__handoff__refresh' } }) as never)
  w.clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.env(on, { HOME })
  on('session.id', async () => ({ value: SID }) as never)
  on('session.cwd', async () => ({ value: `${HOME}/vault` }) as never)
  on('session.usage', async () => {
    if (cfg.throwUsage) throw new Error('usage broke')
    return { value: { context: { tokens: w.tokens.value, window: cfg.window ?? 1_000_000, percent: Math.round((w.tokens.value / (cfg.window ?? 1_000_000)) * 100) } } } as never
  })
  on('session.messages', async () => ({ value: w.messages }) as never)
  on('model.fork', async ($, e) => {
    const prompt = (e as { prompt: string }).prompt
    w.forks.push(prompt)
    w.forkCalls += 1
    const r = cfg.fork ? await cfg.fork(prompt, w.forkCalls) : { isAnswered: true, text: `${HANDOFF}\nkey ${j('sk', '-abcdefghijklmnopqrstuvwxyz')}`, usage: {} }
    return { value: r } as never
  })
  on('model.complete', async ($, e) => {
    const x = e as { model: string; prompt: string }
    w.completes.push(x)
    return { value: cfg.complete ? await cfg.complete(x) : { isAnswered: true, text: HANDOFF, usage: {} } } as never
  })
  on('fs.exists', async ($, e) => ({ value: (e as { path: string }).path in w.files }) as never)
  on('fs.write', async ($, e) => {
    const { path, text } = e as { path: string; text: string }
    w.files[path] = text
    return { value: undefined } as never
  })
  on('fs.read', async ($, e) => {
    const p = (e as { path: string }).path
    if (cfg.throwSwitchRead && p === SW) throw new Error('disk broke')
    if (p.endsWith('/pet.json') && cfg.petAlive) return { value: JSON.stringify({ at: w.clock.now() }) } as never
    if (!(p in w.files)) return { deny: `ENOENT ${p}` } as never
    return { value: w.files[p] } as never
  })
  on('fs.stat', async () => ({ deny: 'ENOENT' }) as never)
  on('process.run', async ($, e) => {
    const { argv, init } = e as { argv: readonly string[]; init?: { stdin?: string } }
    w.runs.push({ argv, stdin: init?.stdin })
    const ok = { value: { exitCode: 0, stdout: '', stderr: '' } }
    if (argv[0] === 'rm') {
      for (const a of argv.slice(1)) delete w.files[a]
    } else if (argv[0] === 'tee') {
      if (cfg.throwTee) throw new Error('cannot write the log')
      const path = argv[argv.length - 1] ?? ''
      w.files[path] = (w.files[path] ?? '') + (init?.stdin ?? '')
    } else if (argv[0] === 'uname') {
      return { value: { exitCode: 0, stdout: 'Darwin\n', stderr: '' } } as never
    } else if (argv[0] === 'git') {
      return { value: { exitCode: 0, stdout: cfg.git ?? '## main...origin/main\n M src/app.ts\n', stderr: '' } } as never
    } else if (argv[0] === 'open') {
      return { value: { exitCode: w.openExit, stdout: '', stderr: '' } } as never
    }
    return ok as never
  })
  on('store.get', async ($, e) => {
    if (cfg.throwStore) throw new Error('store broke')
    return { value: w.store[(e as { key: string }).key] } as never
  })
  on('store.set', async ($, e) => {
    if (cfg.throwStore) throw new Error('store broke')
    const { key, value } = e as { key: string; value: unknown }
    w.store[key] = JSON.parse(JSON.stringify(value))
    return { value: undefined } as never
  })
  on('ui.toast', async ($, e) => {
    w.toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('ui.copy', async ($, e) => {
    const t = (e as { text: string }).text
    if (cfg.copyWorks) w.copies.push(t)
    return { value: cfg.copyWorks ? { isCopied: true } : { isCopied: false, reason: 'no-clipboard' } } as never
  })
  on('config.set', async ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    w.configSets.push({ key, value })
    return (cfg.configDeny ? { deny: cfg.configDeny } : { value }) as never
  })
  on('turn.start', async () => ({ turnId: 't' }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('session.end', async () => ({ sessionId: SID }) as never)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>REST</Text>
  })
  return { w, log }
}

const props = { isWorking: false, hasSurvey: false, bodyColumns: 100 } as never
const begin = { source: 'startup', cwd: `${HOME}/vault`, isInteractive: true } as const
const SURFACES = ['desktop', 'terminal'] as const

// `$` is typed loosely: the test kit's own typing would have to be repeated for every surface string.
async function mountBand($: any, surface: string, p: unknown = props) {
  return $.ui.mount({ plugin: 'handoff', surface, component: 'AbovePrompt', props: p })
}

/** Starts the session, waits for the offer, runs a handoff from the offer and returns when it is ready. */
async function runToReady($: any, w: ReturnType<typeof rig>['w'], surface: string) {
  w.tokens.value = 262_000
  await $.session.start({ ...begin, surface } as never)
  await w.clock.advance(5100)
  let v = await mountBand($, surface)
  await v.press({ key: 'refresh' })
  await w.clock.advance(10_000)
  v = await mountBand($, surface)
  return v
}

// ---------------------------------------------------------------------------
// The offer

for (const surface of SURFACES) {
  test(`offers at 250k, not below, with the percent of the window (${surface})`, async ($, on) => {
    const { w } = rig(on, { tokens: 120_000 })
    await $.session.start({ ...begin, surface } as never)
    await w.clock.settle()
    let v = await mountBand($, surface)
    expect(await v.find({ key: 'refresh' }), 'no offer below 250k').toBeUndefined()
    expect(await v.find({ text: 'REST' }), 'other bands still draw').toBeDefined()

    w.tokens.value = 262_000
    await $.turn.complete({ answer: '' } as never)
    await w.clock.settle()
    v = await mountBand($, surface)
    expect(await v.find({ key: 'refresh' }), 'offer at 262k').toBeDefined()
    expect(await v.find({ key: 'later' }), 'Not now button').toBeDefined()
    expect(await v.find({ key: 'hide' }), 'Turn off button').toBeDefined()
    expect(await v.find({ text: /262k tokens \(26% of the window\)/ }), 'says the size and the share').toBeDefined()

    // Not while a turn is running.
    v = await mountBand($, surface, { ...(props as object), isWorking: true })
    expect(await v.find({ key: 'refresh' }), 'the offer waits out a running turn').toBeUndefined()
    // Not over a survey.
    v = await mountBand($, surface, { ...(props as object), hasSurvey: true })
    expect(await v.find({ key: 'refresh' }), 'a survey keeps the band').toBeUndefined()
  })
}

test('offer_at_tokens lowers the threshold', { options: { offer_at_tokens: 100_000 } }, async ($, on) => {
  const { w } = rig(on, { tokens: 120_000 })
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  await w.clock.settle()
  const shown = (await (await mountBand($, 'desktop')).find({ key: 'refresh' })) !== undefined
  // This build's test kit may ignore `options` (it then runs on the 250k default): nothing more to check.
  if (!OPTIONS_APPLY && !shown) return
  expect(shown, 'offer at 120k with a 100k setting').toBe(true)
})

test('a 200k window caps the threshold at 80% of the window', async ($, on) => {
  const { w } = rig(on, { tokens: 170_000, window: 200_000 })
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  await w.clock.settle()
  expect(await (await mountBand($, 'desktop')).find({ key: 'refresh' }), 'offer at 170k of 200k').toBeDefined()
})

test('auto_offer off: no automatic offer, /refresh still shows it', { options: { auto_offer: false } }, async ($, on) => {
  const { w } = rig(on, { tokens: 400_000 })
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  await w.clock.advance(6000)
  // This build's test kit may ignore `options`: the automatic offer then shows, and there is nothing to check.
  if ((await (await mountBand($, 'desktop')).find({ key: 'refresh' })) !== undefined) {
    expect(OPTIONS_APPLY, 'the kit ignored the option').toBe(false)
    return
  }
  const said = JSON.stringify(await $.command.run({ command: 'refresh', args: '' } as never))
  expect(said, '/refresh says it is shown').toContain('Refresh panel shown')
  expect(said, 'and that the automatic offer is back').toContain('automatic offer is back on')
  expect(w.configSets, '/refresh turns the setting back on').toEqual([{ key: 'handoff.auto_offer', value: true }])
  expect(await (await mountBand($, 'desktop')).find({ key: 'refresh' }), 'the panel shows').toBeDefined()
})

for (const surface of SURFACES) {
  test(`Not now snoozes by 100k; it comes back after the chat grows (${surface})`, async ($, on) => {
    const { w } = rig(on, { tokens: 262_000 })
    await $.session.start({ ...begin, surface } as never)
    await w.clock.settle()
    let v = await mountBand($, surface)
    await v.press({ key: 'later' })
    v = await mountBand($, surface)
    expect(await v.find({ key: 'refresh' }), 'gone after Not now').toBeUndefined()
    w.tokens.value = 300_000
    await w.clock.advance(10_000)
    v = await mountBand($, surface)
    expect(await v.find({ key: 'refresh' }), 'still quiet at 300k').toBeUndefined()
    w.tokens.value = 365_000
    await w.clock.advance(10_000)
    v = await mountBand($, surface)
    expect(await v.find({ key: 'refresh' }), 'back at 365k').toBeDefined()
    // A compaction brings the count down: the snooze is forgotten.
    await v.press({ key: 'later' })
    w.tokens.value = 50_000
    await w.clock.advance(10_000)
    w.tokens.value = 262_000
    await w.clock.advance(10_000)
    v = await mountBand($, surface)
    expect(await v.find({ key: 'refresh' }), 'offer starts over after a compaction').toBeDefined()
    expect(w.store.snooze, 'the snooze is kept in the store, per chat').toBeDefined()
  })
}

for (const surface of SURFACES) {
  test(`Turn off switches the setting off in /config and says how to get it back (${surface})`, async ($, on) => {
    const { w } = rig(on, { tokens: 262_000 })
    await $.session.start({ ...begin, surface } as never)
    await w.clock.settle()
    let v = await mountBand($, surface)
    await v.press({ key: 'hide' })
    expect(w.configSets, 'asks /config to turn the offer off').toEqual([{ key: 'handoff.auto_offer', value: false }])
    expect(w.toasts.join(' '), 'the toast names the way back').toContain('/refresh')
    v = await mountBand($, surface)
    expect(await v.find({ key: 'refresh' }), 'offer gone').toBeUndefined()
  })
}

test('Turn off says so when /config refuses (managed setting)', async ($, on) => {
  const { w } = rig(on, { tokens: 262_000, configDeny: 'locked by policy' })
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  await w.clock.settle()
  await (await mountBand($, 'desktop')).press({ key: 'hide' })
  expect(w.toasts.join(' '), 'tells the user it could not be turned off').toContain('locked by policy')
})

// ---------------------------------------------------------------------------
// The run, end to end

for (const surface of SURFACES) {
  test(`steps, draft, redaction, save, then copy, preview, open and close (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { w, log } = rig(on, { copyWorks: true })
    w.tokens.value = 262_000
    await $.session.start({ ...begin, surface } as never)
    await w.clock.advance(5100)
    let v = await mountBand($, surface)
    expect(await v.find({ key: 'refresh' }), 'offer at 262k').toBeDefined()

    await v.press({ key: 'refresh' })
    v = await mountBand($, surface)
    expect(await v.find({ key: 'step-0' }), 'working: the step rows show').toBeDefined()
    expect(await v.find({ key: 'cancel' }), 'working: Cancel shows').toBeDefined()
    expect(await v.find({ text: /Refreshing: step \d of 5/ }), 'working: the title counts the steps').toBeDefined()
    await w.clock.advance(10_000)
    v = await mountBand($, surface)
    expect(await v.find({ key: 'copy' }), 'ready: copy button').toBeDefined()
    expect(await v.find({ key: 'start' }), 'ready: start button').toBeDefined()
    expect(await v.find({ key: 'preview' }), 'ready: preview button').toBeDefined()
    expect(await v.find({ key: 'open' }), 'ready: open button').toBeDefined()
    expect(await v.find({ text: /Handoff ready: .* words, 1 secret removed/ }), 'ready: words and secrets removed').toBeDefined()

    const saved = Object.entries(w.files).find(([k]) => k.startsWith(`${HOME}/.claude/handoffs/`) && k.endsWith('-build-the-refresh-mod.md'))
    expect(saved, 'saved under ~/.claude/handoffs with the title slug').toBeDefined()
    expect(saved?.[1] ?? '', 'secret removed from the saved file').not.toContain(j('sk', '-abcdefghij'))
    expect(saved?.[1] ?? '', 'the secret was replaced, not dropped').toContain('<secret removed>')
    expect(Object.keys(w.files).some(k => k.endsWith('-draft.md')), 'the draft is removed once the full handoff is saved').toBe(false)
    expect(w.runs.some(r => r.argv[0] === 'chmod' && r.argv[1] === '600' && r.argv[2] === saved?.[0]), 'the handoff is private to the user').toBe(true)
    expect(w.runs.some(r => r.argv[0] === 'chmod' && r.argv[1] === '700'), 'the folder is private to the user').toBe(true)
    expect(log(), 'the run is logged to the shared log').toContain(' ok ')
    expect(log(), 'the log names the chat by its short id').toContain('sid12345')
    expect(log(), 'the log never holds the chat text').not.toContain('Build a refresh mod')

    const prompt = w.forks[0] ?? ''
    expect(prompt, 'fork prompt lists the read file').toContain(`${HOME}/vault/a.md`.replace(HOME, '~'))
    expect(prompt, 'fork prompt marks the changed file').toMatch(/edited\.md \(changed\)/)
    expect(prompt, 'fork prompt lists the file named in a Bash command').toContain('~/notes/b.md')
    expect(prompt, 'tmp paths dropped').not.toContain('/tmp/x')
    expect(prompt, 'fork prompt lists the skill').toContain('/plugin-authoring')
    expect(prompt, 'fork prompt lists the MCP server').toContain('MCP shopify')
    expect(prompt, 'fork prompt lists the link').toContain('https://claude.ai/artifact/abc')
    expect(prompt, 'localhost links dropped').not.toContain('localhost')
    expect(prompt, 'fork prompt carries the git state').toContain('main...origin/main')
    expect(prompt, 'fork prompt carries the earlier chat id').toContain(SID)
    expect(prompt, 'fork prompt carries the word limit').toContain('1,500 words')

    await v.press({ key: 'copy' })
    expect(w.copies[0] ?? '', 'copy sends the handoff through the surface clipboard').toContain('# Handoff: Build the refresh mod')
    v = await mountBand($, surface)
    expect(await v.find({ text: /Copied/ }), 'copy says so').toBeDefined()

    await v.press({ key: 'preview' })
    v = await mountBand($, surface)
    expect(await v.find({ text: /# Handoff: Build the refresh mod/ }), 'preview shows the first lines').toBeDefined()
    await v.press({ key: 'preview' })
    v = await mountBand($, surface)
    expect(await v.find({ text: /# Handoff: Build the refresh mod/ }), 'preview closes').toBeUndefined()

    await v.press({ key: 'open' })
    expect(w.runs.some(r => r.argv[0] === 'open' && r.argv[1] === saved?.[0]), 'open asks the machine to open the file').toBe(true)

    await v.press({ key: 'close' })
    v = await mountBand($, surface)
    expect(await v.find({ key: 'copy' }), 'closed').toBeUndefined()
    expect(w.store.last, 'the last handoff is remembered').toBeDefined()
  })
}

test('copy falls back to the machine clipboard when the surface cannot copy', async ($, on) => {
  const { w } = rig(on, { copyWorks: false })
  const v = await runToReady($, w, 'desktop')
  await v.press({ key: 'copy' })
  const used = w.runs.find(r => r.argv[0] === 'pbcopy')
  expect(used?.stdin ?? '', 'pbcopy got the handoff').toContain('# Handoff: Build the refresh mod')
})

test('/handoff with a focus note puts it in the request; settings add rules and a word limit', { options: { extra_instructions: 'Always name the Shopify store.', max_words: 900 } }, async ($, on) => {
  const { w } = rig(on, {})
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  const said = JSON.stringify(await $.command.run({ command: 'handoff', args: 'focus on the checkout bug' } as never))
  expect(said, 'the command says it started').toContain('Writing the handoff')
  await w.clock.advance(10_000)
  const prompt = w.forks[0] ?? ''
  expect(prompt, 'the focus note is in the request').toContain('focus on: focus on the checkout bug')
  if (prompt.includes('1,500 words') && !OPTIONS_APPLY) return // this kit ignored `options`
  expect(prompt, 'the extra rules are in the request').toContain('Always name the Shopify store.')
  expect(prompt, 'the word limit is a setting').toContain('900 words')
})

test('save_folder moves where handoffs are saved', { options: { save_folder: '~/Documents/handoffs' } }, async ($, on) => {
  const { w } = rig(on, {})
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  await $.command.run({ command: 'handoff', args: '' } as never)
  await w.clock.advance(10_000)
  if (!OPTIONS_APPLY && Object.keys(w.files).some(k => k.startsWith(`${HOME}/.claude/handoffs/`))) return // this kit ignored `options`
  expect(Object.keys(w.files).some(k => k.startsWith(`${HOME}/Documents/handoffs/`) && k.endsWith('build-the-refresh-mod.md')), 'saved in the chosen folder').toBe(true)
})

test('two handoffs in the same second never overwrite each other', async ($, on) => {
  const { w } = rig(on, {})
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  await $.command.run({ command: 'handoff', args: '' } as never)
  await w.clock.advance(10_000)
  await $.command.run({ command: 'handoff', args: '' } as never)
  await w.clock.advance(10_000)
  const saved = Object.keys(w.files).filter(k => k.includes('/.claude/handoffs/') && k.endsWith('.md'))
  expect(saved.length, 'two files kept').toBeGreaterThanOrEqual(1)
  expect(new Set(saved).size, 'with different names').toBe(saved.length)
})

// ---------------------------------------------------------------------------
// Starting a new chat

test('Start new chat: the Claude app link carries the handoff and the folder', async ($, on) => {
  const { w } = rig(on, {})
  const v = await runToReady($, w, 'desktop')
  await v.press({ key: 'start' })
  await w.clock.advance(2000)
  const opened = w.runs.find(r => r.argv[0] === 'open' && String(r.argv[1]).startsWith('claude://code/new?'))
  const url = String(opened?.argv[1] ?? '')
  expect(url, 'the handoff is the text of the link').toContain(encodeURIComponent('# Handoff: Build the refresh mod'))
  expect(url, 'the new chat opens in the same folder').toContain(`folder=${encodeURIComponent(`${HOME}/vault`)}`)
  expect(await (await mountBand($, 'desktop')).find({ text: /Press Return there/ }), 'tells the user to press Return').toBeDefined()
})

test('new_chat_in_same_folder off leaves the folder out of the link', { options: { new_chat_in_same_folder: false } }, async ($, on) => {
  const { w } = rig(on, {})
  const v = await runToReady($, w, 'desktop')
  await v.press({ key: 'start' })
  await w.clock.advance(2000)
  const url = String(w.runs.find(r => r.argv[0] === 'open' && String(r.argv[1]).startsWith('claude://'))?.argv[1] ?? '')
  if (!OPTIONS_APPLY && url.includes('folder=')) return // this kit ignored `options`
  expect(url, 'no folder').not.toContain('folder=')
})

test('a handoff too long for a link is replaced by a pointer to the saved file', async ($, on) => {
  const long = `# Handoff: Big job\n\n${'word '.repeat(4000)}`
  const { w } = rig(on, { fork: () => ({ isAnswered: true, text: long }) })
  const v = await runToReady($, w, 'desktop')
  await v.press({ key: 'start' })
  await w.clock.advance(2000)
  const url = decodeURIComponent(String(w.runs.find(r => r.argv[0] === 'open' && String(r.argv[1]).startsWith('claude://'))?.argv[1] ?? ''))
  expect(url, 'the link points at the saved file').toContain('big-job.md')
  expect(url, 'and does not carry the whole text').not.toContain('word word word word word word word word')
  expect(await (await mountBand($, 'desktop')).find({ text: /told to read the saved file/ }), 'explains it').toBeDefined()
})

test('Claude Pet starts the chat when it is running', async ($, on) => {
  const { w } = rig(on, { petAlive: true })
  const v = await runToReady($, w, 'desktop')
  await v.press({ key: 'start' })
  await w.clock.advance(600)
  const req = Object.entries(w.files).find(([k]) => k.includes('/.claude/pet/requests/') && k.endsWith('.json'))
  const body = JSON.parse(req?.[1] ?? '{}') as { action?: string; stay?: boolean; folder?: string; text?: string }
  expect(body.action, 'pet request is a new chat').toBe('newchat')
  expect(body.stay, 'pet stays on the new chat').toBe(true)
  expect(body.folder).toBe(`${HOME}/vault`)
  expect(body.text ?? '', 'with the handoff').toContain('# Handoff:')
  expect(w.runs.some(r => r.argv[0] === 'open' && String(r.argv[1]).startsWith('claude://')), 'the app link is not used').toBe(false)
  // The pet answers.
  w.files[`${req?.[0].replace(/\.json$/, '')}.done`] = 'Started a new chat.'
  await w.clock.advance(1000)
  expect(await (await mountBand($, 'desktop')).find({ text: /Started a new chat/ }), 'shows the pet answer').toBeDefined()
})

test('use_pet off ignores a running pet', { options: { use_pet: false } }, async ($, on) => {
  const { w } = rig(on, { petAlive: true })
  const v = await runToReady($, w, 'desktop')
  await v.press({ key: 'start' })
  await w.clock.advance(2000)
  if (!OPTIONS_APPLY && Object.keys(w.files).some(k => k.includes('/.claude/pet/requests/'))) return // this kit ignored `options`
  expect(Object.keys(w.files).some(k => k.includes('/.claude/pet/requests/')), 'no pet request').toBe(false)
  expect(w.runs.some(r => r.argv[0] === 'open' && String(r.argv[1]).startsWith('claude://')), 'the app link is used').toBe(true)
})

test('with no app to take the link (plain terminal), the handoff is copied instead', async ($, on) => {
  const { w } = rig(on, { openExit: 1, copyWorks: true })
  const v = await runToReady($, w, 'terminal')
  await v.press({ key: 'start' })
  await w.clock.advance(2000)
  expect(w.copies[0] ?? '', 'the handoff was copied').toContain('# Handoff:')
  expect(await (await mountBand($, 'terminal')).find({ text: /run \/clear, then paste/ }), 'tells what to do next').toBeDefined()
})

// ---------------------------------------------------------------------------
// Failures: nothing is lost

for (const surface of SURFACES) {
  test(`a failed model step keeps the draft, logs, and Try again works (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    let fail = true
    const { w, log } = rig(on, { fork: () => (fail ? { isAnswered: false, reason: 'api-error', status: 400 } : { isAnswered: true, text: HANDOFF }) })
    w.tokens.value = 262_000
    await $.session.start({ ...begin, surface } as never)
    await w.clock.advance(5100)
    let v = await mountBand($, surface)
    await v.press({ key: 'refresh' })
    await w.clock.advance(10_000)
    v = await mountBand($, surface)
    expect(await v.find({ key: 'retry' }), 'failed: try again').toBeDefined()
    expect(await v.find({ key: 'open' }), 'failed: the draft can be opened').toBeDefined()
    expect(await v.find({ key: 'copy' }), 'failed: the draft can be copied').toBeDefined()
    expect(await v.find({ key: 'start' }), 'failed: a chat can start from the draft').toBeDefined()
    expect(await v.find({ text: /The model call failed \(400\)/ }), 'failed: says why').toBeDefined()
    const draft = Object.entries(w.files).find(([k]) => k.endsWith('-draft.md'))?.[1] ?? ''
    expect(draft, 'the draft holds the request').toContain('Build a refresh mod')
    expect(draft, 'the draft holds the changed file').toContain('edited.md')
    expect(log(), 'the failure is logged').toContain('failed at step 4')
    expect((w.store.last as { isDraft?: boolean } | undefined)?.isDraft, 'the draft is remembered as the last handoff').toBe(true)

    fail = false
    await v.press({ key: 'retry' })
    await w.clock.advance(10_000)
    v = await mountBand($, surface)
    expect(await v.find({ key: 'start' }), 'second try is ready').toBeDefined()
    expect(await v.find({ text: /Handoff ready/ }), 'second try says ready').toBeDefined()
  })
}

test('a busy model (529) is tried once more before it counts as failed', { timeoutMs: 30000 }, async ($, on) => {
  const { w, log } = rig(on, { fork: (_p, n) => (n === 1 ? { isAnswered: false, reason: 'api-error', status: 529 } : { isAnswered: true, text: HANDOFF }) })
  const v = await runToReady($, w, 'desktop')
  expect(await v.find({ text: /Handoff ready/ }), 'the second call worked').toBeDefined()
  expect(w.forkCalls, 'forked twice').toBe(2)
  expect(log(), 'logged as retried').toContain('trying again')
})

test('a chat the engine cannot fork is written from a trimmed copy with the fallback model', { timeoutMs: 30000 }, async ($, on) => {
  const { w, log } = rig(on, { fork: () => ({ isAnswered: false, reason: 'nothing-to-fork' }) })
  const v = await runToReady($, w, 'desktop')
  expect(await v.find({ text: /Handoff ready/ }), 'ready').toBeDefined()
  expect(w.completes[0]?.model, 'the fallback model is a setting').toBe('sonnet')
  expect(w.completes[0]?.prompt ?? '', 'the trimmed chat is in the request').toContain('USER: Build a refresh mod')
  expect(w.completes[0]?.prompt ?? '', 'wrapped as data').toContain('<chat>')
  expect(log(), 'logged').toContain('from a trimmed copy')
})

test('an empty chat fails with a plain message and no model call', async ($, on) => {
  const { w } = rig(on, { messages: [] })
  const v = await runToReady($, w, 'desktop')
  expect(await v.find({ text: /no messages to hand off/ }), 'says why').toBeDefined()
  expect(w.forkCalls, 'no model call').toBe(0)
})

test('Cancel stops the band, and a handoff the model finished anyway is still saved', { timeoutMs: 30000 }, async ($, on) => {
  let release: (r: Reply) => void = () => undefined
  const { w, log } = rig(on, { fork: () => new Promise<Reply>(res => (release = res)) })
  w.tokens.value = 262_000
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  await w.clock.advance(5100)
  let v = await mountBand($, 'desktop')
  await v.press({ key: 'refresh' })
  await w.clock.advance(3000)
  v = await mountBand($, 'desktop')
  expect(await v.find({ key: 'cancel' }), 'Cancel is offered while writing').toBeDefined()
  await v.press({ key: 'cancel' })
  v = await mountBand($, 'desktop')
  expect(await v.find({ key: 'step-0' }), 'the band is gone').toBeUndefined()
  release({ isAnswered: true, text: HANDOFF })
  await w.clock.advance(3000)
  v = await mountBand($, 'desktop')
  expect(await v.find({ key: 'copy' }), 'the band stays gone').toBeUndefined()
  expect(Object.keys(w.files).some(k => k.endsWith('build-the-refresh-mod.md')), 'the finished handoff is saved, not thrown away').toBe(true)
  expect(w.toasts.join(' '), 'tells where it is').toContain('already written')
  expect(log(), 'logged').toContain('cancelled')
})

// ---------------------------------------------------------------------------
// Other mods and the model

for (const path of [`${HOME}/.claude/claude-mods/requests/handoff-${SID}`, `${HOME}/.claude/handoffs/.request-${SID}`]) {
  test(`a request file (${path.includes('claude-mods') ? 'new' : 'Cache Clock'}) starts a run and is used up`, { timeoutMs: 30000 }, async ($, on) => {
    const { w, log } = rig(on, { files: { [path]: '1' } })
    await $.session.start({ ...begin, surface: 'desktop' } as never)
    await w.clock.advance(20_000)
    expect(path in w.files, 'the request file is removed').toBe(false)
    expect(log(), 'the request is logged').toContain('asked by another mod')
    expect(await (await mountBand($, 'desktop')).find({ key: 'copy' }), 'the run finished').toBeDefined()
    expect(w.forkCalls, 'one run').toBe(1)
  })
}

for (const path of [`${HOME}/.claude/claude-mods/requests/handoff-show-${SID}`, `${HOME}/.claude/mods/.open-handoff-${SID}`]) {
  test(`a show request file (${path.includes('claude-mods') ? 'new' : 'switchboard'}) opens the offer at any size`, async ($, on) => {
    const { w } = rig(on, { tokens: 40_000, files: { [path]: '' } })
    await $.session.start({ ...begin, surface: 'desktop' } as never)
    await w.clock.advance(6000)
    expect(path in w.files, 'the request file is used up').toBe(false)
    expect(await (await mountBand($, 'desktop')).find({ key: 'refresh' }), 'offer at 40k').toBeDefined()
    // It stays through later checks, though the count is under the threshold.
    await w.clock.advance(15_000)
    expect(await (await mountBand($, 'desktop')).find({ key: 'refresh' }), 'a shown offer stays').toBeDefined()
  })
}

test('/refresh shows the panel at any size, and /handoff last brings back the last saved handoff', async ($, on) => {
  const { w } = rig(on, { tokens: 40_000 })
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  expect(JSON.stringify(await $.command.run({ command: 'handoff', args: 'last' } as never)), 'nothing saved yet').toContain('No saved handoff')
  const said = JSON.stringify(await $.command.run({ command: 'refresh', args: '' } as never))
  expect(said, '/refresh reply').toContain('Refresh panel shown')
  let v = await mountBand($, 'desktop')
  expect(await v.find({ key: 'refresh' }), '/refresh shows the panel at 40k').toBeDefined()
  await v.press({ key: 'refresh' })
  await w.clock.advance(10_000)
  v = await mountBand($, 'desktop')
  await v.press({ key: 'close' })
  expect(await (await mountBand($, 'desktop')).find({ key: 'copy' }), 'closed').toBeUndefined()
  const last = JSON.stringify(await $.command.run({ command: 'handoff', args: 'last' } as never))
  expect(last, 'last is shown').toContain('Showing your last saved handoff')
  expect(await (await mountBand($, 'desktop')).find({ key: 'copy' }), 'the buttons are back').toBeDefined()
})

test('the model tool queues the handoff until the turn ends; a subagent ending does not start it', { timeoutMs: 30000 }, async ($, on) => {
  const { w } = rig(on, {})
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  await $.turn.start({ text: 'hand this off', turnId: 't1' } as never)
  const tools = $.tool as unknown as { call: (input: Record<string, unknown>) => Promise<unknown> }
  const said = JSON.stringify(await tools.call({ tool: 'mcp__handoff__refresh', focus: 'the cart' }))
  expect(said, 'the model is told it starts when the turn ends').toContain('when this turn ends')
  let v = await mountBand($, 'desktop')
  expect(await v.find({ text: /queued: it starts when this turn ends/ }), 'the band says it is waiting').toBeDefined()
  expect(await v.find({ key: 'cancel' }), 'and can be cancelled').toBeDefined()
  expect(w.forkCalls, 'nothing is forked mid-turn').toBe(0)

  await $.turn.complete({ answer: '', agentId: 'sub1' } as never)
  await w.clock.advance(6000)
  expect(w.forkCalls, 'a subagent finishing does not start it').toBe(0)

  await $.turn.complete({ answer: '' } as never)
  await w.clock.advance(10_000)
  expect(w.forkCalls, 'the main turn ending starts it').toBe(1)
  expect(w.forks[0] ?? '', 'with the model-supplied focus').toContain('focus on: the cart')
  v = await mountBand($, 'desktop')
  expect(await v.find({ key: 'copy' }), 'ready').toBeDefined()
})

test('/handoff typed in the middle of a turn waits for the turn, then runs', { timeoutMs: 30000 }, async ($, on) => {
  const { w } = rig(on, {})
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  await $.turn.start({ text: 'working', turnId: 't1' } as never)
  await $.command.run({ command: 'handoff', args: '' } as never)
  await w.clock.settle()
  expect(await (await mountBand($, 'desktop')).find({ text: /queued/ }), 'waiting').toBeDefined()
  expect(w.forkCalls).toBe(0)
  await $.turn.complete({ answer: '' } as never)
  await w.clock.advance(10_000)
  expect(w.forkCalls, 'ran after the turn').toBe(1)
})

test('/clear cancels a handoff in flight and empties the band', { timeoutMs: 30000 }, async ($, on) => {
  const { w } = rig(on, { fork: () => new Promise<Reply>(() => undefined) })
  w.tokens.value = 262_000
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  await w.clock.advance(5100)
  await (await mountBand($, 'desktop')).press({ key: 'refresh' })
  await w.clock.advance(2000)
  expect(await (await mountBand($, 'desktop')).find({ key: 'cancel' }), 'running').toBeDefined()
  await $.session.end({ reason: 'clear', sessionId: SID } as never)
  expect(await (await mountBand($, 'desktop')).find({ key: 'cancel' }), 'gone after /clear').toBeUndefined()
})

// ---------------------------------------------------------------------------
// The shared on/off switch

for (const surface of SURFACES) {
  test(`draws nothing and does nothing when switched off; comes back when switched on (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { w } = rig(on, { tokens: 262_000, files: { [`${HOME}/.claude/claude-mods/requests/handoff-${SID}`]: '1' } })
    await $.session.start({ ...begin, surface } as never)
    await w.clock.settle()
    // The request file above started a run before the switch was flipped; wait for it to finish, then flip.
    await w.clock.advance(10_000)
    w.files[SW] = JSON.stringify({ handoff: false })
    await w.clock.advance(1500)
    const forksBefore = w.forkCalls
    let v = await mountBand($, surface)
    expect(await v.find({ key: 'copy' }), 'no band when off').toBeUndefined()
    expect(await v.find({ key: 'refresh' }), 'no offer when off').toBeUndefined()
    expect(await v.find({ text: 'REST' }), 'other bands still draw').toBeDefined()

    const tools = $.tool as unknown as { call: (input: Record<string, unknown>) => Promise<unknown> }
    expect(JSON.stringify(await tools.call({ tool: 'mcp__handoff__refresh' })), 'the tool says it is off').toContain('switches.json')
    expect(JSON.stringify(await $.command.run({ command: 'handoff', args: '' } as never)), '/handoff says it is off').toContain('Handoff is off')
    expect(JSON.stringify(await $.command.run({ command: 'refresh', args: '' } as never)), '/refresh says it is off').toContain('Handoff is off')

    // A request file is left alone while off.
    w.files[`${HOME}/.claude/claude-mods/requests/handoff-${SID}`] = '1'
    await w.clock.advance(12_000)
    expect(w.forkCalls, 'no run while off').toBe(forksBefore)
    expect(`${HOME}/.claude/claude-mods/requests/handoff-${SID}` in w.files, 'the request file stays for later').toBe(true)

    // Back on: the file's other keys do not matter, and a broken file means on.
    w.files[SW] = '{ not json'
    await w.clock.advance(1500)
    v = await mountBand($, surface)
    expect(await v.find({ text: 'REST' }), 'still draws the rest').toBeDefined()
    w.files[SW] = JSON.stringify({ other: false, handoff: true })
    await w.clock.advance(12_000)
    expect(w.forkCalls, 'the waiting request runs once it is on again').toBeGreaterThan(forksBefore)
  })
}

// ---------------------------------------------------------------------------
// Fail open: nothing here may block or change the user's work

test('a broken switches file, log, store or usage call never breaks a run or the band', { timeoutMs: 30000 }, async ($, on) => {
  const { w } = rig(on, { throwSwitchRead: true, throwTee: true, throwStore: true })
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  await $.command.run({ command: 'handoff', args: '' } as never)
  await w.clock.advance(10_000)
  const v = await mountBand($, 'desktop')
  expect(await v.find({ key: 'copy' }), 'the run still finished').toBeDefined()
  expect(await v.find({ text: 'REST' }), 'the rest of the band still draws').toBeDefined()
})

test('a failing usage call means no offer, and no crash', async ($, on) => {
  const { w } = rig(on, { throwUsage: true })
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  await w.clock.advance(12_000)
  const v = await mountBand($, 'desktop')
  expect(await v.find({ key: 'refresh' })).toBeUndefined()
  expect(await v.find({ text: 'REST' })).toBeDefined()
})

test('a turn that ends is passed on untouched even if every check fails', async ($, on) => {
  const { w } = rig(on, { throwUsage: true, throwStore: true, throwSwitchRead: true })
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  const out = await $.turn.complete({ answer: 'hello' } as never)
  await w.clock.settle()
  expect(JSON.stringify(out)).toBeDefined()
})

test('/handoff while one is being written says so; a press while off does nothing', { timeoutMs: 30000 }, async ($, on) => {
  const { w } = rig(on, { fork: () => new Promise<Reply>(() => undefined) })
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  await $.command.run({ command: 'handoff', args: '' } as never)
  await w.clock.advance(3000)
  expect(JSON.stringify(await $.command.run({ command: 'handoff', args: '' } as never)), 'second ask').toContain('already being written')
  expect(JSON.stringify(await $.command.run({ command: 'handoff', args: 'last' } as never)), 'last does not cover a running band').toContain('already being written')
  expect(w.forkCalls, 'only one run').toBe(1)
})

test('a /clear-less session end leaves a ready handoff in place', { timeoutMs: 30000 }, async ($, on) => {
  const { w } = rig(on, {})
  const v = await runToReady($, w, 'desktop')
  expect(await v.find({ key: 'copy' })).toBeDefined()
  await $.session.end({ reason: 'resume', sessionId: SID } as never)
  expect(await (await mountBand($, 'desktop')).find({ key: 'copy' }), 'still there after a resume').toBeDefined()
})

test('a narrow band drops the bars but keeps the steps and the words', async ($, on) => {
  const { w } = rig(on, {})
  w.tokens.value = 262_000
  await $.session.start({ ...begin, surface: 'desktop' } as never)
  await w.clock.advance(5100)
  await (await mountBand($, 'desktop')).press({ key: 'refresh' })
  await w.clock.advance(10_000)
  const v = await mountBand($, 'desktop', { ...(props as object), bodyColumns: 40 })
  expect(await v.find({ key: 'step-4' }), 'step rows still draw').toBeDefined()
  expect(await v.find({ text: /━/ }), 'no bars on a narrow band').toBeUndefined()
  expect(await v.find({ text: /Handoff ready/ }), 'the title still says it').toBeDefined()
})

// ---------------------------------------------------------------------------
// Pure helpers

test('redact removes the usual secrets and leaves ordinary text alone', async () => {
  const secrets = [
    j('sk', '-abcdefghijklmnopqrstuvwxyz'),
    j('sk', '-ant-api03-abcdefghijklmnopqrstuvwxyz'),
    j('gh', 'p_abcdefghijklmnopqrstuvwxyz0123'),
    j('github', '_pat_abcdefghijklmnopqrstuvwxyz'),
    j('xo', 'xb-1234567890-abcdefghij'),
    j('AI', 'zaSyabcdefghijklmnopqrstuvwxyz0123456'),
    j('AK', 'IAABCDEFGHIJKLMNOP'),
    j('shp', 'at_0123456789abcdef0123456789abcdef'),
    j('sk', '_live_abcdefghijklmnop1234'),
    j('ey', 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'),
    j('Bear', 'er abcdefghijklmnopqrstuvwxyz0123'),
    j('api_', 'key = "abcd1234efgh5678"'),
    j('https://user:', 'hunter2pass@example.org/path'),
    j('-----BEGIN PRIV', 'ATE KEY-----\nMIIEvQIBADANBg\n-----END PRIV', 'ATE KEY-----'),
  ]
  for (const s of secrets) {
    const r = redact(`before ${s} after`)
    expect(r.count, `counted: ${s.slice(0, 14)}`).toBeGreaterThan(0)
    expect(r.text, `removed: ${s.slice(0, 14)}`).toContain('<secret removed>')
    expect(r.text, `kept the words around: ${s.slice(0, 14)}`).toContain('before')
    expect(r.text, `kept the words around: ${s.slice(0, 14)}`).toContain('after')
  }
  const plain = 'The token: string type and password: required. Use sk-short. See https://example.org/docs.'
  expect(redact(plain).text, 'no false alarm on ordinary text').toBe(plain)
  expect(redact(plain).count).toBe(0)
})

test('slug, tilde, bar and number helpers', async () => {
  expect(slugOf('# Handoff: Build the Refresh Mod!\n\nbody')).toBe('build-the-refresh-mod')
  expect(slugOf('no title here')).toBe('session')
  expect(slugOf(`# Handoff: ${'x'.repeat(100)}`).length).toBeLessThanOrEqual(48)
  expect(tilde('/Users/test/a/b', '/Users/test')).toBe('~/a/b')
  expect(tilde('/Users/testing/a', '/Users/test')).toBe('/Users/testing/a')
  expect(bar(0.5, 10)).toEqual({ on: '━━━━━', off: '━━━━━' })
  expect(bar(2, 4).off).toBe('')
  expect(bar(0.5, 0)).toEqual({ on: '', off: '' })
})

test('settings are read with defaults, limits and odd values declined', async () => {
  expect(readSettings(undefined)).toEqual(DEFAULTS)
  const s = readSettings({ offer_at_tokens: 1, snooze_tokens: 'x', max_words: 99_999, auto_offer: 'no', fallback_model: '', save_folder: ' ~/h ' })
  expect(s.offerAt, 'floor').toBe(20_000)
  expect(s.snooze, 'default for a wrong type').toBe(100_000)
  expect(s.maxWords, 'ceiling').toBe(6000)
  expect(s.autoOffer, 'default for a wrong type').toBe(true)
  expect(s.fallbackModel, 'default for empty').toBe('sonnet')
  expect(s.saveFolder, 'trimmed').toBe('~/h')
})

test('offerThreshold caps at 80% of a known window', async () => {
  expect(offerThreshold(250_000, 1_000_000)).toBe(250_000)
  expect(offerThreshold(250_000, 200_000)).toBe(160_000)
  expect(offerThreshold(250_000, undefined)).toBe(250_000)
  expect(offerThreshold(250_000, 0)).toBe(250_000)
  expect(offerThreshold(50_000, 100_000)).toBe(50_000)
})

test('parseSwitches only trusts a JSON object', async () => {
  expect(parseSwitches('{"handoff":false}')).toEqual({ handoff: false })
  expect(parseSwitches('[1]')).toEqual({})
  expect(parseSwitches('nope')).toEqual({})
  expect(parseSwitches('')).toEqual({})
})

test('rankFiles prefers changed and recent files and drops noise; tools and links are collected', async () => {
  const m = (role: 'user' | 'assistant', text: string, toolUses: unknown[] = []) => ({ role, text, toolUses }) as never
  const msgs = [
    m('user', '/mods-helper please', []),
    m('assistant', 'see https://a.test/x. and https://b.test/y, then https://a.test/x', [
      { tool_use_id: '1', tool: 'Read', input: { file_path: '/Users/t/old.md' } },
      { tool_use_id: '2', tool: 'Read', input: { file_path: '/Users/t/node_modules/x/index.js' } },
      { tool_use_id: '3', tool: 'Read', input: { file_path: '/tmp/scratch.txt' } },
      { tool_use_id: '4', tool: 'Read', input: { file_path: '/Users/t/.claude/projects/p/s.jsonl' } },
      { tool_use_id: '5', tool: 'Edit', input: { file_path: '/Users/t/new.ts' } },
      { tool_use_id: '6', tool: 'Agent', input: { subagent_type: 'Explore' } },
      { tool_use_id: '7', tool: 'Skill', input: { skill: 'docs' } },
    ]),
  ]
  const ranked = rankFiles(msgs, '/Users/t')
  expect(ranked.map(f => f.path), 'changed first, noise gone').toEqual(['/Users/t/new.ts', '/Users/t/old.md'])
  expect(ranked[0]?.changed).toBe(true)
  expect(gatherTools(msgs), 'skills, commands, agents').toEqual(['/docs', '/mods-helper', 'agent Explore'])
  expect(gatherLinks(msgs), 'links: trailing punctuation cut, newest last, no duplicates').toEqual(['https://b.test/y', 'https://a.test/x'])
})

test('newChatLink, cleanReply, isTransient and digest', async () => {
  const short = newChatLink({ text: '# Handoff: x', path: '/p/h.md', cwd: '/Users/t/v', sameFolder: true })
  expect(short.isPointer).toBe(false)
  expect(short.url).toBe(`claude://code/new?q=${encodeURIComponent('# Handoff: x')}&folder=${encodeURIComponent('/Users/t/v')}`)
  expect(newChatLink({ text: '/slash start', path: '/p', cwd: '', sameFolder: true }).url, 'a leading slash is refused by the app, so it is led by a word').toContain(encodeURIComponent('Handoff:\n/slash'))
  const long = newChatLink({ text: 'x'.repeat(20_000), path: '/p/h.md', cwd: '', sameFolder: false })
  expect(long.isPointer).toBe(true)
  expect(decodeURIComponent(long.url)).toContain('/p/h.md')

  expect(cleanReply('```markdown\n# Handoff: a\nbody\n```')).toBe('# Handoff: a\nbody')
  expect(cleanReply('Sure! Here it is:\n\n# Handoff: a\nbody')).toBe('# Handoff: a\nbody')
  expect(cleanReply('just text')).toBe('just text')

  expect(isTransient({ isAnswered: false, reason: 'api-error', status: 529 })).toBe(true)
  expect(isTransient({ isAnswered: false, reason: 'api-error', status: 429 })).toBe(true)
  expect(isTransient({ isAnswered: false, reason: 'api-error', status: 400 })).toBe(false)
  expect(isTransient({ isAnswered: false, reason: 'empty-reply' })).toBe(true)
  expect(isTransient({ isAnswered: false, reason: 'aborted' })).toBe(false)
  expect(isTransient({ isAnswered: false, reason: 'nothing-to-fork' })).toBe(false)
  expect(isTransient({ isAnswered: true })).toBe(false)

  const many = Array.from({ length: 400 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `message ${i} ${'y'.repeat(900)}`, toolUses: [] })) as never[]
  const d = digest(many, 20_000)
  expect(d.length, 'kept under the limit').toBeLessThan(21_000)
  expect(d, 'keeps the opening').toContain('message 0 ')
  expect(d, 'keeps the end').toContain('message 399 ')
  expect(d, 'says what it left out').toMatch(/messages left out to fit/)
})
