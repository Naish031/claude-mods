import type { EngineInterface, ModelForkResult, Register } from 'claude-code'

import type { CacheClockClock, CacheClockWarm } from '../types'
import {
  ago,
  coldFor,
  costOf,
  DEFAULTS,
  FIVE_MIN,
  isCold,
  lengthLabel,
  listInputPrice,
  mmss,
  ONE_HOUR,
  parseObject,
  pickTtl,
  readSettings,
  short,
  span,
  ttlFromTranscript,
  usd,
  warmLine,
  warmSpent,
  writeShare,
  type Detected,
  type Settings,
  type Ttl,
} from './core'

// Cache Clock. After each reply it counts down to the moment the chat's prompt cache goes
// cold, says what a cold restart would cost, and offers a capped, opt-in Keep warm.
//
// Keep warm: $.model.fork repeats the main thread's last request (same model, system prompt,
// tools, messages) with one short line after it, so the API reads the chat from its cache and
// the cache's timer starts again. The fork never writes to the transcript.
//
// The cache length (5 min or 1 hour) is not in the API a mod can call: ModelUsage has only the
// four token counts. It is found from, in order: the Cache length setting, the last reply's own
// usage in the chat log (a plain file read, no helper program), Claude Code's own figure at a
// model switch, and what a reply or a ping showed. Without any of them it is a 5 min guess.

type Engine = EngineInterface

const NAME = 'cache-clock'
const CLOCK = { plugin: 'cache-clock', key: 'clock' } as const
const WARM = { plugin: 'cache-clock', key: 'warm' } as const

const PING_PROMPT = 'Reply with the single word: ok'
const PING_TIMEOUT_MS = 120_000
const RETRY_MS = 20_000
const MAX_FAILS = 3
const BAR = 20
const LOG_LINES = 300
// $.fs.read refuses files over 4 MiB, and a read this big on every reply is wasteful, so a
// bigger log is read with `tail` instead: the last 600 KB hold many replies.
const FS_READ_LIMIT = 1_500_000
const TAIL_BYTES = 600_000
const OFF_TEXT = 'Cache Clock is switched off ("cache-clock": false in ~/.claude/claude-mods/switches.json). Remove that line to turn it on.'
// Turns that are not the person typing: they do not count as "they are back".
const BACKGROUND = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'channel', 'coordinator', 'observer', 'observer-activity', 'auto-continuation'])

// Theme keys, so the colors follow the person's light or dark theme.
const GOOD = 'success'
const WARN = 'warning'
const BAD = 'error'
const COLD = 'suggestion'

// Module variables reset on a reload; the clock and keep warm live in $.state.
let sid = ''
let home: string | null | undefined
let opts: Settings = DEFAULTS
let demo = false
let detected: Detected = null
let working = false
let turnStartAt = 0
let pinging = false
let pingStartedAt = 0
let pingToken = 0
let transcriptPath = ''
let transcriptWarned = false
let calib: { model: string; perToken: number } | null = null
let flags = { at: Number.NEGATIVE_INFINITY, off: false, hidden: false }
let handoff = { at: Number.NEGATIVE_INFINITY, has: false }
let started = false
let detectTimer: { cancel: () => void } | undefined
let logQueue: Promise<void> = Promise.resolve()

const errText = (err: unknown) => String(err instanceof Error ? err.message : err).slice(0, 160)

// ---- Files: home, log, switches ----

async function getHome($: Engine): Promise<string | null> {
  if (home !== undefined) return home
  let h = ''
  try {
    h = (await $.env.get('HOME')) ?? ''
  } catch {
    // Try the Windows name next.
  }
  if (!h) {
    try {
      h = (await $.env.get('USERPROFILE')) ?? ''
    } catch {
      // No home: the switch reads as on and nothing is logged.
    }
  }
  home = h ? h.replace(/[\\/]+$/, '') : null
  return home
}

const dir = (base: string) => `${base}/.claude/claude-mods`

async function writeLog($: Engine, line: string) {
  const base = await getHome($)
  if (!base) return
  const path = `${dir(base)}/logs/${NAME}.log`
  const now = await $.clock.now()
  let old = ''
  try {
    if (await $.fs.exists(path)) old = String(await $.fs.read(path))
  } catch {
    // Start the file again.
  }
  const lines = old ? old.trimEnd().split('\n').slice(-(LOG_LINES - 1)) : []
  lines.push(`${new Date(now).toISOString()} ${sid.slice(0, 8)} ${line}`)
  await $.fs.write(path, `${lines.join('\n')}\n`)
}

/** One line per event. Never throws, never holds up the caller for long, and holds no prompt text. */
function log($: Engine, line: string): Promise<void> {
  logQueue = logQueue.then(() => writeLog($, line)).catch(() => undefined)
  return logQueue
}

