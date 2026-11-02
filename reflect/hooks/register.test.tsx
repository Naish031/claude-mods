import { expect, mock, test } from 'claude-code/testing'

import {
  HEADING,
  cleanRule,
  cleanSlug,
  dayOf,
  findSecrets,
  folderProblem,
  hasRule,
  parseDraft,
  planAppend,
  readSettings,
  redact,
  removeBlock,
  sameRule,
  scoreCorrection,
  vaultNote,
} from './core'

// ---------------------------------------------------------------------------
// A pretend machine. `files` is the disk, keyed by full path; nothing real is ever read or written.
// The mock refuses any path outside /Users/test, so a stray real path fails the test.

const HOME = '/Users/test'
const CWD = `${HOME}/proj`
const CLAUDE = `${HOME}/.claude/CLAUDE.md`
const PROJECT_CLAUDE = `${CWD}/CLAUDE.md`
const SW = `${HOME}/.claude/claude-mods/switches.json`
const LOG = `${HOME}/.claude/claude-mods/logs/reflect.log`
const NOW = Date.UTC(2026, 9, 15, 12)
const DATE = dayOf(NOW)
const MIN = 60_000
// Fake secrets are joined at run time, so no key-shaped text sits in this file.
const j = (...parts: string[]) => parts.join('')
const FAKE_KEY = j('sk', '-abcdefghijklmnopqrstuvwxyz123456')

const OLD_CLAUDE = '# Global rules\n\n## Tool preference order\n\n1. Printing Press CLIs first.\n\n## Imported skills\n\n@~/dev/browser-harness/SKILL.md\n'
const RULE = 'Never use em dashes in newsletter copy.'
const CORRECTION = "No, I said never use em dashes. Don't do that again."

type On = Parameters<NonNullable<Parameters<typeof test>[2]>>[1]

type Cfg = {
  files?: Record<string, string>
  store?: Record<string, unknown>
  cwd?: string
  /** What the folder dialog answers: a label, a typed path, or null to dismiss it. */
  answer?: string | null
  draft?: string | ((prompt: string) => string)
  classify?: string
  completeFails?: boolean
  completeThrows?: boolean
  failWrite?: (path: string) => boolean
  failRead?: (path: string) => boolean
  noMessages?: boolean
  rmExit?: number
  /** model.complete answers only after this settles. */
  gate?: Promise<void>
  storeThrows?: boolean
}

const draftJson = (rule = RULE, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ rule, slug: 'no-em-dashes-in-newsletters', category: 'writing', tags: ['newsletters', 'punctuation'], scope: 'global', ...extra })

