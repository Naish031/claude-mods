import { expect, mock, test } from 'claude-code/testing'

/** The `on` a test body is handed. */
type On = Parameters<NonNullable<Parameters<typeof test>[2]>>[1]
type Files = Record<string, string>
type Surface = 'desktop' | 'terminal'
type View = {
  find: (q: object) => Promise<any>
  findAll: (q: object) => Promise<any[]>
  press: (q: { key: string }) => Promise<unknown>
  input: (q: { key: string; text: string; kind?: 'change' | 'submit' }) => Promise<unknown>
  unmount: () => Promise<unknown>
}

const HOME = '/Users/test'
const MODS = `${HOME}/.claude/claude-mods`
const SWITCHES = `${MODS}/switches.json`
const LOG = `${MODS}/logs/mods.log`
const CLAUDE_MODS = `${HOME}/Documents/Claude/claude-mods-publish`
const SID = 'sess1'
const SURFACES = ['desktop', 'terminal'] as const

type Faults = {
  /** fs.write to a path matching this throws. */
  write?: RegExp
  /** fs.read of a path matching this throws. */
  read?: RegExp
  /** fs.write to a path matching this stores cut-off text, as a full disk would. */
  garble?: RegExp
  /** `mv` exits 1 and moves nothing. */
  mv?: boolean
  /** fs.list always throws. */
  list?: boolean
  /** command.list, config.list and settings.read throw. */
  engine?: boolean
  /** ui.open throws. */
  open?: boolean
  /** No HOME in the environment. */
  noHome?: boolean
}

type Rig = {
  opened: string[]
  ran: { command: string; args?: string }[]
  procs: string[][]
  clock: ReturnType<typeof mock.clock>
  files: Files
  mtimes: Record<string, number>
  commands: { name: string; plugin: string }[]
  panes: { id: string }[]
  enabled: Record<string, boolean>
  env: Record<string, string>
}

