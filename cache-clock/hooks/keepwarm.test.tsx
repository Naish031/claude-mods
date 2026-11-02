import { expect, test } from 'claude-code/testing'

import { OWN, SURFACES, rig, row } from '../tests/rig'

for (const surface of SURFACES) {
  test(`keep warm is opt in: the button turns it on, a ping fires before expiry, a prompt stops it (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    // Nothing is spent until the person asks: 4 minutes with no ping.
    await r.w.clock.advance(4 * 60_000)
    expect(r.forks.length, 'no ping without opting in').toBe(0)
    await r.reply()

    let v = await r.mount(surface)
    expect(await v.find({ text: /Each keep-warm ping costs about \$0\.05/ }), 'the price of a ping is shown before opting in').toBeDefined()
    await v.press({ key: 'keepwarm' })
    v = await r.mount(surface)
    expect(await v.find({ text: /Keeping warm · first ping in 4:15 · up to 20 pings or 1 h 30 min/ }), 'on, first ping 45 s before the end, caps shown').toBeDefined()
    expect(r.toasts.join(' '), 'the toast says it spends tokens').toContain('spends tokens')

    await r.w.clock.advance(4 * 60_000)
    expect(r.forks.length, 'no ping with 60 s left').toBe(0)
    await r.w.clock.advance(16_000)
    await r.w.clock.settle()
    expect(r.forks.length, 'one ping before expiry').toBe(1)
    expect(r.forks[0], 'the tiny prompt').toBe('Reply with the single word: ok')
    v = await r.mount(surface)
    expect(await v.find({ text: /Keeping warm · ping 1 of 20 · next in 4:1\d · last ping read 182k cached tokens · \$0\.05 spent so far/ }), 'band after the ping').toBeDefined()
    expect(await v.find({ text: /Cache warm/ }), 'the clock went back to a full cache').toBeDefined()
    expect(await v.find({ text: /4:[45]\d/ }), 'close to 5:00 left again').toBeDefined()
    expect(r.log(), 'the ping is logged').toContain('ping 1: cache read 182000, cache write 0, error none')

    await r.w.clock.advance(4 * 60_000 + 16_000)
    await r.w.clock.settle()
    expect(r.forks.length, 'a second ping one cycle later').toBe(2)

    // Its own command does not stop it; a real prompt does.
    await $.prompt.submit({ text: '/keepwarm' })
    await r.w.clock.settle()
    v = await r.mount(surface)
    expect(await v.find({ text: /Keeping warm/ }), 'still on after its own command').toBeDefined()
    await $.prompt.submit({ text: 'back again' })
    await r.w.clock.settle()
    v = await r.mount(surface)
    expect(await v.find({ text: /Keeping warm/ }), 'stopped by a prompt').toBeUndefined()
    expect(r.toasts.join(' '), 'the toast says why').toContain('you sent a message')
    await r.w.clock.advance(10 * 60_000)
    expect(r.forks.length, 'no more pings once stopped').toBe(2)
  })

  test(`keep warm stops by itself at the ping cap and says when the cache had gone cold (${surface})`, { timeoutMs: 120000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    // The 60 s demo cache pings every 15 s, so 20 pings fit well inside the 90 minute cap.
    await r.said('cacheclock', 'demo')
    expect(await r.said('keepwarm', ''), 'nothing to keep warm before the first reply').toContain('Nothing to keep warm yet')
    await r.reply()
    const said = await r.said('keepwarm', '')
    expect(said, '/keepwarm turns it on').toContain('Keep warm is on')
    expect(said, 'says it costs tokens and what the caps are').toContain('stops after 20 pings, 1 h 30 min')
    expect(said, 'says the price of a ping').toContain('about $0.05')

    r.w.forkMode = 'cold'
    for (let i = 0; i < 16; i++) await r.w.clock.advance(1000)
    await r.w.clock.settle()
    expect(r.forks.length, 'first ping').toBe(1)
    let v = await r.mount(surface)
    expect(await v.find({ text: /the cache had gone cold, so ping 1 wrote 182k tokens to it again/ }), 'cold write said plainly').toBeDefined()
    r.w.forkMode = 'ok'

    for (let i = 0; i < 600 && r.forks.length < 21; i++) await r.w.clock.advance(1000)
    await r.w.clock.settle()
    expect(r.forks.length, 'exactly 20 pings').toBe(20)
    expect(r.toasts.join(' '), 'the stop toast names the cap').toContain('after 20 pings')
    v = await r.mount(surface)
    expect(await v.find({ text: /Keeping warm/ }), 'off after the cap').toBeUndefined()
    expect(await v.find({ key: 'keepwarm' }), 'the button is back to Keep warm').toBeDefined()

    // /keepwarm toggles; /keepwarm off stops it.
    await r.said('keepwarm', '')
    v = await r.mount(surface)
    expect(await v.find({ text: /Keeping warm/ }), 'on again').toBeDefined()
    expect(await r.said('keepwarm', 'status'), 'status').toContain('Keep warm is on: ping 0 of 20')
    expect(await r.said('keepwarm', 'on'), 'on when on').toContain('already on')
    expect(await r.said('keepwarm', 'off'), '/keepwarm off').toContain('Keep warm is off')
    v = await r.mount(surface)
    expect(await v.find({ text: /Keeping warm/ }), 'off by the command').toBeUndefined()
    expect(await r.said('keepwarm', 'status'), 'status when off').toContain('Keep warm is off')
  })

  test(`keep warm stops after the time cap, here on a 1 hour cache (${surface})`, { timeoutMs: 120000 }, async ($, on) => {
    const path = '/Users/test/.claude/projects/p/sid.jsonl'
    const r = rig($, on, { files: { [path]: `${row('1h')}\n` } })
    await r.start(surface)
    await $.classic.Stop({ transcript_path: path, stop_hook_active: false })
    await r.reply()
    await r.w.clock.advance(2000)
    await r.said('keepwarm', '')
    for (let i = 0; i < 95; i++) await r.w.clock.advance(60_000)
    await r.w.clock.settle()
    expect(r.toasts.join(' '), 'the stop toast names the time cap').toContain('after 1 h 30 min')
    expect(r.forks.length, 'one ping fits in 90 minutes of a 1 hour cache').toBe(1)
    const v = await r.mount(surface)
    expect(await v.find({ text: /Keeping warm/ })).toBeUndefined()
  })

  test(`keep warm stops after 3 failed pings in a row, and says why (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    await r.said('keepwarm', '')
    r.w.forkMode = 'api'
    await r.w.clock.advance(4 * 60_000 + 16_000)
    await r.w.clock.settle()
    let v = await r.mount(surface)
    expect(await v.find({ text: /last ping failed \(overloaded 529\), trying again/ }), 'the failure is shown').toBeDefined()
    await r.w.clock.advance(21_000)
    await r.w.clock.advance(21_000)
    await r.w.clock.settle()
    expect(r.forks.length, 'three tries, 20 s apart').toBe(3)
    expect(r.toasts.join(' '), 'the stop toast names the reason').toContain('3 pings in a row failed (overloaded 529)')
    v = await r.mount(surface)
    expect(await v.find({ text: /Keeping warm/ })).toBeUndefined()
  })

  test(`a ping that throws is logged, shown and tried again (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    await r.said('keepwarm', '')
    r.w.forkMode = 'throw'
    await r.w.clock.advance(4 * 60_000 + 16_000)
    await r.w.clock.settle()
    expect(r.log(), 'the error is logged').toContain('error error (')
    const v = await r.mount(surface)
    expect(await v.find({ text: /last ping failed \(error\), trying again/ })).toBeDefined()
  })

  test(`a ping with nothing to fork stops keep warm (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    await r.said('keepwarm', '')
    r.w.forkMode = 'nothing'
    await r.w.clock.advance(4 * 60_000 + 16_000)
    await r.w.clock.settle()
    expect(r.toasts.join(' '), 'nothing to fork stops it').toContain('there is no reply to keep warm yet')
  })

  test(`an aborted ping counts as a failure (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    await r.said('keepwarm', '')
    r.w.forkMode = 'aborted'
    await r.w.clock.advance(4 * 60_000 + 16_000)
    await r.w.clock.settle()
    const v = await r.mount(surface)
    expect(await v.find({ text: /last ping failed \(aborted\), trying again/ })).toBeDefined()
  })

  test(`an empty reply still counts as a warm ping (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    await r.said('keepwarm', '')
    r.w.forkMode = 'empty'
    await r.w.clock.advance(4 * 60_000 + 16_000)
    await r.w.clock.settle()
    const v = await r.mount(surface)
    expect(await v.find({ text: /Keeping warm · ping 1 of 20/ })).toBeDefined()
    expect(await v.find({ text: /last ping failed/ })).toBeUndefined()
  })

  test(`a ping that never answers is given up on, and keep warm stops when the cache has gone (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    await r.said('keepwarm', '')
    r.w.forkMode = 'hang'
    await r.w.clock.advance(4 * 60_000 + 16_000)
    expect(r.forks.length, 'the ping went out').toBe(1)
    await r.w.clock.advance(125_000)
    await r.w.clock.advance(25_000)
    await r.w.clock.settle()
    expect(r.forks.length, 'no second ping into a cache that is gone').toBe(1)
    expect(r.toasts.join(' '), 'it says the cache went cold').toContain('went cold before the next ping')
  })

  test(`no ping goes out during a turn, and keep warm carries on after it (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    await r.said('keepwarm', '')
    await r.w.clock.advance(3 * 60_000)
    await r.turnStart()
    await r.w.clock.advance(2 * 60_000)
    expect(r.forks.length, 'no ping while a turn runs').toBe(0)
    await r.reply()
    await r.w.clock.advance(4 * 60_000 + 16_000)
    await r.w.clock.settle()
    expect(r.forks.length, 'a ping again once the next reply has ended').toBe(1)
  })

  test(`starting keep warm on a cold chat writes it once and says so (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const r = rig($, on)
    r.w.forkMode = 'cold'
    await r.start(surface)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 900, context_tokens: 120_000, model: 'claude-sonnet-4-5', transcript_path: '' })
    r.w.ctx = 120_000
    let v = await r.mount(surface)
    expect(await v.find({ text: /Cache cold/ }), 'a resumed chat 15 min old is cold').toBeDefined()
    expect(await v.find({ text: 'Write it again and keep warm' }), 'the button says it re-writes').toBeDefined()
    await v.press({ key: 'keepwarm' })
    await r.w.clock.advance(2000)
    await r.w.clock.settle()
    expect(r.forks.length, 'one ping at once').toBe(1)
    v = await r.mount(surface)
    expect(await v.find({ text: /the cache had gone cold, so ping 1 wrote 120k tokens to it again/ })).toBeDefined()
    expect(await v.find({ text: /Cache warm/ }), 'warm again after the write').toBeDefined()
    expect(r.log(), 'started cold is logged').toContain('started cold')
  })

  test(`hiding the clock stops keep warm, and turning keep warm on shows a hidden clock (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    await r.said('keepwarm', '')
    await r.said('cacheclock', 'hide')
    expect((await r.said('keepwarm', 'status')), 'stopped by hide').toContain('Keep warm is off')
    expect(r.log(), 'logged').toContain('keep warm off')
    expect(JSON.parse(r.files[OWN] ?? '{}')).toEqual({ hidden: true })
    await r.said('keepwarm', '')
    expect(JSON.parse(r.files[OWN] ?? '{}'), 'keep warm never runs out of sight').toEqual({})
    const v = await r.mount(surface)
    expect(await v.find({ text: /Keeping warm/ })).toBeDefined()
  })

  test(`a model change, a compaction, a /clear or a reply with no cache each end keep warm (${surface})`, { timeoutMs: 60000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    await r.said('keepwarm', '')
    await $.classic.PostModelSwitch({ from_model: 'claude-sonnet-4-5', to_model: 'claude-opus-4-5', requested_model: 'opus', source: 'command', context_tokens: 100_000, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 0.6, pricing: 'catalog' })
    expect(r.toasts.join(' '), 'a model change ends it').toContain('you changed model')

    await r.said('keepwarm', '')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })
    expect(r.toasts.join(' '), 'a compaction ends it').toContain('the chat was compacted')

    await r.said('keepwarm', '')
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} })
    expect(await r.said('keepwarm', 'status'), 'a /clear ends it').toContain('Keep warm is off')

    await r.reply()
    await r.said('keepwarm', '')
    await r.reply(0, 0)
    expect(r.toasts.join(' '), 'a reply with no cache ends it').toContain('used no cache')
    expect(await r.said('keepwarm', ''), 'and there is nothing to start').toContain('Nothing to keep warm yet')
  })
}
