/**
 * Dashboard panel: takes over the failed column's slot. It aggregates the
 * same visible board set as the columns (status tiles, settled-run tally,
 * armed schedules) and lists failed tasks with quick actions (re-run, move
 * to to-do), so failures stay actionable without a dedicated column. The
 * overview carries a today/total dimension switcher: "total" is the
 * cumulative view; "today" slices the same board from the Host-local
 * midnight (tasks by creation time, settled runs by settlement time) and is
 * the default tab.
 */
import { useMemo, useState } from 'react'
import type { BoardController } from '../../core/controller.ts'
import { failedTasks, latestFailureOf, startOfDayMs, summarizeBoard, summarizeByProject, summarizeToday, upcomingSchedules } from '../../core/dashboard.ts'
import { DEFAULT_PROJECT_ID, projectOf, type ProjectRecord } from '../../core/projects.ts'
import { COLUMNS, type TaskRecord } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'
import { STATUS_KEY } from './status-key.ts'
import { formatHostTimestamp, formatTime } from './TaskCard.tsx'

/** How many upcoming runs and failed tasks the dashboard lists. */
const SCHEDULE_LIMIT = 3
const FAILED_LIMIT = 5

/** The two overview dimensions: today's slice (default) or the cumulative total. */
type DashboardDimension = 'today' | 'total'

/**
 * Dashboard panel replacing the failed column. Reads the visible board set
 * and keeps the failed count in the header pill; rows open the task detail,
 * and per-row quick actions stay one click away.
 *
 * With a project layer the panel gains a scope switch: "all" adds the
 * per-project table (row click drills the board into that project); picking
 * a project scopes every section to it (the board pre-filters the task set,
 * so the tiles, runs, and lists follow automatically).
 */