/** Answers every `$` call the mod makes, so a test sees only the mod. `files` stands in for the disk. */
function rig(on: On, files: Files, faults: Faults = {}, extra: Partial<Pick<Rig, 'commands' | 'enabled' | 'env'>> = {}): Rig {
  const r: Rig = {
    opened: [],
    ran: [],
    procs: [],
    files,
    mtimes: {},
    commands: [...(extra.commands ?? [])],
    panes: [],
    enabled: extra.enabled ?? {},
    env: extra.env ?? {},
    clock: undefined as never,
  }
  on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
  on('session.id', async () => ({ value: SID }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  r.clock = mock.clock(on, { now: Date.UTC(2026, 10, 1, 12, 0, 0) })
  mock.env(on, faults.noHome ? r.env : { HOME, ...r.env })
  on('ui.open', async (_$, e) => {
    if (faults.open) throw new Error('no room')
    const id = (e as { id: string }).id
    r.opened.push(id)
    if (!r.panes.some(p => p.id === id)) r.panes.push({ id })
    return { value: { isPlaced: true } } as never
  })
  on('ui.panes', async () => ({ value: r.panes.map(p => ({ ...p, title: p.id, isShown: true, isFocused: false, isPlaced: true })) }) as never)
  on('command.list', async () => {
    if (faults.engine) throw new Error('no list')
    return { value: r.commands.map(c => ({ ...c, description: '', source: 'plugin' })) } as never
  })
  on('command.run', async (_$, e) => {
    r.ran.push({ command: (e as { command: string }).command, args: (e as { args?: string }).args })
    return { text: 'ok' } as never
  })
  on('config.list', async () => {
    if (faults.engine) throw new Error('no rows')
    return { value: [] } as never
  })
  on('settings.read', async () => {
    if (faults.engine) throw new Error('no settings')
    return { value: { enabledPlugins: r.enabled } } as never
  })
  on('fs.exists', async (_$, e) => {
    const path = (e as { path: string }).path
    return { value: path in files || Object.keys(files).some(k => k.startsWith(`${path}/`)) } as never
  })
  on('fs.read', async (_$, e) => {
    const path = (e as { path: string }).path
    if (faults.read?.test(path)) throw new Error('EACCES')
    if (!(path in files)) throw new Error(`ENOENT ${path}`)
    return { value: files[path] } as never
  })
  on('fs.write', async (_$, e) => {
    const { path, text } = e as { path: string; text: string }
    if (faults.write?.test(path)) throw new Error('disk full')
    files[path] = faults.garble?.test(path) ? text.slice(0, Math.floor(text.length / 2)) : text
    r.mtimes[path] = r.clock.now()
    return { value: undefined } as never
  })
  on('fs.list', async (_$, e) => {
    if (faults.list) throw new Error('list failed')
    const path = ((e as { path?: string }).path ?? '').replace(/\/+$/, '')
    const prefix = `${path}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const k of Object.keys(files)) {
      if (!k.startsWith(prefix)) continue
      const rest = k.slice(prefix.length)
      const name = rest.split('/')[0] ?? ''
      names.set(name, rest.includes('/') ? 'dir' : names.get(name) === 'dir' ? 'dir' : 'file')
    }
    if (!names.size) throw new Error(`ENOENT ${path}`)
    return {
      value: [...names].map(([name, kind]) => ({
        name,
        kind,
        size: kind === 'file' ? (files[`${prefix}${name}`] ?? '').length : 0,
        mtimeMs: kind === 'file' ? (r.mtimes[`${prefix}${name}`] ?? r.clock.now()) : 0,
        isLink: false,
      })),
    } as never
  })
  on('process.run', async (_$, e) => {
    const argv = (e as { argv?: string[] }).argv ?? []
    r.procs.push(argv)
    if (argv[0] === 'rm') delete files[argv[argv.length - 1]!]
    if (argv[0] === 'mv') {
      if (faults.mv) return { value: { exitCode: 1, stdout: '', stderr: 'mv: busy' } } as never
      const from = argv[argv.length - 2]!
      const to = argv[argv.length - 1]!
      files[to] = files[from] ?? ''
      delete files[from]
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  return r
}

/** Adds a mod folder to the fake disk. */
function addMod(files: Files, dir: string, o: { name: string; source?: string; description?: string; version?: string; mod?: object; hooks?: string; plugin?: object }) {
  files[`${dir}/.claude-plugin/plugin.json`] = JSON.stringify({ name: o.name, version: o.version ?? '0.1.0', description: o.description ?? `${o.name} does one thing.`, ...(o.plugin ?? {}) })
  files[`${dir}/hooks/hooks.json`] = o.hooks ?? '{"modules":["./register.tsx"]}'
  files[`${dir}/hooks/register.tsx`] = o.source ?? ''
  if (o.mod) files[`${dir}/mod.json`] = JSON.stringify(o.mod)
}

const SW = "const f = `${home}/.claude/claude-mods/switches.json`\n"

/** A fake machine in the shape of Naish's: the claude-mods folder, his other homes for mods, a marketplace install. */
function disk(): Files {
  const f: Files = {}
  addMod(f, `${CLAUDE_MODS}/helper-desk`, {
    name: 'helper-desk',
    description: 'A purple task bar above the prompt. And a side pane.',
    source: `${SW}const k = \`\${NAME}:hidden\`\nconst o = \`\${m}/.open-helper-desk-\${sid}\`\nawait $.command.register({ name: 'helpers', description: 'x' })\nawait $.ui.open({ id: 'helpers' })\non('ui.render', { component: 'Pane', requestId: 'helpers' }, x)`,
  })
  addMod(f, `${CLAUDE_MODS}/chat-inventory`, {
    name: 'chat-inventory',
    source: "await $.command.register({ name: 'inventory', description: 'x' })",
    mod: { pane: 'inventory', hide: true, switch: true, title: 'Chat Inventory' },
  })
  addMod(f, `${CLAUDE_MODS}/cache-clock`, { name: 'cache-clock', source: `${SW}const k = \`\${NAME}:hidden\`\nawait $.command.register({ name: 'cacheclock' })` })
  addMod(f, `${CLAUDE_MODS}/brain-dump`, { name: 'brain-dump', source: `${SW}await $.command.register({ name: 'braindump' })` })
  addMod(f, `${CLAUDE_MODS}/handoff`, { name: 'handoff', source: `${SW}const k = \`\${NAME}:hidden\`\nconst o = \`\${home}/.claude/claude-mods/.open-handoff-\${sid}\`` })
  // The switchboard's own folder, read from disk like any other: its code draws a pane and mentions ":hidden", yet it gets no Open or Shown button.
  addMod(f, `${CLAUDE_MODS}/mods`, {
    name: 'mods',
    description: 'The switchboard for your mods.',
    source: `${SW}const k = \`\${name}:hidden\`\nawait $.command.register({ name: 'mods' })\nawait $.ui.open({ id: 'mods' })\non('ui.render', { component: 'Pane', requestId: 'mods' }, x)`,
  })
  addMod(f, `${CLAUDE_MODS}/foreign-tool`, { name: 'foreign-tool', description: "Somebody else's mod that has no switch.", source: "await $.command.register({ name: 'foreign' })" })
  f[`${CLAUDE_MODS}/not-a-mod/.claude-plugin/plugin.json`] = JSON.stringify({ name: 'not-a-mod' })
  f[`${CLAUDE_MODS}/not-a-mod/hooks/hooks.json`] = '{"hooks":{}}'
  f[`${CLAUDE_MODS}/README.md`] = 'not a folder'
  addMod(f, '/opt/extra/alpha-env', { name: 'alpha-env', description: 'Found through the environment list.', source: SW })
  addMod(f, `${HOME}/.claude/mods/zeta-notes`, { name: 'zeta-notes', description: 'Keeps short notes beside the chat.', source: `${SW}await $.command.register({ name: 'zeta' })` })
  addMod(f, `${HOME}/.claude/dev-mods/${SID}/brand-new`, { name: 'brand-new', description: 'Made in this chat.', source: SW })
  addMod(f, `${HOME}/.claude/dev-mods/other-sid/old-chat-mod`, { name: 'old-chat-mod', description: 'Made in another chat.', source: SW })
  addMod(f, `${HOME}/.claude/plugins/cache/anthropic/replay-theater/0.1.0`, { name: 'replay-theater', description: 'Replays each edit.', version: '0.1.0', source: "await $.command.register({ name: 'replay' })" })
  addMod(f, `${HOME}/.claude/plugins/cache/anthropic/disabled-one/1.0.0`, { name: 'disabled-one', description: 'Turned off in Claude Code.', version: '1.0.0' })
  addMod(f, `${HOME}/.claude/plugins/cache/anthropic/quiet-one/2.0.0`, { name: 'quiet-one', description: 'Installed, draws nothing yet.', version: '2.0.0' })
  f[`${HOME}/.claude/plugins/installed_plugins.json`] = JSON.stringify({
    version: 2,
    plugins: {
      'replay-theater@anthropic': [{ scope: 'user', installPath: `${HOME}/.claude/plugins/cache/anthropic/replay-theater/0.1.0`, version: '0.1.0' }],
      'disabled-one@anthropic': [{ scope: 'user', installPath: `${HOME}/.claude/plugins/cache/anthropic/disabled-one/1.0.0`, version: '1.0.0' }],
      'quiet-one@anthropic': [{ scope: 'user', installPath: `${HOME}/.claude/plugins/cache/anthropic/quiet-one/2.0.0`, version: '2.0.0' }],
    },
  })
  return f
}

const COMMANDS = [
  { name: 'helpers', plugin: 'helper-desk' },
  { name: 'inventory', plugin: 'chat-inventory' },
  { name: 'cacheclock', plugin: 'cache-clock' },
  { name: 'braindump', plugin: 'brain-dump' },
  { name: 'foreign', plugin: 'foreign-tool' },
  { name: 'replay', plugin: 'replay-theater@anthropic' },
]

const props = (bodyColumns = 100) => ({ title: 'Mods', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }) as never
const start = ($: any, surface: Surface) => $.session.start({ source: 'startup', cwd: '/Users/test/vault', surface, isInteractive: true } as never)
const pane = ($: any, surface: Surface, cols = 100): Promise<View> => $.ui.mount({ plugin: 'mods', surface, component: 'Pane', requestId: 'mods', props: props(cols) })
const runMods = async ($: any, args = '') => (await $.command.run({ command: 'mods', args } as never)) as { text?: string }
const sw = (files: Files) => JSON.parse(files[SWITCHES] ?? '{}') as Record<string, unknown>
const rowOrder = async (v: View) =>
  (await v.findAll({ type: 'Box' }))
    .map(b => b.key ?? '')
    .filter((k: string) => k.startsWith('row-'))
    .map((k: string) => k.slice(4))
const logText = (files: Files) => files[LOG] ?? ''

for (const surface of SURFACES) {
  test(`/mods opens the pane and lists every mod it finds (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    const r = rig(on, files, {}, { commands: COMMANDS, env: { CLAUDE_CODE_PLUGIN_DIRS: '~/nowhere:/opt/extra/alpha-env/' }, enabled: { 'disabled-one@anthropic': false, 'replay-theater@anthropic': true } })
    await start($, surface)
    const res = await runMods($)
    await r.clock.settle()
    expect(r.opened, '/mods opens the pane').toContain('mods')
    expect(res.text).toBe('Opened the Mods pane.')

    const v = await pane($, surface)
    // Where each one comes from: the claude-mods folder, the env list, the older folder, installs, this chat, other chats.
    for (const title of ['Helper Desk', 'Chat Inventory', 'Cache Clock', 'Brain Dump', 'Handoff', 'Foreign Tool', 'Alpha Env', 'Zeta Notes', 'Replay Theater', 'Disabled One', 'Brand New', 'Old Chat Mod', 'Quiet One', 'Mods (this switchboard)']) {
      expect(await v.find({ text: title }), `${title} is listed`).toBeDefined()
    }
    expect(await v.find({ text: 'Not A Mod' }), 'no modules key, not a mod').toBeUndefined()
    expect(await v.find({ text: 'README' }), 'a file is not a mod').toBeUndefined()
    expect(await rowOrder(v), 'groups: yours, marketplaces, this chat, other chats; A to Z inside').toEqual([
      'alpha-env',
      'brain-dump',
      'cache-clock',
      'chat-inventory',
      'foreign-tool',
      'handoff',
      'helper-desk',
      'mods',
      'zeta-notes',
      'disabled-one',
      'quiet-one',
      'replay-theater',
      'brand-new',
      'old-chat-mod',
    ])
    for (const heading of ['Your mods', 'From marketplaces', 'This chat only', 'Made in other chats']) expect(await v.find({ text: heading }), heading).toBeDefined()

    // What each row says about itself.
    expect(await v.find({ text: 'A purple task bar above the prompt.' }), 'first sentence of the description').toBeDefined()
    expect(await v.find({ text: 'And a side pane.' }), 'only the first sentence').toBeUndefined()
    expect(await v.find({ text: '/helpers' }), 'its slash command').toBeDefined()
    expect(await v.find({ text: 'v0.1.0 · Loaded' }), 'loaded: it has a command in the engine list').toBeDefined()
    expect(await v.find({ text: 'v2.0.0 · Installed, not seen loaded' }), 'a marketplace install with no sign of running').toBeDefined()
    expect(await v.find({ text: 'v1.0.0 · Disabled in Claude Code' }), 'turned off in Claude Code settings').toBeDefined()
    expect(await v.find({ text: 'v0.1.0 · On disk, not installed' }), 'in a folder only').toBeDefined()
    expect(await v.find({ text: /Turned off in Claude Code's plugin settings/ }), 'says how to enable it').toBeDefined()
    expect(await v.find({ text: /Not installed\. The switch is saved/ })).toBeDefined()
    // The footer and the counts.
    expect(await v.find({ text: /Off means off in every chat\. Hidden keeps it on but out of sight\./ }), 'footer').toBeDefined()
    expect(await v.find({ text: 'New mods appear here by themselves.' }), 'footer line on new mods').toBeDefined()
    expect(await v.find({ text: /14 mods found · 14 on · 0 off/ }), 'counts follow the switches').toBeDefined()
    await v.unmount()
  })
}

for (const surface of SURFACES) {
  test(`On/Off writes the shared file and keeps every other key (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    files[SWITCHES] = JSON.stringify({ 'other-tool': false, nested: { a: [1, 2] }, 'helper-desk:hidden': true })
    const r = rig(on, files, {}, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)

    await v.press({ key: 'toggle-cache-clock' })
    expect(sw(files), 'cache-clock off, nothing else lost').toEqual({ 'other-tool': false, nested: { a: [1, 2] }, 'helper-desk:hidden': true, 'cache-clock': false })
    expect(files[SWITCHES]!.endsWith('\n'), 'valid JSON with a final newline').toBe(true)
    expect(Object.keys(files).filter(k => k.includes('.tmp-')), 'no temporary file left').toEqual([])
    expect(r.procs.some(p => p[0] === 'mv'), 'the new file was renamed into place').toBe(true)
    expect(await v.find({ text: 'Cache Clock is off in every chat.' }), 'note after the press').toBeDefined()
    expect((await v.find({ key: 'toggle-cache-clock' }))?.text, 'the button says Off').toBe('Off')
    expect(await v.find({ key: 'show-cache-clock' }), 'no Shown/Hidden while off').toBeUndefined()
    expect(await v.find({ text: /1 off/ }), 'the count follows').toBeDefined()

    await v.press({ key: 'toggle-cache-clock' })
    expect(sw(files), 'on again: the key is removed').toEqual({ 'other-tool': false, nested: { a: [1, 2] }, 'helper-desk:hidden': true })
    expect((await v.find({ key: 'toggle-cache-clock' }))?.text).toBe('On')

    // A mod found in an odd place switches like any other.
    await v.press({ key: 'toggle-zeta-notes' })
    expect(sw(files)['zeta-notes']).toBe(false)
    expect(await v.find({ text: 'Zeta Notes is off in every chat.' })).toBeDefined()
    await v.unmount()
  })
}

for (const surface of SURFACES) {
  test(`Shown/Hidden flips the hidden key, and Show opens the pane (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    const r = rig(on, files, {}, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)

    expect(await v.find({ key: 'show-brain-dump' }), 'brain-dump has no hidden key in its code').toBeUndefined()
    expect(await v.find({ key: 'show-chat-inventory' }), 'mod.json says chat-inventory can hide').toBeDefined()
    expect(await v.find({ key: 'show-foreign-tool' }), 'a mod with no switch cannot hide').toBeUndefined()
    expect(await v.find({ key: 'show-mods' }), 'the switchboard has nothing to hide').toBeUndefined()

    await v.press({ key: 'show-helper-desk' })
    expect(sw(files)).toEqual({ 'helper-desk:hidden': true })
    expect(await v.find({ text: 'Helper Desk is hidden in every chat.' })).toBeDefined()
    expect(r.ran, 'Hide asks for nothing').toEqual([])
    expect(await v.find({ key: 'open-helper-desk' }), 'no Open while hidden').toBeUndefined()

    await v.press({ key: 'show-helper-desk' })
    expect(sw(files), 'shown: the key is removed').toEqual({})
    expect(await v.find({ text: 'Helper Desk is shown in every chat.' })).toBeDefined()
    expect(r.ran, 'Show runs the mod\'s own pane command').toEqual([{ command: 'helpers', args: '' }])

    // A band mod that polls for a request file gets one; it has no pane to Open.
    await v.press({ key: 'show-handoff' })
    expect(Object.keys(files).filter(k => k.includes('.open-handoff')), 'no request on Hide').toEqual([])
    await v.press({ key: 'show-handoff' })
    expect(files[`${MODS}/.open-handoff-${SID}`], 'request file is empty and has the session id').toBe('')
    expect(await v.find({ key: 'open-handoff' }), 'handoff draws no pane, so no Open button').toBeUndefined()

    // Off: Shown/Hidden and Open are not buttons any more.
    await v.press({ key: 'toggle-helper-desk' })
    expect(await v.find({ key: 'show-helper-desk' })).toBeUndefined()
    expect(await v.find({ key: 'open-helper-desk' })).toBeUndefined()
    expect(sw(files)).toEqual({ 'helper-desk': false })
    await v.unmount()
  })
}

for (const surface of SURFACES) {
  test(`Open runs the mod's pane command, or says why it cannot (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    const r = rig(on, files, {}, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)

    for (const name of ['helper-desk', 'chat-inventory']) expect(await v.find({ key: `open-${name}` }), `Open on ${name}`).toBeDefined()
    for (const name of ['cache-clock', 'brain-dump', 'foreign-tool', 'mods']) expect(await v.find({ key: `open-${name}` }), `no Open on ${name}`).toBeUndefined()

    await v.press({ key: 'open-helper-desk' })
    await v.press({ key: 'open-chat-inventory' })
    expect(r.ran, 'the command found in the code, and the one named in mod.json').toEqual([
      { command: 'helpers', args: '' },
      { command: 'inventory', args: '' },
    ])
    expect(await v.find({ text: 'Asked Chat Inventory to open.' })).toBeDefined()
    expect(Object.keys(files), 'a command needs no request file').not.toContain(`${MODS}/.open-helper-desk-${SID}`)

    // The command is not in this chat: nothing runs and the note says so.
    r.commands.splice(0, r.commands.length, ...COMMANDS.filter(c => c.name !== 'helpers'))
    await v.press({ key: 'open-helper-desk' })
    expect(r.ran.length, 'nothing more ran').toBe(2)
    expect(await v.find({ text: /Could not open Helper Desk: \/helpers is not loaded in this chat/ })).toBeDefined()
    expect(logText(files)).toContain('open helper-desk failed')

    // Hidden or off: not pressable.
    await v.press({ key: 'show-chat-inventory' })
    expect(await v.find({ key: 'open-chat-inventory' }), 'no Open while hidden').toBeUndefined()
    await v.unmount()
  })
}

for (const surface of SURFACES) {
  test(`a mod that polls for a request file gets one to Open (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    // A pane mod that has no command to run, only the request file.
    addMod(files, `${CLAUDE_MODS}/side-pane`, {
      name: 'side-pane',
      source: `${SW}const o = \`\${m}/.open-side-pane-\${sid}\`\nawait $.ui.open({ id: 'p' })\non('ui.render', { component: 'Pane', requestId: 'p' }, x)`,
    })
    rig(on, files, {}, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)
    await v.press({ key: 'open-side-pane' })
    expect(files[`${MODS}/.open-side-pane-${SID}`], 'empty request file for this chat').toBe('')
    expect(await v.find({ text: 'Side Pane opens in this chat within 3 seconds.' })).toBeDefined()
    await v.unmount()
  })
}

