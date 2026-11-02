import { expect, test } from 'claude-code/testing'

import { DEFAULT_RULES, compile } from './mask'
import { hideQuestions, maskQuestions, maskTree } from './rows'

const C = compile({ ...DEFAULT_RULES, style: 'label' })
const EMAIL = 'jane.doe@acme.com'

test('maskTree: text children and text props are hidden, keys, layout and button labels are not touched', () => {
  const tree = {
    type: 'Box',
    props: { key: 'root', flexDirection: 'column' },
    children: [
      { type: 'Text', props: { dimColor: true }, children: [`Mail ${EMAIL}`, { type: 'Text', props: { color: 'error' }, children: ['$4,250.00'] }] },
      { type: 'Button', props: { key: 'go', label: `Go ${EMAIL}` }, children: [] },
      { type: 'Markdown', props: { key: 'md', text: `# ${EMAIL}` } },
      { type: 'Code', props: { source: `const a = "${EMAIL}"`, language: 'ts' } },
      { type: 'Svg', props: { alt: `chart for ${EMAIL}`, source: '<svg/>' } },
      'plain',
    ],
  }
  const out = maskTree(tree, C)
  expect(out.children[0].children[0]).toBe('Mail [email]')
  expect(out.children[0].children[1].children[0]).toBe('[amount]')
  expect(out.children[1].props.label, 'a button label is its address when it has no key: left alone').toBe(`Go ${EMAIL}`)
  expect(out.children[1].props.key).toBe('go')
  expect(out.children[2].props.text).toBe('# [email]')
  expect(out.children[3].props.source).toBe('const a = "[email]"')
  expect(out.children[3].props.language).toBe('ts')
  expect(out.children[4].props.alt).toBe('chart for [email]')
  expect(out.children[5]).toBe('plain')
  expect(out.props, 'untouched props are the same object').toBe(tree.props)
  expect((tree.children[0] as { children: unknown[] }).children[0], 'the input is not changed').toBe(`Mail ${EMAIL}`)
})

test('maskTree: a clean tree comes back as the same object; odd nodes pass; a runaway depth throws', () => {
  const clean = { type: 'Text', children: ['hello', { type: 'Text', children: ['world'] }] }
  expect(maskTree(clean, C)).toBe(clean)
  expect(maskTree(null, C)).toBeNull()
  expect(maskTree(undefined, C)).toBeUndefined()
  expect(maskTree(5, C)).toBe(5)
  let deep: Record<string, unknown> = { type: 'Text', children: ['x'] }
  for (let i = 0; i < 100; i++) deep = { type: 'Box', children: [deep] }
  expect(() => maskTree(deep, C)).toThrow()
})

test('maskQuestions: question, header and option descriptions are hidden; the labels an answer carries are not', () => {
  const qs = [{ question: `Send to ${EMAIL}?`, header: `Re ${EMAIL}`, multiSelect: false, options: [{ label: `Yes ${EMAIL}`, description: `to ${EMAIL}` }, { label: 'No' }] }, 'odd', null]
  const out = maskQuestions(qs, C) as typeof qs
  expect((out[0] as { question: string }).question).toBe('Send to [email]?')
  expect((out[0] as { header: string }).header).toBe('Re [email]')
  const opts = (out[0] as { options: Array<{ label: string; description?: string }> }).options
  expect(opts[0]!.description).toBe('to [email]')
  expect(opts[0]!.label).toBe(`Yes ${EMAIL}`)
  expect(opts[1]).toEqual({ label: 'No' })
  expect(out[1]).toBe('odd')
  expect(out[2]).toBeNull()
  expect(maskQuestions('not a list', C)).toEqual([])
})

test('hideQuestions: every readable field is a placeholder, and it cannot throw', () => {
  const qs = [{ question: `Send to ${EMAIL}?`, header: 'h', multiSelect: true, options: [{ label: 'Yes', description: `to ${EMAIL}` }, { label: 'No' }] }, null, 'odd']
  const out = hideQuestions(qs) as Array<Record<string, unknown>>
  expect(JSON.stringify(out)).not.toContain('jane')
  expect(String(out[0]!.question)).toContain('hidden by screen share')
  expect(out[0]!.multiSelect, 'other fields are kept').toBe(true)
  expect((out[0]!.options as Array<{ label: string }>)[0]!.label).toBe('Yes')
  expect(hideQuestions(undefined)).toEqual([])
})