export function Dashboard({ controller, tasks, timeZone, projects, selectedProjectId, onSelectProject, allTasks }: {
  controller: BoardController
  tasks: readonly TaskRecord[]
  timeZone?: string
  /** The board's project roster; empty/absent hides the project dimension. */
  projects?: readonly ProjectRecord[]
  /** The board's selected project filter (undefined = all projects). */
  selectedProjectId?: string
  /** Drills the board into a project from the table (or back to all). */
  onSelectProject?: (id: string | undefined) => void
  /** The full board set (archived included); feeds the per-project table. */
  allTasks?: readonly TaskRecord[]
}) {
  const [dimension, setDimension] = useState<DashboardDimension>('today')
  // The Host-local midnight boundary of the current wall-clock day; recomputed
  // as the board data (or the host zone) changes, so a day rollover picked
  // up on the next data tick re-slices the today view.
  const startMs = useMemo(() => startOfDayMs(Date.now(), timeZone), [tasks, timeZone])
  const summary = dimension === 'total' ? summarizeBoard(tasks) : summarizeToday(tasks, startMs)
  const failed = failedTasks(tasks, FAILED_LIMIT)
  const scheduled = upcomingSchedules(tasks, SCHEDULE_LIMIT)
  const settled = summary.runs.succeeded + summary.runs.failed + summary.runs.cancelled
  const projectLayer = (projects?.length ?? 0) > 0
  const activeProject = selectedProjectId !== undefined
    ? projects?.find(project => project.id === selectedProjectId) ?? undefined
    : undefined
  // The per-project table only in "all" scope: one row per project with the
  // on-board card count, the archived count, and the project's settled-run
  // success rate. Row click drills the board into that project.
  const projectRows = useMemo(() => {
    if (!projectLayer || activeProject !== undefined || projects === undefined) return []
    const source = allTasks ?? tasks
    return summarizeByProject(source, projects).map(row => {
      const scoped = summarizeBoard(source.filter(task => projectOf(task, projects) === row.projectId))
      return { ...row, successRate: scoped.successRate }
    })
  }, [projectLayer, activeProject, projects, allTasks, tasks])

  const openTask = (id: string): void => { controller.openTask(id) }
  const rowKeyDown = (event: { key: string; preventDefault(): void }, id: string): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openTask(id)
    }
  }
  const selectDimension = (next: DashboardDimension): void => { setDimension(next) }

  return (
    <section className={css.column} data-status="dashboard" data-dsh-part="dashboard">
      <header className={css.columnHeader}>
        <h3 className={css.columnTitle}>{t('board.dashboard')}</h3>
        <span className={css.columnCount}>{summary.counts.failed}</span>
      </header>
      <div className={css.dashBody}>
        <div className={css.dashSection}>
          <div className={css.dashHeadRow}>
            <h4 className={css.dashSectionTitle}>{t('dash.overview')}</h4>
            <div className={css.dashDimTabs} role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={dimension === 'today'}
                className={dimension === 'today' ? css.dashDimTabOn : css.dashDimTab}
                onClick={() => { selectDimension('today') }}
                title={t('dash.dimHintToday')}
              >
                {t('dash.dimToday')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={dimension === 'total'}
                className={dimension === 'total' ? css.dashDimTabOn : css.dashDimTab}
                onClick={() => { selectDimension('total') }}
                title={t('dash.dimHintTotal')}
              >
                {t('dash.dimTotal')}
              </button>
            </div>
            {projectLayer && projects !== undefined && (
              <select
                className={css.select}
                style={{ width: 'auto', height: '28px' }}
                value={selectedProjectId ?? ''}
                aria-label={t('dash.byProject')}
                onChange={event => { onSelectProject?.(event.target.value === '' ? undefined : event.target.value) }}
              >
                <option value="">{t('proj.all')}</option>
                {projects.map(project => (
                  <option key={project.id} value={project.id}>
                    {project.name}{project.id === DEFAULT_PROJECT_ID ? t('proj.defaultTag') : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
          {activeProject !== undefined && (
            <div className={css.dashMuted}>{t('dash.projectScopeHint', { name: activeProject.name })}</div>
          )}
          <div className={css.dashTiles}>
            {COLUMNS.map(column => (
              <div key={column.status} className={css.dashTile}>
                <span className={css.statusDot} data-status={column.status} aria-hidden="true" />
                <span className={css.dashTileValue}>{summary.counts[column.status]}</span>
                <span className={css.dashTileLabel}>{t(STATUS_KEY[column.status])}</span>
              </div>
            ))}
          </div>
          {settled === 0
            ? <div className={css.dashMuted}>{t(dimension === 'today' ? 'dash.noRunsToday' : 'dash.noRuns')}</div>
            : (
              <div className={css.dashRunRow}>
                <span>{t('dash.succeeded', { count: String(summary.runs.succeeded) })}</span>
                <span>{t('dash.failedRuns', { count: String(summary.runs.failed) })}</span>
                <span>{t('dash.cancelled', { count: String(summary.runs.cancelled) })}</span>
                <span className={css.dashSuccessRate}>{t('dash.successRate', { rate: String(summary.successRate) })}</span>
              </div>
            )}
        </div>

        {projectRows.length > 0 && (
          <div className={css.dashSection}>
            <h4 className={css.dashSectionTitle}>{t('dash.byProject')}</h4>
            <table className={css.projectTable}>
              <thead>
                <tr>
                  <th>{t('new.project')}</th>
                  <th>{t('dash.projectCards')}</th>
                  <th>{t('dash.projectArchived')}</th>
                  <th>{t('dash.projectSuccessRate')}</th>
                </tr>
              </thead>
              <tbody>
                {projectRows.map((row) => {
                  const onBoard = row.total - row.archived
                  return (
                    <tr
                      key={row.projectId}
                      className={css.projectTableRow}
                      onClick={() => { onSelectProject?.(row.projectId) }}
                    >
                      <td>
                        <span className={css.projectTableProject}>
                          <span
                            className={css.projectDot}
                            aria-hidden="true"
                            style={{ background: `var(${row.color})` }}
                          />
                          {row.name}
                        </span>
                      </td>
                      <td>{onBoard}</td>
                      <td>{row.archived}</td>
                      <td>{row.successRate === undefined ? '—' : `${row.successRate}%`}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className={css.dashSection}>
          <h4 className={css.dashSectionTitle}>{t('dash.scheduledNext')}</h4>
          {scheduled.length === 0
            ? <div className={css.dashEmpty}>{t('dash.noScheduled')}</div>
            : scheduled.map(row => (
              <div
                key={row.task.id}
                className={css.dashRow}
                role="button"
                tabIndex={0}
                onClick={() => { openTask(row.task.id) }}
                onKeyDown={(event) => { rowKeyDown(event, row.task.id) }}
              >
                <div className={css.dashRowMain}>
                  <span className={css.dashRowTitle}>{row.task.title}</span>
                  <span className={css.dashRowTime}>
                    {t('detail.schedule.nextRun')} {formatHostTimestamp(row.nextRunAt, timeZone)}
                  </span>
                </div>
              </div>
            ))}
        </div>

        <div className={css.dashSection}>
          <h4 className={css.dashSectionTitle}>{t('dash.failedTasks')}</h4>
          {failed.length === 0
            ? <div className={css.dashEmpty}>{t('dash.noFailed')}</div>
            : failed.map(task => {
                const failure = latestFailureOf(task)
                return (
                  <div
                    key={task.id}
                    className={css.dashRow}
                    role="button"
                    tabIndex={0}
                    onClick={() => { openTask(task.id) }}
                    onKeyDown={(event) => { rowKeyDown(event, task.id) }}
                  >
                    <div className={css.dashRowMain}>
                      <span className={css.dashRowTitle}>{task.title}</span>
                      {failure?.error !== undefined && (
                        <span className={css.dashRowError} title={failure.error}>{failure.error}</span>
                      )}
                      <span className={css.dashRowTime}>
                        {t('board.updated')} {formatTime(failure?.endedAt ?? task.updatedAt, timeZone)}
                      </span>
                    </div>
                    <div className={css.dashActions}>
                      <button
                        type="button"
                        className={css.dashActionButton}
                        onClick={(event) => { event.stopPropagation(); void controller.rerunTask(task.id) }}
                      >
                        {t('dash.retry')}
                      </button>
                      <button
                        type="button"
                        className={css.dashActionButton}
                        onClick={(event) => { event.stopPropagation(); controller.moveTask(task.id, 'todo') }}
                      >
                        {t('dash.toTodo')}
                      </button>
                    </div>
                  </div>
                )
              })}
        </div>
      </div>
    </section>
  )
}