async function readJson($: Engine, path: string): Promise<Record<string, unknown>> {
  try {
    if (!(await $.fs.exists(path))) return {}
    return parseObject(String(await $.fs.read(path))) ?? {}
  } catch {
    return {}
  }
}

/**
 * The shared on/off switch ("cache-clock": false in switches.json) and the hide flag, read at
 * event time and kept for maxAge ms. No timer of its own reads them. A missing or broken file
 * means on and shown.
 */
async function refreshFlags($: Engine, maxAge = 1000) {
  const now = await $.clock.now()
  if (now >= flags.at && now - flags.at < maxAge) return flags
  flags.at = now
  const base = await getHome($)
  if (!base) return flags
  const switches = await readJson($, `${dir(base)}/switches.json`)
  const own = await readJson($, `${dir(base)}/${NAME}.json`)
  const off = switches[NAME] === false
  const hidden = own.hidden === true
  const wasOff = flags.off
  const wasHidden = flags.hidden
  flags.off = off
  flags.hidden = hidden
  if (off !== wasOff || hidden !== wasHidden) {
    void log($, `switch: ${off ? 'off' : 'on'}, ${hidden ? 'hidden' : 'shown'}`)
    if (off) await stopWarm($, 'Keep warm stopped: Cache Clock was switched off.')
    else if (hidden) await stopWarm($, 'Keep warm stopped: Cache Clock is hidden.')
    await redraw($)
  }
  return flags
}

/** Hide or show the clock in every chat: the flag sits in a small file of its own. */
async function setHidden($: Engine, value: boolean) {
  const base = await getHome($)
  if (base) {
    try {
      const path = `${dir(base)}/${NAME}.json`
      const json = await readJson($, path)
      if (value) json.hidden = true
      else delete json.hidden
      await $.fs.write(path, `${JSON.stringify(json, null, 2)}\n`)
    } catch (err) {
      void log($, `could not save the hide flag: ${errText(err)}`)
    }
  }
  flags = { ...flags, at: await $.clock.now(), hidden: value }
  if (value) await stopWarm($, 'Keep warm stopped: Cache Clock is hidden.', false)
  await redraw($)
}

// ---- State ----

async function getClock($: Engine): Promise<CacheClockClock | null> {
  const { value } = await $.state.get(CLOCK)
  return value ?? null
}

async function setClock($: Engine, c: CacheClockClock | null) {
  await $.state.set(CLOCK, c)
}

async function getWarm($: Engine): Promise<CacheClockWarm | null> {
  const { value } = await $.state.get(WARM)
  return value ?? null
}

async function setWarm($: Engine, w: CacheClockWarm | null) {
  await $.state.set(WARM, w)
  invalidate($)
}

function invalidate($: Engine) {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // The next tick redraws anyway.
  }
}

async function redraw($: Engine) {
  try {
    const c = await getClock($)
    if (c) await setClock($, { ...c, now: await $.clock.now() })
    invalidate($)
  } catch {
    // The next tick redraws anyway.
  }
}

function toast($: Engine, text: string) {
  try {
    $.ui.toast(text)
  } catch {
    // The toast is only a hint.
  }
}

// ---- Cache length and cost ----

const ttl = () => pickTtl(opts, demo, detected)

/** USD per input token for a model: the setting, else Claude Code's own figure, else a list-price guess. 0: unknown. */
function perToken(model: string): number {
  if (opts.inputPrice > 0) return opts.inputPrice / 1e6
  if (calib && model && calib.model === model) return calib.perToken
  const p = listInputPrice(model)
  return p > 0 ? p / 1e6 : 0
}

async function readLogTail($: Engine): Promise<string> {
  // The path comes from Claude Code's own hook events; still, only an absolute path is read.
  if (!/^([\\/]|[A-Za-z]:[\\/])/.test(transcriptPath)) throw new Error('the chat log path is not absolute')
  const stat = await $.fs.stat(transcriptPath)
  if (stat.size <= FS_READ_LIMIT) return String(await $.fs.read(transcriptPath))
  // No shell and no script: `tail` prints the end of the file and the text is read here.
  const r = await $.process.run(['tail', '-c', String(TAIL_BYTES), transcriptPath], { timeoutMs: 10_000 })
  if (r.exitCode !== 0) throw new Error(`tail exited ${r.exitCode}`)
  return r.stdout
}

/** Which cache length the chat's last cache write used, from its own log file. null when unknown. */
async function readTtl($: Engine): Promise<Ttl | null> {
  if (!opts.readTranscript || !transcriptPath || opts.cacheLength !== 'auto') return null
  try {
    return ttlFromTranscript(await readLogTail($))
  } catch (err) {
    if (!transcriptWarned) {
      transcriptWarned = true
      void log($, `could not read the chat log for the cache length: ${errText(err)}`)
    }
    return null
  }
}

