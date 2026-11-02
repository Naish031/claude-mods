// SPDX-License-Identifier: Apache-2.0
// Replay Theater, a modified version of Anthropic's sample (Copyright 2026 Anthropic PBC, Apache License 2.0). See LICENSE and NOTICE.
// Replay Theater, what kind of file a path is: its highlighter language, a Shopify-friendly label, and whether its
// diff should start folded because it is generated or huge. Pure functions.
// New in this version: the sample showed every file the same way.

import type { ReplayHunk } from '../types'

const EXT_LANG: Record<string, string> = {
  // Liquid is HTML with tags, so the HTML colours read best.
  liquid: 'html',
  html: 'html',
  htm: 'html',
  svg: 'xml',
  xml: 'xml',
  json: 'json',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rb: 'ruby',
  php: 'php',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  ipynb: 'json',
}

const BINARY_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tiff', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'pdf', 'zip', 'gz', 'tgz', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'psd', 'sketch', 'xlsx', 'docx', 'pptx', 'wasm', 'bin'])

const ext = (path: string) => {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** The highlighter language for a path, or '' to let the engine guess from the path. */
export const languageOf = (path: string) => EXT_LANG[ext(path)] ?? ''

/** True for a file type that is not text. */
export const isBinaryPath = (path: string) => BINARY_EXT.has(ext(path))

/** True when the text holds a NUL, which text files do not. */
export const hasNul = (text: string | undefined | null) => typeof text === 'string' && text.includes('\u0000')

const SHOPIFY: [RegExp, string][] = [
  [/(^|\/)config\/settings_data\.json$/, 'Theme settings data'],
  [/(^|\/)config\/settings_schema\.json$/, 'Theme settings schema'],
  [/(^|\/)templates\/customers\/[^/]+\.json$/, 'JSON template'],
  [/(^|\/)templates\/metaobject\/[^/]+\.json$/, 'JSON template'],
  [/(^|\/)templates\/[^/]+\.json$/, 'JSON template'],
  [/(^|\/)templates\/[^/]+\.liquid$/, 'Liquid template'],
  [/(^|\/)sections\/[^/]+\.json$/, 'Section group'],
  [/(^|\/)sections\/[^/]+\.liquid$/, 'Liquid section'],
  [/(^|\/)snippets\/[^/]+\.liquid$/, 'Liquid snippet'],
  [/(^|\/)blocks\/[^/]+\.liquid$/, 'Liquid block'],
  [/(^|\/)layout\/[^/]+\.liquid$/, 'Liquid layout'],
  [/(^|\/)locales\/[^/]+\.json$/, 'Locale'],
  [/(^|\/)assets\/[^/]+\.(js|mjs)$/, 'Theme script'],
  [/(^|\/)assets\/[^/]+\.(css|scss)(\.liquid)?$/, 'Theme style'],
  [/\.liquid$/, 'Liquid'],
]

/** A short name for the file's job in a Shopify theme ("Liquid section", "JSON template"), or ''. */
export function labelOf(path: string): string {
  for (const [re, label] of SHOPIFY) if (re.test(path)) return label
  return ''
}

const GENERATED: [RegExp, string][] = [
  [/\.min\.(js|css|mjs)$/i, 'minified file'],
  [/\.(js|css)\.map$/i, 'source map'],
  [/\.map$/i, 'source map'],
  [/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|Cargo\.lock)$/, 'lock file'],
  [/(^|\/)(dist|build|\.next|\.output|node_modules|vendor)\//, 'generated or vendored folder'],
  [/\.(bundle|chunk)\.[a-z0-9]+\.js$/i, 'bundled file'],
  [/\.snap$/, 'test snapshot'],
]

/**
 * Why a diff should start folded, or '' when it should not: a generated or minified file, lines too long to read,
 * or a change bigger than `limit` lines. The person can open it with Expand.
 */
export function foldReason(path: string, hunks: ReplayHunk[], changed: number, limit: number): string {
  for (const [re, why] of GENERATED) if (re.test(path)) return why
  for (const h of hunks) for (const l of h.lines) if (l.length > 600) return 'very long lines (minified?)'
  if (limit > 0 && changed > limit) return `large change, ${changed} lines`
  return ''
}
