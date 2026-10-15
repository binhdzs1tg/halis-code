/**
 * Tiny zero-dependency syntax highlighting for chat code blocks.
 *
 * DeepSeek Harness highlights with Shiki backed by the JavaScript regex
 * engine; for this app a hand-rolled tokenizer over the same idea — sticky
 * regexes, escape-then-wrap — covers the languages model replies actually
 * contain without pulling a grammar engine into the bundle. Input is escaped
 * as it is consumed, so raw HTML never reaches the DOM.
 */

interface Rule {
  re: RegExp
  cls: string
}

const KEYWORDS_JS = [
  'abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class',
  'const', 'continue', 'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if',
  'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'is', 'keyof', 'let',
  'namespace', 'never', 'new', 'null', 'number', 'object', 'of', 'private', 'protected',
  'public', 'readonly', 'return', 'satisfies', 'set', 'static', 'string', 'super', 'switch',
  'symbol', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'unknown',
  'var', 'void', 'while', 'with', 'yield'
]

function wordRule(words: string[], cls: string): Rule {
  return { re: new RegExp(`\\b(?:${words.join('|')})\\b`, 'y'), cls }
}

const RULES_JS: Rule[] = [
  { re: /\/\/[^\n]*/y, cls: 'com' },
  { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'com' },
  { re: /(["'`])(?:\\[\s\S]|(?!\1)[^\\])*?\1/y, cls: 'str' },
  wordRule(KEYWORDS_JS, 'kw'),
  { re: /\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b/iy, cls: 'num' },
  { re: /\b[A-Za-z_$][\w$]*(?=\s*\()/y, cls: 'fn' }
]

const RULES_JSON: Rule[] = [
  { re: /"(?:\\.|[^"\\])*"(?=\s*:)/y, cls: 'prop' },
  { re: /"(?:\\.|[^"\\])*"/y, cls: 'str' },
  wordRule(['true', 'false', 'null'], 'lit'),
  { re: /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/iy, cls: 'num' }
]

const RULES_BASH: Rule[] = [
  { re: /#[^\n]*/y, cls: 'com' },
  { re: /"(?:\\.|[^"\\])*"|'[^']*'/y, cls: 'str' },
  { re: /\$\{?[\w@#?*]+\}?/y, cls: 'lit' },
  wordRule(
    ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac',
     'function', 'return', 'exit', 'export', 'local', 'source', 'in', 'set', 'unset'],
    'kw'
  ),
  { re: /\b(?:echo|cd|ls|cat|grep|sed|awk|rm|mv|cp|mkdir|rmdir|touch|chmod|chown|curl|wget|git|npm|npx|pnpm|yarn|node|python|pip|make|docker|kill|sleep|test|which|man|ssh|tar|zip|unzip|head|tail|sort|uniq|wc|find|xargs|sudo|env)\b/y, cls: 'fn' }
]

const RULES_PY: Rule[] = [
  { re: /#[^\n]*/y, cls: 'com' },
  { re: /(?:[rbfu]{0,2})("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/y, cls: 'str' },
  wordRule(
    ['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
     'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import',
     'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
     'True', 'try', 'while', 'with', 'yield'],
    'kw'
  ),
  { re: /\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b/iy, cls: 'num' },
  { re: /\b[A-Za-z_][\w]*(?=\s*\()/y, cls: 'fn' }
]

const RULES_CSS: Rule[] = [
  { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'com' },
  { re: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/y, cls: 'str' },
  { re: /#[0-9a-f]{3,8}\b/iy, cls: 'num' },
  { re: /--[\w-]+/y, cls: 'prop' },
  { re: /[.#]?[\w-]+(?=[^;{}]*\{)/y, cls: 'fn' },
  { re: /\b[a-z-]+(?=\s*:)/y, cls: 'prop' }
]

const RULES_HTML: Rule[] = [
  { re: /<!--[\s\S]*?(?:-->|$)/y, cls: 'com' },
  { re: /<\/?[\w-]+|\/?>/y, cls: 'kw' },
  { re: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/y, cls: 'str' },
  { re: /[\w-]+(?==)/y, cls: 'prop' }
]

/** Aliases collapse onto one grammar; unknown languages render plain. */
const GRAMMARS: Record<string, Rule[]> = {
  cjs: RULES_JS, mjs: RULES_JS, javascript: RULES_JS, jsx: RULES_JS,
  ts: RULES_JS, tsx: RULES_JS, typescript: RULES_JS,
  json: RULES_JSON, jsonc: RULES_JSON, json5: RULES_JSON,
  sh: RULES_BASH, bash: RULES_BASH, zsh: RULES_BASH, shell: RULES_BASH, console: RULES_BASH,
  py: RULES_PY, python: RULES_PY,
  css: RULES_CSS, scss: RULES_CSS, less: RULES_CSS,
  html: RULES_HTML, xml: RULES_HTML, svg: RULES_HTML, vue: RULES_HTML, svelte: RULES_HTML
}

const LANG_ALIASES = new Map(Object.entries(GRAMMARS))

const MAX_HIGHLIGHT_CHARS = 30_000

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Highlight one code snippet. Unknown or oversized input falls back to plain
 * escaped text, which is always safe and fast.
 */
export function highlightCode(code: string, lang: string): string {
  const rules = LANG_ALIASES.get(lang.trim().toLowerCase())
  if (!rules || code.length > MAX_HIGHLIGHT_CHARS) {
    return escapeHtml(code)
  }

  let out = ''
  let pos = 0
  while (pos < code.length) {
    let matched = false
    for (const rule of rules) {
      rule.re.lastIndex = pos
      const m = rule.re.exec(code)
      if (m && m[0].length > 0) {
        out += `<span class="tok-${rule.cls}">${escapeHtml(m[0])}</span>`
        pos += m[0].length
        matched = true
        break
      }
    }
    if (!matched) {
      // Consume the run of characters no rule can start with — whitespace
      // and punctuation only — so token-starting characters are always
      // re-checked against the rules.
      let end = pos + 1
      while (end < code.length) {
        const char = code[end]
        if (char === undefined || /[\w$"'`#/<>&]/.test(char)) break
        end += 1
      }
      out += escapeHtml(code.slice(pos, end))
      pos = end
    }
  }
  return out
}
