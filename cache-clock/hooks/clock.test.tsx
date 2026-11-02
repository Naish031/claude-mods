import { expect, test } from 'claude-code/testing'

import { SURFACES, rig, row } from '../tests/rig'

const PATH = '/Users/test/.claude/projects/p/sid.jsonl'

/** Learns the log path the way the mod does: from the Stop event. Then a reply, and the check that follows it. */
async function withLog($: any, r: ReturnType<typeof rig>) {
  await r.start('desktop')
  await $.classic.Stop({ transcript_path: PATH, stop_hook_active: false })
  await r.reply()
  await r.w.clock.advance(2000)
}

for (const surface of SURFACES) {
  test(`cache length: read from the chat log, the last writer wins (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on, { files: { [PATH]: `${row('5m')}\n${row('1h')}\n${row('none')}\n` } })
    await r.start(surface)
    await $.classic.Stop({ transcript_path: PATH, stop_hook_active: false })
    await r.reply()
    let v = await r.mount(surface)
    expect(await v.find({ text: /5 min cache, a guess until the first reply/ }), 'a guess until the log has been read').toBeDefined()
    await r.w.clock.advance(2000)
    v = await r.mount(surface)
    expect(await v.find({ text: /1 hour cache, as Anthropic's last reply set it/ }), 'a 1 hour cache, from the log').toBeDefined()
    expect(await v.find({ text: /59:5\d/ }), 'about an hour left').toBeDefined()
    expect(r.log(), 'the finding is logged once').toContain('cache length 1h (from the chat log)')
    expect(r.procs.length, 'a small log is read with no helper program').toBe(0)
  })

  test(`cache length: a sub-agent row is skipped and a 5 min writer is read as 5 min (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on, { files: { [PATH]: `${row('1h')}\n${row('5m')}\n${row('1h', { isSidechain: true })}\n` } })
    await withLog($, r)
    const v = await r.mount(surface)
    expect(await v.find({ text: /5 min cache, as Anthropic's last reply set it/ })).toBeDefined()
  })

  test(`cache length: a big log is read with tail, no script (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const filler = `${'x'.repeat(1_600_000)}\n`
    const r = rig($, on, { files: { [PATH]: `${filler}${row('1h')}\n` } })
    await withLog($, r)
    expect(r.procs[0]?.slice(0, 2), 'tail of the end of the file').toEqual(['tail', '-c'])
    expect(r.procs[0]?.[3], 'the log path is the last argument').toBe(PATH)
    const v = await r.mount(surface)
    expect(await v.find({ text: /1 hour cache, as Anthropic's last reply set it/ })).toBeDefined()
  })

  test(`cache length: when the log cannot be read it stays a labelled guess, and logs once (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on)
    await withLog($, r)
    await r.reply()
    await r.w.clock.advance(2000)
    const v = await r.mount(surface)
    expect(await v.find({ text: /5 min cache, a guess until the first reply/ })).toBeDefined()
    expect(r.log().split('could not read the chat log').length - 1, 'the problem is logged once, not every reply').toBe(1)
  })

  test(`cache length: a log path that is not absolute is never read (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const rel = 'projects/p/sid.jsonl'
    const r = rig($, on, { files: { [rel]: `${row('1h')}\n` } })
    await r.start(surface)
    await $.classic.Stop({ transcript_path: rel, stop_hook_active: false })
    await r.reply()
    await r.w.clock.advance(2000)
    expect(r.fsCalls, 'not read').not.toContain(rel)
    expect(r.procs.length, 'no helper program either').toBe(0)
    const v = await r.mount(surface)
    expect(await v.find({ text: /5 min cache, a guess/ })).toBeDefined()
  })

  test(`cache length: seen working when a reply after 7 minutes still read the chat from cache (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on, { tokens: 100_000 })
    await r.start(surface)
    await r.reply()
    await r.w.clock.advance(7 * 60_000)
    await r.turnStart()
    await r.reply(100_000, 400)
    const v = await r.mount(surface)
    expect(await v.find({ text: /1 hour cache, seen working: it outlived 5 min/ }), 'the 1 hour cache is proved by a hit after the gap').toBeDefined()
    expect(r.log()).toContain('it is a 1 hour cache')
  })

  test(`cache length: a reply that had to write the chat again proves nothing (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on, { tokens: 100_000 })
    await r.start(surface)
    await r.reply()
    await r.w.clock.advance(7 * 60_000)
    await r.turnStart()
    await r.reply(0, 100_000)
    const v = await r.mount(surface)
    expect(await v.find({ text: /5 min cache, a guess/ })).toBeDefined()
  })

  test(`cache length: a ping that finds a cold cache inside a long one corrects it to 5 min (${surface})`, { timeoutMs: 120000 }, async ($, on) => {
    const r = rig($, on, { files: { [PATH]: `${row('1h')}\n` } })
    await withLog($, r)
    r.w.forkMode = 'cold'
    await r.said('keepwarm', '')
    for (let i = 0; i < 61; i++) await r.w.clock.advance(60_000)
    await r.w.clock.settle()
    expect(r.forks.length, 'one ping near the hour').toBe(1)
    const v = await r.mount(surface)
    expect(await v.find({ text: /5 min cache, seen going cold/ })).toBeDefined()
    expect(r.log()).toContain('it is a 5 min cache')
  })

  test(`a resumed chat starts its clock from how long ago the last reply was (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 120, context_tokens: 90_000, model: 'claude-sonnet-4-5', transcript_path: '' })
    let v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm/ }), 'warm: the last reply was 2 min ago').toBeDefined()
    expect(await v.find({ text: /3:00/ }), '3 min left of 5').toBeDefined()
    expect(await v.find({ text: /90k tokens in this chat/ })).toBeDefined()
    expect(r.log()).toContain('resumed: last reply 2 min ago, 90k tokens')
    await r.w.clock.advance(3 * 60_000 + 5000)
    v = await r.mount(surface)
    expect(await v.find({ text: /Cache cold/ })).toBeDefined()
  })

  test(`a model change makes the cache cold at once, takes Claude Code's cache length and price (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    await $.classic.PostModelSwitch({ from_model: 'claude-sonnet-4-5', to_model: 'claude-opus-4-5', requested_model: 'opus', source: 'command', context_tokens: 100_000, prompt_cache_warm: true, cache_ttl: '1h', estimated_cache_write_usd: 1.0, pricing: 'catalog' })
    const v = await r.mount(surface)
    expect(await v.find({ text: /Cache cold/ }), 'cold, though the 5 minutes are not up').toBeDefined()
    expect(await v.find({ text: /because you changed model/ })).toBeDefined()
    // 1.0 USD for 100k tokens at the 1 hour write price is 5 USD per million; 182k tokens cost 1.82 to write.
    expect(await v.find({ text: /about \$1\.82/ }), "the price is Claude Code's own figure").toBeDefined()
    expect(r.log()).toContain('model changed to claude-opus-4-5')
  })

  test(`a model switch while resuming is not a lost cache (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: null, source: 'resume', context_tokens: 100_000, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 0.5, pricing: 'default' })
    const v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm/ })).toBeDefined()
  })

  test(`a manual compaction says the cache starts over; an automatic one or a helper's does not (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    const msgs = [{ role: 'user', text: 'hi', toolUses: [] }]
    await $.session.compact({ trigger: 'auto', messages: msgs })
    await $.session.compact({ trigger: 'manual', agentId: 'sub-1', messages: msgs })
    let v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm/ }), 'auto and helper compactions leave the clock alone').toBeDefined()
    await $.session.compact({ trigger: 'manual', messages: msgs })
    v = await r.mount(surface)
    expect(await v.find({ text: /Cache cold/ })).toBeDefined()
    expect(await v.find({ text: /because the chat was compacted/ })).toBeDefined()
    expect(await v.find({ text: /writes the shorter chat to the cache/ }), 'no cost for a chat that is now short').toBeDefined()
    expect(await v.find({ key: 'handoff' }), 'no handoff offer after a compaction').toBeUndefined()
  })

  test(`a /clear forgets the clock (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await $.classic.Stop({ transcript_path: PATH, stop_hook_active: false })
    await r.reply()
    let v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm/ })).toBeDefined()
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} })
    v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm|Cache cold/ }), 'nothing drawn for the cleared chat').toBeUndefined()
    expect(r.log()).toContain('chat cleared')
    await r.reply()
    v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm/ }), 'and a fresh clock after the next reply').toBeDefined()
    await $.classic.SessionStart({ source: 'clear' })
    v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm/ }), 'the classic clear event does the same').toBeUndefined()
  })

  test(`a reply that used no cache draws nothing; an error with no usage leaves the clock alone (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    await r.w.clock.advance(60_000)
    await $.turn.complete({ answer: '', reason: 'error', durationMs: 1, isAborted: false, turnId: 't' })
    await r.w.clock.settle()
    let v = await r.mount(surface)
    expect(await v.find({ text: /4:0\d/ }), 'an error with nothing sent does not restart the clock').toBeDefined()
    await $.turn.complete({ answer: '', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'sub-1', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, model: 'm' } })
    await r.w.clock.settle()
    v = await r.mount(surface)
    expect(await v.find({ text: /4:0\d/ }), "a helper's turn does not restart it either").toBeDefined()
    await r.reply(0, 0)
    v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm|Cache cold/ }), 'no cache used: nothing to count down').toBeUndefined()
    expect(r.log()).toContain('the last reply used no cache')
  })

  test(`prices: Claude's list price by model family, tokens-only words for an unknown model (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const opus = rig($, on, { model: 'claude-opus-4-5' })
    await opus.start(surface)
    await opus.reply()
    const v = await opus.mount(surface)
    expect(await v.find({ text: /Reply now: about \$0\.09\. If it goes cold: about \$1\.14/ }), 'opus: 5 USD per million').toBeDefined()
  })

  test(`prices: an unknown model gets the share of the normal price, not a made-up amount (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on, { model: 'mystery-model' })
    await r.start(surface)
    await r.reply()
    const v = await r.mount(surface)
    expect(await v.find({ text: /Reply now costs about 10% of the normal input price for them; once cold, 125%/ })).toBeDefined()
    expect(await v.find({ text: /\$/ }), 'no money amount').toBeUndefined()
  })

  test(`the band yields to a survey and to a running turn (${surface})`, { timeoutMs: 30000 }, async ($, on) => {
    const r = rig($, on)
    await r.start(surface)
    await r.reply()
    let v = await r.mount(surface, { isWorking: false, hasSurvey: true, maxRows: 10, bodyColumns: 140 })
    expect(await v.find({ text: /Cache warm/ }), 'a survey holds the band').toBeUndefined()
    v = await r.mount(surface, { isWorking: true, hasSurvey: false, maxRows: 10, bodyColumns: 140 })
    expect(await v.find({ text: /Cache warm/ }), 'a running turn hides it').toBeUndefined()
    await r.turnStart()
    v = await r.mount(surface)
    expect(await v.find({ text: /Cache warm/ }), 'a turn the mod saw start hides it too').toBeUndefined()
  })
}
