/** Smoke tests for the ported algorithms; run with `npm run smoke`. */
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { computeHunks, fileDiff } from '../electron/main/agent/diff'
import { RepeatGuard } from '../electron/main/agent/guard'
import { extractFileRefs } from '../electron/main/agent/file-refs'
import { assessCommand } from '../electron/main/agent/risky'
import { expandBraces, matchGlob } from '../electron/main/agent/glob'
import { compileLineRegex, matchesInclude, validateInclude } from '../electron/main/agent/grep'
import { htmlToMarkdown, htmlToText, decodeEntities } from '../electron/main/agent/html-to-markdown'
import { applyUpdate, normalizeForMatch, parsePatch } from '../electron/main/agent/patch-format'
import { applyEditText } from '../electron/main/agent/edit-text'
import { repairToolInput } from '../electron/main/agent/tool-input-repair'
import { isSpillPath, readSpill, saveSpill, setSpillBaseForTests, truncateLongLines } from '../electron/main/agent/spill'
import { assertEditable, observeRead, recordWrite, resetObservations } from '../electron/main/agent/observation'
import { setWorkspaceRoot } from '../electron/main/workspace'
import { clearGitInfoCache, getGitInfo } from '../electron/main/agent/git-info'
import {
  filterSubagentSpecs,
  subagentSystemPrompt,
  TASK_TOOL_NAME,
  TASK_TOOL_SPEC,
  taskEnvelope,
  validateTaskInput
} from '../electron/main/agent/subagent'
import {
  configureJobStore,
  jobStatus,
  killJob,
  setJobSink,
  startBackgroundJob,
  tailChars
} from '../electron/main/agent/jobs'
import {
  callMcpTool,
  flattenMcpContent,
  mcpConnectionCount,
  mcpToolName,
  mcpToolSpecs,
  parseMcpConfig,
  sanitizeMcpName,
  setMcpConfigFileForTests,
  stopAllMcpServers,
  syncMcpServers
} from '../electron/main/agent/mcp'
import type { JobNoticeEvent } from '../electron/shared/types'

let failures = 0
function check(name: string, cond: boolean): void {
  if (!cond) {
    failures += 1
    console.error(`FAIL ${name}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

function runSync(cmd: string, args: string[], cwd: string): void {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr}`)
  }
}

function isGitDir(dir: string): boolean {
  return fs.existsSync(join(dir, '.git'))
}

/* ---------- diff ---------- */
const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')
const after = ['a', 'b', 'X', 'd', 'e', 'f', 'g'].join('\n')
const hunks = computeHunks(before, after)
const firstHunk = hunks[0]
check('one hunk for a single change', hunks.length === 1)
check('hunk has context lines', firstHunk?.lines.some((l) => l.kind === 'ctx') === true)
check('hunk counts one add one del', firstHunk?.added === 1 && firstHunk?.removed === 1)

const created = fileDiff('new.ts', null, 'hello\nworld')
check('create diff is pure adds', created?.op === 'create' && created.added === 2)

const unchanged = computeHunks('same', 'same')
check('identical text yields a minimal hunk', unchanged.length === 1)

const gapBefore = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n')
const gapAfter = gapBefore.replace('line5', 'line5!').replace('line35', 'line35!')
const gapHunks = computeHunks(gapBefore, gapAfter)
check('far apart edits make two hunks', gapHunks.length === 2)

/* ---------- repeat guard ---------- */
const guard = new RepeatGuard()
check('first call is quiet', guard.record('read_file', { path: 'a.ts' }) === null)
check('second call is quiet', guard.record('read_file', { path: 'a.ts' }) === null)
check('third call nudges', guard.record('read_file', { path: 'a.ts' }) !== null)
check('different args reset the chain', guard.record('read_file', { path: 'b.ts' }) === null)
check('key order does not matter', guard.record('read_file', { path: 'b.ts' }) === null)
const fifth = guard.record('read_file', { path: 'b.ts' })
check('threshold 3 nudges again', fifth !== null)
check('threshold 4 stays quiet', guard.record('read_file', { path: 'b.ts' }) === null)
check('threshold 5 nudges', guard.record('read_file', { path: 'b.ts' }) !== null)
check('threshold 6 stays quiet', guard.record('read_file', { path: 'b.ts' }) === null)
check('threshold 7 stays quiet', guard.record('read_file', { path: 'b.ts' }) === null)
const eighth = guard.record('read_file', { path: 'b.ts' })
check('threshold 8 escalates with count', eighth?.includes('8 times in a row') === true)
guard.reset()
check('reset clears the chain', guard.record('read_file', { path: 'a.ts' }) === null)

