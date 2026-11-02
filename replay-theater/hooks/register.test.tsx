import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// A pretend machine: `files` is the disk, keyed by full path. Nothing real is touched.
const HOME = '/Users/test'
const CWD = `${HOME}/shop`
const SW = `${HOME}/.claude/claude-mods/switches.json`
const LOG = `${HOME}/.claude/claude-mods/logs/replay-theater.log`
const PATCH = `${HOME}/.claude/claude-mods/replay-theater/last.patch`
const SID = 'sid-1'
const OPEN = `${HOME}/.claude/claude-mods/.open-replay-theater-${SID}`
const SURFACES = ['terminal', 'desktop', 'mobile', 'vscode'] as const
type Surface = (typeof SURFACES)[number]

const bodyProps = { title: 'Replay Theater', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 28 }, view: {} }
const bandProps = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 90, scroll: { offset: 0, bodyRows: 20 }, view: {} }

type Opts = {
  files?: Record<string, string>
  /** What the engine answers to a tool call. Receives the call. */
  answer?: (e: Record<string, unknown>) => Record<string, unknown>
  copy?: boolean | 'throw'
  place?: boolean
  throwWrite?: boolean
  throwRead?: boolean
  throwCwd?: boolean
  throwStat?: boolean
  stat?: Record<string, { kind: 'file' | 'dir' | 'other'; size?: number; isLink?: boolean }>
}

/** Stands for the engine beneath the mod. */
function setup(on: On, o: Opts = {}) {
  const files = { ...(o.files ?? {}) }
  const w = {
    files,
    opened: [] as Record<string, unknown>[],
    closed: [] as string[],
    toasts: [] as string[],
    copied: [] as string[],
    runs: [] as string[][],
    registered: [] as Record<string, unknown>[],
    invalidated: 0,
    reads: [] as string[],
    clock: undefined as unknown as ReturnType<typeof mock.clock>,
  }
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async ($, e) => {
    w.registered.push(e as unknown as Record<string, unknown>)
    return { value: { command: 'replay' } } as never
  })
  mock.env(on, { HOME })
  w.clock = mock.clock(on, { now: Date.UTC(2026, 9, 16, 9, 30, 0) })
  on('session.id', async () => ({ value: SID }) as never)
  on('session.cwd', async () => {
    if (o.throwCwd) throw new Error('no cwd')
    return { value: CWD } as never
  })
  on('fs.exists', async ($, e) => ({ value: (e as { path: string }).path in files }) as never)
  on('fs.read', async ($, e) => {
    if (o.throwRead) throw new Error('disk on fire')
    const path = (e as { path: string }).path
    w.reads.push(path)
    if (!(path in files)) throw new Error('ENOENT')
    return { value: files[path] } as never
  })
  on('fs.write', async ($, e) => {
    if (o.throwWrite) throw new Error('disk full')
    const { path, text } = e as { path: string; text: string }
    files[path] = text
    return { value: undefined } as never
  })
  on('fs.stat', async ($, e) => {
    if (o.throwStat) throw new Error('stat exploded')
    const path = (e as { path: string }).path
    const s = o.stat?.[path]
    if (s) return { value: { kind: s.kind, size: s.size ?? 10, mtimeMs: 0, isLink: s.isLink ?? false } } as never
    if (path in files) return { value: { kind: 'file', size: files[path]!.length, mtimeMs: 0, isLink: false } } as never
    throw new Error('ENOENT')
  })
  on('process.run', async ($, e) => {
    const argv = [...(e as { argv: readonly string[] }).argv]
    w.runs.push(argv)
    if (argv[0] === 'rm') delete files[argv[2]!]
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('ui.invalidate', async () => {
    w.invalidated += 1
    return { value: undefined } as never
  })
  on('ui.open', async ($, e) => {
    w.opened.push(e as unknown as Record<string, unknown>)
    return { value: o.place === false ? { isPlaced: false, reason: 'narrow' } : { isPlaced: true } } as never
  })
  on('ui.close', async ($, e) => {
    w.closed.push((e as { id: string }).id)
    return { value: undefined } as never
  })
  on('ui.toast', async ($, e) => {
    w.toasts.push(String((e as { text?: string }).text ?? ''))
    return { value: undefined } as never
  })
  on('ui.copy', async ($, e) => {
    if (o.copy === 'throw') throw new Error('no clipboard')
    w.copied.push((e as { text: string }).text)
    return { value: o.copy === false ? { isCopied: false, reason: 'no-clipboard' } : { isCopied: true } } as never
  })
  on('turn.start', async ($, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('tool.call', async ($, e) => (o.answer ? o.answer(e as unknown as Record<string, unknown>) : { result: {} }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return w
}

type Mounted = {
  find: (q: Record<string, unknown>) => Promise<{ text?: string; props: Record<string, unknown> } | undefined>
  findAll: (q: Record<string, unknown>) => Promise<{ text?: string; props: Record<string, unknown> }[]>
  press: (q: { key: string }) => Promise<unknown>
  input: (q: { key: string; text: string; kind?: string }) => Promise<unknown>
  unmount: () => Promise<void>
}

const mountPane = ($: Engine, surface: Surface, over: Record<string, unknown> = {}) =>
  $.ui.mount({ plugin: 'replay-theater', surface, component: 'Pane', requestId: 'replay-theater', props: { ...bodyProps, ...over } } as never) as Promise<Mounted>

const mountBand = ($: Engine, surface: 'terminal' | 'desktop', over: Record<string, unknown> = {}) =>
  $.ui.mount({ plugin: 'replay-theater', surface, component: 'AbovePrompt', requestId: 'band', props: { ...bandProps, ...over } } as never) as Promise<Mounted>

type Call = (input: Record<string, unknown>) => Promise<Record<string, unknown>>
const caller = ($: Engine) => $.tool.call as unknown as Call

let seq = 0
const id = () => `t${(seq += 1)}`

async function start($: Engine, w: ReturnType<typeof setup>, surface: Surface = 'terminal') {
  await ($.session.start as (i: unknown) => Promise<unknown>)({ source: 'startup', cwd: CWD, surface, isInteractive: true })
  await w.clock.settle()
}

const run = ($: Engine, args = '') => ($.command.run as (i: unknown) => Promise<{ text?: string }>)({ command: 'replay', args })

/** One finished turn: the start, the calls, the end. `calls` returns each call's input. */
async function turn($: Engine, w: ReturnType<typeof setup>, calls: Record<string, unknown>[], extra: { agentId?: string } = {}) {
  const t = id()
  await ($.turn.start as (i: unknown) => Promise<unknown>)({ text: 'go', turnId: t })
  for (const c of calls) await caller($)({ tool_use_id: id(), ...c })
  await ($.turn.complete as (i: unknown) => Promise<unknown>)({ answer: '', durationMs: 1, isAborted: false, turnId: t, reason: 'answer', ...extra })
  await w.clock.settle()
}

const patch = (oldStart: number, lines: string[]) => ({
  oldStart,
  newStart: oldStart,
  oldLines: lines.filter(l => l[0] !== '+').length,
  newLines: lines.filter(l => l[0] !== '-').length,
  lines,
})

const edit = (file: string, patchLines: string[], more: Record<string, unknown> = {}) => ({
  tool: 'Edit',
  file_path: `${CWD}/${file}`,
  old_string: 'a',
  new_string: 'b',
  ...more,
  __result: { filePath: `${CWD}/${file}`, structuredPatch: [patch(10, patchLines)], originalFile: null, userModified: false, replaceAll: false },
})

/** The engine answers each call with the `__result` the test attached to it. */
const byResult = (e: Record<string, unknown>) => {
  if (e.__fail === 'deny') return { deny: 'no' }
  if (e.__fail === 'error') return { result: 'boom', isError: true, text: 'boom' }
  return { result: e.__result ?? {} }
}

const text = async (ui: Mounted, q: Record<string, unknown> = { type: 'Text' }) => (await ui.findAll(q)).map(t => t.text ?? '').join('\n')

const SMALL = [' one', '-old line', '+new line', ' two']

// ---------------------------------------------------------------------------------------------
// What the original did: record edits, hint above the prompt, a pane with Prev, Next, Close.
// ---------------------------------------------------------------------------------------------

for (const surface of SURFACES) {
  test(`the pane shows the file, the tool, +/- counts, the diff and "step 1 of 2" (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const w = setup(on, { answer: byResult })
    await start($, w)
    await turn($, w, [edit('sections/hero.liquid', SMALL), { tool: 'Write', file_path: `${CWD}/notes.md`, content: 'hello\nworld', __result: { type: 'create', filePath: `${CWD}/notes.md`, content: 'hello\nworld', structuredPatch: [], originalFile: null } }])
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /step 1 of 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /sections\/hero\.liquid/ })).toBeDefined()
    const all = await text(ui)
    expect(all).toMatch(/Edit/)
    expect(all).toMatch(/Liquid section/)
    expect(all).toMatch(/\+1/)
    expect(all).toMatch(/-1/)
    const code = await ui.find({ type: 'Code' })
    expect(code?.text).toContain('@@ -10,3 +10,3 @@')
    expect(code?.text).toContain('-old line')
    expect(code?.text).toContain('+new line')
    expect(code?.props.format).toBe('diff')
    expect(code?.props.language, 'Liquid is coloured as HTML').toBe('html')
    // The strip: one numbered cell for each step.
    expect(await ui.find({ type: 'Text', text: /^ 1 $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ 2 $/ })).toBeDefined()
    await ui.unmount()
  })

  test(`Prev, Next and Close buttons move through the steps and close the pane (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const w = setup(on, { answer: byResult })
    await start($, w)
    await turn($, w, [edit('a.js', SMALL), edit('b.js', SMALL), edit('c.js', SMALL)])
    await run($)
    expect(w.opened.length).toBe(1)
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /step 1 of 3/ })).toBeDefined()
    const next = await ui.find({ key: 'next' })
    expect(next?.props.hotkey).toBe('n')
    expect((await ui.find({ key: 'prev' }))?.props.hotkey).toBe('p')
    expect((await ui.find({ key: 'close' }))?.props.hotkey).toBe('c')
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /step 2 of 3/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /b\.js/ })).toBeDefined()
    await ui.press({ key: 'next' })
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /step 3 of 3/ }), 'stops at the last step').toBeDefined()
    await ui.press({ key: 'prev' })
    await ui.press({ key: 'prev' })
    await ui.press({ key: 'prev' })
    expect(await ui.find({ type: 'Text', text: /step 1 of 3/ }), 'stops at the first step').toBeDefined()
    await ui.press({ key: 'close' })
    expect(w.closed).toContain('replay-theater')
    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the hint above the prompt counts the edits and opens the pane from its button (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const w = setup(on, { answer: byResult })
    await start($, w)
    const before = await mountBand($, surface)
    expect(await before.find({ type: 'Text', text: /Replay/ }), 'no hint before any edit').toBeUndefined()
    expect(await before.find({ text: /engine band/ })).toBeDefined()
    await before.unmount()

    await turn($, w, [edit('a.js', SMALL), edit('b.js', SMALL)])
    const ui = await mountBand($, surface)
    expect(await ui.find({ type: 'Text', text: /^▶ Replay: 2 edits \(press r\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 files, \+2 -2/ })).toBeDefined()
    expect(await ui.find({ text: /engine band/ }), 'other bands stay, the hint sits under them').toBeDefined()
    const open = await ui.find({ key: 'open-replay' })
    expect(open?.props.label).toBe('Replay')
    expect(open?.props.hotkey).toBe('r')
    await ui.press({ key: 'open-replay' })
    await w.clock.advance(300)
    expect(w.opened.length).toBe(1)
    expect(w.opened[0]).toMatchObject({ id: 'replay-theater', title: 'Replay Theater', focus: true, closeOnEscape: true })
    expect(await ui.find({ type: 'Text', text: /Replay:/ }), 'the hint hides while the pane is open').toBeUndefined()
    await ui.unmount()
  })
}