for (const surface of SURFACES) {
  test(`the file is written safely: missing, empty, damaged, unreadable, full disk (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    // Missing file: created with the folder, nothing else.
    {
      const files = disk()
      rig(on, files, {}, { commands: COMMANDS })
      await start($, surface)
      await runMods($)
      const v = await pane($, surface)
      await v.press({ key: 'toggle-cache-clock' })
      expect(files[SWITCHES]).toBe('{\n  "cache-clock": false\n}\n')
      expect(Object.keys(files).some(k => k.includes('.bad-')), 'nothing to save a copy of').toBe(false)
      await v.unmount()
    }
  })

  test(`a damaged switches.json is saved aside before a new one is started (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    files[SWITCHES] = '{ "brain-dump": false, oops'
    rig(on, files, {}, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)
    expect(await v.find({ text: /switches\.json is damaged/ }), 'the pane warns before any press').toBeDefined()
    await v.press({ key: 'toggle-cache-clock' })
    const copy = Object.keys(files).find(k => k.includes('.bad-')) ?? ''
    expect(files[copy], 'the original text is kept').toBe('{ "brain-dump": false, oops')
    expect(sw(files), 'a new, valid file').toEqual({ 'cache-clock': false })
    expect(await v.find({ text: /switches\.json was damaged: a copy is saved as switches\.json\.bad-/ })).toBeDefined()
    expect(logText(files)).toContain('saved a copy')
    await v.unmount()
  })

  test(`an empty file, or JSON that is not an object, is handled (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    files[SWITCHES] = '   \n'
    rig(on, files, {}, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)
    expect(await v.find({ text: /is damaged/ }), 'an empty file is not damage').toBeUndefined()
    await v.press({ key: 'toggle-cache-clock' })
    expect(sw(files)).toEqual({ 'cache-clock': false })
    expect(Object.keys(files).some(k => k.includes('.bad-'))).toBe(false)

    files[SWITCHES] = '["brain-dump"]'
    await v.press({ key: 'toggle-brain-dump' })
    expect(Object.keys(files).some(k => k.includes('.bad-')), 'an array is saved aside').toBe(true)
    expect(sw(files)).toEqual({ 'brain-dump': false })
    await v.unmount()
  })

  test(`an unreadable file is never overwritten (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    files[SWITCHES] = JSON.stringify({ precious: true })
    rig(on, files, { read: /switches\.json$/ }, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)
    expect(await v.find({ text: /Cannot read switches\.json/ })).toBeDefined()
    await v.press({ key: 'toggle-cache-clock' })
    expect(files[SWITCHES], 'untouched').toBe(JSON.stringify({ precious: true }))
    expect(await v.find({ text: /Could not change Cache Clock/ }), 'says so').toBeDefined()
    expect(logText(files)).toContain('toggle cache-clock failed')
    await v.unmount()
  })

  test(`a full disk leaves the old file as it was (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    files[SWITCHES] = JSON.stringify({ keep: 1 })
    rig(on, files, { write: /switches\.json\.tmp/ }, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)
    await v.press({ key: 'toggle-cache-clock' })
    expect(files[SWITCHES]).toBe(JSON.stringify({ keep: 1 }))
    expect(await v.find({ text: /Could not change Cache Clock/ })).toBeDefined()
    expect(await v.find({ key: 'undo' }), 'nothing to undo after a failed change').toBeUndefined()
    await v.unmount()
  })

  test(`a write that does not read back is reported (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    rig(on, files, { garble: /switches\.json$/, mv: true }, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)
    await v.press({ key: 'toggle-cache-clock' })
    expect(await v.find({ text: /Could not change Cache Clock/ }), 'the read-back check caught it').toBeDefined()
    expect(logText(files)).toContain('did not read back')
    await v.unmount()
  })

  test(`when the rename fails the file is written in place and the temporary file goes (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    rig(on, files, { mv: true }, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)
    await v.press({ key: 'toggle-cache-clock' })
    expect(sw(files)).toEqual({ 'cache-clock': false })
    expect(Object.keys(files).filter(k => k.includes('.tmp-'))).toEqual([])
    await v.unmount()
  })
}

for (const surface of SURFACES) {
  test(`the switchboard asks twice before it turns itself off, and the way back is in the pane (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    rig(on, files, {}, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)
    expect(await v.find({ text: 'Mods (this switchboard)' })).toBeDefined()
    expect((await v.find({ key: 'toggle-mods' }))?.text).toBe('On')

    await v.press({ key: 'toggle-mods' })
    expect(files[SWITCHES], 'the first press changes nothing').toBeUndefined()
    expect(await v.find({ text: /turns off the switchboard itself\. Press Off again to confirm/ }), 'the warning').toBeDefined()
    expect((await v.find({ key: 'toggle-mods' }))?.text).toBe('Off?')

    // Any other press cancels it.
    await v.press({ key: 'all-on' })
    expect((await v.find({ key: 'toggle-mods' }))?.text, 'disarmed').toBe('On')

    await v.press({ key: 'toggle-mods' })
    await v.press({ key: 'toggle-mods' })
    expect(sw(files)).toEqual({ mods: false })
    expect(await v.find({ text: 'Mods is off' }), 'the off view').toBeDefined()
    expect(await v.find({ key: 'toggle-cache-clock' }), 'no list while off').toBeUndefined()
    expect((await runMods($, 'list')).text, 'the words say it too').toContain('Mods is off')

    await v.press({ key: 'toggle-mods' })
    expect(sw(files), 'back on: the key is removed').toEqual({})
    expect(await v.find({ key: 'toggle-cache-clock' }), 'the list is back').toBeDefined()
    await v.unmount()
  })
}

