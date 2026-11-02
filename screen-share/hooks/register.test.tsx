import { expect, test } from 'claude-code/testing'

import { BAND, EMAIL, LOG, MONEY, PRIVATE, SURFACES, SWITCHES, WORDS, rig } from '../tests/rig'
import { BAR, FADE } from './mask'

// The same line with each private span drawn as a bar of its own length.
const BARRED = `Mail ${BAR.repeat(EMAIL.length)} or call ${BAR.repeat(3)} ${BAR.repeat(4)} ${BAR.repeat(6)}. The deal is ${BAR.repeat(MONEY.length)} for 2026, we used 182k tokens on v2.1.309 across 12 files.`

// Another mod, written inline: it says things through $.ui when asked, so the mod's hooks on them can be tried.
const speaker = {
  name: 'speaker',
  register(on: any) {
    on('command.run', { command: 'speak' }, async ($: any, e: any) => {
      const { text, title } = JSON.parse(e.args)
      await $.ui.toast(text)
      await $.ui.log(text)
      await $.ui.notice('t1', text)
      await $.ui.status(text)
      await $.ui.notify(text, { title })
      const shown = await $.prompt.suggest({ text })
      return { text: JSON.stringify(shown) }
    })
  },
}

const bash = { stdout: PRIVATE, stderr: '', interrupted: false }

async function drawAll(r: ReturnType<typeof rig>, surface: string) {
  await r.mount(surface, 'AssistantMessage', { text: PRIVATE, isFirstOfReply: true })
  await r.mount(surface, 'UserMessage', { text: PRIVATE, origin: { kind: 'composer' }, isExpanded: true })
  await r.mount(surface, 'ToolResult', { tool_use_id: 't1', tool: 'Bash', output: bash, isErrored: false })
  await r.mount(surface, 'ToolUse', { tool_use_id: 't1', tool: 'Bash', input: { command: `echo "${PRIVATE}"` }, output: bash, isRunning: false, isErrored: false, isInterrupted: false })
  await r.mount(surface, 'CommandOutput', { command: 'cost', args: '', text: PRIVATE, isErrored: false })
}

for (const surface of SURFACES) {
  test(`hides private data on screen only while on, and shows it again off (${surface})`, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    const { seen, statuses, invalidated } = r.w

    // Off: every prop reaches the screen as it came, and there is no band.
    await drawAll(r, surface)
    expect(seen.AssistantMessage.text, 'off: assistant text unchanged').toBe(PRIVATE)
    expect(seen.UserMessage.text, 'off: user text unchanged').toBe(PRIVATE)
    expect(seen.ToolResult.output, 'off: result unchanged').toEqual(bash)
    expect(seen.CommandOutput.text, 'off: command output unchanged').toBe(PRIVATE)
    let band = await r.mount(surface, 'AbovePrompt', BAND)
    expect(await band.find({ key: 'off' }), 'off: no band').toBeUndefined()
    expect(await band.find({ text: /REST/ }), 'off: other bands show').toBeDefined()

    // Turn it on.
    const before = invalidated.length
    const said = await r.cmd('')
    expect(said, 'command says on').toContain('Screen share ON')
    expect(statuses.at(-1), 'status line on').toBe('Screen share ON')
    expect(r.w.toasts.at(-1), 'toast says on').toContain('Screen share ON')
    expect(invalidated.slice(before), 'redraw asked at once').toContain('ui.render')

    // First frame: the light fade-in bar. 200 ms on: the full bars, and one more redraw.
    await drawAll(r, surface)
    expect(String(seen.AssistantMessage.text), 'fade frame').toBe(BARRED.replaceAll(BAR, FADE))
    const mid = invalidated.length
    await r.w.clock.advance(200)
    expect(invalidated.length, 'fade redraws').toBeGreaterThan(mid)
    await drawAll(r, surface)
    const shown = String(seen.AssistantMessage.text)
    expect(shown, 'email, phone and amount become bars of equal length').toBe(BARRED)
    expect(shown.length, 'line keeps its length').toBe(PRIVATE.length)
    expect(shown).not.toContain('jane.doe@acme.com')
    expect(shown).not.toContain('7700 900123')
    expect(shown).not.toContain('4,250')
    expect(shown, 'year stays').toContain('2026')
    expect(shown, 'token count stays').toContain('182k tokens')
    expect(shown, 'version stays').toContain('v2.1.309')
    expect(shown, 'a plain count stays').toContain('12 files')
    expect(String(seen.UserMessage.text), 'user row masked').toBe(BARRED)
    expect(String(seen.CommandOutput.text), 'command output masked').toBe(BARRED)
    expect((seen.ToolResult.output as { stdout: string }).stdout, 'tool result masked').toBe(BARRED)
    expect((seen.ToolResult.output as { interrupted: boolean }).interrupted, 'result keeps its shape').toBe(false)
    expect((seen.ToolUse.input as { command: string }).command, 'tool input masked').not.toContain(EMAIL)
    expect((seen.ToolUse.output as { stdout: string }).stdout, 'tool row output masked').toBe(BARRED)

    // The band says it is on, and the other bands still show.
    band = await r.mount(surface, 'AbovePrompt', BAND)
    expect(await band.find({ text: /SCREEN SHARE ON/ }), 'band says on').toBeDefined()
    expect(await band.find({ key: 'off' }), 'band has Turn off').toBeDefined()
    expect(await band.find({ key: 'peek' }), 'band has Peek').toBeDefined()
    expect(await band.find({ text: /REST/ }), 'other bands still show').toBeDefined()
    const modes = await r.mount(surface, 'SessionMode', { modes: ['focus'] })
    expect(await modes.find({ text: /focus & screen share ON/ }), 'footer label').toBeDefined()

    // Turn off from the band: the real text draws again at once.
    const atOff = invalidated.length
    await band.press({ key: 'off' })
    expect(statuses.at(-1), 'status cleared').toBeUndefined()
    expect(invalidated.slice(atOff), 'redraw asked at once when off').toContain('ui.render')
    await drawAll(r, surface)
    expect(seen.AssistantMessage.text, 'off again: real text').toBe(PRIVATE)
    expect(seen.ToolResult.output, 'off again: real result').toEqual(bash)
    band = await r.mount(surface, 'AbovePrompt', BAND)
    expect(await band.find({ key: 'off' }), 'band gone').toBeUndefined()
  })
}

