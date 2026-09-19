/**
 * Session-reuse rule (issue #1419): decides which task runs continue in the
 * previous execution's conversation. Pure, so the fail-closed conditions stay
 * unit-testable without a gateway.
 */
import type { TaskRecord } from './tasks.ts'

/**
 * The newest settled execution that resolved a session — the session the
 * card's most recent work actually ran in, or undefined when no such
 * execution exists. The execution record a dispatcher just opened (appended
 * by startExecution BEFORE the launcher picks a session) is deliberately
 * skipped: its session id has not resolved yet, so it cannot be the answer.
 */
export function lastSettledSessionId(task: TaskRecord): string | undefined {
  for (let index = task.executions.length - 1; index >= 0; index -= 1) {
    const execution = task.executions[index]
    if (execution !== undefined && execution.sessionId !== undefined && execution.endedAt !== undefined) return execution.sessionId
  }
  return undefined
}

/**
 * Pick the session a new execution of this task may continue in, or undefined
 * to mint a fresh conversation. Reuse requires ALL of:
 * - the task opted in (`reuseSession === true`);
 * - the task's newest SETTLED execution carries a session id (the record the
 *   current dispatcher just opened is skipped — see {@link lastSettledSessionId});
 * - the roster is known and that session is present and idle.
 *
 * An unknown roster (session/list unavailable) never reuses: minting a fresh
 * conversation is always safe, prompting into a session we cannot see is not.
 * @param task - the task about to run.
 * @param idleSessionIds - ids the last roster saw as present and not running;
 *   undefined when that roster is unknown.
 * @returns the session id to continue in, or undefined for a fresh session.
 */
export function reusableSessionId(
  task: TaskRecord,
  idleSessionIds: ReadonlySet<string> | undefined,
): string | undefined {
  if (task.reuseSession !== true || idleSessionIds === undefined) return undefined
  const sessionId = lastSettledSessionId(task)
  return sessionId !== undefined && idleSessionIds.has(sessionId) ? sessionId : undefined
}

/**
 * Pick the card's SOURCE session for a new execution (the session-row "add as
 * task card" entry), or undefined to fall through to the reuse rule or a
 * fresh conversation. A card created from a session is bound to that
 * conversation: the source anchors every run, ahead of the previous-run
 * session. The fail-closed conditions mirror {@link reusableSessionId}: the
 * roster must be known and the source session present AND idle — minting a
 * fresh conversation is always safe, prompting into a session we cannot see
 * is not.
 * @param task - the task about to run.
 * @param idleSessionIds - ids the last roster saw as present and not running;
 *   undefined when that roster is unknown.
 * @returns the source session id to continue in, or undefined when the card
 * has no source session or the session is not confirmed idle.
 */
export function sourceSessionId(
  task: TaskRecord,
  idleSessionIds: ReadonlySet<string> | undefined,
): string | undefined {
  const source = task.sourceSession?.id
  if (source === undefined || idleSessionIds === undefined) return undefined
  return idleSessionIds.has(source) ? source : undefined
}

/**
 * Pick the session a rework execution continues in (the rework/reject flow),
 * or undefined to mint a fresh conversation carrying the full task prompt
 * plus the modification notes. The card's requirement: a modification round
 * always continues in the ORIGINAL execution session — the recorded session
 * id of the newest SETTLED execution is the authoritative record of where the
 * work happened (the record the rework action just opened is skipped, see
 * {@link lastSettledSessionId}), so NO idle-roster check is applied (an
 * unknown roster right after a restart, or a session missing from the list,
 * must not silently re-home the round in a new conversation). Unlike
 * {@link reusableSessionId} this does not require the card's reuseSession
 * opt-in either: a modification round belongs in the session that did the
 * work.
 *
 * Undefined only when the card never ran to a recorded session: the fresh
 * fallback then carries the full task prompt plus the notes, so no context is
 * lost. If the recorded session was deleted in the meantime, the launch fails
 * with a clear error and the notes stay unconsumed — the next execution
 * re-queues them instead of silently dropping a round.
 * @param task - the task being reworked (its execution list already includes
 *   the record the rework action just opened).
 * @returns the session id to continue in, or undefined for a fresh session.
 */
export function reworkSessionId(task: TaskRecord): string | undefined {
  return lastSettledSessionId(task)
}