for (const surface of SURFACES) {
  test(`All on and All off touch only the mods with a switch, and Undo puts them back (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    files[SWITCHES] = JSON.stringify({ 'zeta-notes': false, 'foreign-tool:block': true, extra: 1 })
    rig(on, files, {}, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)
    expect(await v.find({ key: 'undo' }), 'nothing to undo yet').toBeUndefined()

    await v.press({ key: 'all-off' })
    const after = sw(files)
    for (const name of ['brain-dump', 'cache-clock', 'chat-inventory', 'handoff', 'helper-desk', 'zeta-notes', 'brand-new', 'old-chat-mod']) expect(after[name], `${name} off`).toBe(false)
    expect(after.mods, 'never the switchboard').toBeUndefined()
    expect(after['foreign-tool'], 'never a mod with no switch').toBeUndefined()
    expect(after['foreign-tool:block'], 'its block is left as it was').toBe(true)
    expect(after.extra, 'unknown keys stay').toBe(1)
    expect(await v.find({ text: '7 mods turned off in every chat.' }), 'zeta-notes was already off').toBeDefined()
    expect(await v.find({ key: 'undo' })).toBeDefined()

    await v.press({ key: 'undo' })
    expect(sw(files), 'exactly as it was').toEqual({ 'zeta-notes': false, 'foreign-tool:block': true, extra: 1 })
    expect(await v.find({ text: 'Undid All off (7).' })).toBeDefined()
    expect(await v.find({ key: 'undo' }), 'Undo is used up').toBeUndefined()

    await v.press({ key: 'all-on' })
    expect(sw(files), 'zeta-notes switched back on, the rest untouched').toEqual({ 'foreign-tool:block': true, extra: 1 })
    await v.press({ key: 'all-on' })
    expect(await v.find({ text: 'Every mod is already on.' })).toBeDefined()
    await v.unmount()
  })

  test(`Undo reverts one toggle, and leaves alone what changed since (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    rig(on, files, {}, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)
    await v.press({ key: 'toggle-cache-clock' })
    expect(await v.find({ text: 'Undo: Cache Clock off' })).toBeDefined()
    await v.press({ key: 'undo' })
    expect(sw(files)).toEqual({})

    await v.press({ key: 'toggle-cache-clock' })
    // Another chat switched it on, and something else off, before Undo.
    files[SWITCHES] = JSON.stringify({ 'brain-dump': false })
    await v.press({ key: 'undo' })
    expect(sw(files), 'brain-dump is not undone, and cache-clock was already on').toEqual({ 'brain-dump': false })
    expect(await v.find({ text: /except 1 that changed since/ })).toBeDefined()
    await v.unmount()
  })
}