/* ---------- file refs ---------- */
const refs = extractFileRefs('Look at @src/main.ts and @"folder with space/x.ts" plus src/plain.ts')
check('unquoted ref parsed', refs.includes('src/main.ts'))
check('quoted ref parsed', refs.includes('folder with space/x.ts'))
check('plain path is not a ref', !refs.includes('src/plain.ts'))
check('line suffix stripped', extractFileRefs('see @src/a.ts:12')[0] === 'src/a.ts')
check('email is not a ref', extractFileRefs('mail me at a@b.com').length === 0)
check('parent escape refused', extractFileRefs('@../secrets').length === 0)

/* ---------- glob matching ---------- */
check('**/*.ts matches a root-level file', matchGlob('**/*.ts', 'main.ts'))
check('**/*.ts matches a nested file', matchGlob('**/*.ts', 'src/app/main.ts'))
check('**/*.ts rejects other extensions', !matchGlob('**/*.ts', 'src/app/main.js'))
check('single star stays in one segment', !matchGlob('src/*.ts', 'src/app/main.ts'))
check('single star matches within one segment', matchGlob('src/*.ts', 'src/main.ts'))
check('bare ** matches any path', matchGlob('**', 'deep/nested/file.txt'))
check('trailing slash reads as everything below', matchGlob('src/', 'src/lib/util.ts'))
check('question mark matches one char', matchGlob('a?c.ts', 'abc.ts') && !matchGlob('a?c.ts', 'abbc.ts'))
check('braces expand to alternatives', matchGlob('src/{lib,cmd}/*.go', 'src/cmd/run.go'))
check('nested braces expand once', expandBraces('a/{b,{c,d}}/x').length === 3)
check('regex specials in names are literal', matchGlob('a+b.ts', 'a+b.ts') && !matchGlob('a+b.ts', 'aab.ts'))

/* ---------- grep helpers ---------- */
check('include without slash matches the basename', matchesInclude('*.ts', 'deep/nested/main.ts'))
check('include with slash matches the whole path', matchesInclude('src/**/*.ts', 'src/lib/main.ts'))
check('include with slash stays anchored', !matchesInclude('src/**/*.ts', 'test/src/main.ts'))
check('literal mode escapes metacharacters', compileLineRegex('a.c*', { literal: true, caseSensitive: true }).test('a.c*zz') && !compileLineRegex('a.c*', { literal: true, caseSensitive: true }).test('abcz'))
check('case-insensitive mode lowers the bar', compileLineRegex('ERROR', { literal: true, caseSensitive: false }).test('error here'))
let badPatternRejected = false
try {
  compileLineRegex('([unclosed', { literal: false, caseSensitive: true })
} catch {
  badPatternRejected = true
}
check('invalid regex throws a readable error', badPatternRejected)
let negatedIncludeRejected = false
try {
  validateInclude('!**/*.log')
} catch {
  negatedIncludeRejected = true
}
check('negated include is refused', negatedIncludeRejected)

/* ---------- html to markdown ---------- */
const page = [
  '<html><head><style>.x{color:red}</style><script>alert(1)</script></head><body>',
  '<h1>Title &amp; subtitle</h1>',
  '<p>Hello <strong>bold</strong>, <em>italic</em>, <a href="https://example.com/a">a link</a>.</p>',
  '<ul><li>one</li><li>two <ul><li>nested</li></ul></li></ul>',
  '<pre><code class="language-ts">const x = 1</code></pre>',
  '<table><tr><th>Name</th><th>Qty</th></tr><tr><td>box</td><td>2</td></tr></table>',
  '</body></html>'
].join('')
const markdown = htmlToMarkdown(page)
check('heading converts with level', markdown.includes('# Title & subtitle'))
check('inline marks survive', markdown.includes('**bold**') && markdown.includes('*italic*'))
check('links become markdown', markdown.includes('[a link](https://example.com/a)'))
check('script and style are dropped', !markdown.includes('alert') && !markdown.includes('color:red'))
check('entities decode', markdown.includes('Title & subtitle'))
check('nested list stays under its item', markdown.includes('- two\n  - nested'))
check('code fences carry the language', markdown.includes('```ts\nconst x = 1\n```'))
check('tables render as pipes', markdown.includes('| Name | Qty |') && markdown.includes('| --- | --- |'))
const text = htmlToText('<p>a<b>b</b>c</p><script>no()</script>')
check('text mode keeps words, drops marks and scripts', text.includes('abc') && !text.includes('no()'))
check('numeric entities decode', decodeEntities('&#65;&#x42;') === 'AB')

