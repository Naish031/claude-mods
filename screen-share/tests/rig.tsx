// A test rig for Screen Share: stands in for everything beneath the mod, from memory.
// Imported by the test files only; the mod never loads it.
import { mock } from 'claude-code/testing'

export const T0 = 1_000_000
export const HOME = '/Users/test'
export const DIR = `${HOME}/.claude/claude-mods`
export const SWITCHES = `${DIR}/switches.json`
export const WORDS = `${DIR}/screen-share.json`
export const LOG = `${DIR}/logs/screen-share.log`
export const SURFACES = ['desktop', 'terminal'] as const
export const BAND = { isWorking: false, hasSurvey: false, maxRows: 20, bodyColumns: 100 } as never

export const EMAIL = 'jane.doe@acme.com'
export const PHONE = '+44 7700 900123'
export const MONEY = '$4,250.00'
/** One line holding every kind the mod hides, and four things it must leave alone (2026, 182k, v2.1.309, 12 files). */
export const PRIVATE = `Mail ${EMAIL} or call ${PHONE}. The deal is ${MONEY} for 2026, we used 182k tokens on v2.1.309 across 12 files.`

type Cfg = { files?: Record<string, string>; store?: Record<string, unknown>; home?: string }

/* eslint-disable @typescript-eslint/no-explicit-any */
export function rig($: any, on: any, cfg: Cfg = {}) {
  const w = {
    files: { ...(cfg.files ?? {}) } as Record<string, string>,
    statuses: [] as Array<string | undefined>,
    toasts: [] as string[],
    logs: [] as string[],
    notices: [] as Array<string | undefined>,
    notifies: [] as string[],
    invalidated: [] as string[],
    suggestions: [] as string[],
    procs: [] as string[][],
    stored: {} as Record<string, unknown>,
    spec: {} as { name?: string; immediate?: boolean; argumentHint?: string },
    seen: {} as Record<string, any>,
    fsBroken: false,
    clock: undefined as unknown as ReturnType<typeof mock.clock>,
  }
  mock.env(on, { HOME: cfg.home ?? HOME })
  // The store, from memory, keeping what was written so a test can read it back.
  const kept: Record<string, unknown> = { ...(cfg.store ?? {}) }
  on('store.get', async (_: any, e: any) => ({ value: kept[e.key] }))
  on('store.set', async (_: any, e: any) => {
    kept[e.key] = e.value
    w.stored[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', async (_: any, e: any) => {
    delete kept[e.key]
    delete w.stored[e.key]
    return { value: undefined }
  })
  on('store.keys', async () => ({ value: Object.keys(kept) }))
  w.clock = mock.clock(on, { now: T0 })

  on('session.start', async (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', async (_: any, e: any) => {
    w.spec = e
    return { value: undefined }
  })
  on('fs.exists', async (_: any, e: any) => {
    if (w.fsBroken) throw new Error('disk gone')
    return { value: e.path in w.files }
  })
  on('fs.read', async (_: any, e: any) => {
    if (w.fsBroken) throw new Error('disk gone')
    if (!(e.path in w.files)) throw new Error('ENOENT')
    return { value: w.files[e.path] }
  })
  on('fs.write', async (_: any, e: any) => {
    if (w.fsBroken) throw new Error('disk gone')
    w.files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', async (_: any, e: any) => {
    w.procs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.status', async (_: any, e: any) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async (_: any, e: any) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', async (_: any, e: any) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.notice', async (_: any, e: any) => {
    w.notices.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', async (_: any, e: any) => {
    w.notifies.push(`${e.title ?? ''}|${e.text}`)
    return { value: { isSent: true, channel: 'test' } }
  })
  on('ui.invalidate', async (_: any, e: any) => {
    w.invalidated.push(String(e.event))
    return { value: undefined }
  })
  on('prompt.suggest', async (_: any, e: any) => {
    w.suggestions.push(e.text)
    return { isShown: true }
  })

  // Beneath the mod these stand for the engine's own components: they record the props that reached
  // them and draw the text, so what a test reads is what the engine would have been asked to draw.
  const text = (name: string, pick: (p: any) => unknown = p => p.text) =>
    on('ui.render', { component: name }, async (_: any, e: any) => {
      w.seen[name] = e.props
      const { Text } = _.ui.resolve(e)
      const t = pick(e.props)
      return <Text>{typeof t === 'string' ? t : 'row'}</Text>
    })
  text('AssistantMessage')
  text('UserMessage')
  text('CommandOutput')
  text('ToolUse', () => 'tool row')
  text('ToolResult', () => 'tool result')
  text('ToolGroup', () => 'group line')
  text('Spinner', p => `${p.word} ${p.message ?? ''}`)
  text('InfoNotice')
  on('ui.render', { component: 'AbovePrompt' }, async (_: any, e: any) => {
    const { Text } = _.ui.resolve(e)
    return <Text>{w.seen.otherBand ?? 'REST'}</Text>
  })
  on('ui.render', { component: 'SessionMode' }, async (_: any, e: any) => {
    w.seen.SessionMode = e.props
    const { Text } = _.ui.resolve(e)
    return <Text>{e.props.modes.join(' & ')}</Text>
  })
  on('ui.render', { component: 'Pane' }, async (_: any, e: any) => {
    const { Box, Text, Button } = _.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text>{w.seen.paneText ?? 'pane'}</Text>
        <Button key="pane-go" label="Go" onPress={() => undefined} />
      </Box>
    )
  })

  const r = {
    w,
    async start(surface: string) {
      await $.session.start({ source: 'startup', cwd: '/Users/test/vault', surface, isInteractive: true } as never)
      await w.clock.settle()
    },
    async cmd(args = '') {
      const res = await $.command.run({ command: 'screen-share', args } as never)
      await w.clock.settle()
      return String((res as { text?: string }).text)
    },
    mount: (surface: string, component: string, props: unknown, requestId?: string) =>
      $.ui.mount({ plugin: 'screen-share', surface, component, props, ...(requestId ? { requestId } : {}) } as never),
    log: () => w.files[LOG] ?? '',
  }
  return r
}
