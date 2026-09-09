/**
 * Rework/reject prompt composition (the rework flow): the modification notes
 * a settled card was rejected with, composed into the execution prompt when
 * a rework execution opens. Pure, so the text contract stays unit-testable
 * without a gateway.
 */
import type { ReworkNote } from './tasks.ts'

/** Hard cap for a single rework note, enforced by the protocol gate. */
export const REWORK_NOTE_MAX_LENGTH = 8192

/**
 * Compose the rework notes into the prompt text a rework execution sends.
 * For a continued session this IS the whole prompt: the original task prompt
 * already lives in the session history, so only the modification notes are
 * queued. For a fresh session (the last session is gone or the roster is
 * unknown) the caller appends the result after the full task prompt so no
 * context is lost.
 * @param notes - the card's currently unconsumed rework notes, oldest first.
 * @returns the rework section text (never empty for a non-empty note list).
 */
export function reworkSection(notes: readonly ReworkNote[]): string {
  const lines = notes.map((note, index) => `${index + 1}. ${note.note}`)
  return [
    `验收打回修改要求（任务看板）：验收不通过，共 ${notes.length} 条修改意见，请据此修改（原任务目标与上文会话历史保持不变）：`,
    ...lines,
  ].join('\n')
}