/* ---------- patch format ---------- */
const addPatch = [
  '*** Begin Patch',
  '*** Add File: notes/hello.txt',
  '+Hello world',
  '+Second line',
  '*** End Patch'
].join('\n')
const parsedAdd = parsePatch(addPatch)
check('add file parses with contents', parsedAdd.length === 1 && parsedAdd[0]?.type === 'add' && parsedAdd[0].contents === 'Hello world\nSecond line')

const updatePatch = [
  '*** Begin Patch',
  '*** Update File: src/app.ts',
  '@@ function greet()',
  '-console.log("Hi")',
  '+console.log("Hello, world!")',
  '*** End Patch'
].join('\n')
const parsedUpdate = parsePatch(updatePatch)
check('update hunk parses lines',
  parsedUpdate.length === 1 &&
  parsedUpdate[0]?.type === 'update' &&
  parsedUpdate[0].chunks.length === 1 &&
  parsedUpdate[0].chunks[0]?.changeContext === 'function greet()' &&
  parsedUpdate[0].chunks[0]?.oldLines[0] === 'console.log("Hi")' &&
  parsedUpdate[0].chunks[0]?.newLines[0] === 'console.log("Hello, world!")')

const source = ['header', 'function greet()', 'console.log("Hi")', 'tail'].join('\n')
const updated = applyUpdate('src/app.ts', parsedUpdate[0]?.type === 'update' ? parsedUpdate[0].chunks : [], source)
check('apply replaces the old lines',
  updated === 'header\nfunction greet()\nconsole.log("Hello, world!")\ntail\n')

const smartQuotes = ['header', 'function greet()', 'console.log(\u201CHi\u201D)', 'tail'].join('\n')
const smartApplied = applyUpdate('src/app.ts', parsedUpdate[0]?.type === 'update' ? parsedUpdate[0].chunks : [], smartQuotes)
check('normalized tier rescues smart quotes',
  smartApplied === 'header\nfunction greet()\nconsole.log("Hello, world!")\ntail\n')

const tailPatch = [
  '*** Begin Patch',
  '*** Update File: log.txt',
  '@@',
  '-last',
  '+last (edited)',
  '*** End of File',
  '*** End Patch'
].join('\n')
const tailSource = ['first', 'middle', 'last'].join('\n')
const tailHunk = parsePatch(tailPatch)[0]
const tailApplied = applyUpdate('log.txt', tailHunk?.type === 'update' ? tailHunk.chunks : [], tailSource)
check('end of file anchors the last lines', tailApplied === 'first\nmiddle\nlast (edited)\n')

const anchorPatch = [
  '*** Begin Patch',
  '*** Update File: f.txt',
  '@@ two',
  '+INSERTED',
  '*** End Patch'
].join('\n')
const anchorHunk = parsePatch(anchorPatch)[0]
const anchorApplied = applyUpdate('f.txt', anchorHunk?.type === 'update' ? anchorHunk.chunks : [], 'one\ntwo\nthree\nfour')
check('context anchors a pure insertion', anchorApplied === 'one\ntwo\nINSERTED\nthree\nfour\n')

const crlfSource = 'function a() {\r\n  console.log(\"Hello\")\r\n}\r\n'
const crlfEdit = applyEditText(crlfSource, 'console.log("Hello")', 'console.log("Bye")', false)
check('edit keeps crlf endings', crlfEdit.content === 'function a() {\r\n  console.log("Bye")\r\n}\r\n')

