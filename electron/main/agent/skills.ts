/**
 * Skills with progressive disclosure: each skill is a `<dir>/SKILL.md` with
 * YAML frontmatter. The
 * model only ever sees the compact catalog (name + description) in the
 * system prompt; the full body loads on demand through the `skill` tool.
 * Skills live in `.halis/skills/<name>/SKILL.md` inside the workspace.
 */
import fs from 'node:fs'
import path from 'node:path'
import { getWorkspaceRoot, resolveInWorkspace } from '../workspace'
import type { ToolOutcome } from './tools'

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

/**
 * Minimal frontmatter reader for the three keys that matter; anything
 * malformed is skipped with a console warning, never fatal.
 */
function parseSkillFile(filePath: string, raw: string): SkillDefinition | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!match) {
    console.warn(`skills: ${filePath}: skipped — missing frontmatter`)
    return null
  }
  const fields = new Map<string, string>()
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const entry = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim())
    const key = entry?.[1]
    if (entry && key !== undefined) fields.set(key, (entry[2] ?? '').trim())
  }
  const name = fields.get('name') ?? ''
  const description = (fields.get('description') ?? '').slice(0, DESCRIPTION_MAX_CHARS)
  if (!NAME_PATTERN.test(name) || description.length === 0) {
    console.warn(`skills: ${filePath}: skipped — needs a kebab-case "name" and a "description"`)
    return null
  }
  const content = raw.slice(match[0].length).trim()
  if (!content) {
    console.warn(`skills: ${filePath}: skipped — empty body`)
    return null
  }
  return {
    name,
    description,
    whenToUse: fields.get('whenToUse') || null,
    path: filePath,
    content
  }
}

/** Every readable skill in the workspace, sorted by name. */
export function listSkills(): SkillSummary[] {
  const root = getWorkspaceRoot()
  if (!root) return []
  const directory = path.join(root, '.halis', 'skills')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const skills: SkillDefinition[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const filePath = path.join(directory, entry.name, 'SKILL.md')
    try {
      const skill = parseSkillFile(filePath, fs.readFileSync(filePath, 'utf8'))
      if (skill && skill.name === entry.name) {
        skills.push(skill)
      } else if (skill) {
        console.warn(`skills: ${filePath}: folder and frontmatter name disagree`)
      }
    } catch {
      // No SKILL.md or unreadable — skip quietly.
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

function skillByName(name: string): SkillDefinition | null {
  const root = getWorkspaceRoot()
  if (!root) return null
  if (!NAME_PATTERN.test(name)) return null
  const filePath = path.join(root, '.halis', 'skills', name, 'SKILL.md')
  try {
    return parseSkillFile(filePath, fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The compact catalog injected into the system prompt. Summaries only —
 * the closing line teaches the model not to act on an unloaded skill.
 */
export function skillCatalogBlock(): string | null {
  const skills = listSkills()
  if (skills.length === 0) return null
  const lines = [
    'The workspace provides the following skills. This catalog contains summaries only; ' +
      'do not infer or follow a skill\u2019s instructions until it has been loaded with the skill tool.'
  ]
  for (const skill of skills) {
    const when = skill.whenToUse ? ` (use when: ${skill.whenToUse})` : ''
    lines.push(`- \`${skill.name}\`: ${skill.description}${when}`)
  }
  return `<system-reminder>\n${lines.join('\n')}\n</system-reminder>`
}

export const SKILL_TOOL_NAME = 'skill'

export const SKILL_TOOL_SPEC = {
  name: SKILL_TOOL_NAME,
  description:
    'Load the full instructions of a workspace skill by name. The system prompt lists the ' +
    'available skills as one-line summaries; load a skill before acting on what its summary ' +
    'suggests, and follow its instructions once loaded.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name from the catalog' }
    },
    required: ['name']
  }
} as const

/** Body text may not forge the closing tag of the wrapper block. */
function escapeBody(text: string): string {
  return text.replace(/<\/skill_content>/g, '<\\/skill_content>')
}

export function runSkillTool(input: Record<string, unknown>): ToolOutcome {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) {
    return { ok: false, output: 'Parameter "name" must be a skill name from the catalog.' }
  }
  const skill = skillByName(name)
  if (!skill) {
    const available = listSkills().map((item) => item.name)
    const hint = available.length > 0 ? ` Available: ${available.join(', ')}.` : ' No skills are installed.'
    return { ok: false, output: `Unknown skill "${name}".${hint}` }
  }
  const base = path.dirname(resolveInWorkspace(path.relative(getWorkspaceRoot() ?? '.', skill.path)))
  const body = [
    `<skill_content name="${skill.name}">`,
    `<skill_resources>Supporting files, if any, live next to ${skill.path} under ${base}</skill_resources>`,
    '<skill_instructions>',
    escapeBody(skill.content),
    '</skill_instructions>',
    '</skill_content>'
  ].join('\n')
  return { ok: true, output: body }
}
