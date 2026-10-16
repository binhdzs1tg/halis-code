/**
 * Approval gate for risky tool calls, ported from DeepSeek Harness's
 * user-approval package: decisions are one-shot (allowed-once or rejected),
 * never persistent grants; with nobody to ask the gate fails closed; and a
 * denial carries the sanctioned way forward instead of leaving the model to
 * work around it.
 */
import { BrowserWindow } from 'electron'
import { IpcChannel } from '../../shared/ipc-channels'
import type {
  ApprovalDecision,
  ApprovalRequestEvent,
  UserQuestionAnswers,
  UserQuestionOption,
  UserQuestionRequestEvent
} from '../../shared/types'
import { shellSettings } from '../settings'
import { assessCommand, denialText } from './risky'

export { denialText }

export { assessCommand }

interface PendingRequest {
  request: ApprovalRequestEvent
  resolve: (decision: ApprovalDecision) => void
  timer: NodeJS.Timeout
}

interface PendingQuestion {
  request: UserQuestionRequestEvent
  resolve: (answers: UserQuestionAnswers) => void
  timer: NodeJS.Timeout
}

/** Generous ceiling; the renderer usually answers in seconds. */
const ANSWER_TIMEOUT_MS = 5 * 60_000
/** Questions may need real thought; allow a little longer than approvals. */
const QUESTION_TIMEOUT_MS = 10 * 60_000

let counter = 0
const pending = new Map<string, PendingRequest>()
const pendingQuestions = new Map<string, PendingQuestion>()
let activeWindow: BrowserWindow | null = null

/** The run loop reports the window it streams into; approvals go there. */
export function setApprovalWindow(win: BrowserWindow | null): void {
  activeWindow = win
}

/** A window going away withdraws everything still open, failing closed. */
export function dropApprovalsForWindow(win: BrowserWindow | null): void {
  if (win && win !== activeWindow) return
  activeWindow = null
  for (const entry of [...pending.values()]) {
    clearTimeout(entry.timer)
    entry.resolve('rejected')
  }
  pending.clear()
  for (const entry of [...pendingQuestions.values()]) {
    clearTimeout(entry.timer)
    entry.resolve(null)
  }
  pendingQuestions.clear()
}

/** Withdraw the approvals of one aborted run; the tool never runs. */
export function dropApprovalsForRun(runId: string): void {
  for (const [id, entry] of [...pending]) {
    if (entry.request.runId !== runId) continue
    clearTimeout(entry.timer)
    pending.delete(id)
    entry.resolve('rejected')
  }
  for (const [id, entry] of [...pendingQuestions]) {
    if (entry.request.runId !== runId) continue
    clearTimeout(entry.timer)
    pendingQuestions.delete(id)
    entry.resolve(null)
  }
}

/**
 * Ask the user once about one flagged call. Resolves 'rejected' when the
 * preset says full access is off and there is no live window to ask, when
 * the user never answers, or when they say no.
 */
export function askApproval(runId: string, callId: string, command: string): Promise<ApprovalDecision> {
  if (shellSettings().commandApproval === 'fullAccess') {
    return Promise.resolve('allowed-once')
  }
  const reason = assessCommand(command)
  if (!reason) {
    return Promise.resolve('allowed-once')
  }
  const win = activeWindow
  if (!win || win.isDestroyed()) {
    return Promise.resolve('rejected')
  }

  const requestId = `approval-${Date.now()}-${(counter += 1)}`
  const request: ApprovalRequestEvent = {
    requestId,
    runId,
    callId,
    toolName: 'run_command',
    reason,
    command
  }

  return new Promise<ApprovalDecision>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      resolve('rejected')
    }, ANSWER_TIMEOUT_MS)
    pending.set(requestId, { request, resolve, timer })
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.ApprovalRequest, request)
    }
  })
}

/** Settle one pending request; unknown or already-settled ids are ignored. */
export function resolveApproval(requestId: unknown, decision: unknown): void {
  if (typeof requestId !== 'string' || (decision !== 'allowed-once' && decision !== 'rejected')) {
    return
  }
  const entry = pending.get(requestId)
  if (!entry) return
  pending.delete(requestId)
  clearTimeout(entry.timer)
  entry.resolve(decision)
}

/* ---------- ask_user questions, the harness's ask-user pattern ---------- */

/**
 * Put one question to the user and wait. Resolves null when there is no live
 * window, when the user skips or times out, or when the run is cancelled —
 * a skipped question is data the model can act on, never an error.
 */
export function askUserQuestion(
  runId: string,
  callId: string,
  question: string,
  options: UserQuestionOption[],
  multiple: boolean
): Promise<UserQuestionAnswers> {
  const win = activeWindow
  if (!win || win.isDestroyed()) {
    return Promise.resolve(null)
  }
  const requestId = `question-${Date.now()}-${(counter += 1)}`
  const request: UserQuestionRequestEvent = { requestId, runId, callId, question, options, multiple }
  return new Promise<UserQuestionAnswers>((resolve) => {
    const timer = setTimeout(() => {
      pendingQuestions.delete(requestId)
      resolve(null)
    }, QUESTION_TIMEOUT_MS)
    pendingQuestions.set(requestId, { request, resolve, timer })
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.UserQuestionRequest, request)
    }
  })
}

/** Settle one pending question; unknown or already-settled ids are ignored. */
export function resolveUserQuestion(requestId: unknown, answers: unknown): void {
  if (typeof requestId !== 'string') return
  if (answers !== null && !isAnswerList(answers)) return
  const entry = pendingQuestions.get(requestId)
  if (!entry) return
  pendingQuestions.delete(requestId)
  clearTimeout(entry.timer)
  entry.resolve(answers === null ? null : (answers as string[]))
}

/** Shape check for the answers coming back from the renderer. */
function isAnswerList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 12) return false
  return value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 500)
}
