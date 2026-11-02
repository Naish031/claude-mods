import { expect, test } from 'claude-code/testing'

import { SURFACES, rig } from '../tests/rig'
import { DEFAULTS, ago, coldFor, costOf, isCold, listInputPrice, mmss, parseObject, pickTtl, readSettings, short, span, ttlFromTranscript, usd, warmLine } from './core'

// Fail open: whatever breaks inside the mod, the prompt and the turn go on unchanged.

for (const surface of SURFACES) {
  test(`unreadable files: the mod stays on, draws, and the prompt is untouched (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on)
    r.w.fsBroken = true
    await r.start(surface)
    await r.reply()
    const v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm/ }), 'a broken disk reads as on').toBeDefined()
    const sent = await $.prompt.submit({ text: 'hello there' })
    expect(JSON.stringify(sent), 'the prompt is unchanged').toContain('hello there')
    expect(await r.said('cacheclock', 'hide'), 'hide still answers').toContain('hidden')
    const hidden = await r.mount(surface)
    expect(await hidden.find({ text: /Cache warm/ }), 'and still hides, for this chat').toBeUndefined()
  })

  test(`a command that cannot be registered does not stop the session starting (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on)
    r.w.registerFails = true
    const started = await r.start(surface)
    expect(started, 'the session started').toEqual({ cwd: '/Users/test/vault' })
    await r.reply()
    const v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm/ }), 'the clock still works').toBeDefined()
  })

  test(`no token count is not a failure: the clock draws without it (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on)
    r.w.sessionUsageFails = true
    await r.start(surface)
    await r.reply()
    const v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm/ })).toBeDefined()
    expect(await v.find({ text: /tokens in this chat/ }), 'no made-up token line').toBeUndefined()
  })

  test(`a failing command list means no handoff button, and a plain hint on a big chat (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on, { handoff: true })
    r.w.listFails = true
    await r.start(surface)
    await r.reply()
    await r.w.clock.advance(6 * 60_000)
    const v = await r.mount(surface)
    expect(await v.find({ text: /Cache cold/ })).toBeDefined()
    expect(await v.find({ key: 'handoff' })).toBeUndefined()
    expect(await v.find({ text: /fresh chat would skip/ })).toBeDefined()
  })

  test(`a handoff command that fails says so and does not break the band (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on, { handoff: true })
    on('command.run', { command: 'handoff' }, async () => {
      throw new Error('handoff exploded')
    })
    await r.start(surface)
    await r.reply()
    await r.w.clock.advance(6 * 60_000)
    const v = await r.mount(surface)
    await v.press({ key: 'handoff' })
    const again = await r.mount(surface)
    expect(await again.find({ text: /Cache cold/ }), 'the band is still there').toBeDefined()
  })

  test(`hooks never change what the person typed or what the turn answered (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.turnStart()
    const sent = await $.prompt.submit({ text: '  keep my spaces and CASE  ' })
    expect(JSON.stringify(sent)).toContain('  keep my spaces and CASE  ')
    const done = await $.turn.complete({ answer: 'x', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, model: 'm' } })
    expect(done).toEqual({ text: '' })
  })
}

// ---- The pure helpers ----

test('ttlFromTranscript: finds the last cache write, skips helpers and broken lines', () => {
  const w = (h: number, m: number, extra = {}) => JSON.stringify({ type: 'assistant', message: { usage: { cache_creation: { ephemeral_1h_input_tokens: h, ephemeral_5m_input_tokens: m } } }, ...extra })
  expect(ttlFromTranscript('')).toBe(null)
  expect(ttlFromTranscript(`${w(0, 5)}\n${w(7, 0)}\n`)).toBe('1h')
  expect(ttlFromTranscript(`${w(7, 0)}\n${w(0, 5)}\n`)).toBe('5m')
  expect(ttlFromTranscript(`${w(7, 0)}\n${w(0, 0)}\n${w(0, 0)}\n`), 'replies that only read are passed over').toBe('1h')
  expect(ttlFromTranscript(`${w(0, 5)}\n${w(7, 0, { isSidechain: true })}\n`), 'helper rows are skipped').toBe('5m')
  expect(ttlFromTranscript(`${w(0, 5)}\n${JSON.stringify({ type: 'user', message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 9 } } } })}\n`), 'only assistant rows count').toBe('5m')
  expect(ttlFromTranscript(`partial {"ephemeral_1h_input_tokens": 3 }\n${w(0, 5)}\n`), 'a cut first line is ignored').toBe('5m')
  expect(ttlFromTranscript(`${w(7, 0)}\nnot json "ephemeral_1h_input_tokens"\n`), 'a broken last line is skipped').toBe('1h')
  expect(ttlFromTranscript(`{"ephemeral_1h_input_tokens": 3 `), 'only a cut line: unknown').toBe(null)
  expect(ttlFromTranscript(`${w(0, 0)}\n${w(0, 0)}`), 'nothing ever written: unknown').toBe(null)
})

