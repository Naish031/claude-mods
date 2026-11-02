import { expect, test } from 'claude-code/testing'

import { briefPrompt, hasStructure, isBrainDump, parseGaps, tidy } from './register'

const BRIEF = `## Goal
Make the add-to-cart button easier to use on mobile.

## Requirements
- Make the button bigger on mobile.
- Check its color.`

const FOUR = `THE JOB
Fix the add-to-cart button.

THE WHY
Shoppers on phones miss it.

THE GUARDRAILS
- Mobile only.

DONE MEANS
- It is easy to tap.`

const filler =
  'okay so I was thinking about the product page and um the add to cart button is kind of small on mobile and maybe the color is off too and I do not know if the sticky bar is helping or hurting but can you take a look and fix whatever is wrong and keep the desktop layout exactly as it is because the client signed it off last week'

const dump = filler.split(/\s+/).slice(0, 60).join(' ')
const composer = { kind: 'composer' } as const

type Harness = {
  asked: string[]
  filled: string[]
  passed: string[]
  logs: string[]
  files: Record<string, string>
  store: Record<string, unknown>
  prompts: string[]
}

// Stands in for the engine under the mod: one hook per call the mod makes.
const wire = (
  on: any,
  opts: {
    gaps?: string
    brief?: string
    answers?: string[]
    failModel?: boolean
    refuseFill?: boolean
    surfaces?: string[]
  } = {},
): Harness => {
  const h: Harness = { asked: [], filled: [], passed: [], logs: [], files: {}, store: {}, prompts: [] }
  const answers = [...(opts.answers ?? [])]

  on('session.start', async (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: undefined }))
  on('env.get', async () => ({ value: '/Users/test' }))
  on('store.get', async (_: unknown, e: { key: string }) => ({ value: h.store[e.key] }))
  on('store.set', async (_: unknown, e: { key: string; value: unknown }) => {
    h.store[e.key] = e.value
    return { value: undefined }
  })
  on('fs.exists', async (_: unknown, e: { path: string }) => ({ value: e.path in h.files }))
  on('fs.read', async (_: unknown, e: { path: string }) => ({ value: h.files[e.path] ?? '' }))
  on('fs.write', async (_: unknown, e: { path: string; text: string }) => {
    h.files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('session.surfaces', async () => ({ value: opts.surfaces ?? ['desktop'] }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.log', async (_: unknown, e: { text: string }) => {
    h.logs.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, async (_: unknown, e: { questions: { question: string }[] }) => {
    const q = e.questions[0]?.question ?? ''
    h.asked.push(q)
    return { result: { questions: e.questions, answers: { [q]: answers.shift() ?? 'Send it' } } }
  })
  on('model.complete', async (_: unknown, e: { system?: string; prompt: string }) => {
    h.prompts.push(e.prompt)

    if (opts.failModel) {
      return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: {} } }
    }

    const isGap = (e.system ?? '').includes('Return JSON only') || (e.system ?? '').includes('"questions"')

    return { value: { isAnswered: true, text: isGap ? (opts.gaps ?? '{"questions":[]}') : (opts.brief ?? BRIEF), usage: {} } }
  })
  on('prompt.fill', async (_: unknown, e: { text: string }) => {
    h.filled.push(e.text)
    return opts.refuseFill ? { isFilled: false, refusal: 'dialog', text: '' } : { isFilled: true, text: e.text }
  })
  on('prompt.submit', async (_: unknown, e: { text: string }) => {
    h.passed.push(e.text)
    return { text: e.text }
  })

  return h
}

const start = ($: any, surface: string) => $.session.start({ source: 'startup', cwd: '/tmp', surface, isInteractive: true })

const setting = ($: any, args: string) => $.command.run({ command: 'braindump', args, origin: composer } as never)

// ---- pure helpers