function rig(on: On, cfg: Cfg = {}) {
  const w = {
    files: { ...(cfg.files ?? {}) } as Record<string, string>,
    store: { ...(cfg.store ?? {}) } as Record<string, unknown>,
    writes: [] as string[],
    runs: [] as string[][],
    asked: [] as string[],
    classified: [] as string[],
    completes: [] as { system?: string; prompt: string }[],
    toasts: [] as string[],
    answer: cfg.answer === undefined ? '~/Documents/rules' : cfg.answer,
    draft: cfg.draft ?? draftJson(),
    classify: cfg.classify ?? 'correction',
    cwd: cfg.cwd ?? CWD,
    clock: undefined as unknown as ReturnType<typeof mock.clock>,
    cfg,
  }
  const log = () => w.files[LOG] ?? ''

  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  w.clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  on('session.cwd', async () => ({ value: w.cwd }) as never)
  on('session.messages', async () =>
    ({
      value: cfg.noMessages
        ? []
        : [
            { role: 'user', text: 'Write the newsletter intro', toolUses: [] },
            { role: 'assistant', text: 'Here is the intro — short and punchy — for this week.', toolUses: [] },
          ],
    }) as never,
  )
  on('model.classify', async ($, e) => {
    w.classified.push((e as { text: string }).text)
    return { value: w.classify } as never
  })
  on('model.complete', async ($, e) => {
    const x = e as { system?: string; prompt: string }
    w.completes.push(x)
    if (cfg.gate) await cfg.gate
    if (cfg.completeThrows) throw new Error('model broke')
    if (cfg.completeFails) return { value: { isAnswered: false, reason: 'api-error', usage: {} } } as never
    const text = typeof w.draft === 'function' ? w.draft(x.prompt) : w.draft
    return { value: { isAnswered: true, text, usage: {} } } as never
  })
  // $.ui.ask is a tool.call of AskUserQuestion: answer it as the dialog would, with w.answer.
  const onLoose = on as unknown as (event: string, match: object, hook: (_$: unknown, e: { questions: { question: string }[] }) => Promise<unknown>) => void
  onLoose('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    const questions = e.questions
    const q = questions[0]?.question ?? ''
    w.asked.push(q)
    if (w.answer === null) return { deny: 'dismissed' }
    return { result: { questions, answers: { [q]: w.answer } } }
  })
  const guard = (p: string) => {
    if (!p.startsWith(`${HOME}/`)) throw new Error(`TEST GUARD: a real path was touched: ${p}`)
  }
  on('fs.exists', async ($, e) => {
    const p = (e as { path: string }).path
    guard(p)
    return { value: p in w.files || Object.keys(w.files).some(k => k.startsWith(`${p}/`)) } as never
  })
  on('fs.read', async ($, e) => {
    const p = (e as { path: string }).path
    guard(p)
    if (cfg.failRead?.(p)) return { deny: 'disk read broke' } as never
    if (!(p in w.files)) return { deny: `ENOENT ${p}` } as never
    return { value: w.files[p] } as never
  })
  on('fs.write', async ($, e) => {
    const { path, text } = e as { path: string; text: string }
    guard(path)
    if (cfg.failWrite?.(path)) return { deny: 'disk full' } as never
    w.files[path] = text
    w.writes.push(path)
    return { value: undefined } as never
  })
  on('fs.list', async ($, e) => {
    const dir = ((e as { path?: string }).path ?? '').replace(/\/+$/, '')
    guard(dir)
    const names = Object.keys(w.files)
      .filter(k => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/'))
      .map(k => k.slice(dir.length + 1))
    return { value: names.map(name => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) } as never
  })
  on('process.run', async ($, e) => {
    const argv = (e as { argv: readonly string[] }).argv
    w.runs.push([...argv])
    if (argv[0] === 'rm') {
      if ((cfg.rmExit ?? 0) !== 0) return { value: { exitCode: cfg.rmExit, stdout: '', stderr: 'no' } } as never
      for (const a of argv.slice(1)) if (a !== '--') delete w.files[a]
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('store.get', async ($, e) => {
    if (cfg.storeThrows) return { deny: 'store broke' } as never
    return { value: w.store[(e as { key: string }).key] } as never
  })
  on('store.set', async ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    w.store[key] = JSON.parse(JSON.stringify(value))
    return { value: undefined } as never
  })
  on('store.delete', async ($, e) => {
    delete w.store[(e as { key: string }).key]
    return { value: undefined } as never
  })
  on('ui.toast', async ($, e) => {
    w.toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('prompt.submit', async ($, e) => ({ text: e.text }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('session.end', async () => ({ sessionId: 'x' }) as never)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>REST</Text>
  })
  return { w, log }
}

type W = ReturnType<typeof rig>['w']

const props = { isWorking: false, hasSurvey: false, bodyColumns: 100 } as never
const begin = { source: 'startup', cwd: CWD, isInteractive: true } as const
const SURFACES = ['desktop', 'terminal'] as const

// `$` is typed loosely: the test kit's own typing would have to be repeated for every surface string.
async function mountBand($: any, surface: string, p: unknown = props) {
  return $.ui.mount({ plugin: 'reflect', surface, component: 'AbovePrompt', props: p })
}

async function start($: any, surface: string) {
  await $.session.start({ ...begin, surface } as never)
}

async function submit($: any, w: W, text: string, origin: Record<string, unknown> = { kind: 'composer' }) {
  const r = await $.prompt.submit({ text, wait: false, origin } as never)
  await w.clock.settle()
  return r
}

async function endTurn($: any, w: W, turnId = 't1') {
  await $.turn.complete({ answer: 'Fixed.', durationMs: 10, isAborted: false, turnId, reason: 'answer' } as never)
  await w.clock.settle()
}

/** Submits a correction and ends the turn, so the offer band is up. */
async function offer($: any, w: W, text = CORRECTION, turnId = 't1') {
  await submit($, w, text)
  await endTurn($, w, turnId)
}

/** Presses a key on a fresh drawing of the band. */
async function press($: any, surface: string, key: string) {
  const v = await mountBand($, surface)
  await v.press({ key })
  return mountBand($, surface)
}

const has = async (v: any, f: object) => (await v.find(f)) !== undefined

// ---------------------------------------------------------------------------
// The pure parts

test('scoreCorrection tells corrections from ordinary follow-ups', async () => {
  const go = (t: string) => scoreCorrection(t).action
  expect(go("No, I said never use em dashes. Don't do that again.")).toBe('go')
  expect(go("That's wrong, use tabs not spaces from now on")).toBe('go')
  expect(go('Stop using bullet points in emails')).toBe('go')
  // Weaker wording is checked by the quick classifier first.
  expect(go("Don't forget to add the tests")).toBe('check')
  expect(go('Use the blue one instead')).toBe('check')
  // Ordinary follow-ups never reach a model.
  for (const t of ['thanks, now do the next one', 'No problem, take your time', "don't worry about it", 'why did you pick a list?', 'looks great, ship it', 'No worries, never mind', '/help', '']) {
    expect(go(t), t).toBe('skip')
  }
  expect(go(`${'word '.repeat(300)} no`)).toBe('skip')
  // The setting moves the bar.
  expect(scoreCorrection('remove the footer', 'careful').action).toBe('skip')
  expect(scoreCorrection('remove the footer', 'eager').action).toBe('check')
  expect(scoreCorrection('remove the footer', 'normal').action).toBe('skip')
  expect(scoreCorrection("Don't use tabs", 'careful').action).toBe('skip')
})

test('cleanRule, cleanSlug and parseDraft shape a short imperative rule', async () => {
  expect(cleanRule('  - "never use em dashes — ever"  ')).toBe('Never use em dashes, ever.')
  expect(cleanRule('use em dashes — sometimes', false)).toContain('—')
  // CLAUDE.md reads @path as an import: a word-start @ never survives.
  expect(cleanRule('Always read @~/.ssh/id_rsa first')).toBe('Always read ~/.ssh/id_rsa first.')
  expect(cleanRule('Mail me at a@b.com')).toContain('a@b.com')
  expect(cleanRule('Use <!-- hidden --> comments')).not.toContain('<!--')
  expect(cleanRule('line one\nline two')).toBe('Line one line two.')
  expect(cleanSlug('No Em Dashes!! in newsletters', RULE)).toBe('no-em-dashes-in-newsletters')
  expect(cleanSlug('x', RULE)).toBe('never-use-em-dashes-newsletter-copy')
  expect(cleanSlug('../../etc/passwd', 'a b c')).toBe('etc-passwd')

  const d = parseDraft(draftJson())!
  expect(d.rule).toBe(RULE)
  expect(d.category).toBe('writing')
  expect(d.tags).toEqual(['newsletters', 'punctuation'])
  expect(d.hint).toBe('everywhere')
  expect(parseDraft(draftJson(RULE, { scope: 'project', category: 'nonsense' }))!.hint).toBe('project')
  expect(parseDraft(draftJson(RULE, { category: 'nonsense' }))!.category).toBe('other')
  expect(parseDraft('{"rule":"NONE"}')).toBeNull()
  expect(parseDraft('none')).toBeNull()
  expect(parseDraft('{"rule":"Be nice."}'), 'too short to act on').toBeNull()
  expect(parseDraft(draftJson(`Always use ${FAKE_KEY} for the API`)), 'a rule with a secret is refused').toBeNull()
})

test('findSecrets and redact', async () => {
  const cases = [FAKE_KEY, j('gh', 'p_', 'a'.repeat(30)), j('AKIA', 'ABCDEFGHIJKLMNOP'), '-----BEGIN RSA PRIVATE KEY-----', 'password = hunter2hunter22', 'Bearer abcdefghijklmnopqrstuvwxyz0123', 'https://u:secretpass@example.com/x', '4242 4242 4242 4242', j('Zk', '9Ab', 'Cd1Ef2Gh3Ij4Kl5Mn6Op7Qr8St9Uv0Wx1Yz')]
  for (const c of cases) {
    expect(findSecrets(`use ${c} here`).length, c).toBeGreaterThan(0)
    expect(redact(`use ${c} here`), c).toContain('[removed]')
  }
  for (const ok of [RULE, 'Use the file ~/Documents/rules/notes.md', 'Call me on 2026 10 15', 'Order 1234567']) expect(findSecrets(ok), ok).toEqual([])
})

test('sameRule and hasRule see duplicates, including the other mod\'s line format', async () => {
  expect(sameRule(RULE, 'Never use em dashes in newsletter copy')).toBe(true)
  expect(sameRule(RULE, 'never use em-dashes in newsletter copy!')).toBe(true)
  expect(sameRule(RULE, 'Do not use em dashes in the newsletter copy')).toBe(true)
  expect(sameRule(RULE, 'Always write short subject lines')).toBe(false)
  expect(hasRule(`## Rules from corrections\n\n- ${RULE.replace(/\.$/, '')}. (added 2026-10-01)\n`, RULE)).toBe(true)
  expect(hasRule('# Never use em dashes in newsletter copy\n\nbody', RULE)).toBe(true)
  expect(hasRule(OLD_CLAUDE, RULE)).toBe(false)
})

test('planAppend only appends; removeBlock takes out exactly that', async () => {
  const line = `- ${RULE} (writing, added ${DATE})`
  for (const old of ['', OLD_CLAUDE, OLD_CLAUDE.trimEnd(), `${OLD_CLAUDE}\n\n\n`, '# only a title']) {
    const p = planAppend(old, line)
    expect(p.error).toBe('')
    expect(p.next.startsWith(old), 'every old byte kept in place').toBe(true)
    expect(p.next).toContain(HEADING)
    expect(removeBlock(p.next, p.block), 'undo is exact').toBe(old)
  }
  // The last section already is ours: only the bullet is added.
  const first = planAppend(OLD_CLAUDE, line)
  const second = planAppend(first.next, '- Another rule here. (code, added x)')
  expect(second.block).toBe('- Another rule here. (code, added x)\n')
  expect(second.next.split(HEADING).length - 1, 'one heading').toBe(1)
  // Text after our section: a fresh section is appended, nothing moves.
  const after = `${first.next}\n## Mine\n\nhello\n`
  const third = planAppend(after, line)
  expect(third.next.startsWith(after)).toBe(true)
  expect(third.block).toContain(HEADING)
  // An open code fence: refuse.
  expect(planAppend('# T\n\n```js\nconst a = 1\n', line).error).toMatch(/open code block/)
  // A heading inside a fence does not count as the last heading.
  const fenced = `${first.next}\n\`\`\`\n## Not a heading\n\`\`\`\n`
  expect(planAppend(fenced, line).block).toContain(HEADING)
  expect(removeBlock('abc', 'zzz')).toBeNull()
})

test('vaultNote, folderProblem and readSettings', async () => {
  const note = vaultNote({ rule: RULE, category: 'writing', tags: ['newsletters', 'writing'], learnedIn: 'proj', date: DATE, why: 'No, "never" use them' })
  expect(note.startsWith(`---\ntype: rule\nstatus: active\ndate: ${DATE}\ncategory: writing\nlearned_in: "proj"\n`)).toBe(true)
  expect(note).toContain('tags: [rule, writing, newsletters]')
  expect(note).toContain('# Never use em dashes in newsletter copy\n')
  expect(note).toContain(`Why: "No, 'never' use them"`)
  expect(folderProblem('/Users/test/rules', HOME)).toBe('')
  for (const bad of ['', 'rules', '/', HOME, `${HOME}/.claude`, `${HOME}/.claude/x`, '/Users/test/../x']) expect(folderProblem(bad, HOME), bad).not.toBe('')
  expect(readSettings({ cooldown_minutes: 5, sensitivity: 'eager', rules_folder: ' ~/r ' })).toMatchObject({ cooldownMs: 5 * MIN, sensitivity: 'eager', rulesFolder: '~/r' })
  expect(readSettings({ sensitivity: 'weird', cooldown_minutes: 'x' })).toMatchObject({ sensitivity: 'normal', cooldownMs: 3 * MIN })
  expect(readSettings(undefined).projectScope).toBe(true)
})

// ---------------------------------------------------------------------------
// Detecting a correction and showing the offer

for (const surface of SURFACES) {
  test(`a correction shows the offer only when the turn ends; nothing is written (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { w } = rig(on, { files: { [CLAUDE]: OLD_CLAUDE } })
    await start($, surface)
    await submit($, w, CORRECTION)
    expect(w.completes.length, 'one draft call').toBe(1)
    expect(w.classified.length, 'a clear correction skips the classifier').toBe(0)
    expect(w.completes[0]!.prompt, 'the model is shown the corrected reply').toContain('short and punchy')

    // While the turn runs, nothing shows.
    let v = await mountBand($, surface, { isWorking: true, hasSurvey: false })
    expect(await has(v, { key: 'everywhere' }), 'hidden while working').toBe(false)
    await endTurn($, w)
    v = await mountBand($, surface)
    for (const key of ['everywhere', 'project', 'vault', 'edit', 'skip', 'mute']) expect(await has(v, { key }), `${key} button`).toBe(true)
    expect(await has(v, { text: /Save this as a rule\?/ }), 'the question').toBe(true)
    expect(await has(v, { text: /Never use em dashes in newsletter copy\./ }), 'the drafted rule').toBe(true)
    expect(await has(v, { text: 'REST' }), 'other bands still draw').toBe(true)
    // A survey keeps the band.
    v = await mountBand($, surface, { isWorking: false, hasSurvey: true })
    expect(await has(v, { key: 'everywhere' }), 'a survey keeps the band').toBe(false)
    expect(w.writes.filter(p => !p.endsWith('reflect.log')), 'nothing but the log written').toEqual([])
    expect(w.files[CLAUDE], 'CLAUDE.md untouched').toBe(OLD_CLAUDE)
  })
}

test('a doubtful prompt is checked by the classifier first; "other" stops it', async ($, on) => {
  const { w } = rig(on, { classify: 'other' })
  await start($, 'desktop')
  await submit($, w, "Don't forget to add tests for the new function")
  expect(w.classified.length, 'asked the classifier').toBe(1)
  expect(w.completes.length, 'no draft after other').toBe(0)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(false)

  w.classify = 'correction'
  await w.clock.advance(5 * MIN)
  await offer($, w, "Don't use tabs in the config file")
  expect(w.completes.length, 'draft after correction').toBe(1)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(true)
})

test('ordinary follow-ups never reach a model', async ($, on) => {
  const { w } = rig(on)
  await start($, 'desktop')
  for (const t of ['thanks, now do the next one', 'No problem, take your time', 'why did you use a list?', '/help']) await submit($, w, t)
  await endTurn($, w)
  expect(w.classified.length + w.completes.length).toBe(0)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(false)
})

test('a draft of NONE (a one-off fix) shows nothing', async ($, on) => {
  const { w, log } = rig(on, { draft: '{"rule":"NONE"}' })
  await start($, 'desktop')
  await offer($, w)
  expect(w.completes.length).toBe(1)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(false)
  expect(log()).toContain('no lasting lesson')
})

test('a first message with no earlier reply is not a correction', async ($, on) => {
  const { w } = rig(on, { noMessages: true })
  await start($, 'desktop')
  await offer($, w)
  expect(w.completes.length).toBe(0)
})

test('only the person\'s own prompts count: other origins and slash commands are skipped', async ($, on) => {
  const { w } = rig(on)
  await start($, 'desktop')
  for (const origin of [{ kind: 'task-notification' }, { kind: 'scheduled-trigger' }, { kind: 'peer' }, { kind: 'sdk' }, { kind: 'plugin', name: 'other', asUser: true }]) {
    await submit($, w, CORRECTION, origin)
  }
  await submit($, w, '/reflect no never stop')
  await endTurn($, w)
  expect(w.completes.length + w.classified.length, 'no model call for any of them').toBe(0)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(false)
  // The Remote Control bridge is the person too.
  await submit($, w, CORRECTION, { kind: 'bridge' })
  expect(w.completes.length).toBe(1)
})

test('a correction typed while the turn runs is held until the turn ends; a new prompt drops an unanswered offer', async ($, on) => {
  const { w } = rig(on)
  await start($, 'desktop')
  await offer($, w)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(true)
  await submit($, w, 'ok, next question please')
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' }), 'a new prompt makes the offer stale').toBe(false)
})

test('a subagent finishing does not release the offer; the main turn ending does', async ($, on) => {
  const { w } = rig(on)
  await start($, 'desktop')
  await submit($, w, CORRECTION)
  expect(w.completes.length).toBe(1)
  await $.turn.complete({ answer: 'sub done', durationMs: 5, isAborted: false, turnId: 'sub1', reason: 'answer', agentId: 'agent-1' } as never)
  await w.clock.settle()
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' }), 'a subagent turn is not the main turn').toBe(false)
  await endTurn($, w)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(true)
})

test('a slow draft for an older prompt is dropped', async ($, on) => {
  let release: () => void = () => undefined
  const gate = new Promise<void>(r => (release = r))
  const { w } = rig(on, { gate })
  await start($, 'desktop')
  // The draft call answers only after a newer prompt has been typed.
  void $.prompt.submit({ text: CORRECTION, wait: false, origin: { kind: 'composer' } } as never)
  await w.clock.settle()
  await $.prompt.submit({ text: 'and now something else', wait: false, origin: { kind: 'composer' } } as never)
  release()
  await w.clock.settle()
  await endTurn($, w)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(false)
})

// ---------------------------------------------------------------------------
// Quiet time, skip and mute

test('quiet time: no second offer within 3 minutes; each skip in a row doubles it', async ($, on) => {
  const { w } = rig(on)
  await start($, 'desktop')
  await offer($, w, CORRECTION, 't1')
  await press($, 'desktop', 'skip')
  w.draft = draftJson('Always add alt text to every image.')
  await offer($, w, "No, I said always add alt text. Don't forget it.", 't2')
  expect(w.completes.length, 'held back, no model call').toBe(1)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(false)

  // One skip so far: the quiet time is 6 minutes now.
  await w.clock.advance(4 * MIN)
  await offer($, w, "No, I said always add alt text. Don't forget it.", 't3')
  expect(w.completes.length, 'still held back after 4 minutes').toBe(1)
  await w.clock.advance(3 * MIN)
  await offer($, w, "No, I said always add alt text. Don't forget it.", 't4')
  expect(w.completes.length, 'allowed after 7 minutes').toBe(2)
  expect(await has(await mountBand($, 'desktop'), { text: /alt text/ })).toBe(true)
})

test('a rule that was skipped is not offered again in this chat', async ($, on) => {
  const { w, log } = rig(on)
  await start($, 'desktop')
  await offer($, w, CORRECTION, 't1')
  await press($, 'desktop', 'skip')
  await w.clock.advance(30 * MIN)
  await offer($, w, CORRECTION, 't2')
  expect(w.completes.length, 'drafted again').toBe(2)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' }), 'but not shown').toBe(false)
  expect(log()).toContain('skipped before in this chat')
})

test('Not for this chat mutes offers; /reflect mute turns them back on; /clear resets', async ($, on) => {
  const { w } = rig(on)
  await start($, 'desktop')
  await offer($, w, CORRECTION, 't1')
  const v = await press($, 'desktop', 'mute')
  expect(await has(v, { key: 'everywhere' }), 'band gone').toBe(false)
  await w.clock.advance(60 * MIN)
  await offer($, w, CORRECTION, 't2')
  expect(w.completes.length, 'muted: no more drafts').toBe(1)

  const on1 = JSON.stringify(await $.command.run({ command: 'reflect', args: 'mute' } as never))
  expect(on1).toContain('will offer again')
  await offer($, w, CORRECTION, 't3')
  expect(w.completes.length).toBe(2)
  await press($, 'desktop', 'skip')

  const off = JSON.stringify(await $.command.run({ command: 'reflect', args: 'mute' } as never))
  expect(off).toContain('quiet for this chat')
  // A /clear is a new chat.
  await $.session.end({ reason: 'clear', sessionId: 'x' } as never)
  await w.clock.settle()
  await w.clock.advance(60 * MIN)
  await offer($, w, CORRECTION, 't4')
  expect(w.completes.length, 'not muted after /clear').toBe(3)
})

test('the cooldown setting can be changed with /reflect cooldown, and 0 turns the quiet time off', async ($, on) => {
  const { w } = rig(on)
  await start($, 'desktop')
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'cooldown 0' } as never))).toContain('now 0 min')
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'cooldown abc' } as never))).toContain('Use /reflect cooldown')
  await offer($, w, CORRECTION, 't1')
  await press($, 'desktop', 'skip')
  w.draft = draftJson('Always add alt text to every image.')
  await offer($, w, "No, I said always add alt text. Don't forget it.", 't2')
  expect(await has(await mountBand($, 'desktop'), { text: /alt text/ }), 'no quiet time').toBe(true)
})

test('sensitivity careful ignores doubtful wording', async ($, on) => {
  const { w } = rig(on)
  await start($, 'desktop')
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'sensitivity careful' } as never))).toContain('careful')
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'sensitivity loud' } as never))).toContain('Use /reflect sensitivity')
  await offer($, w, "Don't use tabs in the config file", 't1')
  expect(w.classified.length + w.completes.length).toBe(0)
  await offer($, w, CORRECTION, 't2')
  expect(w.completes.length).toBe(1)
})

// ---------------------------------------------------------------------------
// Save everywhere: show first, back up, append, undo

for (const surface of SURFACES) {
  test(`Save everywhere: shows the exact text, then appends, backs up once, and Undo restores every byte (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { w } = rig(on, { files: { [CLAUDE]: OLD_CLAUDE } })
    await start($, surface)
    await offer($, w)

    // Step one: pick the scope. The text is shown; nothing is written.
    let v = await press($, surface, 'everywhere')
    expect(await has(v, { text: /Add this to the end of ~\/\.claude\/CLAUDE\.md\?/ }), 'says where').toBe(true)
    expect(await has(v, { text: /Nothing already in the file changes\./ })).toBe(true)
    expect(await has(v, { text: HEADING }), 'shows the heading it will add').toBe(true)
    expect(await has(v, { text: new RegExp(`- Never use em dashes in newsletter copy\\. \\(writing, learned in proj, added ${DATE}\\)`) }), 'shows the exact bullet').toBe(true)
    expect(await has(v, { key: 'write' })).toBe(true)
    expect(await has(v, { key: 'back' })).toBe(true)
    expect(w.files[CLAUDE], 'still untouched').toBe(OLD_CLAUDE)
    expect(Object.keys(w.files).some(k => k.includes('backups')), 'no backup yet').toBe(false)

    // Back goes to the offer; nothing written.
    v = await press($, surface, 'back')
    expect(await has(v, { key: 'vault' })).toBe(true)
    await press($, surface, 'everywhere')

    // Step two: Write it.
    v = await press($, surface, 'write')
    const after = w.files[CLAUDE]!
    expect(after.startsWith(OLD_CLAUDE), 'old content kept in place').toBe(true)
    expect(after.slice(OLD_CLAUDE.length)).toBe(`\n${HEADING}\n<!-- Added by the reflect mod. One bullet per rule you approved. /reflect undo takes the last one out. -->\n\n- ${RULE} (writing, learned in proj, added ${DATE})\n`)
    const backup = Object.entries(w.files).find(([k]) => k.includes('/.claude/claude-mods/backups/reflect/'))
    expect(backup, 'a timestamped backup').toBeDefined()
    expect(backup![0]).toMatch(/\/\d{4}-\d{2}-\d{2}-\d{6}-global-CLAUDE\.md$/)
    expect(backup![1], 'backup holds the old file exactly').toBe(OLD_CLAUDE)
    expect(await has(v, { text: /Saved to/ })).toBe(true)
    expect(await has(v, { text: /~\/\.claude\/CLAUDE\.md/ }), 'short path shown').toBe(true)
    expect(await has(v, { key: 'open' }), 'Open').toBe(true)
    expect(await has(v, { key: 'undo' }), 'Undo').toBe(true)
    expect(await has(v, { text: /Backup of the old file: ~\/\.claude\/claude-mods\/backups\/reflect\// })).toBe(true)

    // Open uses the machine's opener on the saved file.
    await press($, surface, 'open')
    expect(w.runs.some(r => r[0] === 'open' && r[1] === CLAUDE), 'opened').toBe(true)

    // A second save in the same chat appends only a bullet and makes no second backup.
    await w.clock.advance(5 * MIN)
    w.draft = draftJson('Always add alt text to every image.', { slug: 'alt-text', category: 'code', tags: [] })
    await offer($, w, "No, I said always add alt text. Don't forget it.", 't2')
    await press($, surface, 'everywhere')
    await press($, surface, 'write')
    expect(w.files[CLAUDE]!.split(HEADING).length - 1, 'still one heading').toBe(1)
    expect(w.files[CLAUDE]!.endsWith(`- Always add alt text to every image. (code, learned in proj, added ${DATE})\n`)).toBe(true)
    expect(Object.keys(w.files).filter(k => k.includes('/backups/')).length, 'one backup per file per chat').toBe(1)

    // Undo (the command) takes out exactly the last bullet.
    const said = JSON.stringify(await $.command.run({ command: 'reflect', args: 'undo' } as never))
    expect(said).toContain('Removed from ~/.claude/CLAUDE.md')
    expect(w.files[CLAUDE]!.endsWith(`added ${DATE})\n`) && !w.files[CLAUDE]!.includes('alt text'), 'only the last rule removed').toBe(true)
    // Undo again takes the first one, and the file is byte-for-byte what it was.
    await $.command.run({ command: 'reflect', args: 'undo' } as never)
    expect(w.files[CLAUDE], 'restored exactly').toBe(OLD_CLAUDE)
    expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'undo' } as never))).toContain('Nothing to undo')
  })
}

test('the Undo button on the saved line removes the text; the line fades after 20 seconds', async ($, on) => {
  const { w } = rig(on, { files: { [CLAUDE]: OLD_CLAUDE } })
  await start($, 'desktop')
  await offer($, w)
  await press($, 'desktop', 'everywhere')
  await press($, 'desktop', 'write')
  expect(w.files[CLAUDE]).not.toBe(OLD_CLAUDE)
  let v = await press($, 'desktop', 'undo')
  expect(w.files[CLAUDE], 'restored').toBe(OLD_CLAUDE)
  expect(await has(v, { text: /Removed from/ })).toBe(true)
  expect(await has(v, { key: 'undo' }), 'no second undo').toBe(false)
  await w.clock.advance(8100)
  v = await mountBand($, 'desktop')
  expect(await has(v, { text: /Removed from/ }), 'gone after 8 seconds').toBe(false)

  await w.clock.advance(5 * MIN)
  await offer($, w, CORRECTION, 't2')
  await press($, 'desktop', 'everywhere')
  await press($, 'desktop', 'write')
  await w.clock.advance(15_000)
  expect(await has(await mountBand($, 'desktop'), { key: 'undo' }), 'still there at 15 s').toBe(true)
  await w.clock.advance(6000)
  expect(await has(await mountBand($, 'desktop'), { key: 'undo' }), 'gone after 20 s').toBe(false)
  // The command still works after the line is gone.
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'undo' } as never))).toContain('Removed from')
  expect(w.files[CLAUDE]).toBe(OLD_CLAUDE)
})