async function detectAndApply($: Engine) {
  if (flags.off) return
  const r = await readTtl($)
  if (!r) return
  if (!detected || detected.ttl !== r || detected.source !== 'transcript') {
    detected = { ttl: r, source: 'transcript' }
    void log($, `cache length ${r} (from the chat log)`)
  }
  const c = await getClock($)
  if (!c || demo) return
  const t = ttl()
  if (t.ttlMs !== c.ttlMs || t.ttlSource !== c.ttlSource) await setClock($, { ...c, ...t, now: await $.clock.now() })
}

function scheduleDetect($: Engine, ms: number) {
  try {
    detectTimer?.cancel()
    detectTimer = $.clock.after(ms, () => {
      void detectAndApply($).catch(err => log($, `cache length check failed: ${errText(err)}`))
    })
  } catch {
    // Not worth failing for.
  }
}

// ---- The clock ----

type ReplyEnd = { reason?: string; usage?: { cache_read_input_tokens: number; cache_creation_input_tokens: number; model?: string } }

/** A main-chat reply just ended: the cache is warm again from now. */
async function restart($: Engine, e: ReplyEnd) {
  const now = await $.clock.now()
  const u = e.usage
  const read = u?.cache_read_input_tokens ?? 0
  const wrote = u?.cache_creation_input_tokens ?? 0
  // An error or an interrupt that sent nothing leaves the cache as it was.
  if (!u && e.reason !== 'answer') return
  const prev = await getClock($)

  // Caching is off, or the chat is under the model's minimum: there is nothing to count down.
  if (u && read + wrote === 0 && !demo) {
    if (prev || (await getWarm($))) void log($, 'the last reply used no cache: clock cleared')
    await stopWarm($, 'Keep warm stopped: the last reply used no cache, so there is nothing to keep warm.')
    await setClock($, null)
    return
  }

  let tokens = 0
  try {
    tokens = (await $.session.usage()).context.tokens ?? 0
  } catch {
    // Keep the clock without a token count.
  }
  let model = u?.model ?? ''
  if (!model) {
    try {
      model = await $.session.model()
    } catch {
      // The model is only used to guess a price.
    }
  }

  // Proof of a 1 hour cache: a gap longer than 5 min, and the chat was still read from cache.
  if (u && prev && prev.lastEnd > 0 && prev.coldAt === 0 && !demo && opts.cacheLength === 'auto') {
    const gap = (turnStartAt || now) - prev.lastEnd
    const same = !prev.model || !model || prev.model === model
    if (same && gap > FIVE_MIN + 20_000 && gap < ONE_HOUR - 30_000 && prev.tokens >= 4096 && read >= prev.tokens * 0.5 && wrote < prev.tokens * 0.2 && detected?.ttl !== '1h') {
      detected = { ttl: '1h', source: 'seen' }
      void log($, `the cache lasted ${span(gap)}: it is a 1 hour cache`)
    }
  }

  turnStartAt = 0
  await setClock($, { lastEnd: now, ...ttl(), tokens, model, now, coldAt: 0, coldReason: '', note: '' })
  scheduleDetect($, 1500)
}

async function markCold($: Engine, reason: 'model' | 'compact', patch: Partial<CacheClockClock> = {}) {
  const c = await getClock($)
  if (!c) return
  const now = await $.clock.now()
  await setClock($, { ...c, ...patch, now, coldAt: now, coldReason: reason, note: '' })
}

/** Forget this chat's clock: after a /clear there is nothing left to keep warm. */
async function resetChat($: Engine) {
  await stopWarm($, 'Keep warm stopped: the chat was cleared.', false)
  await setClock($, null)
  detected = null
  demo = false
  working = false
  transcriptPath = ''
  transcriptWarned = false
  void log($, 'chat cleared: clock reset')
}

/** Once a second: moves the countdown while the band shows, and runs keep warm. */
async function tick($: Engine) {
  const w0 = await getWarm($)
  // Switched off and nothing running: do no work at all, not even a file read.
  if (flags.off && !w0) return
  const c = await getClock($)
  if (!c && !w0) return
  const f = await refreshFlags($, flags.hidden ? 3000 : 1000)
  if (f.off) return
  const now = await $.clock.now()
  const w = await getWarm($)
  if (w) await warmStep($, c, w, now)
  if (!c || f.hidden || !c.lastEnd) return
  // A cold clock only needs a redraw once a minute, for its "went cold" line.
  if (isCold(c, now) && isCold(c, c.now) && Math.floor(coldFor(c, now) / 60_000) === Math.floor(coldFor(c, c.now) / 60_000)) return
  await setClock($, { ...c, now })
}