for (const surface of SURFACES) {
  test(`a mod with no switch of its own is shown honestly and can be blocked at load (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    const r = rig(on, files, {}, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)

    expect(await v.find({ text: /No switch of its own, so it cannot be turned off live\. Block stops it loading next time\./ })).toBeDefined()
    expect(await v.find({ key: 'show-foreign-tool' }), 'no Shown/Hidden').toBeUndefined()
    expect((await v.find({ key: 'toggle-foreign-tool' }))?.text).toBe('On')

    await v.press({ key: 'toggle-foreign-tool' })
    expect(sw(files), 'its own key, never the mod name').toEqual({ 'foreign-tool:block': true })
    expect(await v.find({ text: /Foreign Tool will not load next time Claude Code starts it/ })).toBeDefined()
    expect((await v.find({ key: 'toggle-foreign-tool' }))?.text).toBe('Blocked')
    expect(await v.find({ text: 'Takes effect the next time it loads: a new chat or a restart.' }), 'running now, so the reload hint is shown').toBeDefined()
    expect(await v.find({ text: /Undo: Foreign Tool blocked/ })).toBeDefined()
    expect(r.ran, 'blocking runs nothing').toEqual([])

    await v.press({ key: 'toggle-foreign-tool' })
    expect(sw(files)).toEqual({})
    expect(await v.find({ text: /Foreign Tool will load again/ })).toBeDefined()
    expect(await v.find({ text: /Takes effect the next time/ }), 'no hint when nothing is pending').toBeUndefined()
    await v.unmount()
  })
}

for (const surface of SURFACES) {
  test(`discovery: the folder setting, this mod's own folder, duplicates, odd names (${surface})`, { timeoutMs: 20000, options: { mod_folders: '~/work/mods:/opt/more/' } }, async ($, on) => {
    const files: Files = {}
    addMod(files, `${HOME}/work/mods/one`, { name: 'one', source: SW })
    addMod(files, '/opt/more/two', { name: 'two', source: SW })
    // The default folder is not searched once the setting names others.
    addMod(files, `${CLAUDE_MODS}/three`, { name: 'three', source: SW })
    // The same mod in two places is one row.
    addMod(files, `${HOME}/work/mods/copy-a`, { name: 'dup', source: SW })
    addMod(files, '/opt/more/copy-b', { name: 'dup', source: SW })
    // A name that cannot be a switch key.
    addMod(files, `${HOME}/work/mods/odd`, { name: 'has space', source: SW })
    // A folder that is itself a mod, named directly.
    addMod(files, '/opt/more', { name: 'more-itself', source: SW })
    rig(on, files, {}, { commands: [] })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)
    expect(await v.find({ text: 'One' })).toBeDefined()
    expect(await v.find({ text: 'Two' })).toBeDefined()
    expect(await v.find({ text: 'More Itself' })).toBeDefined()
    expect(await v.find({ text: 'Three' }), 'not in a folder that was asked for').toBeUndefined()
    expect((await v.findAll({ key: 'row-dup' })).length, 'one row for a mod found twice').toBe(1)
    expect(await v.find({ text: /2 copies found/ })).toBeDefined()
    await v.press({ key: 'toggle-has space' })
    expect(sw(files), 'a name that is no safe key is not written').toEqual({})
    expect(await v.find({ text: /name that cannot be used as a switch/ })).toBeDefined()
    await v.unmount()
  })
}