// A setting is checked only where the test kit hands the plugin its userConfig (Claude Code 2.1.283's kit does not).
const applied = async ($: Engine, re: RegExp) => re.test((await run($, 'status')).text ?? '')

test('a hint can be turned off', { timeoutMs: 30000, options: { show_hint: false } }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  if (!(await applied($, /Hint: off/))) return
  await turn($, w, [edit('a.js', SMALL)])
  const ui = await mountBand($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /Replay/ })).toBeUndefined()
  await run($)
  expect(w.opened.length, '/replay still works').toBe(1)
})

test('a survey holds the band, so the hint steps aside', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, [edit('a.js', SMALL)])
  const ui = await mountBand($, 'terminal', { hasSurvey: true })
  expect(await ui.find({ type: 'Text', text: /Replay:/ })).toBeUndefined()
  await ui.unmount()
  const one = await mountBand($, 'terminal')
  expect(await one.find({ type: 'Text', text: /^▶ Replay: 1 edit \(press r\)$/ })).toBeDefined()
})

test('where no pane fits, the replay is drawn in the band above the prompt', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult, place: false })
  await start($, w)
  await turn($, w, [edit('a.js', SMALL), edit('b.js', SMALL)])
  const band = await mountBand($, 'terminal', { bodyColumns: 60 })
  await run($)
  expect(await band.find({ type: 'Text', text: /step 1 of 2/ })).toBeDefined()
  expect(await band.find({ text: /engine band/ }), 'the replay takes the band').toBeUndefined()
  await band.press({ key: 'next' })
  expect(await band.find({ type: 'Text', text: /step 2 of 2/ })).toBeDefined()
  await band.press({ key: 'close' })
  expect(w.closed, 'no pane was placed, so none is closed').not.toContain('replay-theater')
  expect(await band.find({ type: 'Text', text: /step 2 of 2/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /Replay:/ }), 'the hint is back').toBeDefined()
})

// ---------------------------------------------------------------------------------------------
// Recording: only what ran, never changing a call
// ---------------------------------------------------------------------------------------------

