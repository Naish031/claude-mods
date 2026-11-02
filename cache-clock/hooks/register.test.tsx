import { expect, test } from 'claude-code/testing'

import { HOME, LOG, NARROW, OWN, PROPS, SURFACES, SWITCHES, rig } from '../tests/rig'

for (const surface of SURFACES) {
  test(`counts down, goes cold, offers a handoff on a big chat when the command exists (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on, { handoff: true })
    await r.start(surface)
    let v = await r.mount(surface)
    expect(await v.find({ key: 'hide' }), 'nothing before the first reply').toBeUndefined()

    await r.reply()
    await r.w.clock.advance(30_000)
    v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm/ }), 'warm with time left').toBeDefined()
    expect(await v.find({ text: /4:30/ }), '4:30 left after 30 s of a 5 min cache').toBeDefined()
    expect(await v.find({ text: /5 min cache, a guess until the first reply/ }), 'says it is a guess').toBeDefined()
    expect(await v.find({ text: /182k tokens in this chat/ }), 'says how big the chat is').toBeDefined()
    expect(await v.find({ key: 'handoff' }), 'no handoff while warm').toBeUndefined()
    expect(await v.find({ key: 'keepwarm' }), 'keep warm is offered').toBeDefined()

    await r.w.clock.advance(5 * 60_000)
    v = await r.mount(surface)
    expect(await v.find({ text: /Cache cold/ }), 'cold after 5 min').toBeDefined()
    expect(await v.find({ text: /re-reads 182k tokens at full price/ }), 'says what the next message costs').toBeDefined()
    expect(await v.find({ key: 'handoff' }), 'handoff offered on a big cold chat').toBeDefined()
    await v.press({ key: 'handoff' })
    expect(r.ran, 'the handoff command was run through the seam').toContain('handoff')
    expect(r.log(), 'the handoff is logged').toContain('handoff asked for at 182k tokens')
  })

  test(`a small cold chat gets no handoff, and a big one without the command gets a plain hint (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const small = rig($, on, { handoff: true, tokens: 20_000 })
    await small.start(surface)
    await small.reply()
    await small.w.clock.advance(6 * 60_000)
    let v = await small.mount(surface)
    expect(await v.find({ text: /Cache cold/ })).toBeDefined()
    expect(await v.find({ key: 'handoff' }), 'a small chat is cheap to re-read').toBeUndefined()
    expect(await v.find({ text: /fresh chat would skip/ }), 'no hint for a small chat').toBeUndefined()

    small.w.ctx = 300_000
    await small.reply(0, 300_000)
    await small.w.clock.advance(6 * 60_000)
    small.w.handoff = false
    await small.w.clock.advance(11_000)
    v = await small.mount(surface)
    expect(await v.find({ key: 'handoff' }), 'no command, no button').toBeUndefined()
    expect(await v.find({ text: /There is no \/handoff command here/ }), 'a plain hint instead').toBeDefined()
    expect(small.toasts.length, 'no toast spam').toBe(0)
  })

  test(`hide goes to every chat, names the way back, and a new reply does not undo it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    let v = await r.mount(surface)
    await v.press({ key: 'hide' })
    v = await r.mount(surface)
    expect(await v.find({ key: 'hide' }), 'hidden').toBeUndefined()
    expect(await v.find({ text: 'REST' }), 'other bands still draw').toBeDefined()
    expect(JSON.parse(r.files[OWN] ?? '{}'), 'Hide writes a flag every chat reads').toEqual({ hidden: true })
    expect(r.toasts.join(' '), 'the toast names the way back').toContain('/cacheclock show')
    await r.reply()
    v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm/ }), 'still hidden after a reply').toBeUndefined()
  })

  test(`/cacheclock hide, show, status and a flag set by another chat (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on, { files: { [OWN]: JSON.stringify({ hidden: true }) } })
    await r.start(surface)
    await r.reply()
    let v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm/ }), 'hidden while the flag is set').toBeUndefined()
    expect(await v.find({ text: 'REST' }), 'other bands still draw').toBeDefined()

    // Another chat clears the flag: the next second's tick or render sees it.
    r.files[OWN] = '{}'
    await r.w.clock.advance(3100)
    v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm/ }), 'clock back').toBeDefined()

    let said = await r.said('cacheclock', 'hide')
    expect(said, 'hide reply').toContain('Cache Clock hidden in every chat')
    expect(said, 'names the way back').toContain('/cacheclock show')
    expect(JSON.parse(r.files[OWN] ?? '{}')).toEqual({ hidden: true })
    expect(await r.said('cacheclock', 'status'), 'status says hidden').toContain('Cache Clock is hidden')
    said = await r.said('cacheclock', 'show')
    expect(said, 'show reply').toContain('Cache Clock is on')
    expect(JSON.parse(r.files[OWN] ?? '{}')).toEqual({})
    expect(await r.said('cacheclock', 'status'), 'status says the cache state').toMatch(/Cache warm|warm, \d:\d\d left/)
    // Bare /cacheclock toggles.
    expect(await r.said('cacheclock', ''), 'toggle hides').toContain('hidden')
    expect(await r.said('cacheclock', ''), 'toggle shows').toContain('is on')
  })

  test(`draws nothing, writes nothing and does no work when switched off (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    let v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm/ }), 'clock shows while on').toBeDefined()
    await r.said('keepwarm', '')

    r.files[SWITCHES] = JSON.stringify({ 'cache-clock': false })
    await r.w.clock.advance(1500)
    v = await r.mount(surface)
    expect(await v.find({ key: 'hide' }), 'no clock when off').toBeUndefined()
    expect(await v.find({ text: 'REST' }), 'other bands still draw').toBeDefined()
    expect(r.toasts.join(' '), 'keep warm stopped and said why').toContain('switched off')
    expect(await r.said('cacheclock', ''), 'the command says it is off').toContain('switched off')
    expect(await r.said('keepwarm', ''), '/keepwarm says it is off').toContain('switched off')

    // Off means no polling of its own: a minute later the switch file has not been read again by a timer.
    const before = r.fsCalls.filter(p => p === SWITCHES).length
    await r.w.clock.advance(60_000)
    expect(r.fsCalls.filter(p => p === SWITCHES).length, 'no timer polls the switch while off').toBe(before)
    expect(r.forks.length, 'no ping while off').toBe(0)

    // Hooks pass straight through: a prompt goes on unchanged and nothing is logged for it.
    const sent = await $.prompt.submit({ text: 'hello there' })
    expect(JSON.stringify(sent)).toContain('hello there')

    // Back on at the next event.
    r.files[SWITCHES] = JSON.stringify({ 'cache-clock': true })
    await r.w.clock.advance(1100)
    v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm|Cache cold/ }), 'comes back when the switch is on').toBeDefined()
  })

  test(`a broken or odd switch file means on (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on, { files: { [SWITCHES]: '{ not json' } })
    await r.start(surface)
    await r.reply()
    const v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm/ }), 'on with a broken file').toBeDefined()
  })

  for (const bad of ['[]', '42', JSON.stringify({ 'cache-clock': 'no' }), JSON.stringify({ other: false })]) {
    test(`a switch file of ${bad} means on (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
      const r = rig($, on, { files: { [SWITCHES]: bad } })
      await r.start(surface)
      await r.reply()
      const v = await r.mount(surface)
      expect(await v.find({ text: /Cache warm/ })).toBeDefined()
    })
  }

  test(`narrow window stacks the buttons under the line (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    const v = await r.mount(surface, NARROW)
    expect(await v.find({ key: 'keepwarm' })).toBeDefined()
    expect(await v.find({ key: 'hide' })).toBeDefined()
  })

  test(`demo mode: a 60 s cache for this chat only (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on, { tokens: 8_000, handoff: true })
    await r.start(surface)
    expect(await r.said('cacheclock', 'demo')).toContain('60 s demo cache')
    await r.reply()
    await r.w.clock.advance(15_000)
    let v = await r.mount(surface)
    expect(await v.find({ text: /0:45/ }), '45 s left of 60').toBeDefined()
    expect(await v.find({ text: /60 s demo cache, this chat only/ })).toBeDefined()
    await r.w.clock.advance(60_000)
    v = await r.mount(surface)
    expect(await v.find({ text: /Cache cold/ }), 'cold after 60 s').toBeDefined()
    expect(await v.find({ key: 'handoff' }), 'the demo offers the handoff even in a small chat').toBeDefined()
    expect(await r.said('cacheclock', 'auto')).toContain('5 min cache')
  })
}

test('the log has one line per event, with no prompt text and a short id', { timeoutMs: 30000 }, async ($, on) => {
  const r = rig($, on)
  await r.start('desktop')
  await r.reply()
  await r.said('keepwarm', '')
  await $.prompt.submit({ text: 'my secret prompt about project Falcon' })
  await r.w.clock.settle()
  const text = r.log()
  expect(text, 'keep warm on is logged').toContain('keep warm on')
  expect(text, 'keep warm off is logged').toContain('keep warm off after 0 pings')
  expect(text, 'lines carry a short session id').toContain(' sid-1234 ')
  expect(text, 'no prompt text in the log').not.toContain('Falcon')
  expect(text, 'no secret-looking text').not.toMatch(/sk-|token=|password/i)
})

test('with no home folder the mod still runs: switch reads as on, nothing is logged', { timeoutMs: 30000 }, async ($, on) => {
  const r = rig($, on, { home: null })
  await r.start('desktop')
  await r.reply()
  const v = await r.mount('desktop')
  expect(await v.find({ text: /Cache warm/ })).toBeDefined()
  expect(Object.keys(r.files).length, 'no files written').toBe(0)
  expect(await r.said('cacheclock', 'hide')).toContain('hidden')
  const hidden = await r.mount('desktop')
  expect(await hidden.find({ text: /Cache warm/ }), 'hide still works for this chat').toBeUndefined()
  expect(HOME.length).toBeGreaterThan(0)
  expect(LOG.length).toBeGreaterThan(0)
  expect(PROPS).toBeDefined()
})