for (const surface of SURFACES) {
  test(`the filter box narrows a long list (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    rig(on, files, {}, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)
    expect(await v.find({ key: 'filter' }), 'many mods: a filter box').toBeDefined()

    await v.input({ key: 'filter', text: 'desk', kind: 'change' })
    expect(await rowOrder(v)).toEqual(['helper-desk'])
    await v.input({ key: 'filter', text: '/inventory' })
    expect(await rowOrder(v), 'a slash command matches too').toEqual(['chat-inventory'])
    await v.input({ key: 'filter', text: 'INVENTORY' })
    expect(await rowOrder(v), 'case does not matter').toEqual(['chat-inventory'])
    await v.input({ key: 'filter', text: 'no such mod' })
    expect(await rowOrder(v)).toEqual([])
    expect(await v.find({ text: 'Nothing matches "no such mod".' })).toBeDefined()
    await v.input({ key: 'filter', text: '', kind: 'change' })
    expect((await rowOrder(v)).length).toBe(13)
    await v.unmount()
  })

  test(`a short list has no filter box (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files: Files = {}
    addMod(files, `${CLAUDE_MODS}/only`, { name: 'only', source: SW })
    rig(on, files, {}, {})
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)
    expect(await v.find({ key: 'filter' })).toBeUndefined()
    await v.unmount()
  })
}

