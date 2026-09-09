/**
 * Board view: the multi-column kanban that replaces the middle column while
 * active. Cards open the task detail (never execute directly); the header
 * offers filter, new-task, and a back-to-chat escape.
 */
import { memo, useCallback, useEffect, useState } from 'react'
import { selectedTaskOf, type BoardController } from '../../core/controller.ts'
import { DEFAULT_PROJECT_ID, projectOf, type ProjectRecord } from '../../core/projects.ts'
import { COLUMNS, canMoveManually, MANUAL_STATUSES, pendingParentTasks, taskGateNote, type TaskRecord } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'
import { Dashboard } from './Dashboard.tsx'
import { NewTaskModal } from './NewTaskModal.tsx'
import { ProjectManagerModal } from './ProjectManagerModal.tsx'
import { ProjectSwitcher } from './ProjectSwitcher.tsx'
import { STATUS_KEY } from './status-key.ts'
import { TaskCard } from './TaskCard.tsx'
import { TaskDetail } from './TaskDetail.tsx'

/**
 * Filter match: a query shaped like "#N" locates a card by its stable
 * serial number (exact match, whitespace around the number tolerated);
 * anything else is the usual case-insensitive
 * title/description/freeze-snapshot substring match.
 */
export function matchesFilter(task: TaskRecord, filter: string): boolean {
  const query = filter.trim()
  if (query === '') return true
  const serialQuery = /^#\s*(\d+)$/.exec(query.toLowerCase())
  if (serialQuery !== null) {
    return task.serial !== undefined && task.serial === Number(serialQuery[1])
  }
  const needle = query.toLowerCase()
  const haystacks = [task.title, task.description]
  if (task.freeze !== undefined) haystacks.push(task.freeze.goal, task.freeze.progress, task.freeze.next)
  return haystacks.some(text => text.toLowerCase().includes(needle))
}

/**
 * Memoized per-card adapter: with a stable `onOpen` from the board, an
 * immutable task record (only the changed card gets a new object ref), and a
 * stable gate state (0/undefined when open), a card re-renders only when its
 * own task or gate state changes — not when a sibling card status, the
 * filter, or the selection moves.
 */
const MemoTaskCard = memo(function MemoTaskCard({ task, pending, timeZone, onOpen, onOpenSession, gateCount, gateNote, projects }: {
  task: TaskRecord
  pending: boolean
  timeZone?: string
  onOpen: (id: string) => void
  onOpenSession: (sessionId: string) => void
  gateCount: number
  gateNote?: string
  /** The board's project roster; undefined hides the project chip (legacy Host). */
  projects?: readonly ProjectRecord[]
}) {
  const onClick = useCallback(() => { onOpen(task.id) }, [task.id, onOpen])
  return (
    <TaskCard
      task={task}
      pending={pending}
      timeZone={timeZone}
      onClick={onClick}
      onOpenSession={onOpenSession}
      gateCount={gateCount}
      gateNote={gateNote}
      projects={projects}
    />
  )
})