test('a refused or failed edit is not recorded, and the call comes back untouched', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  const t = id()
  await ($.turn.start as (i: unknown) => Promise<unknown>)({ text: 'go', turnId: t })
  const denied = await caller($)({ tool_use_id: id(), ...edit('x.js', SMALL), __fail: 'deny' })
  const failed = await caller($)({ tool_use_id: id(), ...edit('y.js', SMALL), __fail: 'error' })
  const ok = await caller($)({ tool_use_id: id(), ...edit('z.js', SMALL) })
  expect(denied.deny).toBe('no')
  expect(failed).toMatchObject({ isError: true, text: 'boom' })
  expect(ok.result).toBeDefined()
  await ($.turn.complete as (i: unknown) => Promise<unknown>)({ answer: '', durationMs: 1, isAborted: false, turnId: t, reason: 'answer' })
  await w.clock.settle()
  expect((await run($, 'list')).text).toMatch(/1 edit in 1 file/)
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /z\.js/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /x\.js|y\.js/ })).toBeUndefined()
})

test('other tools pass straight through and are not recorded', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, [{ tool: 'Read', file_path: `${CWD}/a.js`, __result: { x: 1 } }, { tool: 'Bash', command: 'ls -la', __result: { stdout: '' } }, { tool: 'Grep', pattern: 'x' }])
  expect((await run($)).text).toMatch(/no edits/i)
  expect(w.opened.length).toBe(0)
  expect(w.runs.length, 'nothing ran on the disk for an ls').toBe(0)
})

test('an edit made by a helper is part of the main turn, and a helper turn does not end it', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  const t = id()
  await ($.turn.start as (i: unknown) => Promise<unknown>)({ text: 'go', turnId: t })
  await caller($)({ tool_use_id: id(), ...edit('main.js', SMALL) })
  await ($.turn.start as (i: unknown) => Promise<unknown>)({ text: 'sub', turnId: id(), agentId: 'a1' })
  await caller($)({ tool_use_id: id(), agentId: 'a1', ...edit('helper.js', SMALL) })
  await ($.turn.complete as (i: unknown) => Promise<unknown>)({ answer: '', durationMs: 1, isAborted: false, turnId: id(), reason: 'answer', agentId: 'a1' })
  expect((await run($)).text, 'the helper turn ended: nothing is replayable yet').toMatch(/no edits/i)
  await ($.turn.complete as (i: unknown) => Promise<unknown>)({ answer: '', durationMs: 1, isAborted: false, turnId: t, reason: 'answer' })
  await w.clock.settle()
  expect((await run($)).text).toMatch(/2 edits/)
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/helper\.js/)
  expect(await text(ui)).toMatch(/helper/)
})

test('a new turn clears what was pending, and a turn with no edits keeps the replay', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  const t = id()
  await ($.turn.start as (i: unknown) => Promise<unknown>)({ text: 'go', turnId: t })
  await caller($)({ tool_use_id: id(), ...edit('lost.js', SMALL) })
  // The turn never completes; the next one starts.
  await turn($, w, [edit('kept.js', SMALL)])
  await turn($, w, [{ tool: 'Read', file_path: `${CWD}/kept.js`, __result: {} }])
  const list = (await run($, 'list')).text ?? ''
  expect(list).toMatch(/1\. last turn/)
  expect(list).not.toMatch(/2\./)
  await run($)
  const ui = await mountPane($, 'terminal')
  expect(await text(ui)).toMatch(/kept\.js/)
  expect(await text(ui)).not.toMatch(/lost\.js/)
})

test('MultiEdit gives one step for each edit, NotebookEdit one for the cell', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, [
    { tool: 'MultiEdit', file_path: `${CWD}/m.js`, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c\nd', new_string: 'e' }], __result: { originalFile: 'a\nx\nc\nd\n' } },
    { tool: 'NotebookEdit', notebook_path: `${CWD}/n.ipynb`, new_source: 'print(2)', edit_mode: 'replace', cell_id: 'c1', __result: { old_source: 'print(1)', new_source: 'print(2)', cell_id: 'c1', cell_type: 'code', edit_mode: 'replace', language: 'python', notebook_path: `${CWD}/n.ipynb` } },
  ])
  const ui = await mountPane($, 'terminal')
  expect(await text(ui)).toMatch(/step 1 of 3/)
  expect(await text(ui)).toMatch(/edit 1 of 2/)
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/edit 2 of 2/)
  expect((await ui.find({ type: 'Code' }))?.text).toContain('@@ -3,2 +3 @@')
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/NotebookEdit · cell c1, replace, code/)
  expect((await ui.find({ type: 'Code' }))?.text).toContain('+print(2)')
})

test('Write: a new file, a rewrite, binary, the same content, a write held for review', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  const wr = (file: string, content: string, result: Record<string, unknown>) => ({ tool: 'Write', file_path: `${CWD}/${file}`, content, __result: { filePath: `${CWD}/${file}`, content, structuredPatch: [], originalFile: null, ...result } })
  await turn($, w, [
    wr('new.txt', 'l1\nl2\nl3\n', { type: 'create' }),
    wr('old.txt', 'a\nB\nc\n', { type: 'update', originalFile: 'a\nb\nc\n' }),
    wr('logo.png', 'xx', { type: 'create' }),
    wr('same.txt', 'same\n', { type: 'update', originalFile: 'same\n' }),
    wr('held.txt', 'held', { type: 'update', originalFile: 'x', staged: true }),
    wr('huge.txt', 'a\nb\n', { type: 'update', originalFile: null }),
  ])
  const ui = await mountPane($, 'terminal')
  expect(await text(ui)).toMatch(/step 1 of 5/)
  expect(await text(ui)).toMatch(/new file/)
  expect(await text(ui)).toMatch(/\+3/)
  expect((await ui.find({ type: 'Code' }))?.text).toContain('@@ -0,0 +1,3 @@')
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/rewrite/)
  expect((await ui.find({ type: 'Code' }))?.text).toContain('-b')
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/binary file/)
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/rewritten with the same content/)
  expect(await text(ui)).toMatch(/\(no line changes\)/)
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/too large to compare/)
})

test('an Edit with no result from the tool still shows its snippet, with a note that line numbers are unknown', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on) // the engine answers { result: {} }
  await start($, w)
  await turn($, w, [{ tool: 'Edit', file_path: `${CWD}/s.js`, old_string: 'x = 1', new_string: 'x = 2', replace_all: true }])
  const ui = await mountPane($, 'terminal')
  expect(await text(ui)).toMatch(/replace all/)
  expect(await text(ui)).toMatch(/line numbers not known/)
  expect((await ui.find({ type: 'Code' }))?.text).toContain('+x = 2')
})

test('the tool says the person changed the edit first, and where a replace-all landed', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, [{ tool: 'Edit', file_path: `${CWD}/r.js`, old_string: 'foo', new_string: 'bar', replace_all: true, __result: { originalFile: 'foo\nx\nfoo\nfoo\n', userModified: true } }])
  const ui = await mountPane($, 'terminal')
  expect(await text(ui)).toMatch(/replace all, 3 places, you changed it first/)
})