// ---- Keep warm ----

const ttlLabelForLog = (c: CacheClockClock) => (c.ttlMs >= ONE_HOUR ? '1 hour' : c.ttlMs === FIVE_MIN ? '5 min' : `${c.ttlMs / 1000} s`)

/** Turns keep warm on. 'none' when there is no reply yet whose cache could be kept. */
async function startWarm($: Engine): Promise<'on' | 'none'> {
  const c = await getClock($)
  if (!c || !c.lastEnd) return 'none'
  // Keep warm never runs out of sight: it shows the clock first.
  if (flags.hidden) await setHidden($, false)
  const now = await $.clock.now()
  const cold = isCold(c, now)
  await setWarm($, {
    startedAt: now,
    pings: 0,
    maxPings: opts.maxPings,
    maxMs: opts.maxMs,
    leadMs: opts.leadMs,
    read: 0,
    write: 0,
    readTotal: 0,
    writeTotal: 0,
    outTotal: 0,
    cold: false,
    error: '',
    sending: false,
    failures: 0,
    retryAt: 0,
    allowCold: cold,
  })
  void log($, `keep warm on (${ttlLabelForLog(c)} cache, ${short(c.tokens)} tokens, up to ${opts.maxPings} pings or ${span(opts.maxMs)}${cold ? ', started cold' : ''})`)
  return 'on'
}

async function stopWarm($: Engine, why: string, shout = true) {
  const w = await getWarm($)
  if (!w) return
  pingToken++
  pinging = false
  await setWarm($, null)
  void log($, `keep warm off after ${w.pings} pings (read ${w.readTotal}, wrote ${w.writeTotal}): ${why || 'stopped'}`)
  if (shout && why) toast($, why)
}

const tooMany = (w: CacheClockWarm) => `Keep warm stopped after ${w.maxPings} pings. Type /keepwarm to start it again.`
const tooLong = (w: CacheClockWarm) => `Keep warm stopped after ${span(w.maxMs)}. Type /keepwarm to start it again.`

/** Sends the ping when the cache is leadMs from going cold, and keeps the caps. */
async function warmStep($: Engine, c: CacheClockClock | null, w: CacheClockWarm, now: number) {
  if (pinging) {
    // A ping that never answers must not hold keep warm for ever.
    if (now - pingStartedAt > PING_TIMEOUT_MS) {
      pingToken++
      pinging = false
      await failPing($, w, 'timed out', now)
    }
    return
  }
  if (working) return
  if (now - w.startedAt >= w.maxMs) return stopWarm($, tooLong(w))
  if (w.pings >= w.maxPings) return stopWarm($, tooMany(w))
  if (now < w.retryAt) return
  if (!c || !c.lastEnd) return
  const cold = isCold(c, now)
  if (cold && !w.allowCold) {
    return stopWarm($, 'Keep warm stopped: the cache went cold before the next ping (the computer may have slept). Press Keep warm to write it again.')
  }
  // A ping only helps while the cache is still warm: it goes out at the lead time, never after.
  if (!cold && c.lastEnd + c.ttlMs - now > w.leadMs) return
  pinging = true
  pingStartedAt = now
  const token = ++pingToken
  void ping($, w, c, now, token).catch(async err => {
    if (token === pingToken) pinging = false
    void log($, `ping failed: ${errText(err)}`)
  })
}

async function failPing($: Engine, w: CacheClockWarm, error: string, now: number) {
  const failures = w.failures + 1
  await setWarm($, { ...w, error, sending: false, failures, retryAt: now + RETRY_MS })
  if (failures >= MAX_FAILS) await stopWarm($, `Keep warm stopped: ${MAX_FAILS} pings in a row failed (${error}).`)
}