/** Board component; subscribes to the controller snapshot. */
export function TaskBoard({ controller }: { controller: BoardController }) {
  const [snapshot, setSnapshot] = useState(controller.getSnapshot())
  useEffect(
    () => controller.subscribe(() => setSnapshot(controller.getSnapshot())),
    [controller],
  )
  const [filter, setFilter] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showManage, setShowManage] = useState(false)
  const selected = selectedTaskOf(snapshot)
  const archiveView = snapshot.archiveView
  // The project layer only exists once a v4 Host is behind the transport;
  // legacy Hosts (and the localStorage fallback) keep the classic board with
  // no project UI at all.
  const projects = snapshot.projects ?? []
  const projectLayer = snapshot.host !== undefined && projects.length > 0
  const defaultProjectId = snapshot.defaultProjectId ?? DEFAULT_PROJECT_ID
  // A selected project scopes the board (columns, archive, dashboard); it is
  // a display dimension only — dispatch gates and the global #N serial never
  // see it.
  const selectedProjectId = projectLayer ? snapshot.selectedProjectId : undefined
  // Archived tasks leave the columns; the archive view shows them instead.
  const visible = snapshot.tasks.filter(task =>
    (archiveView ? task.archivedAt !== undefined : task.archivedAt === undefined)
    && matchesFilter(task, filter)
    && (selectedProjectId === undefined || projectOf(task, projects) === selectedProjectId),
  )
  const openTask = useCallback((id: string): void => { controller.openTask(id) }, [controller])
  const openSession = useCallback((sessionId: string): void => { controller.openSession(sessionId) }, [controller])

  return (
    <div className={css.board} data-dsh-taskboard-board="" data-dsh-plugin="task-board">
      <header className={css.boardHeader}>
        {/* Shared hook: dsh-web-all offsets center-view back controls beside the collapsed mobile sidebar. */}
        <button
          type="button"
          className={`${css.ghostButton} ${css.backButton}`}
          data-dsh-center-view-back=""
          aria-label={t('board.close')}
          onClick={() => { controller.closeBoard() }}
        >
          <span aria-hidden="true">‹</span>
          <span>{t('board.close')}</span>
        </button>
        <h2 className={css.boardTitle}>{t('board.title')}</h2>
        {snapshot.host !== undefined && (
          <span className={css.detailMeta}>
            {t('board.hostMeta', {
              revision: String(snapshot.host.revision),
              timeZone: snapshot.host.scheduler.timeZone,
            })}
          </span>
        )}
        {snapshot.host !== undefined && snapshot.host.automation !== undefined && (
          <span className={css.detailMeta}>
            {t('board.automationChip', {
              patrol: t(snapshot.host.automation.patrolEnabled ? 'board.patrolOn' : 'board.patrolOff'),
              open: String(snapshot.host.automation.openExecutions),
              cap: String(snapshot.host.automation.maxConcurrency),
            })}
          </span>
        )}
        {projectLayer && (
          <ProjectSwitcher
            controller={controller}
            projects={projects}
            defaultProjectId={defaultProjectId}
            selectedProjectId={selectedProjectId}
            tasks={snapshot.tasks}
            onManage={() => { setShowManage(true) }}
          />
        )}
        <input
          className={css.search}
          type="search"
          placeholder={t('board.search')}
          value={filter}
          onChange={event => { setFilter(event.target.value) }}
          aria-label={t('board.search')}
        />
        <button
          type="button"
          className={archiveView ? css.primaryButton : css.ghostButton}
          onClick={() => { controller.toggleArchiveView() }}
        >
          {archiveView
            ? t('board.backToBoard')
            : t('board.archiveView', { count: String(snapshot.tasks.filter(task => task.archivedAt !== undefined).length) })}
        </button>
        <button
          type="button"
          className={css.primaryButton}
          onClick={() => { setShowNew(true) }}
        >
          + {t('board.new')}
        </button>
      </header>

      {snapshot.transportError !== undefined && (
        <div className={css.formError}>
          {t('board.hostError', { error: snapshot.transportError })}{' '}
          <button type="button" className={css.linkButton} onClick={() => { void controller.retryHostSync() }}>
            {t('board.retryHost')}
          </button>
        </div>
      )}

      <div className={css.columns}>
        {archiveView ? (
          <section className={css.column} data-status="archived" data-dsh-part="column">
            <header className={css.columnHeader}>
              <h3 className={css.columnTitle}>{t('board.archive')}</h3>
              <span className={css.columnCount}>{visible.length}</span>
            </header>
            <div className={css.cards}>
              {visible.map(task => (
                <MemoTaskCard key={task.id} task={task} pending={snapshot.pendingTaskIds.includes(task.id)} timeZone={snapshot.host?.scheduler.timeZone} onOpen={openTask} onOpenSession={openSession} gateCount={0} projects={projectLayer ? projects : undefined} />
              ))}
              {visible.length === 0 && <div className={css.columnEmpty}>{t('archive.empty')}</div>}
            </div>
          </section>
        ) : (
          COLUMNS.map(column => {
            // The dashboard takes over the failed column's grid slot: same
            // position, overview stats plus an actionable failed-tasks list in
            // place of the plain cards.
            if (column.status === 'failed') {
              return (
                <Dashboard
                  key={column.status}
                  controller={controller}
                  tasks={visible}
                  timeZone={snapshot.host?.scheduler.timeZone}
                  projects={projectLayer ? projects : undefined}
                  selectedProjectId={selectedProjectId}
                  onSelectProject={id => { controller.setSelectedProject(id) }}
                  allTasks={snapshot.tasks}
                />
              )
            }
            const tasks = visible.filter(task => task.status === column.status)
            const isManualDropTarget = MANUAL_STATUSES.includes(column.status)
            return (
              <section
                key={column.status}
                className={css.column}
                data-status={column.status}
                data-dsh-part="column"
                onDragOver={isManualDropTarget ? (event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                } : undefined}
                onDrop={isManualDropTarget ? (event) => {
                  event.preventDefault()
                  const taskId = event.dataTransfer.getData('text/plain')
                  if (!taskId) return
                  const dropped = snapshot.tasks.find(t => t.id === taskId)
                  if (dropped && canMoveManually(dropped.status, column.status) && dropped.status !== column.status) {
                    controller.moveTask(taskId, column.status)
                  }
                } : undefined}
              >
                <header className={css.columnHeader}>
                  <span className={css.statusDot} data-status={column.status} aria-hidden="true" />
                  <h3 className={css.columnTitle}>{t(STATUS_KEY[column.status])}</h3>
                  <span className={css.columnCount}>{tasks.length}</span>
                </header>
                <div className={css.cards}>
                  {tasks.map(task => {
                    const pendingParents = pendingParentTasks(task, snapshot.tasks)
                    return (
                      <MemoTaskCard
                        key={task.id}
                        task={task}
                        pending={snapshot.pendingTaskIds.includes(task.id)}
                        timeZone={snapshot.host?.scheduler.timeZone}
                        onOpen={openTask}
                        onOpenSession={openSession}
                        gateCount={pendingParents.length}
                        gateNote={pendingParents.length > 0 ? taskGateNote(task, snapshot.tasks) : undefined}
                        projects={projectLayer ? projects : undefined}
                      />
                    )
                  })}
                  {tasks.length === 0 && <div className={css.columnEmpty}>{t('board.empty')}</div>}
                </div>
              </section>
            )
          })
        )}
      </div>

      {selected !== undefined && (
        <TaskDetail controller={controller} task={selected} />
      )}
      {showNew && (
        <NewTaskModal
          controller={controller}
          onClose={() => { setShowNew(false) }}
          projects={projectLayer ? projects : []}
          defaultProjectId={selectedProjectId ?? defaultProjectId}
        />
      )}
      {showManage && projectLayer && (
        <ProjectManagerModal
          controller={controller}
          projects={projects}
          defaultProjectId={defaultProjectId}
          tasks={snapshot.tasks}
          transportError={snapshot.transportError}
          onClose={() => { setShowManage(false) }}
        />
      )}
    </div>
  )
}
