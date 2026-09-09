/**
 * Task card: the board's column item. The body button opens the task detail —
 * it never executes anything directly (detail holds the Run button). The
 * session button (magnifier, top-right corner) jumps straight to the task's
 * newest execution session; without a session yet it falls back to opening
 * the detail (description / context live there).
 *
 * Memoized: the card re-renders only when its own task record, gate state,
 * or click handler changes, so a status/filter update on one card (or
 * scrolling) never re-renders every card on the board. The per-card onClick
 * is built with a stable task reference by the board, so the memo boundary
 * is effective.
 */
import { memo } from 'react'
import type { TaskRecord } from '../../core/tasks.ts'
import { executionLabel, latestSessionIdOf } from '../../core/tasks.ts'
import { projectOf, type ProjectRecord } from '../../core/projects.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'

/** Compact relative/absolute time label. */
export function formatHostTimestamp(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
      ...(timeZone === undefined ? {} : { timeZone }),
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString()
  }
}

export function formatTime(ms: number, timeZone?: string): string {
  const date = new Date(ms)
  const now = Date.now()
  const minutes = Math.floor((now - ms) / 60000)
  if (minutes < 1) return t('time.justNow')
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  if (timeZone !== undefined) return formatHostTimestamp(ms, timeZone)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function TaskCardInner({ task, pending, timeZone, onClick, onOpenSession, gateCount, gateNote, projects }: {
  task: TaskRecord
  pending: boolean
  timeZone?: string
  onClick: () => void
  /** Jump to a task's execution session (the detail fallback is `onClick`). */
  onOpenSession: (sessionId: string) => void
  /** Pending parent-task count for the dependency gate (0 = open). */
  gateCount: number
  /** The pending parent titles, for the badge tooltip. */
  gateNote?: string
  /** The board's project roster; undefined hides the project chip (legacy Host). */
  projects?: readonly ProjectRecord[]
}) {
  const latest = task.executions[task.executions.length - 1]
  const runs = task.executions.length
  const archived = task.archivedAt !== undefined
  const isDraggable = !archived && task.status !== 'running' && !pending
  const sessionId = latestSessionIdOf(task)
  const sessionLabel = sessionId !== undefined ? t('card.viewSession') : t('card.openDetail')
  // The card's owning project (dangling pins fall back to the default,
  // mirroring the ledger's load-time backfill); hidden without a roster.
  const owningProject = projects === undefined ? undefined
    : projects.find(project => project.id === projectOf(task, projects))
  const openSession = (): void => {
    if (sessionId !== undefined) onOpenSession(sessionId)
    else onClick()
  }

  return (
    <div
      className={css.card}
      data-status={archived ? 'archived' : task.status}
      data-dsh-part="card"
      data-pending={pending || undefined}
      draggable={isDraggable}
      onDragStart={isDraggable ? (event) => {
        event.dataTransfer.setData('text/plain', task.id)
        event.dataTransfer.effectAllowed = 'move'
      } : undefined}
      title={task.description !== '' ? task.description : task.title}
    >
      <button type="button" className={css.cardBody} onClick={onClick}>
        {task.serial !== undefined && (
          <span className={css.cardSerial} title={t('card.serial', { serial: String(task.serial) })}>#{task.serial}</span>
        )}
        <span className={css.cardTitle}>{task.title}</span>
        {task.description !== '' && <span className={css.cardExcerpt}>{task.description}</span>}
        <span className={css.cardMeta}>
          <span className={css.cardTime}>{t('board.updated')} {formatTime(task.updatedAt)}</span>
          {owningProject !== undefined && (
            <span className={css.projectChip} title={owningProject.name}>
              <span
                className={css.projectDot}
                aria-hidden="true"
                style={{ background: `var(${owningProject.color})` }}
              />
              <span className={css.projectChipName}>{owningProject.name}</span>
            </span>
          )}
          {task.freeze !== undefined && (
            <span className={css.cardSchedule} title={task.freeze.goal}>{t('card.frozen')}</span>
          )}
          {!archived && task.schedule?.enabled === true && (
            <span
              className={css.cardSchedule}
              title={task.schedule.nextRunAt !== undefined
                ? `${t('card.scheduled')} · ${formatHostTimestamp(task.schedule.nextRunAt, timeZone)}`
                : t('card.scheduled')}
            >
              {t('card.scheduled')}
            </span>
          )}
          {!archived && gateCount > 0 && (
            <span className={css.cardGate} title={gateNote}>{t('card.gated', { count: String(gateCount) })}</span>
          )}
          {!archived && (task.reworkNotes ?? []).some(item => item.consumedAt === undefined) && (
            <span className={css.cardRework} title={t('card.reworkPendingTitle')}>{t('card.reworkPending')}</span>
          )}
          {latest !== undefined && (
            <span className={css.cardRun} data-result={archived ? undefined : latest.result}>
              {runs} {t('board.runs')}
            </span>
          )}
          {!archived && (task.status === 'running' || pending) && <span className={css.cardSpinner} aria-hidden="true" />}
        </span>
        {!archived && pending && <span className={css.cardRunningLabel}>{t('board.pending')}…</span>}
        {!archived && latest !== undefined && executionLabel(latest) === 'running' && (
          <span className={css.cardRunningLabel}>{t('detail.result.running')}…</span>
        )}
      </button>
      <button
        type="button"
        className={css.cardSessionButton}
        onClick={openSession}
        title={sessionLabel}
        aria-label={sessionLabel}
      >
        <span aria-hidden="true">⌕</span>
      </button>
    </div>
  )
}

/** Memoized card: re-renders only when the card's own task record changes. */
export const TaskCard = memo(TaskCardInner)