// ---------------------------------------------------------------- the rest of the surfaces

for (const surface of SURFACES) {
  test(`hides tool groups, spinners, an errored result and a peer's message (${surface})`, async ($, on) => {
    const r = rig($, on, { store: { on: true } })
    await r.start(surface)
    await r.w.clock.advance(300)
    const { seen } = r.w

    await r.mount(surface, 'ToolGroup', { calls: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: `/Users/test/${EMAIL}.txt` }, output: bash }], isActive: false, isExpanded: false })
    const group = seen.ToolGroup.calls[0]
    expect(group.tool_use_id, 'ids pass untouched').toBe('a')
    expect(group.tool, 'tool names pass untouched').toBe('Read')
    expect(JSON.stringify(group), 'group calls masked').not.toContain(EMAIL)

    await r.mount(surface, 'Spinner', { word: `Creating ${EMAIL}.md`, message: null, suffix: '…', mode: 'tool-use' })
    expect(seen.Spinner.word, 'spinner word masked').not.toContain(EMAIL)

    // An errored result is drawn by the engine from its own copy, so the mod draws it itself.
    const err = await r.mount(surface, 'ToolResult', { tool_use_id: 'e', tool: 'Bash', output: `failed for ${EMAIL}`, isErrored: true })
    expect(await err.find({ text: /failed for/ }), 'error text still readable').toBeDefined()
    expect(await err.find({ text: /jane/ }), 'error text masked').toBeUndefined()
    const err2 = await r.mount(surface, 'ToolResult', { tool_use_id: 'e', tool: 'Bash', output: { weird: true }, isErrored: true })
    expect(await err2.find({ text: /hidden by screen share/ }), 'unknown error shape is a placeholder').toBeDefined()

    // A message another agent sent is drawn by the mod, as one masked row.
    const from = await r.mount(surface, 'UserMessage', { text: `from ${EMAIL}`, origin: { kind: 'peer' }, isExpanded: false, from: { name: 'helper' } })
    expect(await from.find({ text: /from/ })).toBeDefined()
    expect(await from.find({ text: /jane/ }), 'peer message masked').toBeUndefined()
  })
}

test('the info notice on the terminal is masked', async ($, on) => {
  const r = rig($, on, { store: { on: true } })
  await r.start('terminal')
  await r.mount('terminal', 'InfoNotice', { text: `Logged in as ${EMAIL}`, command: null })
  expect(r.w.seen.InfoNotice.text).not.toContain(EMAIL)
})