for (const surface of SURFACES) {
  test(`an open pane follows another chat's change, new mods and old notes (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    const r = rig(on, files, {}, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface)
    expect((await v.find({ key: 'toggle-cache-clock' }))?.text).toBe('On')

    // Another chat flips a switch: the pane redraws by itself within 3 seconds.
    files[SWITCHES] = JSON.stringify({ 'cache-clock': false })
    await r.clock.advance(3000)
    expect((await v.find({ key: 'toggle-cache-clock' }))?.text, 'now Off').toBe('Off')

    // A mod appears on disk: found within 9 seconds.
    addMod(files, `${CLAUDE_MODS}/late-comer`, { name: 'late-comer', source: SW })
    await r.clock.advance(9000)
    expect(await v.find({ key: 'row-late-comer' }), 'appeared by itself').toBeDefined()

    // A note goes after 90 seconds.
    await v.press({ key: 'toggle-brain-dump' })
    expect(await v.find({ text: 'Brain Dump is off in every chat.' })).toBeDefined()
    await r.clock.advance(100_000)
    expect(await v.find({ text: 'Brain Dump is off in every chat.' }), 'the old note is gone').toBeUndefined()

    // The pane is closed: the timer stops, nothing is read or redrawn.
    r.panes.length = 0
    await r.clock.advance(3000)
    files[SWITCHES] = JSON.stringify({})
    await r.clock.advance(30_000)
    expect((await v.find({ key: 'toggle-cache-clock' }))?.text, 'no redraw while the pane is closed').toBe('Off')
    await v.unmount()
  })
}

for (const surface of SURFACES) {
  test(`/mods list, on and off work without the pane (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    rig(on, files, {}, { commands: COMMANDS })
    await start($, surface)

    const list = (await runMods($, 'list')).text ?? ''
    expect(list).toContain('on      helper-desk v0.1.0  Loaded')
    expect(list).toContain('on      foreign-tool v0.1.0  Loaded  (no switch of its own)')
    expect(list).toContain('On disk, not installed')

    expect((await runMods($, 'off cache-clock')).text).toBe('Cache Clock is off in every chat.')
    expect(sw(files)).toEqual({ 'cache-clock': false })
    expect((await runMods($, 'off cache-clock')).text).toBe('Cache Clock is already off.')
    expect((await runMods($, 'list')).text).toContain('off     cache-clock')
    expect((await runMods($, 'on Cache Clock')).text, 'by title too').toBe('Cache Clock is on in every chat.')
    expect(sw(files)).toEqual({})
    expect((await runMods($, 'off nothing-here')).text).toContain('No mod called "nothing-here"')
    expect((await runMods($, 'off mods')).text).toContain('cannot turn itself')
    expect((await runMods($, 'off foreign-tool')).text, 'blocks it').toContain('will not load next time')
    expect(sw(files)).toEqual({ 'foreign-tool:block': true })
    expect((await runMods($, 'list')).text).toContain('blocked foreign-tool')
  })
}

test('the log is one line per event, bounded, and holds no prompt text', { timeoutMs: 20000 }, async ($, on) => {
  const files = disk()
  files[LOG] = Array.from({ length: 400 }, (_, i) => `2026-01-01T00:00:00.000Z old line ${i}`).join('\n') + '\n'
  rig(on, files, {}, { commands: COMMANDS })
  await start($, 'desktop')
  await runMods($)
  const v = await pane($, 'desktop')
  await v.press({ key: 'toggle-cache-clock' })
  await v.press({ key: 'show-helper-desk' })
  await v.unmount()
  const lines = logText(files).split('\n').filter(Boolean)
  expect(lines.length, 'the last 300 lines or so are kept').toBeLessThanOrEqual(301)
  expect(lines[lines.length - 1]).toMatch(/^2026-11-01T12:00:0\d\.\d{3}Z (hide helper-desk|show helper-desk)/)
  expect(logText(files)).toContain('off cache-clock')
  expect(logText(files)).toContain('open pane')
  expect(logText(files), 'the first old lines were cut').not.toContain('old line 0\n')
})

test('old open requests are cleaned out; new ones and other files stay', { timeoutMs: 20000 }, async ($, on) => {
  const files = disk()
  const r = rig(on, files, {}, { commands: COMMANDS })
  files[`${MODS}/.open-old-mod-dead`] = ''
  r.mtimes[`${MODS}/.open-old-mod-dead`] = r.clock.now() - 7 * 3600 * 1000
  files[`${MODS}/.open-new-mod-live`] = ''
  r.mtimes[`${MODS}/.open-new-mod-live`] = r.clock.now() - 1000
  files[`${MODS}/.open-has-text-old`] = 'x'
  r.mtimes[`${MODS}/.open-has-text-old`] = r.clock.now() - 9 * 3600 * 1000
  files[`${MODS}/notes.txt`] = ''
  r.mtimes[`${MODS}/notes.txt`] = 0
  await start($, 'desktop')
  await runMods($)
  const kept = Object.keys(files)
  expect(kept).not.toContain(`${MODS}/.open-old-mod-dead`)
  expect(kept).toContain(`${MODS}/.open-new-mod-live`)
  expect(kept, 'a request with content is not ours to remove').toContain(`${MODS}/.open-has-text-old`)
  expect(kept).toContain(`${MODS}/notes.txt`)
})