async function ping($: Engine, w0: CacheClockWarm, c0: CacheClockClock, start: number, token: number) {
  await setWarm($, { ...w0, sending: true })
  let r: ModelForkResult | null = null
  let thrown = ''
  try {
    r = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    thrown = errText(err)
  }
  // Stopped or timed out while the ping was out: the log keeps what it cost.
  const abandoned = token !== pingToken
  if (!abandoned) pinging = false
  const n = w0.pings + 1
  if (r && !r.isAnswered && r.reason === 'nothing-to-fork') {
    void log($, `ping ${n}: nothing to fork yet`)
    if (!abandoned) await stopWarm($, 'Keep warm stopped: there is no reply to keep warm yet.')
    return
  }
  const usage = r && 'usage' in r ? r.usage : null
  const read = usage?.cache_read_input_tokens ?? 0
  const write = usage?.cache_creation_input_tokens ?? 0
  const out = usage?.output_tokens ?? 0
  // An answer, or a reply with no words, still read the chat: the cache timer restarted.
  const ok = r !== null && (r.isAnswered || r.reason === 'empty-reply')
  const error = ok ? '' : thrown ? 'error' : r && !r.isAnswered && r.reason === 'api-error' ? `${r.error}${r.status ? ` ${r.status}` : ''}` : r && !r.isAnswered ? r.reason : 'error'
  void log($, `ping ${n}: cache read ${read}, cache write ${write}, error ${error || 'none'}${thrown ? ` (${thrown})` : ''}`)
  if (abandoned) return
  const w = await getWarm($)
  if (!w) return
  const now = await $.clock.now()
  if (!ok) {
    await failPing($, { ...w, pings: n }, error, now)
    return
  }
  const cold = write > read
  await setWarm($, {
    ...w,
    pings: n,
    read,
    write,
    readTotal: w.readTotal + read,
    writeTotal: w.writeTotal + write,
    outTotal: w.outTotal + out,
    cold,
    error: '',
    sending: false,
    failures: 0,
    retryAt: 0,
    allowCold: false,
  })
  const c = (await getClock($)) ?? c0
  // A ping that had to write the chat again found a cache that was already gone. If it was
  // sent well inside a long cache, the cache is really a 5 min one.
  if (cold && !demo && opts.cacheLength === 'auto' && c.ttlMs > FIVE_MIN && start - c.lastEnd > FIVE_MIN) {
    detected = { ttl: '5m', source: 'seen' }
    void log($, 'the ping found a cold cache long before an hour: it is a 5 min cache')
  }
  await setClock($, { ...c, ...ttl(), lastEnd: Math.max(c.lastEnd, start), now, coldAt: 0, coldReason: '', note: '' })
  if (n >= w.maxPings) await stopWarm($, tooMany(w))
}

// ---- Handoff seam ----

/**
 * Is the handoff command there? Another mod (the handoff mod) registers /handoff; this mod
 * only looks the name up and runs it. Nothing here depends on that mod being installed.
 */
async function hasHandoff($: Engine, force = false): Promise<boolean> {
  const now = await $.clock.now()
  if (!force && now - handoff.at < 10_000) return handoff.has
  let has = false
  try {
    has = (await $.command.list()).some(cmd => cmd.name === opts.handoffCommand)
  } catch {
    // Unknown counts as not there.
  }
  handoff = { at: now, has }
  return has
}

// ---- Text of the commands ----

function costWords(c: CacheClockClock): string {
  const p = perToken(c.model)
  const { warm, cold } = costOf(c.tokens, c.ttlMs, p)
  return p > 0 ? `a keep-warm ping or a reply now: about ${usd(warm)}; writing the chat again: about ${usd(cold)}` : ''
}

async function describe($: Engine): Promise<string> {
  const c = await getClock($)
  const w = await getWarm($)
  if (!c || !c.lastEnd) return 'No reply yet, so there is no cache to count down.'
  const now = await $.clock.now()
  const cold = isCold(c, now)
  const state = cold ? `cold for ${span(coldFor(c, now))}` : `warm, ${mmss(c.lastEnd + c.ttlMs - now)} left`
  return `Cache ${state} (${lengthLabel(c)}). ${short(c.tokens)} tokens in the chat. Keep warm is ${w ? `on: ${w.pings} of ${w.maxPings} pings` : 'off'}.`
}

