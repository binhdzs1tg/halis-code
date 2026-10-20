/**
 * Inspection handles for background jobs: the model reads progress through
 * job_output and stops runaway work through job_kill. The store lives in
 * background.ts; these are the two thin tool wrappers over it.
 */
import type { Tool, ToolOutcome } from '../types.js'
import { jobOutput, killJob, listJobs } from './background.js'

export const jobOutputTool: Tool = {
  spec: {
    name: 'job_output',
    description:
      'Read what a background job has printed so far. Returns the latest output plus the job ' +
      'status; when more output follows, call again with the returned offset. Also fine on a ' +
      'finished job — the output file stays around for a while.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job id from the bash call that started it, like sh-1a2b3c' },
        offset_chars: { type: 'number', description: 'Character position to read from; omit for the tail' },
      },
      required: ['id'],
    },
  },
  async run(input): Promise<ToolOutcome> {
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (!id) return { output: 'error: id is required', ok: false }
    const offset = typeof input.offset_chars === 'number' ? input.offset_chars : undefined
    return { output: jobOutput(id, offset), ok: true }
  },
}

export const jobKillTool: Tool = {
  spec: {
    name: 'job_kill',
    description: 'Stop one background job by id. Use when the command turned out wrong or runs away.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job id to kill' },
      },
      required: ['id'],
    },
  },
  async run(input): Promise<ToolOutcome> {
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (!id) return { output: 'error: id is required', ok: false }
    const outcome = killJob(id)
    if (outcome === 'unknown') {
      const known = listJobs().map((job) => `${job.id} (${job.status})`).join(', ')
      return { output: `error: unknown job "${id}"${known ? ` — known: ${known}` : ''}`, ok: false }
    }
    if (outcome === 'settled') {
      return { output: `job ${id} had already finished — nothing to stop`, ok: true }
    }
    return { output: `sent SIGTERM to job ${id}`, ok: true }
  },
}