// ---------------------------------------------------------------------------------------------
// Any of the last turns
// ---------------------------------------------------------------------------------------------

test('any of the last turns can be replayed, /replay 2 and the Older and Newer buttons', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, [edit('first.js', SMALL)])
  await turn($, w, [edit('second.js', SMALL), edit('second-b.js', SMALL)])
  await turn($, w, [edit('third.js', SMALL)])
  expect((await run($, 'list')).text).toMatch(/1\. last turn.*\n2\. 1 turns ago.*\n3\. 2 turns ago/)
  expect((await run($, '2')).text).toMatch(/2 edits/)
  const ui = await mountPane($, 'terminal')
  expect(await text(ui)).toMatch(/Turn 2 of 3/)
  expect(await text(ui)).toMatch(/second\.js/)
  await ui.press({ key: 'older' })
  expect(await text(ui)).toMatch(/Turn 1 of 3/)
  expect(await text(ui)).toMatch(/first\.js/)
  expect(await ui.find({ key: 'older' })).toBeDefined()
  await ui.press({ key: 'older' })
  expect(await text(ui)).toMatch(/Turn 1 of 3/)
  await ui.press({ key: 'newer' })
  await ui.press({ key: 'newer' })
  expect(await text(ui)).toMatch(/Turn 3 of 3 \(last\)/)
  expect(await text(ui)).toMatch(/third\.js/)
  expect((await run($, '9')).text).toMatch(/Only 3 turns kept/)
  expect((await run($, '0')).text).toMatch(/count from 1/)
})

test('only the newest turns are kept, as many as the setting says', { timeoutMs: 30000, options: { keep_turns: 2 } }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  if (!(await applied($, /up to 2\)/))) return
  for (const n of ['a', 'b', 'c']) await turn($, w, [edit(`${n}.js`, SMALL)])
  const list = (await run($, 'list')).text ?? ''
  expect(list).toMatch(/1\./)
  expect(list).toMatch(/2\./)
  expect(list).not.toMatch(/3\./)
})

test('a pane left open on the newest turn follows the next turn', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, [edit('one.js', SMALL)])
  await run($)
  const ui = await mountPane($, 'terminal')
  expect(await text(ui)).toMatch(/one\.js/)
  await turn($, w, [edit('two.js', SMALL)])
  expect(await text(ui)).toMatch(/two\.js/)
  await run($, '2')
  expect(await text(ui)).toMatch(/one\.js/)
  await turn($, w, [edit('three.js', SMALL)])
  expect(await text(ui), 'a pane on an older turn stays on it').toMatch(/one\.js/)
  expect(await text(ui)).toMatch(/Turn 1 of 3/)
})

// ---------------------------------------------------------------------------------------------
// Views: file, overview, filter, split
// ---------------------------------------------------------------------------------------------

test('file view stacks every edit of a file, and Next goes to the next file', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, [edit('a.js', [' ctx', '-x', '+y']), edit('b.js', SMALL), edit('a.js', [' ctx', '-p', '+q'])])
  await run($, 'file')
  const ui = await mountPane($, 'terminal')
  expect(await text(ui)).toMatch(/file 1 of 2/)
  expect(await text(ui)).toMatch(/1\. Edit/)
  expect(await text(ui)).toMatch(/2\. Edit/)
  const codes = await ui.findAll({ type: 'Code' })
  expect(codes.length).toBe(2)
  expect(codes[0]?.text).toContain('+y')
  expect(codes[1]?.text).toContain('+q')
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/file 2 of 2/)
  expect(await text(ui)).toMatch(/b\.js/)
  await ui.press({ key: 'prev' })
  expect(await text(ui)).toMatch(/file 1 of 2/)
})

test('File and File buttons jump between files in the step view', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, [edit('a.js', SMALL), edit('a.js', SMALL), edit('b.js', SMALL), edit('c.js', SMALL)])
  await run($)
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'file-next' }))?.props.hotkey).toBe('f')
  expect((await ui.find({ key: 'file-back' }))?.props.hotkey).toBe('b')
  await ui.press({ key: 'file-next' })
  expect(await text(ui)).toMatch(/step 3 of 4/)
  await ui.press({ key: 'file-next' })
  expect(await text(ui)).toMatch(/step 4 of 4/)
  await ui.press({ key: 'file-next' })
  expect(await text(ui)).toMatch(/step 4 of 4/)
  await ui.press({ key: 'file-back' })
  expect(await text(ui)).toMatch(/step 3 of 4/)
})