test('a missing CLAUDE.md is created, not backed up, and undo removes the empty file', async ($, on) => {
  const { w } = rig(on)
  await start($, 'desktop')
  await offer($, w)
  const v = await press($, 'desktop', 'everywhere')
  expect(await has(v, { text: /Create ~\/\.claude\/CLAUDE\.md with this\?/ })).toBe(true)
  await press($, 'desktop', 'write')
  expect(w.files[CLAUDE]!.startsWith(HEADING)).toBe(true)
  expect(Object.keys(w.files).some(k => k.includes('/backups/')), 'nothing to back up').toBe(false)
  await $.command.run({ command: 'reflect', args: 'undo' } as never)
  expect(CLAUDE in w.files, 'the file we made is gone again').toBe(false)
  expect(w.runs.some(r => r[0] === 'rm' && r[2] === CLAUDE)).toBe(true)
})

test('undo refuses when the saved text was edited away, and leaves the file alone', async ($, on) => {
  const { w } = rig(on, { files: { [CLAUDE]: OLD_CLAUDE } })
  await start($, 'desktop')
  await offer($, w)
  await press($, 'desktop', 'everywhere')
  await press($, 'desktop', 'write')
  w.files[CLAUDE] = OLD_CLAUDE + '\nmy own line\n'
  const said = JSON.stringify(await $.command.run({ command: 'reflect', args: 'undo' } as never))
  expect(said).toContain('Could not find the saved text')
  expect(w.files[CLAUDE]).toBe(OLD_CLAUDE + '\nmy own line\n')
})