test('the helpers read, clean and check text', () => {
  expect(isBrainDump(dump, 40)).toBe(true)
  expect(isBrainDump('fix the button', 40)).toBe(false)
  expect(isBrainDump(`## Goal\n${dump}`, 40)).toBe(false)
  expect(isBrainDump(`/clear ${dump}`, 40)).toBe(false)

  expect(tidy('```\n## Goal\nA — B\n```', 'standard', true)).toBe('## Goal\nA, B')
  expect(tidy('Sure! Here it is:\n\n## Goal\nA', 'standard', true)).toBe('## Goal\nA')
  expect(tidy('x — y', 'standard', false)).toBe('x — y')
  expect(hasStructure(FOUR, 'four-part')).toBe(true)
  expect(hasStructure('THE JOB\nonly', 'four-part')).toBe(false)

  const gaps = parseGaps('```json\n{"questions":[{"q":"Which store","options":["Live","Staging","Other"]},{"q":"bad","options":["one"]}]}\n```')
  expect(gaps).toEqual([{ q: 'Which store?', options: ['Live', 'Staging'] }])
  expect(() => parseGaps('no json here')).toThrow()

  expect(briefPrompt('x', [{ q: 'Q?', a: null }])).toContain('skipped, no answer')
})

// ---- the hook