for (const surface of SURFACES) {
  test(`other mods' panes and bands are walked, their buttons are not touched (${surface})`, async ($, on) => {
    const r = rig($, on, { store: { on: true } })
    await r.start(surface)
    await r.w.clock.advance(300)
    r.w.seen.paneText = `Files for ${EMAIL}`
    const pane = await r.mount(surface, 'Pane', { title: 'x', isFocused: false, bodyColumns: 80, placement: 'inline', scroll: { bodyRows: 10 }, view: {} })
    expect(await pane.find({ text: /Files for/ }), 'pane text is there').toBeDefined()
    expect(await pane.find({ text: /jane/ }), 'pane text masked').toBeUndefined()
    expect(await pane.find({ key: 'pane-go' }), 'its button keeps its key').toBeDefined()

    r.w.seen.otherBand = `Cache cold, replying costs ${MONEY}`
    const band = await r.mount(surface, 'AbovePrompt', BAND)
    expect(await band.find({ text: /Cache cold/ })).toBeDefined()
    expect(await band.find({ text: /4,250/ }), 'another mod band masked').toBeUndefined()
    expect(await band.find({ text: /SCREEN SHARE ON/ })).toBeDefined()

    // While a survey holds the band the mod yields to it.
    const survey = await r.mount(surface, 'AbovePrompt', { ...(BAND as object), hasSurvey: true } as never)
    expect(await survey.find({ key: 'off' }), 'no band over a survey').toBeUndefined()
  })
}

test('text other mods put on screen through $.ui is masked: toast, log, notice, status, notification, suggestion', { plugins: [speaker] }, async ($, on) => {
  const r = rig($, on, { store: { on: true } })
  await r.start('desktop')
  await r.w.clock.advance(300)
  const say = async (text: string, title = 'Mail') => {
    const res = await $.command.run({ command: 'speak', args: JSON.stringify({ text, title }) } as never)
    return JSON.parse(String((res as { text?: string }).text))
  }
  const shown = await say(`Sent to ${EMAIL} for ${MONEY}`, `Order ${MONEY}`)
  expect(r.w.toasts.at(-1), 'toast').not.toContain(EMAIL)
  expect(r.w.toasts.at(-1), 'toast keeps its words').toContain('Sent to')
  expect(r.w.logs.at(-1), 'log').not.toContain('4,250')
  expect(r.w.notices.at(-1), 'notice').not.toContain(EMAIL)
  expect(r.w.statuses.at(-1), 'status').not.toContain(EMAIL)
  expect(r.w.notifies.at(-1), 'native notification text and title').not.toContain('4,250')
  expect(r.w.notifies.at(-1)).not.toContain(EMAIL)
  expect(shown.isShown, 'the prompt box suggestion is hidden while on').toBe(false)
  expect(r.w.suggestions.length, 'it never reached the box').toBe(0)

  await r.cmd('off')
  const back = await say(`Sent to ${EMAIL}`)
  expect(r.w.toasts.at(-1), 'off: toast passes as it came').toBe(`Sent to ${EMAIL}`)
  expect(back.isShown, 'off: suggestion allowed').toBe(true)
})

test('the prompt box suggestion stays when the setting says so', { plugins: [speaker], options: { hide_suggestions: false } }, async ($, on) => {
  const r = rig($, on, { store: { on: true } })
  await r.start('desktop')
  const res = await $.command.run({ command: 'speak', args: JSON.stringify({ text: 'hello', title: 't' }) } as never)
  expect(JSON.parse(String((res as { text?: string }).text)).isShown).toBe(true)
})

// ---------------------------------------------------------------- the way it is remembered

for (const surface of SURFACES) {
  test(`a machine that had it on starts every chat on, and off is remembered too (${surface})`, async ($, on) => {
    const r = rig($, on, { store: { on: true } })
    await r.start(surface)
    expect(r.w.statuses.at(-1), 'on from the first moment').toBe('Screen share ON')
    const band = await r.mount(surface, 'AbovePrompt', BAND)
    expect(await band.find({ key: 'off' }), 'band is there in a new chat').toBeDefined()
    await r.mount(surface, 'AssistantMessage', { text: PRIVATE, isFirstOfReply: true })
    expect(String(r.w.seen.AssistantMessage.text), 'hidden in a new chat').not.toContain(EMAIL)

    await r.cmd('off')
    expect(r.w.stored.on, 'off is stored for the machine').toBe(false)
    await r.cmd('on')
    expect(r.w.stored.on, 'on is stored for the machine').toBe(true)
    expect(await r.cmd('on'), 'on twice is fine').toContain('Screen share ON')
    expect(await r.cmd('status')).toContain('Screen share is ON')
  })
}

// ---------------------------------------------------------------- styles, categories

test('styles: partial and label from the config menu, and from the command', async ($, on) => {
  const r = rig($, on, { store: { on: true } })
  await r.start('desktop')
  await r.w.clock.advance(300)
  const draw = async () => {
    await r.mount('desktop', 'AssistantMessage', { text: `Mail ${EMAIL}, ${MONEY}, Priya Sharma <priya@x.in>`, isFirstOfReply: true })
    return String(r.w.seen.AssistantMessage.text)
  }
  expect(await r.cmd('style label')).toContain('label')
  expect(await draw()).toBe('Mail [email], [amount], [name] <[email]>')
  expect(await r.cmd('style partial')).toContain('partial')
  expect(await draw()).toBe('Mail j***@a***.com, $*,***.**, P*** S*** <p***@x***.in>')
  expect(r.w.stored.style, 'the style is kept for the machine').toBe('partial')
  expect(await r.cmd('style bar')).toContain('bar')
  expect(await draw()).toContain(BAR.repeat(EMAIL.length))
  expect(await r.cmd('style neon')).toContain('Use /screen-share style')
})