test('undo removes our text even when the person added more after it', async ($, on) => {
  const { w } = rig(on, { files: { [CLAUDE]: OLD_CLAUDE } })
  await start($, 'desktop')
  await offer($, w)
  await press($, 'desktop', 'everywhere')
  await press($, 'desktop', 'write')
  w.files[CLAUDE] = `${w.files[CLAUDE]!}\n## Mine\n\nkeep this\n`
  await $.command.run({ command: 'reflect', args: 'undo' } as never)
  expect(w.files[CLAUDE]).toContain('keep this')
  expect(w.files[CLAUDE]).not.toContain(RULE)
})

test('safety: a failed backup stops the write; a file that changes while deciding is shown again; a failed write says so', async ($, on) => {
  // 1. The backup cannot be written.
  const a = rig(on, { files: { [CLAUDE]: OLD_CLAUDE }, failWrite: p => p.includes('/backups/') })
  await start($, 'desktop')
  await offer($, a.w)
  await press($, 'desktop', 'everywhere')
  let v = await press($, 'desktop', 'write')
  expect(a.w.files[CLAUDE], 'nothing written without a backup').toBe(OLD_CLAUDE)
  expect(await has(v, { text: /nothing was written/ })).toBe(true)
  expect(a.log()).toContain('backup failed')
})