test('readSettings: defaults, clamps and odd values', () => {
  expect(readSettings(undefined)).toEqual(DEFAULTS)
  expect(readSettings({})).toEqual(DEFAULTS)
  const s = readSettings({ cache_length: '1h', read_transcript: false, show_cost: false, input_price_per_million: 7.5, big_chat_tokens: 0, handoff_command: '/wrapup', warm_max_pings: 5, warm_max_minutes: 30, warm_lead_seconds: 60 })
  expect(s).toEqual({ cacheLength: '1h', readTranscript: false, showCost: false, inputPrice: 7.5, bigTokens: 0, handoffCommand: 'wrapup', maxPings: 5, maxMs: 30 * 60_000, leadMs: 60_000 })
  const wild = readSettings({ cache_length: 'forever', warm_max_pings: 100000, warm_max_minutes: 1, warm_lead_seconds: 1, input_price_per_million: -4, handoff_command: 'bad name!', big_chat_tokens: 'x' })
  expect(wild.cacheLength, 'an unknown length is auto').toBe('auto')
  expect(wild.maxPings, 'pings are capped').toBe(200)
  expect(wild.maxMs, 'minutes have a floor').toBe(5 * 60_000)
  expect(wild.leadMs, 'the lead has a floor').toBe(15_000)
  expect(wild.inputPrice, 'no negative price').toBe(0)
  expect(wild.handoffCommand, 'a bad command name falls back').toBe('handoff')
  expect(wild.bigTokens, 'text for a number falls back').toBe(150_000)
  expect(readSettings({ warm_max_pings: '12' }).maxPings, 'a number typed as text still reads').toBe(12)
})

test('formatting helpers say things plainly', () => {
  expect(mmss(270_000)).toBe('4:30')
  expect(mmss(-5)).toBe('0:00')
  expect(mmss(59_001)).toBe('1:00')
  expect(short(182_000)).toBe('182k')
  expect(short(950)).toBe('950')
  expect(ago(30_000)).toBe('just now')
  expect(ago(60_000)).toBe('1 min ago')
  expect(ago(7 * 60_000)).toBe('7 min ago')
  expect(ago(3 * 3_600_000)).toBe('3 h ago')
  expect(span(45_000)).toBe('45 s')
  expect(span(10 * 60_000)).toBe('10 min')
  expect(span(90 * 60_000)).toBe('1 h 30 min')
  expect(span(2 * 3_600_000)).toBe('2 h')
  expect(usd(0)).toBe('')
  expect(usd(0.004)).toBe('under $0.01')
  expect(usd(0.0546)).toBe('$0.05')
  expect(usd(12.4)).toBe('$12')
})

test('prices, cache length choice and clock states', () => {
  expect(listInputPrice('claude-sonnet-4-5')).toBe(3)
  expect(listInputPrice('claude-opus-4-5')).toBe(5)
  expect(listInputPrice('claude-opus-4-1-20250805')).toBe(15)
  expect(listInputPrice('claude-haiku-4-5')).toBe(1)
  expect(listInputPrice('something-else')).toBe(0)
  const { warm, cold } = costOf(1_000_000, 300_000, 3e-6)
  expect(Math.round(warm * 1000)).toBe(300)
  expect(Math.round(cold * 1000)).toBe(3750)
  expect(Math.round(costOf(1_000_000, 3_600_000, 3e-6).cold * 1000), 'a 1 hour write costs 2x').toBe(6000)

  expect(pickTtl(DEFAULTS, false, null)).toEqual({ ttlMs: 300_000, ttlSource: 'default' })
  expect(pickTtl(DEFAULTS, false, { ttl: '1h', source: 'transcript' })).toEqual({ ttlMs: 3_600_000, ttlSource: 'transcript' })
  expect(pickTtl({ ...DEFAULTS, cacheLength: '5m' }, false, { ttl: '1h', source: 'transcript' }), 'the setting beats what was found').toEqual({ ttlMs: 300_000, ttlSource: 'setting' })
  expect(pickTtl(DEFAULTS, true, { ttl: '1h', source: 'engine' }), 'the demo beats everything').toEqual({ ttlMs: 60_000, ttlSource: 'demo' })

  const c = { lastEnd: 1000, ttlMs: 300_000, ttlSource: 'default' as const, tokens: 1, model: '', now: 1000, coldAt: 0, coldReason: '' as const, note: '' }
  expect(isCold(c, 1000 + 299_999)).toBe(false)
  expect(isCold(c, 1000 + 300_000)).toBe(true)
  expect(coldFor(c, 1000 + 360_000)).toBe(60_000)
  expect(isCold({ ...c, coldAt: 500 }, 1001), 'a lost cache is cold at once').toBe(true)
  expect(coldFor({ ...c, coldAt: 500 }, 1500)).toBe(1000)
})

test('warmLine and parseObject', () => {
  const w = { startedAt: 0, pings: 0, maxPings: 20, maxMs: 90 * 60_000, leadMs: 45_000, read: 0, write: 0, readTotal: 0, writeTotal: 0, outTotal: 0, cold: false, error: '', sending: false, failures: 0, retryAt: 0, allowCold: false }
  expect(warmLine(w, 255_000, '')).toBe('Keeping warm · first ping in 4:15 · up to 20 pings or 1 h 30 min')
  expect(warmLine({ ...w, pings: 2, read: 182_000 }, 240_000, '$0.11')).toBe('Keeping warm · ping 2 of 20 · next in 4:00 · last ping read 182k cached tokens · $0.11 spent so far')
  expect(warmLine({ ...w, sending: true }, 0, '')).toContain('sending ping 1 of 20')
  expect(warmLine({ ...w, pings: 1, error: 'overloaded 529' }, 20_000, '')).toContain('last ping failed (overloaded 529), trying again')
  expect(parseObject('{"a":1}')).toEqual({ a: 1 })
  expect(parseObject('[1]')).toBeUndefined()
  expect(parseObject('nope')).toBeUndefined()
  expect(parseObject('null')).toBeUndefined()
})
