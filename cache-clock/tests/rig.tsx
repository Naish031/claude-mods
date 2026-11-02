// A test rig for Cache Clock: stands in for everything beneath the mod, from memory.
// Imported by the test files only; the mod never loads it.
import { mock } from 'claude-code/testing'

export const T0 = 1_000_000
export const HOME = '/Users/test'
export const SWITCHES = `${HOME}/.claude/claude-mods/switches.json`
export const OWN = `${HOME}/.claude/claude-mods/cache-clock.json`
export const LOG = `${HOME}/.claude/claude-mods/logs/cache-clock.log`
export const SURFACES = ['desktop', 'terminal'] as const
export const PROPS = { isWorking: false, hasSurvey: false, maxRows: 10, bodyColumns: 140 } as never
export const NARROW = { isWorking: false, hasSurvey: false, maxRows: 10, bodyColumns: 60 } as never

type Cfg = {
  files?: Record<string, string>
  tokens?: number
  model?: string
  handoff?: boolean
  home?: string | null
}

export type ForkMode = 'ok' | 'cold' | 'throw' | 'api' | 'empty' | 'nothing' | 'hang' | 'aborted'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function rig($: any, on: any, cfg: Cfg = {}) {
  const w = {
    files: { ...(cfg.files ?? {}) } as Record<string, string>,
    toasts: [] as string[],
    forks: [] as string[],
    ran: [] as string[],
    procs: [] as string[][],
    fsCalls: [] as string[],
    ctx: cfg.tokens ?? 182_000,
    model: cfg.model ?? 'claude-sonnet-4-5',
    handoff: cfg.handoff ?? false,
    forkMode: 'ok' as ForkMode,
    sessionUsageFails: false,
    fsBroken: false,
    registerFails: false,
    listFails: false,
    appended: [] as string[],
    clock: undefined as unknown as ReturnType<typeof mock.clock>,
  }
  if (cfg.home !== null) mock.env(on, { HOME: cfg.home ?? HOME })
  else mock.env(on, {})
  w.clock = mock.clock(on, { now: T0 })

  on('session.start', async (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', async (_: any, e: any) => ({ sessionId: e.sessionId }))
  on('turn.start', async () => ({ turnId: 't' }))
  on('turn.complete', async () => ({ text: '' }))
  on('command.register', async () => {
    if (w.registerFails) throw new Error('no commands')
    return { value: undefined }
  })
  on('session.id', async () => ({ value: 'sid-1234567890' }))
  on('session.model', async () => ({ value: w.model }))
  on('session.usage', async () => {
    if (w.sessionUsageFails) throw new Error('usage unavailable')
    return { value: { startedAt: T0, rateLimits: [], context: { tokens: w.ctx, window: 1_000_000 } } }
  })
  on('fs.exists', async (_: any, e: any) => {
    w.fsCalls.push(e.path)
    if (w.fsBroken) throw new Error('disk gone')
    return { value: e.path in w.files }
  })
  on('fs.read', async (_: any, e: any) => {
    w.fsCalls.push(e.path)
    if (w.fsBroken) throw new Error('disk gone')
    if (!(e.path in w.files)) throw new Error('ENOENT')
    return { value: w.files[e.path] }
  })
  on('fs.write', async (_: any, e: any) => {
    if (w.fsBroken) throw new Error('disk gone')
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.stat', async (_: any, e: any) => {
    if (!(e.path in w.files)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: w.files[e.path]!.length, mtimeMs: 0, isLink: false } }
  })
  on('process.run', async (_: any, e: any) => {
    const argv = e.argv as string[]
    w.procs.push(argv)
    if (argv[0] === 'tail') return { value: { exitCode: 0, stdout: (w.files[argv[3]!] ?? '').slice(-Number(argv[2])), stderr: '' } }
    return { value: { exitCode: 1, stdout: '', stderr: 'no' } }
  })
  on('ui.toast', async (_: any, e: any) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.list', async () => {
    if (w.listFails) throw new Error('no list')
    return {
      value: w.handoff ? [{ name: 'handoff', description: 'Hand off', source: 'plugin', plugin: 'handoff' }] : [{ name: 'compact', description: '', source: 'builtin' }],
    }
  })
  on('command.run', async (_: any, e: any) => {
    w.ran.push(`${e.command} ${e.args}`.trim())
    return { text: 'ran' }
  })
  on('prompt.submit', async (_: any, e: any) => ({ text: e.text }))
  on('classic.SessionStart', async () => ({}))
  on('classic.Stop', async () => ({}))
  on('classic.PostModelSwitch', async () => ({}))
  on('session.compact', async () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
  on('model.fork', async (_: any, e: any) => {
    w.forks.push(e.prompt)
    const hit = { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: w.ctx, cache_creation_input_tokens: 0 }
    const miss = { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: w.ctx }
    const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    switch (w.forkMode) {
      case 'throw':
        throw new Error('network down')
      case 'api':
        return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: zero } }
      case 'empty':
        return { value: { isAnswered: false, reason: 'empty-reply', usage: hit } }
      case 'nothing':
        return { value: { isAnswered: false, reason: 'nothing-to-fork' } }
      case 'aborted':
        return { value: { isAnswered: false, reason: 'aborted', usage: zero } }
      case 'hang':
        await w.clock.sleep(10 * 60_000)
        return { value: { isAnswered: true, text: 'ok', usage: hit } }
      case 'cold':
        return { value: { isAnswered: true, text: 'ok', usage: miss } }
      default:
        return { value: { isAnswered: true, text: 'ok', usage: hit } }
    }
  })
  // The engine's own AbovePrompt band: something to draw above the clock.
  on('ui.render', { component: 'AbovePrompt' }, async (hook$: any, e: any) => {
    const { Text } = hook$.ui.resolve(e)
    return <Text>REST</Text>
  })

  const start = (surface: 'desktop' | 'terminal') => $.session.start({ source: 'startup', cwd: '/Users/test/vault', surface, isInteractive: true })
  /** A main-chat reply ends. read and wrote are what the reply's requests used. */
  const reply = async (read = w.ctx, wrote = 0, extra: Record<string, unknown> = {}) => {
    await $.turn.complete({ answer: '', reason: 'answer', durationMs: 1000, isAborted: false, turnId: 't', usage: { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: read, cache_creation_input_tokens: wrote, model: w.model }, ...extra })
    await w.clock.settle()
  }
  const turnStart = () => $.turn.start({ text: 'go', turnId: 't' })
  const mount = (surface: 'desktop' | 'terminal', props: unknown = PROPS) => $.ui.mount({ plugin: 'cache-clock', surface, component: 'AbovePrompt', props })
  const said = async (command: string, args = '') => JSON.stringify(await $.command.run({ command, args }))
  const log = () => w.files[LOG] ?? ''
  return { ...w, w, start, reply, turnStart, mount, said, log }
}

/** One line of a chat log, as the API's usage block spells it. */
export const row = (ttl: '5m' | '1h' | 'none', extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    message: { usage: { cache_creation: { ephemeral_1h_input_tokens: ttl === '1h' ? 1200 : 0, ephemeral_5m_input_tokens: ttl === '5m' ? 1200 : 0 } } },
    ...extra,
  })