export const register: Register = (on, options) => {
  opts = readSettings(options as Record<string, unknown> | undefined)

  on('session.start', async ($, e, next) => {
    try {
      try {
        sid = String(await $.session.id())
      } catch {
        // The id is only a label in the log.
      }
      // The 60 s demo is for one chat only.
      demo = false
      await refreshFlags($)
      await $.command.register({
        name: 'cacheclock',
        description: 'Cache Clock: show or hide it. "/cacheclock hide", "/cacheclock show", "/cacheclock status", "/cacheclock demo" (60 s cache, for filming), "/cacheclock auto"',
        argumentHint: '[hide|show|status|demo|auto]',
        immediate: true,
      })
      await $.command.register({
        name: 'keepwarm',
        description: `Cache Clock: keep the cache warm with a small background ping before it goes cold. It costs tokens, stops after ${opts.maxPings} pings or ${span(opts.maxMs)}, and "/keepwarm off" stops it`,
        argumentHint: '[on|off|status]',
        immediate: true,
      })
      if (!started) {
        started = true
        $.clock.every(1000, () => {
          void tick($).catch(err => log($, `tick failed: ${errText(err)}`))
        })
      }
    } catch (err) {
      void log($, `session start failed: ${errText(err)}`)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      if (e.reason === 'clear') await resetChat($)
    } catch (err) {
      void log($, `session end failed: ${errText(err)}`)
    }
    return next(e)
  })

  // Classic hooks: Claude Code's own facts, with no helper program. Each one passes through.
  on('classic.SessionStart', async ($, e, next) => {
    try {
      if (e.transcript_path) transcriptPath = e.transcript_path
      if (e.source === 'clear') await resetChat($)
      const f = await refreshFlags($)
      if (!f.off) {
        // A resumed chat: Claude Code says how long ago the last reply was, so the clock can start now.
        if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number' && (e.context_tokens ?? 0) > 0) {
          const now = await $.clock.now()
          await setClock($, {
            lastEnd: now - e.seconds_since_last_response * 1000,
            ...ttl(),
            tokens: e.context_tokens ?? 0,
            model: e.model ?? '',
            now,
            coldAt: 0,
            coldReason: '',
            note: '',
          })
          void log($, `resumed: last reply ${span(e.seconds_since_last_response * 1000)} ago, ${short(e.context_tokens ?? 0)} tokens`)
        }
        scheduleDetect($, 800)
      }
    } catch (err) {
      void log($, `session start event failed: ${errText(err)}`)
    }
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    try {
      // Learn the chat log's path where SessionStart did not give it.
      if (e.transcript_path && e.transcript_path !== transcriptPath) {
        transcriptPath = e.transcript_path
        scheduleDetect($, 800)
      }
    } catch (err) {
      void log($, `stop event failed: ${errText(err)}`)
    }
    return next(e)
  })

  // A model switch loses the cache (it belongs to the model) and Claude Code says the cache length.
  on('classic.PostModelSwitch', async ($, e, next) => {
    try {
      const f = await refreshFlags($)
      if (!f.off) {
        if (e.cache_ttl === '5m' || e.cache_ttl === '1h') detected = { ttl: e.cache_ttl, source: 'engine' }
        const tokens = e.context_tokens
        if (tokens >= 1000 && e.estimated_cache_write_usd > 0 && e.to_model) {
          calib = { model: e.to_model, perToken: e.estimated_cache_write_usd / (tokens * writeShare(e.cache_ttl === '1h' ? ONE_HOUR : FIVE_MIN)) }
        }
        if (e.source !== 'resume' && e.from_model !== e.to_model) {
          await markCold($, 'model', { ...ttl(), model: e.to_model })
          await stopWarm($, 'Keep warm stopped: you changed model, so the cache starts over.')
          void log($, `model changed to ${e.to_model}: cache lost`)
        }
      }
    } catch (err) {
      void log($, `model switch event failed: ${errText(err)}`)
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    try {
      const compacted = !('skip' in result && result.skip) && Array.isArray(result.messages)
      if (e.agentId === undefined && compacted && (e.trigger === 'manual' || e.trigger === 'plugin')) {
        const f = await refreshFlags($)
        if (!f.off) {
          await markCold($, 'compact', { tokens: 0 })
          await stopWarm($, 'Keep warm stopped: the chat was compacted.')
          void log($, 'chat compacted: cache starts over')
        }
      }
    } catch (err) {
      void log($, `compact event failed: ${errText(err)}`)
    }
    return result
  })

  on('turn.start', async ($, e, next) => {
    try {
      const f = await refreshFlags($)
      // Only the main chat's turns matter, and not a ping, should the engine ever raise one.
      if (!f.off && e.agentId === undefined && !(pinging && e.text === PING_PROMPT)) {
        working = true
        turnStartAt = await $.clock.now()
      }
    } catch (err) {
      void log($, `turn start failed: ${errText(err)}`)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      // A helper's turn does not touch the main chat's cache.
      if (e.agentId === undefined) {
        working = false
        const f = await refreshFlags($)
        if (!f.off) void restart($, e).catch(err => log($, `restart failed: ${errText(err)}`))
      }
    } catch (err) {
      void log($, `turn complete failed: ${errText(err)}`)
    }
    return result
  })

  // The person is back: a prompt of theirs ends keep warm. Its own commands do not.
  on('prompt.submit', async ($, e, next) => {
    try {
      const f = await refreshFlags($)
      if (!f.off && !e.isMeta) {
        const text = e.text.trim().toLowerCase()
        const own = /^\/(keepwarm|cacheclock)(\s|$)/.test(text) || text === PING_PROMPT.toLowerCase()
        if (!own && !BACKGROUND.has(e.origin?.kind ?? '')) void stopWarm($, 'Keep warm stopped: you sent a message.').catch(() => undefined)
      }
    } catch (err) {
      void log($, `prompt hook failed: ${errText(err)}`)
    }
    return next(e)
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    try {
      const f = await refreshFlags($)
      if (f.off) return { text: OFF_TEXT }
      const arg = e.args.trim().toLowerCase()
      const w = await getWarm($)
      if (arg === 'status') return { text: w ? `Keep warm is on: ping ${w.pings} of ${w.maxPings}, ${span(w.maxMs)} at most. Type /keepwarm off to stop it.` : 'Keep warm is off. Type /keepwarm to start it.' }
      if (arg === 'off' || (arg !== 'on' && w)) {
        await stopWarm($, 'Keep warm is off.', false)
        return { text: 'Keep warm is off. Type /keepwarm to start it again.' }
      }
      if (w) return { text: 'Keep warm is already on. Type /keepwarm off to stop it.' }
      if ((await startWarm($)) === 'none') return { text: "Nothing to keep warm yet. Keep warm works after Claude's first reply." }
      const c = await getClock($)
      const cost = c && opts.showCost ? costWords(c) : ''
      return {
        text: `Keep warm is on: one small background ping about ${span(opts.leadMs)} before the cache goes cold. Each ping spends tokens${cost ? ` (${cost})` : ''}. It stops after ${opts.maxPings} pings, ${span(opts.maxMs)}, or when you send a message. Type /keepwarm off to stop it.`,
      }
    } catch (err) {
      void log($, `/keepwarm failed: ${errText(err)}`)
      return { text: 'Keep warm hit a problem and was not changed. See the Cache Clock log.' }
    }
  })

  on('command.run', { command: 'cacheclock' }, async ($, e) => {
    try {
      const f = await refreshFlags($)
      if (f.off) return { text: OFF_TEXT }
      const arg = e.args.trim().toLowerCase()
      if (arg === 'status') return { text: `Cache Clock is ${f.hidden ? 'hidden' : 'on'}. ${await describe($)}` }
      const hide = arg === 'hide' || (arg !== 'demo' && arg !== 'auto' && arg !== 'show' && !f.hidden)
      if (arg === 'demo' || arg === 'auto') {
        // This chat only: a new chat starts with the real cache length again.
        demo = arg === 'demo'
      }
      await setHidden($, hide)
      const c = await getClock($)
      if (c) await setClock($, { ...c, ...ttl(), now: await $.clock.now() })
      if (hide) return { text: 'Cache Clock hidden in every chat. Type /cacheclock or /cacheclock show to bring it back.' }
      const t = ttl()
      return { text: `Cache Clock is on: ${lengthLabel(t)}. Type /cacheclock hide to hide it.` }
    } catch (err) {
      void log($, `/cacheclock failed: ${errText(err)}`)
      return { text: 'Cache Clock hit a problem and was not changed. See the Cache Clock log.' }
    }
  })

  on('ui.press', { plugin: 'cache-clock', element: 'keepwarm' }, async ($, e) => {
    try {
      const f = await refreshFlags($)
      if (f.off) return { element: e.element }
      if (await getWarm($)) await stopWarm($, 'Keep warm is off.')
      else if ((await startWarm($)) === 'on') toast($, `Keep warm is on: it spends tokens, and stops after ${opts.maxPings} pings or ${span(opts.maxMs)}. Type /keepwarm off to stop it.`)
    } catch (err) {
      void log($, `keep warm button failed: ${errText(err)}`)
    }
    return { element: e.element }
  })

  on('ui.press', { plugin: 'cache-clock', element: 'handoff' }, async ($, e) => {
    try {
      const f = await refreshFlags($)
      if (f.off) return { element: e.element }
      if (!(await hasHandoff($, true))) {
        toast($, `There is no /${opts.handoffCommand} command to hand off with. Start a fresh chat by hand.`)
      } else {
        void log($, `handoff asked for at ${short((await getClock($))?.tokens ?? 0)} tokens`)
        await $.command.run({ command: opts.handoffCommand, args: '' })
      }
    } catch (err) {
      void log($, `handoff failed: ${errText(err)}`)
      toast($, 'The handoff could not start. See the Cache Clock log.')
    }
    return { element: e.element }
  })

  on('ui.press', { plugin: 'cache-clock', element: 'hide' }, async ($, e) => {
    try {
      const wasWarm = (await getWarm($)) !== null
      await setHidden($, true)
      toast($, `Cache Clock hidden${wasWarm ? ' and keep warm stopped' : ''}. Type /cacheclock show to bring it back.`)
    } catch (err) {
      void log($, `hide failed: ${errText(err)}`)
    }
    return { element: e.element }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    try {
      const f = await refreshFlags($)
      if (f.off || f.hidden || working || e.props.isWorking || e.props.hasSurvey) return rest
      const c = await getClock($)
      if (!c || !c.lastEnd) return rest
      const w = await getWarm($)
      const now = c.now
      const { Box, Text, Button } = $.ui.resolve(e)
      const noop = () => undefined
      const narrow = e.props.bodyColumns < 90
      const cold = isCold(c, now)
      const price = perToken(c.model)
      const { warm: warmCost, cold: coldCost } = costOf(c.tokens, c.ttlMs, price)
      const tokens = short(c.tokens)
      const spent = w && opts.showCost && price > 0 ? usd(warmSpent(w, c.ttlMs, price)) : ''
      const left = c.lastEnd + c.ttlMs - now

      const warmButton = w ? (
        <Button key="keepwarm" label="Stop keeping warm" onPress={noop} />
      ) : (
        <Button key="keepwarm" label={cold ? 'Write it again and keep warm' : 'Keep warm'} onPress={noop} />
      )
      const hideButton = <Button key="hide" label="Hide" role="dismiss" onPress={noop} />
      const warmRow = w ? <Text color={w.cold || w.error ? BAD : COLD}>{warmLine(w, Math.max(0, left - w.leadMs), spent)}</Text> : null

      if (!cold) {
        const share = left / c.ttlMs
        const filled = Math.max(1, Math.round(share * BAR))
        const color = left <= 60_000 ? BAD : share < 0.5 ? WARN : GOOD
        const reply = !opts.showCost
          ? ''
          : price > 0
            ? ` Reply now: about ${usd(warmCost)}. If it goes cold: about ${usd(coldCost)}.`
            : ` Reply now costs about 10% of the normal input price for them; once cold, ${c.ttlMs >= ONE_HOUR ? '200%' : '125%'}.`
        const pingNote = !w && price > 0 && opts.showCost ? ` Each keep-warm ping costs about ${usd(warmCost)}.` : ''
        const info = c.tokens <= 0 ? null : <Text dimColor>{`${tokens} tokens in this chat.${reply}${pingNote}`}</Text>
        const headline = (
          <Text>
            <Text color={color}>◷ Cache warm </Text>
            <Text bold color={color}>
              {mmss(left)}
            </Text>
            <Text> </Text>
            <Text color={color}>{'━'.repeat(filled)}</Text>
            <Text dimColor>{'━'.repeat(BAR - filled)}</Text>
            <Text dimColor>{` ${lengthLabel(c)}.`}</Text>
          </Text>
        )
        return (
          <Box flexDirection="column">
            {rest}
            <Box flexDirection={narrow ? 'column' : 'row'} alignItems={narrow ? 'flex-start' : 'center'} justifyContent="space-between" gap={1}>
              {headline}
              <Box flexDirection="row" gap={1}>
                {warmButton}
                {hideButton}
              </Box>
            </Box>
            {info}
            {warmRow}
          </Box>
        )
      }

      // Cold. A big chat, or the 60 s demo, gets the handoff offer.
      const big = (opts.bigTokens > 0 && c.tokens >= opts.bigTokens) || (c.ttlSource === 'demo' && c.tokens > 0)
      const canHandoff = big && (await hasHandoff($))
      const reason = c.coldReason === 'model' ? ' because you changed model' : c.coldReason === 'compact' ? ' because the chat was compacted' : ''
      const rewrite = opts.showCost ? (price > 0 ? ` (about ${usd(coldCost)})` : ` (${c.ttlMs >= ONE_HOUR ? '200%' : '125%'} of the normal input price)`) : ''
      const what = c.coldReason === 'compact' || c.tokens === 0 ? ' The next message writes the shorter chat to the cache.' : ` Your next message re-reads ${tokens} tokens at full price${rewrite}.`
      return (
        <Box flexDirection="column">
          {rest}
          <Box flexDirection={narrow ? 'column' : 'row'} alignItems={narrow ? 'flex-start' : 'center'} justifyContent="space-between" gap={1}>
            <Text>
              <Text color={COLD}>❄ Cache cold</Text>
              <Text dimColor>{` since ${ago(coldFor(c, now))}${reason}.${what}`}</Text>
            </Text>
            <Box flexDirection="row" gap={1}>
              {canHandoff ? <Button key="handoff" label="Hand off to a fresh chat" variant="primary" onPress={noop} /> : null}
              {warmButton}
              {hideButton}
            </Box>
          </Box>
          {big && !canHandoff && c.tokens > 0 ? <Text dimColor>{`A fresh chat would skip this cost. There is no /${opts.handoffCommand} command here, so start one by hand with a short summary.`}</Text> : null}
          {warmRow}
          {c.note ? <Text dimColor>{c.note}</Text> : null}
        </Box>
      )
    } catch (err) {
      void log($, `draw failed: ${errText(err)}`)
      return rest
    }
  })
}
