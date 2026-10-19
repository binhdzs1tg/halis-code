/**
 * Skills with progressive disclosure: each skill is a `<dir>/SKILL.md` with
 * YAML frontmatter. The model only ever sees the compact catalog (name +
 * description) in the system prompt; the full body loads on demand through
 * the `skill` tool. Skills live in `.halis/skills/<name>/SKILL.md` inside
 * the workspace, with a user-wide set in `~/.halis/skills` behind them.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Tool, ToolOutcome } from '../types.js'

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DESCRIPTION_MAX_CHARS = 500

export interface SkillSummary {
  name: string
  description: string
  whenToUse: string | null
  path: string
}

export interface SkillDefinition extends SkillSummary {
  content: string
}

/** Workspace first, then the user-wide folder; the same name shadows the latter. */
export function skillRoots(cwd: string): string[] {
  return [path.join(cwd, '.halis', 'skills'), path.join(process.env.HALIS_HOME ?? path.join(os.homedir(), '.halis'), 'skills')]
}

/**
 * Minimal frontmatter reader for the keys that matter; anything malformed
 * is skipped with a warning, never fatal.
 */
function parseSkillFile(filePath: string, raw: string): SkillDefinition | null {
  // Windows editors love to write a BOM; it must not break the frontmatter
  // anchor or every SKILL.md saved with one gets skipped.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return null
  const fields = new Map<string, string>()
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const entry = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim())
    const key = entry?.[1]
    if (entry && key !== undefined) fields.set(key, (entry[2] ?? '').trim())
  }
  const name = fields.get('name') ?? ''
  const description = (fields.get('description') ?? '').slice(0, DESCRIPTION_MAX_CHARS)
  if (!NAME_PATTERN.test(name) || description.length === 0) return null
  return {
    name,
    description,
    whenToUse: fields.get('when_to_use') || null,
    path: filePath,
    content: text.slice(match[0]?.length ?? 0).trim(),
  }
}

export function listSkills(cwd: string): SkillSummary[] {
  const skills: SkillSummary[] = []
  const seen = new Set<string>()
  for (const directory of skillRoots(cwd)) {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue
      const filePath = path.join(directory, entry.name, 'SKILL.md')
      try {
        const skill = parseSkillFile(filePath, fs.readFileSync(filePath, 'utf8'))
        if (skill && skill.name === entry.name) {
          skills.push(skill)
          seen.add(entry.name)
        }
      } catch {
        // No SKILL.md or unreadable — skip quietly.
      }
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

function skillByName(cwd: string, name: string): SkillDefinition | null {
  if (!NAME_PATTERN.test(name)) return null
  for (const directory of skillRoots(cwd)) {
    const filePath = path.join(directory, name, 'SKILL.md')
    try {
      return parseSkillFile(filePath, fs.readFileSync(filePath, 'utf8'))
    } catch {
      // next root
    }
  }
  return null
}

/**
 * The compact catalog injected into the system prompt. Summaries only —
 * the closing line teaches the model not to act on an unloaded skill.
 */
export function skillCatalogBlock(cwd: string): string | null {
  const skills = listSkills(cwd)
  if (skills.length === 0) return null
  const lines = [
    'The workspace provides the following skills. This catalog contains summaries only; ' +
      'do not infer or follow a skill’s instructions until it has been loaded with the skill tool.',
  ]
  for (const skill of skills) {
    const when = skill.whenToUse ? ` (use when: ${skill.whenToUse})` : ''
    lines.push(`- \`${skill.name}\`: ${skill.description}${when}`)
  }
  return `<system-reminder>\n${lines.join('\n')}\n</system-reminder>`
}

export const skillTool: Tool = {
  spec: {
    name: 'skill',
    description:
      'Load the full instructions of a workspace skill by name. The system prompt lists the ' +
      'available skills as one-line summaries; load a skill before acting on what its summary ' +
      'suggests, and follow its instructions once loaded.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name from the catalog' },
      },
      required: ['name'],
    },
  },
  run(input, ctx): Promise<ToolOutcome> {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) {
      return Promise.resolve({ ok: false, output: 'Parameter "name" must be a skill name from the catalog.' })
    }
    const skill = skillByName(ctx.cwd, name)
    if (!skill) {
      const available = listSkills(ctx.cwd).map((item) => item.name)
      const hint = available.length > 0 ? ` Available: ${available.join(', ')}.` : ' No skills are installed.'
      return Promise.resolve({ ok: false, output: `Unknown skill "${name}".${hint}` })
    }
    const base = path.dirname(skill.path)
    const body = [
      `<skill_content name="${skill.name}">`,
      `<skill_resources>Supporting files, if any, live next to ${skill.path} under ${base}</skill_resources>`,
      '<skill_instructions>',
      escapeBody(skill.content),
      '</skill_instructions>',
      '</skill_content>',
    ].join('\n')
    return Promise.resolve({ ok: true, output: body })
  },
}

/** Body text may not forge the closing tag of the wrapper block. */
function escapeBody(text: string): string {
  return text.replace(/<\/skill_content>/g, '<\\/skill_content>')
}