const movePatch = [
  '*** Begin Patch',
  '*** Update File: a.ts',
  '*** Move to: b.ts',
  '@@',
  ' x',
  '-old',
  '+new',
  '*** End Patch'
].join('\n')
const moveHunk = parsePatch(movePatch)[0]
check('move to parses a rename', moveHunk?.type === 'update' && moveHunk.movePath === 'b.ts')

const fenced = '```\n' + addPatch + '\n```'
check('code fences are stripped', parsePatch(fenced).length === 1)
check('heredoc wrappers are stripped', parsePatch(`cat <<'EOF'\n${addPatch}\nEOF`).length === 1)

let badPatchRejected = false
try {
  parsePatch(['*** Begin Patch', '*** Add File: x.txt', 'not a plus line', '*** End Patch'].join('\n'))
} catch {
  badPatchRejected = true
}
check('bad add lines throw', badPatchRejected)

check('normalize folds typographic punctuation',
  normalizeForMatch('\u201Cquoted\u201D \u2014 dash\u00a0space') === '"quoted" - dash space')

/* ---------- edit matching ---------- */
const editSource = 'function greet() {\n  console.log("Hello")\n}\n'
const single = applyEditText(editSource, 'console.log("Hello")', 'console.log("Goodbye")', false)
check('exact single edit lands', single.content.includes('console.log("Goodbye")') && single.count === 1)

const repeated = 'todo = 1\ntodo = 2\ntodo = 3\n'
const all = applyEditText(repeated, 'todo =', 'done =', true)
check('replace_all swaps every occurrence', all.count === 3 && !all.content.includes('todo ='))

const smartQuotesSource = 'function greet() {\n  console.log(\u201CHello\u201D)\n}\n'
const forgiving = applyEditText(smartQuotesSource, 'console.log("Hello")', 'console.log("Hi")', false)
check('forgiving tier rescues smart quotes', forgiving.content.includes('console.log("Hi")') && forgiving.note !== undefined)

const trailingSpace = 'line one   \nline two\n'
const forgivingSpace = applyEditText(trailingSpace, 'line one', 'first line', false)
check('forgiving tier rescues trailing whitespace', forgivingSpace.content.startsWith('first line'))

const twinSource = 'function a() {\n console.log("hi")\n}\nfunction b() {\n console.log("hi")\n}\n'
let forgivingAmbiguityRejected = false
try {
  applyEditText(twinSource, 'console.log(“hi”)', 'console.log("bye")', false)
} catch {
  forgivingAmbiguityRejected = true
}
check('forgiving tier refuses ambiguous windows', forgivingAmbiguityRejected)

const crlfTwin = 'a\r\nB\r\nc\r\n'
const crlfForgiving = applyEditText(crlfTwin, ' B', 'C', false)
check('forgiving tier keeps crlf endings', crlfForgiving.content === 'a\r\nC\r\nc\r\n')

let identicalRejected = false
try {
  applyEditText(editSource, 'same', 'same', false)
} catch {
  identicalRejected = true
}
check('identical old and new rejected', identicalRejected)

let ambiguousRejected = false
try {
  applyEditText(repeated, 'todo =', 'x', false)
} catch (err) {
  ambiguousRejected = err instanceof Error && err.message.includes('replace_all')
}
check('ambiguous match points at replace_all', ambiguousRejected)