for (const surface of SURFACES) {
  test(`fail open: when the engine, the disk or the home folder fail, the pane still opens (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    rig(on, files, { list: true, engine: true }, {})
    await start($, surface)
    const res = await runMods($)
    expect(res.text).toBe('Opened the Mods pane.')
    const v = await pane($, surface)
    expect(await v.find({ text: 'Mods (this switchboard)' }), 'the switchboard is always listed').toBeDefined()
    await v.press({ key: 'toggle-mods' })
    await v.unmount()
  })

  test(`fail open: no home folder means no change is made and the pane says so (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    rig(on, files, { noHome: true }, { commands: COMMANDS })
    await start($, surface)
    const res = await runMods($)
    expect(res.text).toBe('Opened the Mods pane.')
    const v = await pane($, surface)
    expect(await v.find({ text: /Cannot read switches\.json: no home folder/ })).toBeDefined()
    await v.press({ key: 'toggle-mods' })
    expect(Object.keys(files).filter(k => k.includes('switches')), 'nothing written anywhere').toEqual([])
    expect(await v.find({ text: /Could not change/ }) ?? (await v.find({ text: /This turns off the switchboard/ })), 'a note, not a crash').toBeDefined()
    await v.unmount()
  })

  test(`fail open: a pane that cannot open says so in words (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    const r = rig(on, files, { open: true }, { commands: COMMANDS })
    await start($, surface)
    expect((await runMods($)).text).toBe('Could not open the Mods pane. See ~/.claude/claude-mods/logs/mods.log')
    await r.clock.settle()
    expect(logText(files)).toContain('command failed')
  })

  test(`a narrow pane still draws every row (${surface})`, { timeoutMs: 20000 }, async ($, on) => {
    const files = disk()
    rig(on, files, {}, { commands: COMMANDS })
    await start($, surface)
    await runMods($)
    const v = await pane($, surface, 24)
    expect((await rowOrder(v)).length).toBe(13)
    expect(await v.find({ key: 'toggle-helper-desk' })).toBeDefined()
    expect(await v.find({ key: 'open-helper-desk' })).toBeDefined()
    await v.unmount()
  })
}

// The block at load: the engine raises plugin.register for each module it admits, so inline plugins stand in for other people's mods.

test('a mod the person blocked is refused at load; the others, the managed ones and an off switchboard are not', { timeoutMs: 20000, plugins: [{ name: 'blocked-one', register(on: any) { on('command.run', { command: 'pong' }, async () => ({ text: 'blocked-one ran' })) } }] }, async ($, on) => {
  const files = disk()
  files[SWITCHES] = JSON.stringify({ 'blocked-one:block': true })
  const r = rig(on, files, {}, {})
  // The test engine reports a refused module as an error when it loads the plugins.
  let said = ''
  try {
    await start($, 'desktop')
  } catch (err) {
    said = String((err as Error).message)
  }
  expect(said, 'the engine names who refused it and why').toContain('blocked-one: refused by mods: Blocked in the Mods pane ("blocked-one:block" in switches.json)')
  await r.clock.settle()
  expect(logText(files)).toContain('blocked blocked-one at load')
})

test('a mod that is not blocked loads as usual', { timeoutMs: 20000, plugins: [{ name: 'fine-one', register(on: any) { on('command.run', { command: 'pong' }, async () => ({ text: 'fine-one ran' })) } }] }, async ($, on) => {
  const files = disk()
  files[SWITCHES] = JSON.stringify({ 'other-mod:block': true, 'fine-one': false })
  rig(on, files, {}, {})
  await start($, 'desktop')
  expect(((await $.command.run({ command: 'pong', args: '' } as never)) as { text?: string }).text, 'an off switch is not a block').toBe('fine-one ran')
})

test('a blocked mod in a managed tier is not refused', { timeoutMs: 20000, plugins: [{ name: 'org-policy', tier: 'prepend', register(on: any) { on('command.run', { command: 'pong' }, async () => ({ text: 'org ran' })) } }] }, async ($, on) => {
  const files = disk()
  files[SWITCHES] = JSON.stringify({ 'org-policy:block': true })
  rig(on, files, {}, {})
  await start($, 'desktop')
  expect(((await $.command.run({ command: 'pong', args: '' } as never)) as { text?: string }).text).toBe('org ran')
})

test('with the switchboard off, nothing is blocked; a broken switch file blocks nothing', { timeoutMs: 20000, plugins: [{ name: 'blocked-one', register(on: any) { on('command.run', { command: 'pong' }, async () => ({ text: 'blocked-one ran' })) } }] }, async ($, on) => {
  const files = disk()
  files[SWITCHES] = JSON.stringify({ 'blocked-one:block': true, mods: false })
  rig(on, files, {}, {})
  await start($, 'desktop')
  expect(((await $.command.run({ command: 'pong', args: '' } as never)) as { text?: string }).text).toBe('blocked-one ran')
})

test('a file that cannot be read blocks nothing: the module loads', { timeoutMs: 20000, plugins: [{ name: 'blocked-one', register(on: any) { on('command.run', { command: 'pong' }, async () => ({ text: 'blocked-one ran' })) } }] }, async ($, on) => {
  const files = disk()
  files[SWITCHES] = JSON.stringify({ 'blocked-one:block': true })
  rig(on, files, { read: /switches\.json$/ }, {})
  await start($, 'desktop')
  expect(((await $.command.run({ command: 'pong', args: '' } as never)) as { text?: string }).text).toBe('blocked-one ran')
})