test('a style set in the config menu is the default', { options: { style: 'label' } }, async ($, on) => {
  const r = rig($, on, { store: { on: true } })
  await r.start('terminal')
  await r.w.clock.advance(300)
  await r.mount('terminal', 'UserMessage', { text: `Mail ${EMAIL}`, origin: { kind: 'composer' }, isExpanded: true })
  expect(r.w.seen.UserMessage.text).toBe('Mail [email]')
})

test('a bar character set in the config menu is used', { options: { bar_glyph: '█' } }, async ($, on) => {
  const r = rig($, on, { store: { on: true } })
  await r.start('terminal')
  await r.w.clock.advance(300)
  await r.mount('terminal', 'UserMessage', { text: `Mail ${EMAIL}`, origin: { kind: 'composer' }, isExpanded: true })
  expect(r.w.seen.UserMessage.text).toBe(`Mail ${'█'.repeat(EMAIL.length)}`)
})

test('categories can be turned off one by one, and names have three modes', async ($, on) => {
  const r = rig($, on, { store: { on: true } })
  await r.start('desktop')
  await r.w.clock.advance(300)
  const line = `Priya Sharma wrote from ${EMAIL} about ${MONEY}, call +44 7700 900123`
  const draw = async () => {
    await r.mount('desktop', 'AssistantMessage', { text: line, isFirstOfReply: true })
    return String(r.w.seen.AssistantMessage.text)
  }
  await r.cmd('style label')
  expect(await draw()).toBe('[name] wrote from [email] about [amount], call [phone]')
  await r.cmd('cat email off')
  expect(await draw()).toBe(`[name] wrote from ${EMAIL} about [amount], call [phone]`)
  await r.cmd('cat amounts off')
  await r.cmd('cat phone off')
  expect(await draw()).toBe(`[name] wrote from ${EMAIL} about ${MONEY}, call +44 7700 900123`)
  await r.cmd('names off')
  expect(await draw(), 'names off: nothing left to hide').toBe(line)
  expect(await r.cmd('cat widgets on')).toContain('Use /screen-share cat')
  await r.cmd('reset')
  await r.cmd('style label')
  expect(await draw(), 'reset: everything is hidden again').toBe('[name] wrote from [email] about [amount], call [phone]')
  await r.cmd('names context')
  expect(await draw(), 'context only: no guess from two capitalised words').toBe(`Priya Sharma wrote from [email] about [amount], call [phone]`)
})

// ---------------------------------------------------------------- always-mask and never-mask words

for (const surface of SURFACES) {
  test(`always-mask and never-mask lists: config menu, command, words file (${surface})`, { options: { always_mask: 'Project Falcon, Globex', never_mask: 'Priya Sharma, @mycompany.com' } }, async ($, on) => {
    const r = rig($, on, { store: { on: true } })
    await r.start(surface)
    await r.w.clock.advance(300)
    const draw = async (text: string) => {
      await r.mount(surface, 'AssistantMessage', { text, isFirstOfReply: true })
      return String(r.w.seen.AssistantMessage.text)
    }
    expect(await draw('Project-Falcon ships; the globex-prod and GLOBEX accounts'), 'listed words, any case and separator').toBe(`${BAR.repeat(14)} ships; the ${BAR.repeat(6)}-prod and ${BAR.repeat(6)} accounts`)
    expect(await draw('Falconry is a sport'), 'a longer word is not hit').toBe('Falconry is a sport')
    expect(await draw('Mail Priya Sharma <priya@x.in>'), 'never-mask keeps a name, the email still goes').toBe(`Mail Priya Sharma <${BAR.repeat(10)}>`)
    expect(await draw('Mail dev@mycompany.com and dev@other.com'), 'an allowed domain').toBe(`Mail dev@mycompany.com and ${BAR.repeat(13)}`)

    // Add by command: kept in the words file, hidden at once, the word is never echoed back.
    const said = await r.cmd('add Acme Corp, Zed Zebra')
    expect(said).toContain('Added 2')
    expect(said, 'the word is not echoed').not.toContain('Acme')
    expect(JSON.parse(r.w.files[WORDS] ?? '{}').mask, 'kept in the words file').toEqual(['Acme Corp', 'Zed Zebra'])
    expect(await draw('Call Acme Corp today'), 'hidden at once').toBe(`Call ${BAR.repeat(4)} ${BAR.repeat(4)} today`)
    expect((await r.cmd('words')), 'words are counted, not printed').not.toContain('Acme')
    expect(await r.cmd('words')).toContain('2 always-mask')

    // A word that is also listed to allow is still hidden: the always-mask list wins.
    await r.cmd('allow Acme Corp')
    expect(await draw('Call Acme Corp today'), 'deny beats allow').toBe(`Call ${BAR.repeat(4)} ${BAR.repeat(4)} today`)

    // Editing the file by hand is picked up within 2 s.
    r.w.files[WORDS] = JSON.stringify({ mask: ['Falconry'], allow: [] })
    await r.w.clock.advance(2100)
    expect(await draw('Falconry is a sport'), 'file edit picked up').toBe(`${BAR.repeat(8)} is a sport`)
    expect(await draw('Call Acme Corp today'), 'removed from the file: shows again').toBe('Call Acme Corp today')

    expect(await r.cmd('remove falconry')).toContain('Removed 1')
    expect(await draw('Falconry is a sport')).toBe('Falconry is a sport')
    expect(await r.cmd('remove nothing')).toContain('None of those')
    expect(await r.cmd('add')).toContain('Use /screen-share add')
  })
}