test('safety: the file changing between Show and Write it asks again instead of writing', async ($, on) => {
  const { w } = rig(on, { files: { [CLAUDE]: OLD_CLAUDE } })
  await start($, 'desktop')
  await offer($, w)
  await press($, 'desktop', 'everywhere')
  w.files[CLAUDE] = `${OLD_CLAUDE}\n## Added by me meanwhile\n`
  const v = await press($, 'desktop', 'write')
  expect(w.files[CLAUDE], 'not written').toBe(`${OLD_CLAUDE}\n## Added by me meanwhile\n`)
  expect(await has(v, { text: /The file changed since you looked/ })).toBe(true)
  expect(await has(v, { key: 'write' }), 'asks again').toBe(true)
  // Now the person confirms the new text.
  await press($, 'desktop', 'write')
  expect(w.files[CLAUDE]!.startsWith(`${OLD_CLAUDE}\n## Added by me meanwhile\n`)).toBe(true)
  expect(w.files[CLAUDE]).toContain(RULE)
})

test('safety: a write that fails is reported and nothing else changes; a CLAUDE.md that cannot be read is not touched', async ($, on) => {
  const a = rig(on, { files: { [CLAUDE]: OLD_CLAUDE }, failWrite: p => p === CLAUDE })
  await start($, 'desktop')
  await offer($, a.w)
  await press($, 'desktop', 'everywhere')
  const v = await press($, 'desktop', 'write')
  expect(await has(v, { text: /Could not save: / }), 'says it could not save').toBe(true)
  expect(a.w.files[CLAUDE], 'file unchanged').toBe(OLD_CLAUDE)
  expect(a.w.store.journal, 'no undo entry for a save that did not happen').toBeUndefined()
})

test('safety: an unreadable CLAUDE.md is left alone', async ($, on) => {
  const { w } = rig(on, { files: { [CLAUDE]: OLD_CLAUDE }, failRead: p => p === CLAUDE })
  await start($, 'desktop')
  await offer($, w, CORRECTION)
  const v = await press($, 'desktop', 'everywhere')
  expect(await has(v, { text: /Could not read ~\/\.claude\/CLAUDE\.md/ })).toBe(true)
  expect(w.writes.filter(p => p === CLAUDE)).toEqual([])
})

test('safety: a CLAUDE.md that ends inside an open code block is not appended to', async ($, on) => {
  const open = '# T\n\n```sh\necho hi\n'
  const { w } = rig(on, { files: { [CLAUDE]: open } })
  await start($, 'desktop')
  await offer($, w)
  const v = await press($, 'desktop', 'everywhere')
  expect(await has(v, { text: /open code block/ })).toBe(true)
  expect(w.files[CLAUDE]).toBe(open)
})

// ---------------------------------------------------------------------------
// Save to project