/* ---------- tool input repair ---------- */
const repairSchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer' },
    enabled: { type: 'boolean' },
    note: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    pair: { type: 'array', items: [{ type: 'number' }, { type: 'boolean' }] },
    counts: { type: 'object', additionalProperties: { type: 'number' } },
    filter: { type: 'object', properties: { path: { type: 'string' }, min: { type: 'number' } } }
  },
  required: ['limit']
}
const repaired = repairToolInput({ limit: '20', enabled: 'false' }, repairSchema)
check('numeric and boolean strings coerce', repaired.limit === 20 && repaired.enabled === false)
const nested = repairToolInput({ filter: '{"path":"a.ts","min":"2"}' }, repairSchema)
check(
  'stringified nested objects parse',
  typeof nested.filter === 'object' &&
    nested.filter !== null &&
    (nested.filter as Record<string, unknown>).path === 'a.ts' &&
    (nested.filter as Record<string, unknown>).min === 2
)
const placeholder = repairToolInput({ limit: '5', note: null }, repairSchema)
check('optional null placeholder drops', !('note' in placeholder) && placeholder.limit === 5)
const wrapped = repairToolInput({ tags: '["a","b"]' }, repairSchema)
check('stringified array parses', Array.isArray(wrapped.tags) && (wrapped.tags as unknown[]).length === 2)
const lone = repairToolInput({ tags: 'a' }, repairSchema)
check('compatible single item wraps into the array', Array.isArray(lone.tags) && (lone.tags as unknown[])[0] === 'a')
const tuple = repairToolInput({ pair: ['2', 'false'] }, repairSchema)
check(
  'tuple positions repair against their own schemas',
  Array.isArray(tuple.pair) && (tuple.pair as unknown[])[0] === 2 && (tuple.pair as unknown[])[1] === false
)
const dict = repairToolInput({ counts: { first: '2' } }, repairSchema)
check(
  'dictionary values coerce through additionalProperties',
  typeof dict.counts === 'object' && dict.counts !== null && (dict.counts as Record<string, unknown>).first === 2
)
const closedSchema = { ...repairSchema, additionalProperties: false }
const closed = repairToolInput({ limit: '20', extra: true }, closedSchema)
check('extra key dropped on a closed object', !('extra' in closed))
const open = repairToolInput({ limit: '20', extra: true }, repairSchema)
check('extra key kept on an open object', 'extra' in open)
const malformed = repairToolInput(
  { _malformed: true, _raw: '{"limit":"20"}', _note: 'arguments failed to parse' },
  repairSchema
)
check('malformed wrapper gets one parse chance', malformed.limit === 20)
let deepSurvived = true
try {
  let deep: unknown = { limit: '1' }
  for (let i = 0; i < 10; i += 1) {
    deep = repairToolInput({ limit: '1', nested: deep }, {
      type: 'object',
      properties: { limit: { type: 'integer' }, nested: { type: 'object' } }
    })
  }
} catch {
  deepSurvived = false
}
check('deeply nested repair does not crash', deepSurvived)
const untouched = repairToolInput({ limit: 'x' }, repairSchema)
check('unparseable value passes through', untouched.limit === 'x')

/* ---------- spill store ---------- */
const spillDir = fs.mkdtempSync(join(os.tmpdir(), 'halis-spill-test-'))
setSpillBaseForTests(spillDir)
const spilled = saveSpill('run_command', 'call-1', 'a'.repeat(100))
check('spill saves under the configured root', spilled !== null && isSpillPath(spilled as string))
check('spill round-trips the content', readSpill(spilled as string) === 'a'.repeat(100))
check('outside paths are not spill reads', readSpill('/etc/hosts') === null)
check('spill ids are filename-safe', isSpillPath(join(spillDir, 'weird name~$()')))
const monster = `short\n${'x'.repeat(3_000)}\nshort`
const folded = truncateLongLines(monster)
check(
  'long lines fold with a marker',
  folded.includes('[... line truncated]') && !folded.includes('x'.repeat(2_100)) && folded.split('\n').length === 3
)
check('short text passes through untouched', truncateLongLines('one\ntwo') === 'one\ntwo')

/* ---------- read-before-edit gate ---------- */
const obsDir = fs.mkdtempSync(join(os.tmpdir(), 'halis-obs-test-'))
setWorkspaceRoot(obsDir)
resetObservations()
const obsFile = join(obsDir, 'a.ts')
fs.writeFileSync(obsFile, 'one\ntwo\n', 'utf8')
let unreadRejected = ''
try {
  assertEditable(obsFile, 'a.ts')
} catch (err) {
  unreadRejected = err instanceof Error ? err.message : ''
}
check('unread file refuses edits', unreadRejected.includes('read the file first'))
observeRead(obsFile)
let editable = true
try {
  assertEditable(obsFile, 'a.ts')
} catch {
  editable = false
}
check('observed file is editable', editable)
fs.appendFileSync(obsFile, 'three\n')
let staleRejected = ''
try {
  assertEditable(obsFile, 'a.ts')
} catch (err) {
  staleRejected = err instanceof Error ? err.message : ''
}
check('on-disk change fails the edit', staleRejected.includes('changed on disk'))
recordWrite(obsFile)
let stillEditable = true
try {
  assertEditable(obsFile, 'a.ts')
} catch {
  stillEditable = false
}
check('a recorded write refreshes the basis', stillEditable)
const createdFile = join(obsDir, 'new.ts')
let createAllowed = true
try {
  assertEditable(createdFile, 'new.ts')
} catch {
  createAllowed = false
}
check('a missing file is a create and sails through', createAllowed)