test('a broken or unwritable words file never breaks hiding', async ($, on) => {
  const r = rig($, on, { store: { on: true }, files: { [WORDS]: '{ not json' } })
  await r.start('desktop')
  await r.w.clock.advance(300)
  await r.mount('desktop', 'AssistantMessage', { text: `Mail ${EMAIL}`, isFirstOfReply: true })
  expect(String(r.w.seen.AssistantMessage.text)).not.toContain(EMAIL)
  r.w.fsBroken = true
  expect(await r.cmd('add Acme')).toContain('Could not save')
  await r.mount('desktop', 'AssistantMessage', { text: `Mail ${EMAIL}`, isFirstOfReply: true })
  expect(String(r.w.seen.AssistantMessage.text), 'still hidden with the disk gone').not.toContain(EMAIL)
})

// ---------------------------------------------------------------- fail closed

for (const surface of SURFACES) {
  test(`when hiding a row fails, the row is a placeholder and never the raw text (${surface})`, { plugins: [speaker] }, async ($, on) => {
    const r = rig($, on, { store: { on: true, fault: 'mask' } })
    await r.start(surface)
    await r.w.clock.advance(300)
    const seen = r.w.seen
    const rows: Array<[string, unknown]> = [
      ['AssistantMessage', { text: PRIVATE, isFirstOfReply: true }],
      ['UserMessage', { text: PRIVATE, origin: { kind: 'composer' }, isExpanded: true }],
      ['CommandOutput', { command: 'cost', args: '', text: PRIVATE, isErrored: false }],
      ['ToolUse', { tool_use_id: 't1', tool: 'Bash', input: { command: PRIVATE }, output: bash, isRunning: false, isErrored: false, isInterrupted: false }],
      ['ToolResult', { tool_use_id: 't1', tool: 'Bash', output: bash, isErrored: false }],
      ['ToolGroup', { calls: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: PRIVATE } }], isActive: false, isExpanded: false }],
      ['Spinner', { word: PRIVATE, message: null, suffix: '…', mode: 'tool-use' }],
      ['Pane', { title: 'x', isFocused: false, bodyColumns: 80, placement: 'inline', scroll: { bodyRows: 10 }, view: {} }],
    ]
    seen.paneText = PRIVATE
    for (const [component, props] of rows) {
      const v = await r.mount(surface, component, props)
      expect(await v.find({ text: /hidden by screen share/ }), `${component}: placeholder drawn`).toBeDefined()
      expect(JSON.stringify(await v.drawn()), `${component}: no raw text in the drawing`).not.toContain('jane.doe')
      if (component !== 'Pane') expect(seen[component], `${component}: the engine was never given the raw props`).toBeUndefined()
    }
    const band = await r.mount(surface, 'AbovePrompt', BAND)
    expect(await band.find({ text: /SCREEN SHARE ON/ }), 'the indicator survives a failure').toBeDefined()
    expect(await band.find({ text: /REST/ }), 'other bands are dropped on a failure').toBeUndefined()

    await $.command.run({ command: 'speak', args: JSON.stringify({ text: `Mail ${EMAIL}`, title: 't' }) } as never)
    expect(r.w.toasts.at(-1), 'toast hidden').not.toContain(EMAIL)
    expect(r.w.toasts.at(-1)).toContain('hidden by screen share')
    expect(r.log(), 'the failure is logged').toContain('hiding failed in AssistantMessage')
    expect(r.log(), 'the log holds no data').not.toContain('jane')

    // Off, nothing is hidden, a fault or not.
    await r.cmd('off')
    const real = await r.mount(surface, 'AssistantMessage', { text: PRIVATE, isFirstOfReply: true })
    expect(seen.AssistantMessage.text).toBe(PRIVATE)
    expect(await real.find({ text: /hidden by screen share/ })).toBeUndefined()
  })
}