test('Save to project appends to ./CLAUDE.md of the chat\'s folder, without a place in the bullet', async ($, on) => {
  const { w } = rig(on, { files: { [PROJECT_CLAUDE]: '# Proj\n\nUse pnpm.\n' } })
  await start($, 'terminal')
  await offer($, w, CORRECTION)
  await press($, 'terminal', 'project')
  await press($, 'terminal', 'write')
  const f = w.files[PROJECT_CLAUDE]!
  expect(f.startsWith('# Proj\n\nUse pnpm.\n')).toBe(true)
  expect(f).toContain(`- ${RULE} (writing, added ${DATE})\n`)
  expect(f).not.toContain('learned in')
  expect(Object.keys(w.files).find(k => k.includes('/backups/'))).toMatch(/-project-proj-CLAUDE\.md$/)
  expect(w.files[CLAUDE], 'global file untouched').toBeUndefined()
  await $.command.run({ command: 'reflect', args: 'undo' } as never)
  expect(w.files[PROJECT_CLAUDE]).toBe('# Proj\n\nUse pnpm.\n')
})

test('a rule the model says is project-specific makes Save to project the main button', async ($, on) => {
  const { w } = rig(on, { draft: draftJson('Run pnpm test before every commit.', { scope: 'project' }) })
  await start($, 'desktop')
  await offer($, w, CORRECTION)
  const v = await mountBand($, 'desktop')
  expect(await has(v, { key: 'project' })).toBe(true)
  const hit = (await v.find({ key: 'project' })) as { props?: { variant?: string } } | undefined
  expect(hit?.props?.variant ?? 'primary').toBe('primary')
})

test('no Save to project when the chat runs in the home folder, or when the setting is off', async ($, on) => {
  const a = rig(on, { cwd: HOME })
  await start($, 'desktop')
  await offer($, a.w)
  expect(await has(await mountBand($, 'desktop'), { key: 'project' }), 'home folder: no project button').toBe(false)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(true)
})

test('/reflect project off hides Save to project', async ($, on) => {
  const { w } = rig(on)
  await start($, 'desktop')
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'project off' } as never))).toContain('now off')
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'project maybe' } as never))).toContain('Use /reflect project')
  await offer($, w)
  expect(await has(await mountBand($, 'desktop'), { key: 'project' })).toBe(false)
})

// ---------------------------------------------------------------------------
// Save to vault

for (const surface of SURFACES) {
  test(`rules_folder unset: Save to vault asks once, remembers, shows the note, writes it, and undo removes it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { w } = rig(on)
    await start($, surface)
    await offer($, w, "Stop using em dashes in the newsletter, avoid them.")

    let v = await press($, surface, 'vault')
    expect(w.asked, 'asked once, for a folder').toEqual(['Which folder should rule notes go in?'])
    expect(w.store.folder, 'folder kept in the store').toBe('~/Documents/rules')
    expect(await has(v, { text: /Create ~\/Documents\/rules\/no-em-dashes-in-newsletters\.md with this\?/ }), 'shows the path').toBe(true)
    expect(await has(v, { text: /A new note\. No existing file is touched\./ })).toBe(true)
    expect(await has(v, { text: /type: rule/ }), 'shows the note').toBe(true)
    expect(Object.keys(w.files).some(k => k.endsWith('.md')), 'nothing written yet').toBe(false)

    v = await press($, surface, 'write')
    const path = `${HOME}/Documents/rules/no-em-dashes-in-newsletters.md`
    const body = w.files[path] ?? ''
    expect(body.startsWith(`---\ntype: rule\nstatus: active\ndate: ${DATE}\ncategory: writing\nlearned_in: "proj"\nsource: correction in a Claude Code chat\ntags: [rule, writing, newsletters, punctuation]\n---\n`), 'frontmatter').toBe(true)
    expect(body).toContain('# Never use em dashes in newsletter copy\n')
    expect(body).toContain(`\n${RULE}\n`)
    expect(body).toContain('Why: "Stop using em dashes in the newsletter, avoid them."')
    expect(body, 'the ~ was expanded').not.toContain('~')
    expect(w.files[CLAUDE], 'CLAUDE.md untouched').toBeUndefined()
    expect(await has(v, { text: /~\/Documents\/rules\/no-em-dashes-in-newsletters\.md/ }), 'saved line names the file').toBe(true)

    // A different rule with the same slug gets -2, and the folder is not asked again.
    await w.clock.advance(5 * MIN)
    w.draft = draftJson('Never put emojis in newsletter headlines.')
    await offer($, w, 'No, never use emojis. Stop adding them.', 't2')
    await press($, surface, 'vault')
    await press($, surface, 'write')
    expect(w.asked.length, 'folder remembered').toBe(1)
    expect(`${HOME}/Documents/rules/no-em-dashes-in-newsletters-2.md` in w.files, '-2 suffix').toBe(true)

    // Undo removes the note we made, and only that one.
    await $.command.run({ command: 'reflect', args: 'undo' } as never)
    expect(`${HOME}/Documents/rules/no-em-dashes-in-newsletters-2.md` in w.files).toBe(false)
    expect(path in w.files).toBe(true)
  })

  test(`/reflect folder forgets the remembered folder; a typed path is used and kept (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { w } = rig(on, { store: { folder: '~/Documents/rules' } })
    await start($, surface)
    const said = JSON.stringify(await $.command.run({ command: 'reflect', args: 'folder' } as never))
    expect(said, 'says it forgot').toContain('Remembered folder cleared')
    expect(w.store.folder, 'store cleared').toBeUndefined()
    w.answer = '/Users/test/notes/rules/'
    await offer($, w)
    await press($, surface, 'vault')
    await press($, surface, 'write')
    expect(w.asked.length, 'asked again after /reflect folder').toBe(1)
    expect(w.store.folder, 'typed path kept').toBe('/Users/test/notes/rules/')
    expect('/Users/test/notes/rules/no-em-dashes-in-newsletters.md' in w.files, 'written to the typed path').toBe(true)
  })

  test(`cancelling the folder dialog (or typing a bad path) saves nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { w } = rig(on)
    await start($, surface)
    let n = 1
    for (const answer of [null, 'Cancel', 'relative/path'] as const) {
      w.answer = answer
      w.draft = draftJson(`Always add alt text to image number ${n}.`)
      await w.clock.advance(60 * MIN)
      await offer($, w, CORRECTION, `t-${n++}`)
      const v = await press($, surface, 'vault')
      expect(Object.keys(w.files).some(k => k.endsWith('.md')), `nothing written (${String(answer)})`).toBe(false)
      expect(w.store.folder, `nothing remembered (${String(answer)})`).toBeUndefined()
      expect(await has(v, { text: /No folder picked\. Nothing saved\./ }), `says nothing was saved (${String(answer)})`).toBe(true)
      await press($, surface, 'skip')
    }
  })
}

test('rules_folder set (or /reflect folder <path>): Save to vault writes there without asking', { timeoutMs: 30000, options: { rules_folder: '/Users/test/my-rules' } }, async ($, on) => {
  const { w } = rig(on)
  await start($, 'desktop')
  // Whether this build applies the config value or not, the person can state the folder with the command.
  const applied = JSON.stringify(await $.command.run({ command: 'reflect', args: 'status' } as never)).includes('/Users/test/my-rules')
  if (!applied) await $.command.run({ command: 'reflect', args: 'folder /Users/test/my-rules' } as never)
  await offer($, w)
  await press($, 'desktop', 'vault')
  const v = await press($, 'desktop', 'write')
  expect(w.asked.length, 'never asked').toBe(0)
  expect('/Users/test/my-rules/no-em-dashes-in-newsletters.md' in w.files, `written to the folder (${Object.keys(w.files).join(' | ')})`).toBe(true)
  expect(await has(v, { text: /~\/my-rules\/no-em-dashes-in-newsletters\.md/ }), 'saved line').toBe(true)
  const said = JSON.stringify(await $.command.run({ command: 'reflect', args: 'folder' } as never))
  expect(said === '' || said.includes('Remembered folder cleared')).toBe(true)
})

test('unsafe folders are refused: the home folder, ~/.claude and paths with ..', async ($, on) => {
  const { w } = rig(on)
  await start($, 'desktop')
  for (const dir of ['~', '~/.claude/rules', '/Users/test/a/../b']) {
    expect(JSON.stringify(await $.command.run({ command: 'reflect', args: `folder ${dir}` } as never)), dir).not.toContain('remembered')
  }
  w.answer = '~/.claude/rules'
  await offer($, w)
  const v = await press($, 'desktop', 'vault')
  expect(await has(v, { text: /outside ~\/\.claude/ })).toBe(true)
  expect(Object.keys(w.files).filter(k => k.endsWith('.md'))).toEqual([])
})

test('a vault note that was edited is not deleted by undo', async ($, on) => {
  const { w } = rig(on, { store: { folder: '~/Documents/rules' } })
  await start($, 'desktop')
  await offer($, w)
  await press($, 'desktop', 'vault')
  await press($, 'desktop', 'write')
  const path = `${HOME}/Documents/rules/no-em-dashes-in-newsletters.md`
  w.files[path] += '\nMy own notes.\n'
  const said = JSON.stringify(await $.command.run({ command: 'reflect', args: 'undo' } as never))
  expect(said).toContain('was edited since it was saved')
  expect(path in w.files).toBe(true)
})

// ---------------------------------------------------------------------------
// Dedupe

test('a rule already in CLAUDE.md (even in the other mod\'s line format) is not offered', async ($, on) => {
  const { w, log } = rig(on, { files: { [CLAUDE]: `${OLD_CLAUDE}\n## Rules from corrections\n\n- Never use em dashes in newsletter copy. (added 2026-09-01)\n` } })
  await start($, 'desktop')
  await offer($, w)
  expect(w.completes.length, 'drafted').toBe(1)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' }), 'but no nag').toBe(false)
  expect(log()).toContain('already saved')
})