for (const surface of ['terminal', 'desktop', 'mobile', 'vscode'] as const) {
  test(`the file list shows each file with its counts and jumps to it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const w = setup(on, { answer: byResult })
    await start($, w)
    await turn($, w, [edit('a.js', SMALL), edit('sections/b.liquid', SMALL), edit('a.js', SMALL), { tool: 'Write', file_path: `${CWD}/n.txt`, content: 'x', __result: { type: 'create', structuredPatch: [], originalFile: null } }])
    await run($, 'files')
    const ui = await mountPane($, surface)
    expect(await text(ui)).toMatch(/3 files/)
    const rows = await ui.findAll({ type: 'Button', text: /\+\d+ -\d+/ })
    expect(rows.length).toBe(3)
    expect(rows[0]?.text).toMatch(/^a\.js\s+x2\s+\+2 -2$/)
    expect(rows[2]?.text).toMatch(/n\.txt\s+new\s+\+1 -0/)
    const hasInput = await ui.find({ key: 'filter' })
    expect(Boolean(hasInput), 'a text field where the surface has one').toBe(surface !== 'mobile')
    await ui.press({ key: 'file-1' })
    expect(await text(ui)).toMatch(/step 2 of 4/)
    expect(await text(ui)).toMatch(/sections\/b\.liquid/)
    await ui.press({ key: 'view' })
    await ui.press({ key: 'view' })
    await ui.press({ key: 'view' })
    expect(await text(ui), 'View cycles step, file, files and back').toMatch(/step \d of 4/)
  })
}

test('the View button cycles step, file, files', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, [edit('a.js', SMALL), edit('b.js', SMALL)])
  await run($)
  const ui = await mountPane($, 'terminal')
  expect((await ui.find({ key: 'view' }))?.props.label).toBe('View: step')
  await ui.press({ key: 'view' })
  expect((await ui.find({ key: 'view' }))?.props.label).toBe('View: file')
  await ui.press({ key: 'view' })
  expect((await ui.find({ key: 'view' }))?.props.label).toBe('View: overview')
  expect(await ui.find({ key: 'next' }), 'no step buttons in the file list').toBeUndefined()
  await ui.press({ key: 'view' })
  expect((await ui.find({ key: 'view' }))?.props.label).toBe('View: step')
})

test('the filter keeps only matching files, from the command or the text field, and says when nothing matches', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, [edit('sections/a.liquid', SMALL), edit('assets/app.js', SMALL), edit('locales/en.json', SMALL), edit('snippets/b.liquid', SMALL)])
  expect((await run($, 'filter *.liquid')).text).toMatch(/2 edits/)
  await run($)
  const ui = await mountPane($, 'terminal')
  expect(await text(ui)).toMatch(/step 1 of 2/)
  expect(await text(ui)).toMatch(/filter: \*\.liquid \(2 of 4 edits\)/)
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/snippets\/b\.liquid/)
  await run($, 'files')
  await ui.input({ key: 'filter', text: 'assets, !x' })
  expect(await text(ui)).toMatch(/filter: assets, !x \(1 of 4 edits\)/)
  await ui.input({ key: 'filter', text: 'nothing-here' })
  expect(await text(ui)).toMatch(/No file matches "nothing-here"/)
  await ui.press({ key: 'clear' })
  expect(await text(ui)).toMatch(/4 files/)
  expect((await run($, 'filter !locales')).text).toMatch(/3 edits/)
  expect((await run($, 'filter')).text).toMatch(/cleared/)
  expect((await run($, 'status')).text).toMatch(/Filter: none/)
})

test('side by side shows old and new in two columns, and falls back to one column in a narrow pane', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, [edit('a.js', [' one', '-old line', '-gone', '+new line', ' two'])])
  await run($)
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  expect((await ui.find({ key: 'split' }))?.props.label).toBe('Split')
  await ui.press({ key: 'split' })
  expect(await ui.find({ type: 'Code' }), 'no unified Code in split').toBeUndefined()
  const cells = await text(ui)
  expect(cells).toMatch(/11 - old line/)
  expect(cells).toMatch(/11 \+ new line/)
  expect(cells).toMatch(/12 - gone/)
  expect(cells).toMatch(/│/)
  expect((await ui.find({ key: 'split' }))?.props.label).toBe('Unified')
  await ui.press({ key: 'split' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  expect((await run($, 'split')).text).toMatch(/side by side/)
  await ui.unmount()
  const narrow = await mountPane($, 'terminal', { bodyColumns: 50 })
  expect(await narrow.find({ type: 'Code' }), 'one column when too narrow').toBeDefined()
  expect(await text(narrow)).toMatch(/side by side needs 72 columns/)
  expect(await narrow.find({ key: 'split' }), 'no Split button in a narrow pane').toBeUndefined()
  expect((await run($, 'view unified')).text).toMatch(/one column/)
})

test('the layout can start side by side from the setting', { timeoutMs: 30000, options: { default_view: 'split' } }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  if (!(await applied($, /Layout: side by side/))) return
  await turn($, w, [edit('a.js', SMALL)])
  await run($)
  const ui = await mountPane($, 'desktop')
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await text(ui)).toMatch(/│/)
})

// ---------------------------------------------------------------------------------------------
// Big diffs: windows, folds
// ---------------------------------------------------------------------------------------------

const big = (n: number) => Array.from({ length: n }, (_, i) => `+line ${i + 1}`)

test('a long diff is shown in a window that scrolls with Down and Up, and says where it is', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  const body = big(120).map(l => l.slice(1)).join('\n')
  await turn($, w, [{ tool: 'Write', file_path: `${CWD}/long.txt`, content: body, __result: { type: 'create', structuredPatch: [], originalFile: null } }])
  await run($)
  const ui = await mountPane($, 'terminal')
  const first = (await ui.find({ type: 'Code' }))?.text ?? ''
  expect(first.split('\n').length).toBeLessThan(30)
  expect(await text(ui)).toMatch(/lines 1-16 of 120/)
  expect(first).toContain('+line 1\n')
  expect(await ui.find({ key: 'up' }), 'scroll buttons appear only for a long diff').toBeDefined()
  await ui.press({ key: 'down' })
  const second = (await ui.find({ type: 'Code' }))?.text ?? ''
  expect(second).toContain('@@ -0,0 +15,')
  expect(second).toContain('+line 15')
  expect(await text(ui)).toMatch(/lines 15-30 of 120/)
  for (let i = 0; i < 12; i += 1) await ui.press({ key: 'down' })
  expect(await text(ui), 'stops at the end').toMatch(/lines 105-120 of 120/)
  await ui.press({ key: 'up' })
  expect(await text(ui)).toMatch(/lines 91-106 of 120/)
  await ui.press({ key: 'next' })
})

test('a very long diff keeps its start and says how much was left out', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  const content = Array.from({ length: 2600 }, (_, i) => `row ${i}`).join('\n')
  await turn($, w, [{ tool: 'Write', file_path: `${CWD}/data.txt`, content, __result: { type: 'create', structuredPatch: [], originalFile: null, content } }])
  await run($)
  const ui = await mountPane($, 'terminal')
  expect(await text(ui)).toMatch(/\+2600/)
  expect(await text(ui)).toMatch(/Folded: large change, 2600 lines/)
  await ui.press({ key: 'fold' })
  expect(await text(ui)).toMatch(/of 2000/)
  expect(await text(ui)).toMatch(/600 more lines not kept/)
})

test('a large change, a minified file and a lock file start folded, and Expand opens them', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  const wr = (file: string, content: string) => ({ tool: 'Write', file_path: `${CWD}/${file}`, content, __result: { type: 'create', structuredPatch: [], originalFile: null, content } })
  await turn($, w, [wr('assets/app.min.js', 'var a=1;'), wr('package-lock.json', '{}\n'), wr('big.txt', Array.from({ length: 400 }, (_, i) => `r${i}`).join('\n')), wr('assets/long.js', `x=${'1,'.repeat(400)}`), wr('small.txt', 'a\nb')])
  await run($)
  const ui = await mountPane($, 'terminal')
  expect(await text(ui)).toMatch(/Folded: minified file/)
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.press({ key: 'fold' })
  expect((await ui.find({ type: 'Code' }))?.text).toContain('+var a=1;')
  expect((await ui.find({ type: 'Code' }))?.props.wrap).toBe('truncate-end')
  expect((await ui.find({ key: 'fold' }))?.props.label).toBe('Fold')
  await ui.press({ key: 'fold' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/Folded: lock file/)
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/Folded: large change, 400 lines/)
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/Folded: very long lines/)
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Code' }), 'a small file is never folded').toBeDefined()
  expect(await ui.find({ key: 'fold' })).toBeUndefined()
})

test('the fold limit is a setting, and 0 never folds on size', { timeoutMs: 30000, options: { fold_over_lines: 0 } }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  if (!(await applied($, /Never folds on size/))) return
  const content = Array.from({ length: 900 }, (_, i) => `r${i}`).join('\n')
  await turn($, w, [{ tool: 'Write', file_path: `${CWD}/big.txt`, content, __result: { type: 'create', structuredPatch: [], originalFile: null, content } }])
  await run($)
  const ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Code' })).toBeDefined()
})

test('a huge turn keeps counts for the steps past its budget', { timeoutMs: 60000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  const line = 'x'.repeat(900)
  const content = Array.from({ length: 1500 }, () => line).join('\n') // 1.3 MB of diff for one file
  const calls = Array.from({ length: 4 }, (_, i) => ({ tool: 'Write', file_path: `${CWD}/f${i}.txt`, content, __result: { type: 'create', structuredPatch: [], originalFile: null, content } }))
  await turn($, w, calls)
  await run($)
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'file-next' })
  await ui.press({ key: 'file-next' })
  await ui.press({ key: 'file-next' })
  expect(await text(ui)).toMatch(/step 4 of 4/)
  expect(await text(ui)).toMatch(/\+1500/)
  expect(await text(ui)).toMatch(/not kept/)
})

test('a turn with more edits than the limit counts the rest', { timeoutMs: 120000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  const calls = Array.from({ length: 305 }, (_, i) => edit(`f${i}.js`, SMALL))
  await turn($, w, calls)
  await run($)
  const ui = await mountPane($, 'terminal')
  expect(await text(ui)).toMatch(/step 1 of 300/)
  expect(await text(ui)).toMatch(/5 more not kept/)
})

// ---------------------------------------------------------------------------------------------
// Copy and save
// ---------------------------------------------------------------------------------------------

test('Copy puts the diff, the file or the turn on the clipboard as a patch', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, [edit('a.js', [' c', '-x', '+y']), edit('b.js', SMALL)])
  await run($)
  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'copy' })
  expect(w.copied.length).toBe(1)
  expect(w.copied[0]).toContain(`--- a/${CWD}/a.js\n+++ b/${CWD}/a.js`)
  expect(w.copied[0]).toContain('@@ -10,2 +10,2 @@')
  expect(w.copied[0]).not.toContain('b.js')
  expect(w.toasts.join()).toMatch(/Copied the patch of a\.js/)
  await ui.press({ key: 'view' })
  await ui.press({ key: 'view' })
  expect((await ui.find({ key: 'copy' }))?.props.label).toBe('Copy patch')
  await ui.press({ key: 'copy' })
  expect(w.copied[1]).toContain('a.js')
  expect(w.copied[1]).toContain('b.js')
  expect((await run($, 'copy')).text).toMatch(/Copied the patch of 2 edits/)
  expect(w.copied.length).toBe(3)
})

test('when the clipboard is out of reach the patch is saved to a file', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult, copy: false })
  await start($, w)
  await turn($, w, [edit('a.js', SMALL)])
  await run($)
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'copy' })
  expect(w.files[PATCH]).toContain('+new line')
  expect(w.toasts.join()).toMatch(/clipboard is out of reach.*~\/\.claude\/claude-mods\/replay-theater\/last\.patch/)
  expect((await run($, 'copy')).text).toMatch(/Saved the patch of 1 edit to ~\/\.claude/)
  expect((await run($, 'save')).text).toMatch(/Saved the patch of 1 edit/)
})

test('a clipboard that throws, and a disk that will not save, are reported and never thrown', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult, copy: 'throw', throwWrite: true })
  await start($, w)
  await turn($, w, [edit('a.js', SMALL)])
  expect((await run($, 'copy')).text).toMatch(/Could not copy or save/)
  expect((await run($, 'save')).text).toMatch(/Could not save/)
})

// ---------------------------------------------------------------------------------------------
// Removes and moves run in Bash
// ---------------------------------------------------------------------------------------------

test('rm shows the deleted file as removed lines, mv as a rename or move, a folder as removed', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, {
    answer: byResult,
    files: { [`${CWD}/snippets/old.liquid`]: 'a\nb\n', [`${CWD}/assets/a.css`]: 'x', [`${CWD}/readme.md`]: 'r', [`${CWD}/img.png`]: 'bin' },
    stat: { [`${CWD}/legacy`]: { kind: 'dir' }, [`${CWD}/archive`]: { kind: 'dir' } },
  })
  await start($, w)
  await turn($, w, [
    { tool: 'Bash', command: 'rm snippets/old.liquid && mv assets/a.css assets/b.css; git mv readme.md docs.md', __result: { stdout: '' } },
    { tool: 'Bash', command: 'mv readme.md archive/', __result: { stdout: '' } },
    { tool: 'Bash', command: 'rm -rf legacy', __result: { stdout: '' } },
    { tool: 'Bash', command: 'rm img.png missing.txt', __result: { stdout: '' } },
  ])
  const ui = await mountPane($, 'terminal')
  expect(await text(ui)).toMatch(/step 1 of 6/)
  expect(await text(ui)).toMatch(/snippets\/old\.liquid/)
  expect(await text(ui)).toMatch(/file removed/)
  expect(await text(ui)).toMatch(/Liquid snippet/)
  expect((await ui.find({ type: 'Code' }))?.text).toContain('-a')
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/assets\/a\.css → assets\/b\.css/)
  expect(await text(ui)).toMatch(/renamed from a\.css/)
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/readme\.md → docs\.md/)
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/readme\.md → archive\/readme\.md/)
  expect(await text(ui)).toMatch(/moved from readme\.md/)
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/legacy/)
  expect(await text(ui)).toMatch(/folder removed/)
  await ui.press({ key: 'next' })
  expect(await text(ui)).toMatch(/img\.png/)
  expect(await text(ui)).toMatch(/not text/)
})

test('a Bash command that failed, or that the mod cannot read with certainty, records nothing', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, {
    answer: e => (e.__fail === 'error' ? { result: 'x', isError: true, text: 'x' } : { result: {} }),
    files: { [`${CWD}/a.txt`]: 'a', [`${CWD}/b.txt`]: 'b' },
  })
  await start($, w)
  await turn($, w, [
    { tool: 'Bash', command: 'rm a.txt', __fail: 'error' },
    { tool: 'Bash', command: 'ls | xargs rm' },
    { tool: 'Bash', command: 'cd sub && rm b.txt' },
    { tool: 'Bash', command: 'rm $FILE' },
    { tool: 'Bash', command: 'rm *.txt' },
    { tool: 'Bash', command: 'echo hi > x.txt && rm -f b.txt' },
  ])
  expect((await run($)).text).toMatch(/no edits/i)
})

// ---------------------------------------------------------------------------------------------
// The switch, hide, open request, command words
// ---------------------------------------------------------------------------------------------

test('off in the switch file: nothing recorded, nothing drawn, /replay says so, and it comes back', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult, files: { [SW]: '{"replay-theater": false, "other-mod": false}' } })
  await start($, w)
  await turn($, w, [edit('a.js', SMALL)])
  expect((await run($)).text).toMatch(/is off/)
  expect(w.opened.length).toBe(0)
  const band = await mountBand($, 'terminal')
  expect(await band.find({ type: 'Text', text: /Replay:/ })).toBeUndefined()
  expect(await band.find({ text: /engine band/ })).toBeDefined()
  const pane = await mountPane($, 'terminal')
  expect(await text(pane)).toMatch(/off in/)
  expect((await run($, 'status')).text).toMatch(/off in the mods switch file/)
  // Back on: a missing key, true, or a broken file all mean on.
  w.files[SW] = '{"replay-theater": true}'
  await w.clock.advance(1500)
  await turn($, w, [edit('b.js', SMALL)])
  expect((await run($)).text).toMatch(/1 edit/)
  w.files[SW] = '{ not json'
  await w.clock.advance(1500)
  expect((await run($, 'list')).text).toMatch(/Turns kept/)
})

test('the switch is read at event time with a one second cache', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  const reads = () => w.reads.filter(p => p === SW).length
  await start($, w)
  const base = reads()
  for (let i = 0; i < 4; i += 1) await caller($)({ tool_use_id: id(), ...edit('a.js', SMALL) })
  expect(reads() - base, 'no file yet: no read').toBe(0)
  w.files[SW] = '{"replay-theater": false}'
  await caller($)({ tool_use_id: id(), ...edit('a.js', SMALL) })
  await caller($)({ tool_use_id: id(), ...edit('a.js', SMALL) })
  await w.clock.advance(1100)
  await caller($)({ tool_use_id: id(), ...edit('a.js', SMALL) })
  await caller($)({ tool_use_id: id(), ...edit('a.js', SMALL) })
  expect(reads() - base, 'one read for each second, not each event').toBeLessThanOrEqual(2)
})

test('switching off closes a pane that is open, at the next event', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, [edit('a.js', SMALL)])
  await run($)
  w.files[SW] = '{"replay-theater": false}'
  await w.clock.advance(1500)
  await turn($, w, [edit('b.js', SMALL)])
  expect(w.closed).toContain('replay-theater')
  const logged = w.files[LOG] ?? ''
  expect(logged).toMatch(/off: switched off/)
})

test('the hidden flag hides the hint and the pane, /replay brings it back and keeps the other switches', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult, files: { [SW]: '{"keep-me": false, "replay-theater:hidden": true}' } })
  await start($, w)
  await turn($, w, [edit('a.js', SMALL)])
  const band = await mountBand($, 'terminal')
  expect(await band.find({ type: 'Text', text: /Replay:/ })).toBeUndefined()
  await band.unmount()
  expect((await run($)).text).toMatch(/1 edit/)
  expect(JSON.parse(w.files[SW]!)).toEqual({ 'keep-me': false })
  expect(w.opened.length).toBe(1)
  await w.clock.advance(1500)
  expect((await run($, 'hide')).text).toMatch(/hidden/)
  expect(JSON.parse(w.files[SW]!)).toEqual({ 'keep-me': false, 'replay-theater:hidden': true })
  expect(w.closed).toContain('replay-theater')
  expect((await run($, 'status')).text).toMatch(/hint hidden/)
  expect((await run($, 'show')).text).toMatch(/shown again/)
  expect(JSON.parse(w.files[SW]!)).toEqual({ 'keep-me': false })
})

test('hide never overwrites a switch file it cannot read as an object', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult, files: { [SW]: '[1,2]' } })
  await start($, w)
  await turn($, w, [edit('a.js', SMALL)])
  expect((await run($, 'hide')).text).toMatch(/Could not change/)
  expect(w.files[SW]).toBe('[1,2]')
})

test('a request file left by a mods switch panel opens the replay at the next event', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, [edit('a.js', SMALL)])
  expect(w.opened.length).toBe(0)
  w.files[OPEN] = ''
  await w.clock.advance(1500)
  await caller($)({ tool_use_id: id(), tool: 'Read', file_path: `${CWD}/x` })
  expect(w.opened.length, 'a Read is not watched, so no open yet').toBe(0)
  await caller($)({ tool_use_id: id(), ...edit('b.js', SMALL) })
  expect(w.opened.length).toBe(1)
  expect(w.runs).toContainEqual(['rm', '-f', OPEN])
  expect(OPEN in w.files).toBe(false)
})

test('an open request with nothing to replay says so, and one while off is dropped quietly', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  w.files[OPEN] = ''
  await w.clock.advance(1500)
  await caller($)({ tool_use_id: id(), ...edit('b.js', SMALL) })
  expect(w.toasts.join()).toMatch(/no edits to replay yet/)
  w.files[SW] = '{"replay-theater": false}'
  w.files[OPEN] = ''
  await w.clock.advance(1500)
  const before = w.toasts.length
  await caller($)({ tool_use_id: id(), ...edit('c.js', SMALL) })
  expect(w.toasts.length).toBe(before)
  expect(OPEN in w.files).toBe(false)
})

test('/replay registers with a hint, and its words work: help, status, bad words', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  expect(w.registered[0]).toMatchObject({ name: 'replay' })
  expect(String(w.registered[0]?.argumentHint)).toMatch(/filter/)
  expect((await run($, 'help')).text).toMatch(/In the pane: n and p step/)
  expect((await run($, 'status')).text).toMatch(/0 turns kept \(up to 10\), 0 edits.*Folds diffs over 300 lines\. Hint: on\./)
  expect((await run($, 'bogus')).text).toMatch(/Do not know "bogus"/)
  expect((await run($, 'view middle')).text).toMatch(/Use \/replay view/)
  expect((await run($, 'copy x')).text).toMatch(/Use \/replay copy/)
  expect((await run($)).text).toMatch(/no edits to replay yet/)
  expect((await run($, 'list')).text).toMatch(/No file edits/)
  expect((await run($, 'copy')).text).toMatch(/No file edits/)
  await turn($, w, [edit('a.js', SMALL)])
  expect((await run($, 'status')).text).toMatch(/1 turn kept.*1 edit\. Layout: unified/)
  expect((await run($, 'filter zzz')).text).toMatch(/0 edits/)
  expect((await run($, 'copy')).text).toMatch(/No file matches "zzz"/)
})

// ---------------------------------------------------------------------------------------------
// Fail open, and the log
// ---------------------------------------------------------------------------------------------

test('every failure inside the mod is logged and skipped: the tool call comes back as the engine answered', { timeoutMs: 30000 }, async ($, on) => {
  const answered = { result: { filePath: `${CWD}/a.js`, structuredPatch: [patch(1, SMALL)] }, text: 'ok' }
  const w = setup(on, { answer: () => answered, throwWrite: true, throwRead: true, throwCwd: true })
  await start($, w)
  for (const input of [{ tool: 'Edit', file_path: `${CWD}/a.js`, old_string: 'a', new_string: 'b' }, { tool: 'Bash', command: 'rm a.txt' }, { tool: 'Write', file_path: 'x', content: 'y' }]) {
    const ran = await caller($)({ tool_use_id: id(), ...input })
    expect(ran).toEqual(answered)
  }
  expect(Object.keys(w.files).filter(k => k.includes('replay-theater'))).toEqual([])
})

test('a throwing engine call while recording is logged, and the edit still goes through', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult, throwStat: true, files: { [`${CWD}/a.txt`]: 'a' } })
  await start($, w)
  const ran = await caller($)({ tool_use_id: id(), tool: 'Bash', command: 'rm a.txt && mv b.txt c.txt', __result: { stdout: 'hi' } })
  expect(ran.result).toEqual({ stdout: 'hi' })
  expect((await run($)).text, 'a path that cannot be read counts as not there').toMatch(/no edits/i)
})

test('the log keeps its newest 300 lines and never holds file text', { timeoutMs: 60000 }, async ($, on) => {
  const secret = 'SECRET_BODY_TEXT'
  const w = setup(on, { answer: byResult, files: { [LOG]: Array.from({ length: 400 }, (_, i) => `old line ${i}`).join('\n') } })
  await start($, w)
  await turn($, w, [{ tool: 'Write', file_path: `${CWD}/s.txt`, content: secret, __result: { type: 'create', structuredPatch: [], originalFile: null } }])
  await run($)
  // A logged event: the mod is switched off while its pane is open.
  w.files[SW] = '{"replay-theater": false}'
  await w.clock.advance(1500)
  await turn($, w, [edit('x.js', SMALL)])
  const lines = (w.files[LOG] ?? '').split('\n').filter(Boolean)
  expect(lines.length).toBe(300)
  expect(lines[lines.length - 1]).toMatch(/off: switched off/)
  expect(lines.join('\n')).not.toContain(secret)
})

test('a failing engine call never reaches the person: a disk that cannot be read is skipped', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult, throwRead: true })
  await start($, w)
  await turn($, w, [edit('a.js', SMALL)])
  expect((await run($)).text).toMatch(/1 edit/)
  expect((await run($, 'status')).text).toMatch(/Replay Theater is on/)
})

test('a Pane drawn for another id is left to the engine, and the band passes on a rendering fault', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, [edit('a.js', SMALL)])
  const other = (await $.ui.mount({ plugin: 'replay-theater', surface: 'terminal', component: 'Pane', requestId: 'other', props: bodyProps } as never)) as Mounted
  expect(await other.find({ text: /engine band/ })).toBeDefined()
})

test('the empty pane says there is nothing to replay', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  const ui = await mountPane($, 'terminal')
  expect(await text(ui)).toMatch(/No file edits to replay yet/)
  await ui.press({ key: 'close' })
  expect(w.closed).toContain('replay-theater')
})

test('a long strip of steps is cut around the current one', { timeoutMs: 120000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, Array.from({ length: 60 }, (_, i) => edit(`f${i}.js`, SMALL)))
  await run($)
  const ui = await mountPane($, 'terminal', { bodyColumns: 50 })
  const cells = await ui.findAll({ type: 'Text', text: /^ \d+ $/ })
  expect(cells.length).toBeLessThan(25)
  expect(cells[0]?.text).toBe(' 1 ')
  for (let i = 0; i < 40; i += 1) await ui.press({ key: 'next' })
  const later = await ui.findAll({ type: 'Text', text: /^ \d+ $/ })
  expect(later.map(c => c.text)).toContain(' 41 ')
  expect(later.map(c => c.text)).not.toContain(' 1 ')
})

// ---------------------------------------------------------------------------------------------
// More edges
// ---------------------------------------------------------------------------------------------

test('edits that run at the same time are all recorded', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  const t = id()
  await ($.turn.start as (i: unknown) => Promise<unknown>)({ text: 'go', turnId: t })
  await Promise.all(Array.from({ length: 8 }, (_, i) => caller($)({ tool_use_id: id(), ...edit(`p${i}.js`, SMALL) })))
  await ($.turn.complete as (i: unknown) => Promise<unknown>)({ answer: '', durationMs: 1, isAborted: false, turnId: t, reason: 'answer' })
  await w.clock.settle()
  expect((await run($, 'list')).text).toMatch(/8 edits in 8 files/)
})

test('a turn the person interrupted still keeps the edits that ran', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  const t = id()
  await ($.turn.start as (i: unknown) => Promise<unknown>)({ text: 'go', turnId: t })
  await caller($)({ tool_use_id: id(), ...edit('a.js', SMALL) })
  await ($.turn.complete as (i: unknown) => Promise<unknown>)({ answer: '', durationMs: 1, isAborted: true, turnId: t, reason: 'aborted' })
  await w.clock.settle()
  expect((await run($, 'list')).text).toMatch(/1 edit in 1 file/)
})

test('/replay step and /replay file open in that view, on the turn asked for', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, [edit('a.js', SMALL), edit('a.js', SMALL), edit('b.js', SMALL)])
  await turn($, w, [edit('c.js', SMALL)])
  await run($, 'file 2')
  const ui = await mountPane($, 'terminal')
  expect(await text(ui)).toMatch(/file 1 of 2/)
  expect(await text(ui)).toMatch(/Turn 1 of 2/)
  await run($, 'step')
  expect(await text(ui)).toMatch(/step 1 of 1/)
  expect(await text(ui)).toMatch(/c\.js/)
})

test('the file list pages through many files', { timeoutMs: 60000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  await turn($, w, Array.from({ length: 30 }, (_, i) => edit(`dir/file${String(i).padStart(2, '0')}.js`, SMALL)))
  await run($, 'files')
  const ui = await mountPane($, 'terminal')
  const rows = async () => (await ui.findAll({ type: 'Button', text: /\+1 -1$/ })).map(b => b.text ?? '')
  expect((await rows()).length).toBe(16 - 2)
  expect((await rows())[0]).toMatch(/^dir\/file00\.js/)
  expect(await text(ui)).toMatch(/files 1-14 of 30/)
  expect((await ui.find({ key: 'file-0' }))?.props.autoFocus, 'the first file takes the ring').toBe(true)
  await ui.press({ key: 'down' })
  expect((await rows())[0]).toMatch(/^dir\/file13\.js/)
  for (let i = 0; i < 5; i += 1) await ui.press({ key: 'down' })
  expect(await text(ui)).toMatch(/files 17-30 of 30/)
  await ui.press({ key: 'up' })
  expect(await text(ui)).toMatch(/files 4-17 of 30/)
})

test('while off, a finished turn is not kept', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  w.files[SW] = '{"replay-theater": false}'
  await w.clock.advance(1500)
  await turn($, w, [edit('a.js', SMALL)])
  w.files[SW] = '{}'
  await w.clock.advance(1500)
  expect((await run($, 'list')).text).toMatch(/No file edits/)
})

test('a dropped long path is cut from the left, so the file name stays', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  const deep = `${'very-long-folder-name/'.repeat(8)}last.js`
  await turn($, w, [edit(deep, SMALL), edit('b.js', SMALL)])
  await run($, 'files')
  const ui = await mountPane($, 'terminal', { bodyColumns: 50 })
  const first = (await ui.findAll({ type: 'Button', text: /\+1 -1$/ }))[0]?.text ?? ''
  expect(first).toMatch(/^….*last\.js\s+\+1 -1$/)
  expect(first.length).toBeLessThanOrEqual(50)
})

test('the status says whether the mod is on, hidden or off, and the settings in force', { timeoutMs: 30000 }, async ($, on) => {
  const w = setup(on, { answer: byResult })
  await start($, w)
  expect((await run($, 'status')).text).toMatch(/^Replay Theater is on\./)
  w.files[SW] = '{"replay-theater:hidden": true}'
  expect((await run($, 'status')).text).toMatch(/is on, hint hidden/)
  w.files[SW] = '{"replay-theater": false}'
  expect((await run($, 'status')).text).toMatch(/is off in the mods switch file/)
  expect((await run($, 'filter x')).text).toMatch(/Turn it on/)
})