// ---------------------------------------------------------------- the switch file

for (const surface of SURFACES) {
  test(`the switch file turns the whole mod off and back on (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const r = rig($, on, { store: { on: true } })
    await r.start(surface)
    await r.w.clock.advance(300)
    let band = await r.mount(surface, 'AbovePrompt', BAND)
    expect(await band.find({ key: 'off' }), 'band shows while on').toBeDefined()

    r.w.files[SWITCHES] = JSON.stringify({ 'screen-share': false })
    await r.w.clock.advance(2100)
    band = await r.mount(surface, 'AbovePrompt', BAND)
    expect(await band.find({ key: 'off' }), 'no band when switched off').toBeUndefined()
    expect(await band.find({ text: /REST/ }), 'other bands still show').toBeDefined()
    await r.mount(surface, 'AssistantMessage', { text: PRIVATE, isFirstOfReply: true })
    expect(r.w.seen.AssistantMessage.text, 'nothing hidden when switched off').toBe(PRIVATE)
    const modes = await r.mount(surface, 'SessionMode', { modes: [] })
    expect(await modes.find({ text: /screen share/ }), 'no footer label when switched off').toBeUndefined()
    expect(r.w.statuses.at(-1), 'status line cleared').toBeUndefined()
    expect(r.w.toasts.at(-1), 'a toast says nothing is hidden').toContain('nothing is hidden')
    expect(await r.cmd('on'), 'the command says why it does nothing').toContain('switched off')
    expect(await r.cmd('status')).toContain('switched off')
    expect(r.log()).toContain('switched off in the switch file')

    // Other mods' switches do not matter; this one's value true is on.
    r.w.files[SWITCHES] = JSON.stringify({ 'brain-dump': false, 'screen-share': true })
    await r.w.clock.advance(2100)
    await r.mount(surface, 'AssistantMessage', { text: PRIVATE, isFirstOfReply: true })
    expect(String(r.w.seen.AssistantMessage.text), 'hidden again').not.toContain(EMAIL)
    expect(r.w.statuses.at(-1), 'status back').toBe('Screen share ON')

    // A broken file leaves it on: what was asked to be hidden stays hidden.
    r.w.files[SWITCHES] = '{ nope'
    await r.w.clock.advance(2100)
    await r.mount(surface, 'AssistantMessage', { text: PRIVATE, isFirstOfReply: true })
    expect(String(r.w.seen.AssistantMessage.text)).not.toContain(EMAIL)
  })
}

test('the switch file is read at draw time, with a one second cache, not only by the poll', async ($, on) => {
  const r = rig($, on, { store: { on: true } })
  await r.start('terminal')
  await r.w.clock.advance(300)
  r.w.files[SWITCHES] = JSON.stringify({ 'screen-share': false })
  await r.w.clock.advance(1100)
  await r.mount('terminal', 'UserMessage', { text: PRIVATE, origin: { kind: 'composer' }, isExpanded: true })
  expect(r.w.seen.UserMessage.text, 'read at draw time').toBe(PRIVATE)
})

// ---------------------------------------------------------------- peek

for (const surface of SURFACES) {
  test(`peek shows the real text for a while, counts down, and hides again (${surface})`, async ($, on) => {
    const r = rig($, on, { store: { on: true } })
    await r.start(surface)
    await r.w.clock.advance(300)
    expect(await r.cmd('peek 5')).toContain('5 s')
    await r.mount(surface, 'AssistantMessage', { text: PRIVATE, isFirstOfReply: true })
    expect(r.w.seen.AssistantMessage.text, 'real text while peeking').toBe(PRIVATE)
    let band = await r.mount(surface, 'AbovePrompt', BAND)
    expect(await band.find({ text: /PEEKING/ }), 'the band says so').toBeDefined()
    expect(await band.find({ key: 'hide' }), 'with a Hide now button').toBeDefined()
    expect(r.w.statuses.at(-1)).toContain('peeking')
    expect(await r.cmd('status')).toContain('peeking')
    const modes = await r.mount(surface, 'SessionMode', { modes: [] })
    expect(await modes.find({ text: /screen share PEEK/ })).toBeDefined()

    await r.w.clock.advance(3000)
    band = await r.mount(surface, 'AbovePrompt', BAND)
    expect(await band.find({ text: /PEEKING [12]s/ }), 'it counts down').toBeDefined()
    await r.w.clock.advance(2500)
    await r.mount(surface, 'AssistantMessage', { text: PRIVATE, isFirstOfReply: true })
    expect(String(r.w.seen.AssistantMessage.text), 'hidden again after the time').not.toContain(EMAIL)
    expect(r.w.toasts.at(-1)).toContain('hiding again')
    expect(r.w.statuses.at(-1)).toBe('Screen share ON')

    // The Peek button uses the setting's length; Hide now ends it early.
    band = await r.mount(surface, 'AbovePrompt', BAND)
    await band.press({ key: 'peek' })
    await r.mount(surface, 'AssistantMessage', { text: PRIVATE, isFirstOfReply: true })
    expect(r.w.seen.AssistantMessage.text, 'peek button').toBe(PRIVATE)
    band = await r.mount(surface, 'AbovePrompt', BAND)
    await band.press({ key: 'hide' })
    await r.mount(surface, 'AssistantMessage', { text: PRIVATE, isFirstOfReply: true })
    expect(String(r.w.seen.AssistantMessage.text), 'hide now').not.toContain(EMAIL)
    expect(await r.cmd('hide')).toContain('no peek')

    // A peek is capped, and turning screen share off ends it.
    expect(await r.cmd('peek 99999')).toContain('120 s')
    expect(await r.cmd('peek soon')).toContain('Use /screen-share peek')
    await r.cmd('off')
    expect(await r.cmd('peek')).toContain('off')
  })
}

// ---------------------------------------------------------------- the command

test('the command: help, status, unknown words, test sample, and no word is ever printed back', async ($, on) => {
  const r = rig($, on, { options: undefined } as never)
  await r.start('terminal')
  expect(await r.cmd('help')).toContain('peek')
  expect(await r.cmd('banana')).toContain('Unknown option')
  expect(await r.cmd('status')).toContain('Screen share is OFF')
  expect(await r.cmd('status')).toContain('Hiding: email, phone, amount, name, secret, number, path, address')
  expect(await r.cmd('on')).toContain('ON')
  const sample = await r.cmd('test')
  expect(sample, 'the sample is shown hidden').not.toContain('jane.doe@acme.com')
  expect(sample).not.toContain('sk-ant-api03')
  expect(sample).not.toContain('4111 1111')
  expect(sample).toContain('182k tokens')
  expect(await r.cmd('toggle'), 'an unknown word is not a toggle').toContain('Unknown option')
  expect(await r.cmd('')).toContain('OFF')
  expect(await r.cmd('')).toContain('ON')
})

test('the command is registered to run at once, with a hint', async ($, on) => {
  const r = rig($, on)
  await r.start('terminal')
  const spec = r.w.spec
  expect(spec.name).toBe('screen-share')
  expect(spec.immediate, 'works mid-turn').toBe(true)
  expect(spec.argumentHint).toContain('on|off|status')
})

// ---------------------------------------------------------------- never touches the chat or the model

test('prompts and the chat are never changed: only drawing hooks, and a prompt passes as typed', async ($, on) => {
  const r = rig($, on, { store: { on: true } })
  let seen = ''
  on('prompt.submit', async (_: unknown, e: { text: string }) => {
    seen = e.text
    return { text: e.text }
  })
  await r.start('terminal')
  await r.w.clock.advance(300)
  const sent = `Email ${EMAIL} the invoice of ${MONEY}`
  await $.prompt.submit({ text: sent, origin: { kind: 'composer' } } as never)
  await r.w.clock.settle()
  expect(seen, 'the model gets the real prompt').toBe(sent)
})

// ---------------------------------------------------------------- the log

test('the log is one line per event, bounded, and holds no data', async ($, on) => {
  const r = rig($, on, { store: { fault: 'mask' } })
  await r.start('terminal')
  await r.cmd('on')
  await r.cmd('add Secret Client Name')
  for (let i = 0; i < 40; i++) {
    await r.cmd(i % 2 ? 'on' : 'off')
  }
  await r.mount('terminal', 'AssistantMessage', { text: PRIVATE, isFirstOfReply: true })
  const log = r.log()
  expect(log.length, 'bounded').toBeLessThan(100_001)
  expect(log).toContain('(command)')
  expect(log, 'no hidden value').not.toContain('Secret Client')
  expect(log, 'no email').not.toContain('jane')
  expect(log).not.toContain('4,250')
  for (const line of log.trim().split('\n')) expect(line, 'dated').toMatch(/^\d{4}-\d\d-\d\dT/)
})

// ---------------------------------------------------------------- more edges

test("the account's own user name is hidden everywhere, not only in paths", async ($, on) => {
  const r = rig($, on, { store: { on: true }, home: '/Users/janedoe' })
  await r.start('terminal')
  await r.w.clock.advance(300)
  await r.mount('terminal', 'AssistantMessage', { text: 'Committed as janedoe-corp in /Users/janedoe/Documents', isFirstOfReply: true })
  const shown = String(r.w.seen.AssistantMessage.text)
  expect(shown).not.toContain('janedoe')
  expect(shown, 'the rest of the line is left').toContain('Committed as')
  expect(shown).toContain('/Documents')
})

test('a setting that turns the account name off leaves the word alone', { options: { mask_username: false } }, async ($, on) => {
  const r = rig($, on, { store: { on: true }, home: '/Users/janedoe' })
  await r.start('terminal')
  await r.w.clock.advance(300)
  await r.mount('terminal', 'AssistantMessage', { text: 'Committed as janedoe-corp', isFirstOfReply: true })
  expect(r.w.seen.AssistantMessage.text).toBe('Committed as janedoe-corp')
})

test('a running tool row, a result with an image, and data that is not text pass untouched', async ($, on) => {
  const r = rig($, on, { store: { on: true } })
  await r.start('desktop')
  await r.w.clock.advance(300)
  await r.mount('desktop', 'ToolUse', { tool_use_id: 't2', tool: 'Bash', input: { command: 'ls' }, isRunning: true, isErrored: false, isInterrupted: false })
  expect(r.w.seen.ToolUse.input, 'clean input passes').toEqual({ command: 'ls' })
  expect(r.w.seen.ToolUse.output, 'no output yet').toBeUndefined()
  const image = { type: 'image', file: { base64: 'iVBORw0KGgo4111111111111111ABC', type: 'image/png' } }
  await r.mount('desktop', 'ToolResult', { tool_use_id: 't3', tool: 'Read', output: image, isErrored: false })
  expect(r.w.seen.ToolResult.output, 'image data is left exactly as it was').toEqual(image)
  await r.mount('desktop', 'ToolResult', { tool_use_id: 't4', tool: 'Read', output: 42, isErrored: false })
  expect(r.w.seen.ToolResult.output).toBe(42)
})

test('options can turn single categories off, and panels can be left alone', { options: { mask_emails: false, mask_panels: false } }, async ($, on) => {
  const r = rig($, on, { store: { on: true } })
  await r.start('desktop')
  await r.w.clock.advance(300)
  await r.mount('desktop', 'AssistantMessage', { text: PRIVATE, isFirstOfReply: true })
  const shown = String(r.w.seen.AssistantMessage.text)
  expect(shown, 'emails left').toContain(EMAIL)
  expect(shown, 'amounts still hidden').not.toContain('4,250')
  r.w.seen.paneText = `Files for ${EMAIL}`
  const pane = await r.mount('desktop', 'Pane', { title: 'x', isFocused: false, bodyColumns: 80, placement: 'inline', scroll: { bodyRows: 10 }, view: {} })
  expect(await pane.find({ text: /jane/ }), 'panes are not walked when the setting says so').toBeDefined()
})

test('a narrow band is still a band: it says it is on and keeps both buttons', async ($, on) => {
  const r = rig($, on, { store: { on: true } })
  await r.start('terminal')
  const band = await r.mount('terminal', 'AbovePrompt', { ...(BAND as object), bodyColumns: 30 } as never)
  expect(await band.find({ text: /SCREEN SHARE ON/ })).toBeDefined()
  expect(await band.find({ key: 'peek' })).toBeDefined()
  expect(await band.find({ key: 'off' })).toBeDefined()
})

test('a words file that is there at the start is used from the first row', async ($, on) => {
  const r = rig($, on, { store: { on: true }, files: { [WORDS]: JSON.stringify({ mask: ['Falcon'], allow: [] }) } })
  await r.start('terminal')
  await r.w.clock.advance(300)
  await r.mount('terminal', 'AssistantMessage', { text: 'Falcon lands', isFirstOfReply: true })
  expect(r.w.seen.AssistantMessage.text).toBe(`${BAR.repeat(6)} lands`)
})

test('hiding works before the session start hook has run, as after a hot reload', async ($, on) => {
  const r = rig($, on, { store: { on: true } })
  // No r.start(): the first draw boots the mod by itself.
  await r.mount('terminal', 'AssistantMessage', { text: PRIVATE, isFirstOfReply: true })
  await r.w.clock.advance(300)
  await r.mount('terminal', 'AssistantMessage', { text: PRIVATE, isFirstOfReply: true })
  expect(String(r.w.seen.AssistantMessage.text)).not.toContain(EMAIL)
})

test('turning it off while a peek runs ends the peek, and the band goes', async ($, on) => {
  const r = rig($, on, { store: { on: true } })
  await r.start('desktop')
  await r.w.clock.advance(300)
  await r.cmd('peek 30')
  await r.cmd('off')
  await r.w.clock.advance(31_000)
  expect(r.w.toasts.filter(t => t.includes('hiding again')).length, 'no stray "hiding again" after off').toBe(0)
  await r.cmd('on')
  await r.mount('desktop', 'AssistantMessage', { text: PRIVATE, isFirstOfReply: true })
  expect(String(r.w.seen.AssistantMessage.text), 'a new on is hiding, not peeking').not.toContain(EMAIL)
})