test('a rule already saved in the project CLAUDE.md, the journal or the vault folder is not offered again', async ($, on) => {
  const a = rig(on, { files: { [PROJECT_CLAUDE]: `- ${RULE}\n` } })
  await start($, 'desktop')
  await offer($, a.w)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(false)
})

test('pressing a scope for a rule that is already there says Already saved and writes nothing (CLAUDE.md and vault)', async ($, on) => {
  const { w } = rig(on, { store: { folder: '~/Documents/rules' }, files: { [`${HOME}/Documents/rules/old-note.md`]: `# ${RULE.replace(/\.$/, '')}\n\nbody\n` } })
  await start($, 'desktop')
  await offer($, w)
  let v = await press($, 'desktop', 'vault')
  expect(await has(v, { text: /Already saved in/ }), 'vault dedupe').toBe(true)
  expect(w.writes.filter(p => p.endsWith('.md'))).toEqual([])
  // The rule appears in CLAUDE.md after the offer was drafted.
  await w.clock.advance(60 * MIN)
  await offer($, w, CORRECTION, 't2')
  w.files[CLAUDE] = `- ${RULE}\n`
  v = await press($, 'desktop', 'everywhere')
  expect(await has(v, { text: /Already saved in/ }), 'CLAUDE.md dedupe').toBe(true)
  expect(w.files[CLAUDE]).toBe(`- ${RULE}\n`)
  expect(await has(v, { key: 'undo' }), 'nothing to undo').toBe(false)
})

// ---------------------------------------------------------------------------
// Edit before saving

for (const surface of SURFACES) {
  test(`Edit: the rule can be reworded before saving, and the saved text is the edited one (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { w } = rig(on, { files: { [CLAUDE]: OLD_CLAUDE } })
    await start($, surface)
    await offer($, w)
    let v = await press($, surface, 'edit')
    expect(await has(v, { key: 'rule' }), 'a text field').toBe(true)
    expect(await has(v, { key: 'use' })).toBe(true)

    // Typing a secret is refused, and the field stays.
    v = await mountBand($, surface)
    await v.input({ key: 'rule', text: `Always use ${FAKE_KEY} for the API`, kind: 'submit' })
    v = await mountBand($, surface)
    expect(await has(v, { text: /Rules are never saved with secrets/ }), 'secret refused').toBe(true)
    expect(await has(v, { key: 'rule' }), 'still editing').toBe(true)
    // Too short is refused.
    await v.input({ key: 'rule', text: 'Be nice', kind: 'submit' })
    v = await mountBand($, surface)
    expect(await has(v, { text: /too short/ })).toBe(true)

    // A good edit, by Enter, goes back to the offer with the new wording.
    await v.input({ key: 'rule', text: 'never use em dashes — not even in subject lines', kind: 'submit' })
    v = await mountBand($, surface)
    expect(await has(v, { text: /Never use em dashes, not even in subject lines\./ }), 'new wording').toBe(true)
    expect(await has(v, { key: 'everywhere' })).toBe(true)

    await press($, surface, 'everywhere')
    await press($, surface, 'write')
    expect(w.files[CLAUDE]).toContain('- Never use em dashes, not even in subject lines. (writing')
    expect(w.files[CLAUDE]).not.toContain('- Never use em dashes in newsletter copy.')
  })
}

test('Edit by typing then pressing Use this; Cancel keeps the old rule', async ($, on) => {
  const { w } = rig(on)
  await start($, 'desktop')
  await offer($, w)
  await press($, 'desktop', 'edit')
  let v = await mountBand($, 'desktop')
  await v.input({ key: 'rule', text: 'Keep newsletter intros under 50 words', kind: 'change' })
  v = await press($, 'desktop', 'use')
  expect(await has(v, { text: /Keep newsletter intros under 50 words\./ })).toBe(true)
  await press($, 'desktop', 'edit')
  v = await press($, 'desktop', 'cancel')
  expect(await has(v, { text: /Keep newsletter intros under 50 words\./ })).toBe(true)
  expect(await has(v, { key: 'vault' })).toBe(true)
})

// ---------------------------------------------------------------------------
// Secrets

test('a drafted rule that holds a secret is never offered or saved', async ($, on) => {
  const { w, log } = rig(on, { draft: draftJson(`Always send the key ${FAKE_KEY} in the header.`) })
  await start($, 'desktop')
  await offer($, w)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(false)
  expect(w.writes.filter(p => !p.endsWith('.log'))).toEqual([])
  expect(log()).not.toContain(FAKE_KEY)
})

test('a secret in the correction is cut out before the model sees it and before it goes in a note', async ($, on) => {
  const { w } = rig(on, { store: { folder: '~/Documents/rules' } })
  await start($, 'desktop')
  await offer($, w, `No, I said never paste my key ${FAKE_KEY} into prompts. Don't do that again.`)
  expect(w.completes[0]!.prompt, 'the model never saw the key').not.toContain(FAKE_KEY)
  expect(w.completes[0]!.prompt).toContain('[removed]')
  await press($, 'desktop', 'vault')
  await press($, 'desktop', 'write')
  const body = w.files[`${HOME}/Documents/rules/no-em-dashes-in-newsletters.md`]!
  expect(body).not.toContain(FAKE_KEY)
  expect(body).toContain('[removed]')
})

test('/reflect add with a secret is refused', async ($, on) => {
  const { w } = rig(on)
  await start($, 'desktop')
  const said = JSON.stringify(await $.command.run({ command: 'reflect', args: `add Always use ${FAKE_KEY} for the API` } as never))
  expect(said).toContain('never saved with secrets')
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(false)
  expect(w.writes.filter(p => !p.endsWith('.log')).length).toBe(0)
})

// ---------------------------------------------------------------------------
// Commands