/* ---------- git info ---------- */
async function gitChecks(): Promise<void> {
  const gitDir = fs.mkdtempSync(join(os.tmpdir(), 'halis-git-test-'))
  fs.writeFileSync(join(gitDir, 'a.txt'), 'hello\n', 'utf8')
  runSync('git', ['init', '--quiet'], gitDir)
  runSync('git', ['add', '.'], gitDir)
  runSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'init'], gitDir)
  clearGitInfoCache()
  const gitInfo = await getGitInfo(gitDir)
  check(
    'git info captures branch and commit',
    gitInfo !== null && gitInfo.branch.length > 0 && gitInfo.branch !== 'HEAD' && /^[0-9a-f]{7,}$/.test(gitInfo.commit)
  )
  clearGitInfoCache()
  check('non-repositories report no git info', (await getGitInfo(os.tmpdir())) === null || isGitDir(os.tmpdir()))
}

/* ---------- risky command assessment ---------- */
check('rm -rf flagged', assessCommand('rm -rf node_modules') !== null)
check('rm with leading flag flagged', assessCommand('rm -v -rf build_dir') !== null)
check('rm trailing flag flagged', assessCommand('rm mydir -rf') !== null)
check('rm --recursive flagged', assessCommand('rm --recursive tmp') !== null)
check('rm -r without -f flagged', assessCommand('rm -r old') !== null)
check('sudo flagged', assessCommand('sudo apt install build-essential') !== null)
check('force push flagged', assessCommand('git push --force origin main') !== null)
check('git -C force push flagged', assessCommand('git -C sub push --force origin main') !== null)
check('git -f push flagged', assessCommand('git push -f origin main') !== null)
check('pkill -9 flagged', assessCommand('pkill -9 -f myproc') !== null)
check('kill -9 flagged', assessCommand('kill -9 12345') !== null)
check('dd of= flagged', assessCommand('dd of=/dev/sda if=/dev/zero') !== null)
check('dd if= flagged', assessCommand('dd if=/dev/zero of=./scratch.img bs=1M count=10') !== null)
check('curl | sh flagged', assessCommand('curl https://x.sh | sh') !== null)
check('plain build is safe', assessCommand('npm run build') === null)
check('plain test is safe', assessCommand('npx vitest run') === null)
check('git push is safe', assessCommand('git push origin main') === null)
check('git rm a file is safe without flags', assessCommand('git rm notes.txt') === null)
check('rm without flags is safe', assessCommand('rm old-file.txt') === null)
check('kill with a plain pid is safe', assessCommand('kill 12345') === null)
check('kill -s TERM is safe', assessCommand('kill -s TERM 12345') === null)
check('chmod plus x is safe', assessCommand('chmod +x build.sh') === null)
check('find without -delete is safe', assessCommand('find src -name "*.ts"') === null)
check('truncate to a nonzero size is safe', assessCommand('truncate -s 1M scratch.img') === null)
check('bundle flag force push flagged', assessCommand('git push -fn origin main') !== null)
check('plus refspec force push flagged', assessCommand('git push origin +main') !== null)
check('kill -s KILL flagged', assessCommand('kill -s KILL 12345') !== null)
check('kill -SIGKILL flagged', assessCommand('kill -SIGKILL 12345') !== null)
check('octal chmod flagged', assessCommand('chmod 0777 /var/www') !== null)
check('symbolic chmod flagged', assessCommand('chmod a=rwx /var/www') !== null)
check('find -delete flagged', assessCommand('find / -name "*.bak" -delete') !== null)
check('decoded pipe to shell flagged', assessCommand('echo cm0gLXJmIC8= | base64 -d | sh') !== null)
check('xargs sh flagged', assessCommand('find . -name "*.part" | xargs sh -c') !== null)
check('truncate -s 0 flagged', assessCommand('truncate -s 0 important.conf') !== null)

