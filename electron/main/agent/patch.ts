/**
 * The patch tool: apply one multi-file patch. The parser lives in
 * patch-format.ts (pure,
 * smoke-tested); this wrapper owns the filesystem, the diffs and the
 * workspace-change events.
 */
import { shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { resolveInWorkspace, getWorkspaceRoot } from '../workspace'
import { fileDiff } from './diff'
import { applyUpdate, parsePatch, type PatchHunk } from './patch-format'
import { assertEditable, recordWrite } from './observation'
import type { FileDiff } from '../../shared/types'
import type { ToolOutcome } from './tools'

export const PATCH_TOOL_SPEC = {
  name: 'patch',
  description:
    'Apply a multi-file patch: add files, update them in place (with an ' +
    'optional rename) or delete them, all in one call. The format is an ' +
    "envelope of '*** Begin Patch' / '*** End Patch' with one section per " +
    "file: '*** Add File: <path>' followed by '+' lines, '*** Delete File: " +
    "<path>', or '*** Update File: <path>' with '@@' hunks of context, '-' " +
    "and '+' lines, an optional '*** Move to: <path>' and '*** End of File' " +
    'to anchor a hunk at the tail. Prefer this over repeated edit_file calls ' +
    'when several files change at once; prefer edit_file for a single small change.',
  parameters: {
    type: 'object',
    properties: {
      patch_text: {
        type: 'string',
        description:
          'The full patch text, including the Begin/End Patch envelope. ' +
          'Every added line must start with +, even in a new file.'
      }
    },
    required: ['patch_text']
  }
} as const

interface PlannedChange {
  hunk: PatchHunk
  before: string | null
  after: string
  finalPath: string
}

export async function runPatchTool(input: Record<string, unknown>): Promise<ToolOutcome> {
  const patchText = typeof input.patch_text === 'string' ? input.patch_text : ''
  if (patchText.trim().length === 0) {
    throw new Error('Parameter "patch_text" must be the full patch text.')
  }
  const root = getWorkspaceRoot()
  if (!root) {
    throw new Error('No workspace is open. Ask the user to open a folder first.')
  }
  const hunks = parsePatch(patchText)

  // Plan every change before touching the disk so a bad patch fails whole,
  // not half-applied.
  const planned: PlannedChange[] = []
  const touched = new Set<string>()
  for (const hunk of hunks) {
    for (const target of [hunk.path, hunk.type === 'update' ? hunk.movePath : undefined]) {
      if (target === undefined) continue
      if (path.isAbsolute(target) || target.split('/').includes('..')) {
        throw new Error(`Patch path "${target}" must stay inside the workspace.`)
      }
      if (touched.has(target)) {
        throw new Error(`Patch touches "${target}" more than once.`)
      }
      touched.add(target)
    }
    const absolute = resolveInWorkspace(hunk.path)
    const exists = fs.existsSync(absolute) && fs.statSync(absolute).isFile()
    if (hunk.type === 'add') {
      if (exists) {
        throw new Error(`Cannot add "${hunk.path}" — the file already exists.`)
      }
      // Text files end with a newline; an empty Add File stays empty.
      const contents =
        hunk.contents.length > 0 && !hunk.contents.endsWith('\n') ? `${hunk.contents}\n` : hunk.contents
      planned.push({ hunk, before: null, after: contents, finalPath: hunk.path })
      continue
    }
    if (!exists) {
      throw new Error(`Cannot ${hunk.type === 'delete' ? 'delete' : 'update'} "${hunk.path}" — it does not exist.`)
    }
    // The observation gate applies to patches too: an unread file refuses
    // to be updated, deleted or moved.
    assertEditable(absolute, hunk.path)
    const before = fs.readFileSync(absolute, 'utf8')
    if (hunk.type === 'delete') {
      planned.push({ hunk, before, after: '', finalPath: hunk.path })
      continue
    }
    const movePath = hunk.movePath
    if (movePath) {
      const moveTarget = resolveInWorkspace(movePath)
      if (fs.existsSync(moveTarget)) {
        throw new Error(`Cannot move "${hunk.path}" — "${movePath}" already exists.`)
      }
    }
    const after = applyUpdate(hunk.path, hunk.chunks, before)
    planned.push({ hunk, before, after, finalPath: movePath ?? hunk.path })
  }

  const notes: string[] = []
  const diffs: FileDiff[] = []
  const changedPaths: string[] = []
  for (const change of planned) {
    const { hunk, before, after, finalPath } = change
    const target = resolveInWorkspace(finalPath)
    if (hunk.type === 'add') {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, after, 'utf8')
      recordWrite(target)
      notes.push(`Added ${finalPath} (${lineCount(after)} lines)`)
      changedPaths.push(finalPath)
    } else if (hunk.type === 'delete') {
      // Same recoverability as the explorer's delete: trash, not unlink.
      const trashed = await shell.trashItem(resolveInWorkspace(hunk.path)).then(
        () => true,
        () => false
      )
      if (!trashed) {
        throw new Error(`Could not move "${hunk.path}" to the trash; nothing else was rolled back.`)
      }
      notes.push(`Deleted ${hunk.path}`)
      changedPaths.push(hunk.path)
      recordWrite(target)
    } else {
      if (hunk.movePath) {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, after, 'utf8')
        recordWrite(target)
        const trashed = await shell.trashItem(resolveInWorkspace(hunk.path)).then(
          () => true,
          () => false
        )
        if (!trashed) {
          // The new file landed; only the old copy stays behind. Say so.
          throw new Error(
            `Moved content to ${finalPath} but could not trash the old ${hunk.path} — remove it manually.`
          )
        }
        notes.push(`Moved ${hunk.path} to ${hunk.movePath} and applied the hunks`)
        changedPaths.push(hunk.path, finalPath)
        recordWrite(resolveInWorkspace(hunk.path))
      } else {
        fs.writeFileSync(target, after, 'utf8')
        recordWrite(target)
        notes.push(`Updated ${finalPath}`)
        changedPaths.push(finalPath)
      }
    }
    const diff = fileDiff(finalPath, before, hunk.type === 'delete' ? '' : after)
    if (diff && (diff.added > 0 || diff.removed > 0 || hunk.type === 'add')) {
      diffs.push(diff)
    }
  }

  return {
    ok: true,
    output: `Applied ${notes.length} change${notes.length === 1 ? '' : 's'}:\n- ${notes.join('\n- ')}`,
    changedPaths,
    diff: diffs
  }
}

function lineCount(text: string): number {
  if (text.length === 0) return 0
  return text.split('\n').length
}