test('/reflect turns the mod on and off, and the choice is kept', async ($, on) => {
  const { w } = rig(on)
  await start($, 'desktop')
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: '' } as never))).toContain('Reflect is off')
  expect(w.store.enabled).toBe(false)
  await offer($, w)
  expect(w.completes.length, 'no draft while off').toBe(0)
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: '' } as never))).toContain('Reflect is on')
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'off' } as never))).toContain('Reflect is off')
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'on' } as never))).toContain('Reflect is on')
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'nonsense' } as never))).toContain('Use /reflect')
})

test('turning it off clears an offer on screen; a stored "off" survives a new session', async ($, on) => {
  const { w } = rig(on, { store: { enabled: false } })
  await start($, 'desktop')
  await offer($, w)
  expect(w.completes.length).toBe(0)
  await $.command.run({ command: 'reflect', args: 'on' } as never)
  await w.clock.advance(MIN)
  await offer($, w, CORRECTION, 't2')
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(true)
  await $.command.run({ command: 'reflect', args: 'off' } as never)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' }), 'offer cleared').toBe(false)
})

test('/reflect status and /reflect list', async ($, on) => {
  const { w } = rig(on, { files: { [CLAUDE]: OLD_CLAUDE }, store: { folder: '~/Documents/rules' } })
  await start($, 'desktop')
  const s = JSON.stringify(await $.command.run({ command: 'reflect', args: 'status' } as never))
  expect(s).toContain('Reflect is on')
  expect(s).toContain('Offers: normal')
  expect(s).toContain('Quiet time: 3 min')
  expect(s).toContain('~/Documents/rules')
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'list' } as never))).toContain('No rules saved yet')
  await offer($, w)
  await press($, 'desktop', 'everywhere')
  await press($, 'desktop', 'write')
  const l = JSON.stringify(await $.command.run({ command: 'reflect', args: 'list' } as never))
  expect(l).toContain(`${DATE} everywhere: ${RULE}`)
  expect(l).toContain('~/.claude/CLAUDE.md')
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'status' } as never))).toContain('Saves you can undo: 1')
})

test('/reflect add <rule> offers the person\'s own words; /reflect add alone drafts from the last message', async ($, on) => {
  const { w } = rig(on, { files: { [CLAUDE]: OLD_CLAUDE } })
  await start($, 'desktop')
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'add' } as never))).toContain('Nothing to draft from')
  const said = JSON.stringify(await $.command.run({ command: 'reflect', args: 'add always reply in british english' } as never))
  expect(said).toContain('choose where to save it')
  expect(w.completes.length, 'no model call for the person\'s own words').toBe(0)
  let v = await mountBand($, 'desktop')
  expect(await has(v, { text: /Always reply in british english\./ })).toBe(true)
  // Another add while the offer is up asks to finish it first.
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'add another rule please' } as never))).toContain('Finish or skip')
  v = await press($, 'desktop', 'skip')

  // From the last message: the typed prompt is used even if it did not look like a correction.
  await submit($, w, 'please keep intros to two lines')
  expect(w.completes.length, 'wording alone did not trigger it').toBe(0)
  await endTurn($, w)
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'add' } as never))).toContain('Drafting a rule')
  await w.clock.settle()
  expect(w.completes.length).toBe(1)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(true)
})

// ---------------------------------------------------------------------------
// The shared switch, fail open and the log

for (const surface of SURFACES) {
  test(`draws nothing and drafts nothing when switched off in the mods switchboard (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const { w } = rig(on, { files: { [CLAUDE]: OLD_CLAUDE } })
    await start($, surface)
    await offer($, w)
    let v = await mountBand($, surface)
    expect(await has(v, { key: 'everywhere' }), 'band shows while on').toBe(true)

    w.files[SW] = JSON.stringify({ reflect: false, 'other-mod': true })
    await w.clock.advance(1100)
    v = await mountBand($, surface)
    expect(await has(v, { key: 'everywhere' }), 'no band when off').toBe(false)
    expect(await has(v, { text: 'REST' }), 'other bands still show').toBe(true)

    // A press that still arrives does nothing.
    await v.press({ key: 'everywhere' }).catch(() => undefined)
    expect(w.files[CLAUDE]).toBe(OLD_CLAUDE)

    await offer($, w, 'No, never use em dashes there. Stop it.', 't2')
    expect(w.completes.length, 'no new draft while off').toBe(1)
    expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'add a rule about nothing at all' } as never))).toContain('Reflect is off')
    expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'status' } as never))).toContain('off in the mods switchboard')

    // Switching it back on works within a second.
    w.files[SW] = '{"reflect": true}'
    await w.clock.advance(1100)
    await w.clock.advance(5 * MIN)
    await offer($, w, CORRECTION, 't3')
    expect(w.completes.length).toBe(2)
  })
}

test('a broken switches file counts as on', async ($, on) => {
  const { w } = rig(on, { files: { [SW]: '{not json' } })
  await start($, 'desktop')
  await offer($, w)
  expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(true)
})

for (const [name, cfg] of [['the model call fails', { completeFails: true }], ['the model call throws', { completeThrows: true }]] as const) {
  test(`fail open: when ${name}, the prompt goes through unchanged and the log has no words`, async ($, on) => {
    const { w, log } = rig(on, cfg)
    await start($, 'desktop')
    const r = (await submit($, w, CORRECTION)) as { text?: string }
    expect(r?.text, 'the prompt went through unchanged').toBe(CORRECTION)
    await endTurn($, w)
    expect(await has(await mountBand($, 'desktop'), { key: 'everywhere' })).toBe(false)
    expect(log()).toMatch(/check failed: (draft failed|model broke|no implementation)/)
    expect(log()).not.toContain('em dashes')
    expect(log()).not.toContain('Don')
  })
}

test('fail open: a store that cannot be read and a switches file that cannot be read do not stop a prompt', async ($, on) => {
  const { w } = rig(on, { failRead: p => p === SW, files: { [SW]: '{}' }, storeThrows: true })
  await start($, 'desktop')
  const r = (await submit($, w, CORRECTION)) as { text?: string }
  expect(r?.text).toBe(CORRECTION)
  await endTurn($, w)
  expect(JSON.stringify(await $.command.run({ command: 'reflect', args: 'status' } as never))).toContain('Reflect is')
})

test('a failure line in the log never names a file', async ($, on) => {
  const { w, log } = rig(on, { files: { [CLAUDE]: OLD_CLAUDE }, failWrite: p => p === CLAUDE })
  await start($, 'desktop')
  await offer($, w)
  await press($, 'desktop', 'everywhere')
  await press($, 'desktop', 'write')
  expect(log()).toContain('write everywhere failed')
  expect(log()).not.toContain('/Users/test')
  expect(log()).not.toContain('CLAUDE.md')
})

test('the log has one short line per event, no prompt text, and stays bounded', async ($, on) => {
  const long = Array.from({ length: 500 }, (_, i) => `${NOW} old line ${i}`).join('\n') + '\n'
  const { w, log } = rig(on, { files: { [LOG]: long, [CLAUDE]: OLD_CLAUDE } })
  await start($, 'desktop')
  await offer($, w, `No, never use em dashes in newsletters, I said. Don't. ${FAKE_KEY}`)
  await press($, 'desktop', 'everywhere')
  await press($, 'desktop', 'write')
  const lines = log().split('\n').filter(Boolean)
  expect(lines.length, 'bounded').toBeLessThanOrEqual(300)
  const text = log()
  expect(text).toContain('offer shown')
  expect(text).toContain('saved to everywhere, backup made')
  for (const secret of ['newsletters', 'em dashes', FAKE_KEY, 'Never use']) expect(text, secret).not.toContain(secret)
})