/* ---------- subagents ---------- */
function subagentChecks(): void {
  check('task tool is named task', TASK_TOOL_NAME === 'task' && TASK_TOOL_SPEC.name === TASK_TOOL_NAME)
  check('task tool requires only the prompt',
    Array.isArray((TASK_TOOL_SPEC.parameters as { required?: unknown }).required) &&
    (TASK_TOOL_SPEC.parameters as { required: string[] }).required.length === 1)
  // A stand-in for the full registry: the blocklist has to strip the
  // interactive and recursive tools wherever they sit in the list.
  const registry = [
    TASK_TOOL_SPEC,
    { name: 'read_file', description: '', parameters: {} },
    { name: 'ask_user', description: '', parameters: {} },
    { name: 'todo_write', description: '', parameters: {} },
    { name: 'run_command', description: '', parameters: {} }
  ]
  const subNames = filterSubagentSpecs(registry).map((spec) => spec.name)
  check('subagent cannot spawn subagents', !subNames.includes('task'))
  check('subagent cannot ask the user', !subNames.includes('ask_user'))
  check('subagent cannot write the todo list', !subNames.includes('todo_write'))
  check('subagent keeps the file tools', subNames.includes('read_file') && subNames.includes('run_command'))

  let threw = false
  try {
    validateTaskInput({})
  } catch {
    threw = true
  }
  check('task tool requires a prompt', threw)
  const brief = validateTaskInput({ prompt: '  Find every TODO in src/.\nList file and line.  ' })
  check('missing description derives from the prompt', brief.description.includes('Find every TODO'))
  check('prompt is trimmed', brief.prompt.startsWith('Find') && brief.prompt.endsWith('line.'))
  const capped = validateTaskInput({ description: 'x'.repeat(300), prompt: 'do it' })
  check('description is capped', capped.description.length <= 120)

  const prompt = subagentSystemPrompt()
  check('subagent prompt explains the handoff', prompt.includes('final message') && prompt.includes('subagent'))
  const instrDir = fs.mkdtempSync(join(os.tmpdir(), 'halis-subagent-test-'))
  fs.writeFileSync(join(instrDir, 'AGENTS.md'), 'SUBAGENT-INSTR-MARKER')
  setWorkspaceRoot(instrDir)
  check('subagent prompt includes workspace instructions', subagentSystemPrompt().includes('SUBAGENT-INSTR-MARKER'))
  setWorkspaceRoot(null)
  const envelope = taskEnvelope('found 3 todos')
  check('task result is framed', envelope.startsWith('<task-result>') && envelope.endsWith('</task-result>'))
}

/* ---------- mcp ---------- */
/** A stand-in MCP server: node -e script speaking newline-delimited JSON-RPC. */
const FAKE_SERVER = [
  "process.stdin.setEncoding('utf8')",
  "let buf = ''",
  "process.stdin.on('data', (c) => {",
  "  buf += c",
  "  let i",
  "  while ((i = buf.indexOf('\\n')) !== -1) {",
  "    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)",
  "    if (line) handle(JSON.parse(line))",
  "  }",
  "})",
  "function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n') }",
  "function handle(msg) {",
  "  if (msg.method === 'initialize') reply(msg.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } })",
  "  else if (msg.method === 'tools/list') reply(msg.id, { tools: [{ name: 'echo', description: 'echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] })",
  "  else if (msg.method === 'tools/call') reply(msg.id, { content: [{ type: 'text', text: 'echo: ' + msg.params.arguments.text }] })",
  "}"
].join('\n')

