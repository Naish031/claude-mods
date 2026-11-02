// Pure helpers that hide text inside drawings and dialogs: another mod's tree, and the question dialog's questions.
// No engine calls, so they are tried directly in rows.test.ts.

import { hiddenRow, maskText, type Compiled } from './mask'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** Props that hold text to read. A Button's `label` is left alone: when it has no `key`, the label is its address. */
const TEXT_PROPS = ['text', 'alt', 'source'] as const

/** Hides private text inside another mod's drawing: text children and the text props of its elements. Layout and keys are kept. */
export function maskTree(node: Any, c: Compiled, glyph?: string, depth = 0): Any {
  if (typeof node === 'string') return maskText(node, c, glyph)
  if (!node || typeof node !== 'object') return node
  if (depth > 80) throw new Error('drawing nested too deep to hide')
  let out = node
  const props = node.props
  if (props && typeof props === 'object') {
    let copy: Record<string, unknown> | undefined
    for (const k of TEXT_PROPS) {
      const s = props[k]
      if (typeof s === 'string') {
        const m = maskText(s, c, glyph)
        if (m !== s) (copy ??= { ...props })[k] = m
      }
    }
    if (copy) out = { ...out, props: copy }
  }
  if (Array.isArray(node.children)) {
    let changed = false
    const children = node.children.map((child: Any) => {
      const m = maskTree(child, c, glyph, depth + 1)
      if (m !== child) changed = true
      return m
    })
    if (changed) out = { ...out, children }
  }
  return out
}

/** The question dialog: hide the questions, headers and option descriptions. Option labels stay, they are what the answer carries. */
export function maskQuestions(questions: unknown, c: Compiled, glyph?: string): unknown[] {
  if (!Array.isArray(questions)) return []
  return questions.map(q => {
    if (!q || typeof q !== 'object') return q
    const o = { ...(q as Record<string, unknown>) }
    for (const k of ['question', 'header']) if (typeof o[k] === 'string') o[k] = maskText(o[k] as string, c, glyph)
    if (Array.isArray(o.options))
      o.options = o.options.map((opt: unknown) => {
        if (!opt || typeof opt !== 'object') return opt
        const x = { ...(opt as Record<string, unknown>) }
        if (typeof x.description === 'string') x.description = maskText(x.description, c, glyph)
        return x
      })
    return o
  })
}

/** The same dialog with every question, header and description a placeholder: for when hiding them failed. Cannot throw on a string. */
export function hideQuestions(questions: unknown): unknown[] {
  if (!Array.isArray(questions)) return []
  return questions.map((q: Any) => {
    if (!q || typeof q !== 'object') return q
    return {
      ...q,
      ...(typeof q.question === 'string' ? { question: hiddenRow(q.question) } : {}),
      ...(typeof q.header === 'string' ? { header: hiddenRow(q.header) } : {}),
      ...(Array.isArray(q.options) ? { options: q.options.map((o: Any) => (typeof o?.description === 'string' ? { ...o, description: hiddenRow(o.description) } : o)) } : {}),
    }
  })
}