for (const surface of ['desktop', 'terminal'] as const) {
  test(`shapes a long dump and puts the brief in the prompt box (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const h = wire(on, { surfaces: [surface] })
    await start($, surface)

    const r = await $.prompt.submit({ text: dump, origin: composer, wait: false } as never)

    expect((r as { drop?: string }).drop).toBe('shaped into a brief')
    expect(h.passed.length, 'the original is not sent').toBe(0)
    expect(h.filled).toEqual([BRIEF])
    expect(h.store.lastOriginal, 'the original is kept for undo').toBe(dump)
    expect(Object.values(h.files).join(''), 'a log line is written').toContain('shaped in')

    // Enter on the brief itself goes straight through.
    await $.prompt.submit({ text: BRIEF, origin: composer, wait: false } as never)
    expect(h.passed).toEqual([BRIEF])
  })
}

test('short prompts, slash lines, other senders and the !! bypass pass through', { timeoutMs: 30000 }, async ($, on) => {
  const h = wire(on)
  await start($, 'desktop')

  const short = 'fix the add to cart button on mobile please'
  await $.prompt.submit({ text: short, origin: composer, wait: false } as never)
  await $.prompt.submit({ text: `/clear ${dump}`, origin: composer, wait: false } as never)
  await $.prompt.submit({ text: dump, origin: { kind: 'task-notification' }, wait: false } as never)
  await $.prompt.submit({ text: `${dump} !!`, origin: composer, wait: false } as never)

  expect(h.passed).toEqual([short, `/clear ${dump}`, dump, dump])
  expect(h.filled.length).toBe(0)
  expect(h.prompts.length, 'no model call for any of them').toBe(0)
})

test('questions are asked one at a time and their answers reach the brief', { timeoutMs: 30000 }, async ($, on) => {
  const gaps = '{"questions":[{"q":"Which theme?","options":["Live","Staging"]},{"q":"Which width?","options":["375","768"]}]}'
  const h = wire(on, { gaps, answers: ['Staging', '375'] })
  await start($, 'desktop')

  await $.prompt.submit({ text: dump, origin: composer, wait: false } as never)

  expect(h.asked).toEqual(['Which theme?', 'Which width?'])
  const briefCall = h.prompts[h.prompts.length - 1] ?? ''
  expect(briefCall).toContain('A: Staging')
  expect(briefCall).toContain('A: 375')
})

test('bad JSON from the gap check still makes a brief', { timeoutMs: 30000 }, async ($, on) => {
  const h = wire(on, { gaps: 'sorry, no json' })
  await start($, 'desktop')

  await $.prompt.submit({ text: dump, origin: composer, wait: false } as never)

  expect(h.asked.length).toBe(0)
  expect(h.filled).toEqual([BRIEF])
})

test('a failed model call sends the original and logs why', { timeoutMs: 30000 }, async ($, on) => {
  const h = wire(on, { failModel: true })
  await start($, 'desktop')

  await $.prompt.submit({ text: dump, origin: composer, wait: false } as never)

  expect(h.passed).toEqual([dump])
  expect(Object.values(h.files).join('')).toContain('overloaded')
})

test('switched off in the shared switch file or by /braindump off, it does nothing', { timeoutMs: 30000 }, async ($, on) => {
  const h = wire(on)
  h.files['/Users/test/.claude/claude-mods/switches.json'] = '{"brain-dump": false}'
  await start($, 'desktop')

  await $.prompt.submit({ text: dump, origin: composer, wait: false } as never)
  expect(h.passed).toEqual([dump])
  expect(h.prompts.length).toBe(0)
})

test('/braindump off turns it off and undo restores the original', { timeoutMs: 30000 }, async ($, on) => {
  const h = wire(on)
  await start($, 'desktop')

  await $.prompt.submit({ text: dump, origin: composer, wait: false } as never)
  expect(h.filled.length).toBe(1)

  const undo = await $.command.run({ command: 'braindump', args: 'undo', origin: composer } as never)
  expect((undo as { text?: string }).text).toContain('back in the prompt box')
  expect(h.filled[1]).toBe(dump)

  await $.command.run({ command: 'braindump', args: 'off', origin: composer } as never)
  expect(h.store.enabled).toBe(false)

  await $.prompt.submit({ text: dump, origin: composer, wait: false } as never)
  expect(h.passed[h.passed.length - 1]).toBe(dump)
})

test('with no one to ask (no surface) the prompt is left alone', { timeoutMs: 30000 }, async ($, on) => {
  const h = wire(on, { surfaces: [] })
  await start($, 'desktop')

  await $.prompt.submit({ text: dump, origin: composer, wait: false } as never)
  expect(h.passed).toEqual([dump])
  expect(h.prompts.length).toBe(0)
})

test('confirm delivery shows the brief, then sends it on Send it', { timeoutMs: 30000 }, async ($, on) => {
  const h = wire(on, { answers: ['Send it'] })
  await start($, 'desktop')
  await setting($, 'delivery confirm')

  await $.prompt.submit({ text: dump, origin: composer, wait: false } as never)

  expect(h.logs.join('\n')).toContain('Goal')
  expect(h.asked).toEqual(['Send this prompt?'])
  expect(h.passed).toEqual([BRIEF])
  expect(h.filled.length).toBe(0)
})

test('confirm delivery: Cancel drops the prompt and prints the original', { timeoutMs: 30000 }, async ($, on) => {
  const h = wire(on, { answers: ['Cancel'] })
  await start($, 'desktop')
  await setting($, 'delivery confirm')

  const r = await $.prompt.submit({ text: dump, origin: composer, wait: false } as never)

  expect((r as { drop?: string }).drop).toContain('cancelled')
  expect(h.passed.length).toBe(0)
  expect(h.logs.join('\n')).toContain(dump)
})

test('auto delivery sends the brief at once', { timeoutMs: 30000 }, async ($, on) => {
  const h = wire(on)
  await start($, 'desktop')
  await setting($, 'delivery auto')

  await $.prompt.submit({ text: dump, origin: composer, wait: false } as never)
  expect(h.passed).toEqual([BRIEF])
})

test('review falls back to the dialog when the prompt box refuses', { timeoutMs: 30000 }, async ($, on) => {
  const h = wire(on, { refuseFill: true, answers: ['Send my original'] })
  await start($, 'desktop')

  await $.prompt.submit({ text: dump, origin: composer, wait: false } as never)

  expect(h.asked).toEqual(['Send this prompt?'])
  expect(h.passed).toEqual([dump])
})

test('four-part format keeps the four headings', { timeoutMs: 30000 }, async ($, on) => {
  const h = wire(on, { brief: FOUR })
  await start($, 'desktop')
  await setting($, 'format four-part')
  await setting($, 'delivery auto')

  await $.prompt.submit({ text: dump, origin: composer, wait: false } as never)
  expect(h.passed).toEqual([FOUR])
})