async function mcpChecks(): Promise<void> {
  const missing = parseMcpConfig({})
  check('mcp config wants an mcpServers object', missing.errors.length === 1 && Object.keys(missing.servers).length === 0)
  const bad = parseMcpConfig({ mcpServers: { a: {}, b: { command: 'x', args: [1] }, c: { command: 'y', disabled: true } } })
  check('mcp entries need a command', bad.errors.some((e) => e.startsWith('a:')))
  check('mcp args must be strings', bad.errors.some((e) => e.startsWith('b:')))
  check('disabled mcp servers are skipped', !('c' in bad.servers))
  const good = parseMcpConfig({ mcpServers: { srv: { command: 'npx', args: ['-y', 'x'], env: { K: 'v' }, toolTimeoutMs: 999_999 } } })
  check('valid mcp entry parses', good.errors.length === 0 && good.servers.srv?.command === 'npx')
  check('mcp tool timeout is capped', good.servers.srv?.toolTimeoutMs === 300_000)

  check('mcp names are sanitized', sanitizeMcpName('my server!') === 'my_server_')
  check('mcp tool names carry the prefix', mcpToolName('github', 'create issue') === 'mcp__github__create_issue')
  const flat = flattenMcpContent({
    content: [
      { type: 'text', text: 'a' },
      { type: 'image', data: 'xx', mimeType: 'image/png' },
      { type: 'text', text: 'b' }
    ]
  })
  check('text blocks are joined', flat.text.includes('a') && flat.text.includes('b') && !flat.isError)
  check('binary blocks are counted', flat.text.includes('[1 binary block omitted]'))
  const errFlat = flattenMcpContent({ content: [{ type: 'text', text: 'boom' }], isError: true })
  check('mcp isError survives flattening', errFlat.isError && errFlat.text === 'boom')
  const structured = flattenMcpContent({ content: [], structuredContent: { rows: 2 } })
  check('structured content rides along', structured.text.includes('"rows"'))

  // Live handshake against the fake stdio server, config file and all.
  const configDir = fs.mkdtempSync(join(os.tmpdir(), 'halis-mcp-test-'))
  const file = join(configDir, 'mcp.json')
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: ['-e', FAKE_SERVER] } } }))
  setMcpConfigFileForTests(file)
  await syncMcpServers()
  const specs = mcpToolSpecs()
  const echo = specs.find((spec) => spec.name === 'mcp__fake__echo')
  check('fake mcp server offers its tool', echo !== undefined)
  check('mcp spec names its server', (echo?.description ?? '').includes('[fake]'))
  const called = await callMcpTool('mcp__fake__echo', { text: 'hi there' })
  check('mcp tool round-trips', called.ok && called.output.includes('echo: hi there'))
  const unknown = await callMcpTool('mcp__fake__nope', {})
  check('missing mcp tools report clearly', !unknown.ok && unknown.output.includes('not available'))
  check('one mcp connection is up', mcpConnectionCount() === 1)
  stopAllMcpServers()
  check('mcp connections stop cleanly', mcpConnectionCount() === 0)
  setMcpConfigFileForTests(null)
}

/* ---------- background jobs ---------- */
async function jobChecks(): Promise<void> {
  const jobDir = fs.mkdtempSync(join(os.tmpdir(), 'halis-jobs-test-'))
  configureJobStore(jobDir)
  const notices: JobNoticeEvent[] = []
  setJobSink((event) => {
    notices.push(event)
  })
  const { job } = startBackgroundJob('echo halis-job-ok', jobDir, 0)
  check('background job starts running', jobStatus(job.id)?.status === 'running')
  await waitFor(() => notices.length > 0, 5_000)
  check(
    'background job notifies on settle',
    notices[0] !== undefined && notices[0].status === 'completed' && notices[0].output.includes('halis-job-ok')
  )
  check('settled job keeps its exit code', jobStatus(job.id)?.exitCode === 0)
  check('job output file is readable', tailChars(job.outputFile, 200).includes('halis-job-ok'))
  // Portable long-running command: `sleep` does not exist in Windows cmd,
  // and a failed spawn would fail this suite there even when the code
  // under test is fine.
  const sleeper = startBackgroundJob(`"${process.execPath}" -e "setInterval(() => {}, 1e6)"`, jobDir, 0)
  check('job_kill stops a running job', killJob(sleeper.job.id))
  await waitFor(() => notices.length > 1, 5_000)
  check(
    'killed job reports as killed',
    notices[1] !== undefined && notices[1].status === 'killed'
  )
  check('killJob refuses unknown ids', killJob('sh-does-not-exist') === false)
  setJobSink(null)
}

function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const tick = (): void => {
      if (condition()) {
        resolve()
        return
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('waitFor timed out'))
        return
      }
      setTimeout(tick, 25)
    }
    tick()
  })
}

void gitChecks()
  .then(() => {
    subagentChecks()
  })
  .then(() => mcpChecks())
  .then(() => jobChecks())
  .then(() => {
    if (failures > 0) {
      console.error(`\n${failures} failure(s)`)
      process.exit(1)
    }
    console.log('\nall smoke tests passed')
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
