/**
 * Task detail: the full view of one task — content, prompt, execution
 * history — and the only place execution can be triggered. Also offers
 * delete (with confirmation), manual status moves, and a jump to the
 * execution's session transcript.
 */
import { useEffect, useState } from 'react'
import type { BoardController } from '../../core/controller.ts'
import { isValidCron } from '../../core/schedule.ts'
import { childTasks, MANUAL_STATUSES, pendingParentTasks, TASK_PERMISSIONS, type ExecutionRecord, type TaskPermission, type TaskRecord } from '../../core/tasks.ts'
import { DEFAULT_PROJECT_ID, type ProjectRecord } from '../../core/projects.ts'
import { canEditTaskContent } from '../../core/use-cases/task-update.ts'
import { requiresPermissionConfirmation } from '../../core/handover.ts'
import { t, type TaskBoardKey } from '../locales.ts'
import css from '../board.module.css'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { EditTaskModal } from './EditTaskModal.tsx'
import { NewTaskModal } from './NewTaskModal.tsx'
import { ReworkModal } from './ReworkModal.tsx'
import { ScheduleEditor } from './ScheduleEditor.tsx'
import { defaultModelName, groupModelOptions, modelOptionLabel, reasoningEffortLabel, reasoningEffortOptionsFor } from './model-options.ts'
import { formatHostTimestamp, formatTime } from './TaskCard.tsx'
import { STATUS_KEY } from './status-key.ts'

/** Execution outcome → locale key. */
const RESULT_KEY: Record<NonNullable<ExecutionRecord['result']>, TaskBoardKey> = {
  succeeded: 'detail.result.succeeded',
  failed: 'detail.result.failed',
  cancelled: 'detail.result.cancelled',
}

/** One execution-history row. */
function ExecutionRow({ execution, timeZone, onOpen }: { execution: ExecutionRecord; timeZone?: string; onOpen: (sessionId: string) => void }) {
  const result = execution.result
  return (
    <li className={css.executionRow} data-result={result}>
      <span className={css.executionBadge} data-result={result}>
        {result === undefined ? t('detail.result.running') : t(RESULT_KEY[result])}
      </span>
      <span className={css.executionTimes}>
        {t('detail.executionStarted')} {formatTime(execution.startedAt, timeZone)}
        {execution.endedAt !== undefined && ` · ${t('detail.executionEnded')} ${formatTime(execution.endedAt, timeZone)}`}
      </span>
      {execution.initiatedBy !== undefined && (
        <span className={css.executionTimes} title={execution.initiatedBy}>
          {t('detail.execution.initiator', { session: execution.initiatedBy })}
        </span>
      )}
      {execution.sessionId !== undefined && (
        <button
          type="button"
          className={css.linkButton}
          onClick={() => { onOpen(execution.sessionId as string) }}
          title={execution.sessionId}
        >
          {t('detail.viewSession')} ⌁
        </button>
      )}
      {execution.error !== undefined && execution.error !== '' && (
        <span className={css.executionError}>{execution.error}</span>
      )}
    </li>
  )
}

/** The execution-target editor: workspace / mode / permission pickers. */
function ExecutionSettingsSection({ controller, task, pending }: { controller: BoardController; task: TaskRecord; pending: boolean }) {
  const [options, setOptions] = useState(controller.getSnapshot().executionOptions)
  const [projects, setProjects] = useState<readonly ProjectRecord[]>(controller.getSnapshot().projects ?? [])
  const [defaultProjectId, setDefaultProjectId] = useState<string>(controller.getSnapshot().defaultProjectId ?? DEFAULT_PROJECT_ID)
  useEffect(
    () => controller.subscribe(() => {
      setOptions(controller.getSnapshot().executionOptions)
      setProjects(controller.getSnapshot().projects ?? [])
      setDefaultProjectId(controller.getSnapshot().defaultProjectId ?? DEFAULT_PROJECT_ID)
    }),
    [controller],
  )
  // The owning project (unowned = the default project, mirroring the
  // ledger's load-time backfill). The row only renders with a v4 Host,
  // which always carries a non-empty roster.
  const projectId = task.projectId ?? defaultProjectId
  const owningProject = projects.find(project => project.id === projectId)
  const projectKnown = projects.length === 0 || owningProject !== undefined
  const workspaceId = task.workspaceId ?? ''
  const mode = task.mode ?? ''
  const permission = task.permission ?? ''
  const model = task.model ?? ''
  const effort = task.reasoningEffort ?? ''
  // A pinned target may disappear from the runtime (workspace deleted,
  // preset removed); keep it selectable as a stale row instead of silently
  // dropping it, so the user sees exactly what the task will ask for.
  const workspaceKnown = workspaceId === '' || options.workspaces.some(item => item.workspaceId === workspaceId)
  const modeKnown = mode === '' || options.presets.some(item => item.id === mode)
  const modelKnown = model === '' || (options.models ?? []).some(item => item.id === model)
  const effortOptions = reasoningEffortOptionsFor(model, options.defaultModel, options.models ?? [])
  const effortKnown = effort === '' || effortOptions.some(item => item.id === effort)
  return (
    <section className={css.detailSection}>
      <h4>{t('detail.executionSettings')}</h4>
      <p className={css.detailText}>{t('exec.hint')}</p>
      {projects.length > 0 && (
        <div className={css.field}>
          <span className={css.fieldLabel}>
            {t('detail.project')}
            {owningProject !== undefined && (
              <span
                className={css.projectDot}
                aria-hidden="true"
                style={{ background: `var(${owningProject.color})` }}
              />
            )}
          </span>
          <select
            className={css.select}
            value={projectId}
            disabled={pending}
            onChange={event => { controller.updateTask(task.id, { projectId: event.target.value }) }}
          >
            {!projectKnown && <option value={projectId}>{projectId}{t('exec.mode.removed')}</option>}
            {projects.map(project => (
              <option key={project.id} value={project.id}>
                {project.name}{project.id === defaultProjectId ? t('proj.defaultTag') : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.workspace')}</span>
        <select
          className={css.select}
          value={workspaceId}
          disabled={pending}
          onChange={event => { controller.updateTask(task.id, { workspaceId: event.target.value }) }}
        >
          <option value="">{t('exec.workspace.recent')}</option>
          {!workspaceKnown && <option value={workspaceId}>{workspaceId}{t('exec.mode.removed')}</option>}
          {options.workspaces.map(workspace => (
            <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
          ))}
        </select>
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.mode')}</span>
        <select
          className={css.select}
          value={mode}
          disabled={pending}
          onChange={event => { controller.updateTask(task.id, { mode: event.target.value }) }}
        >
          <option value="">{t('exec.mode.default')}</option>
          {!modeKnown && <option value={mode}>{mode}{t('exec.mode.removed')}</option>}
          {options.presets.map(preset => (
            <option key={preset.id} value={preset.id} disabled={preset.broken !== undefined}>
              {preset.name ?? preset.id}
              {preset.isDefault ? t('exec.mode.defaultSuffix') : ''}
              {preset.broken !== undefined ? t('exec.mode.brokenSuffix') : ''}
            </option>
          ))}
        </select>
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.permission')}</span>
        <select
          className={css.select}
          value={permission}
          disabled={pending}
          onChange={event => { controller.updateTask(task.id, { permission: event.target.value === '' ? undefined : event.target.value as TaskPermission }) }}
        >
          <option value="">{t('exec.permission.default')}</option>
          {TASK_PERMISSIONS.map(id => (
            <option key={id} value={id}>{t(`exec.permission.${id}` as TaskBoardKey)}</option>
          ))}
        </select>
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('new.model')}</span>
        <select
          className={css.select}
          value={model}
          disabled={pending}
          onChange={event => {
            // 切模型同时清掉旧强度档位（各模型的档位不同，残留档位必然失效）。
            controller.updateTask(task.id, { model: event.target.value === '' ? undefined : event.target.value, reasoningEffort: undefined })
          }}
        >
          <option value="">{options.defaultModel === undefined || options.defaultModel === ''
            ? t('exec.model.default')
            : t('exec.model.hostDefault', { model: defaultModelName(options.defaultModel, options.models ?? []) })}</option>
          {!modelKnown && <option value={model}>{model}{t('exec.model.unknown')}</option>}
          {groupModelOptions(options.models ?? []).map(group => (
            group.key === ''
              ? group.items.map(item => <option key={item.id} value={item.id}>{modelOptionLabel(item)}</option>)
              : (
                <optgroup key={group.key} label={group.label ?? group.key}>
                  {group.items.map(item => <option key={item.id} value={item.id}>{modelOptionLabel(item)}</option>)}
                </optgroup>
              )
          ))}
        </select>
      </label>
      {(effortOptions.length > 0 || effort !== '') && (
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.effort')}</span>
          <select
            className={css.select}
            value={effort}
            disabled={pending}
            onChange={event => {
              const value = event.target.value
              if (value === '') {
                controller.updateTask(task.id, { reasoningEffort: undefined })
                return
              }
              if (model === '' && options.defaultModel !== undefined && options.defaultModel !== '') {
                // 「宿主默认」路由上选档位：钉住默认路由的模型使档位可落地
                //（select-model 契约要求 provider+model 同发）。
                controller.updateTask(task.id, { model: options.defaultModel, reasoningEffort: value })
                return
              }
              controller.updateTask(task.id, { reasoningEffort: value })
            }}
          >
            <option value="">{t('exec.effort.default')}</option>
            {!effortKnown && <option value={effort}>{effort}{t('exec.effort.unknown')}</option>}
            {effortOptions.map(item => (
              <option key={item.id} value={item.id}>{reasoningEffortLabel(item)}</option>
            ))}
          </select>
        </label>
      )}
      <label className={css.scheduleToggle}>
        <input
          type="checkbox"
          checked={task.reuseSession === true}
          disabled={pending}
          onChange={event => { controller.updateTask(task.id, { reuseSession: event.target.checked }) }}
        />
        <span>{t('exec.reuseSession')}</span>
      </label>
      <p className={css.detailText}>{t('exec.reuseSessionHint')}</p>
    </section>
  )
}

/** The scheduled-runs editor: enable toggle, the structured schedule editor, next/last run info. */
function ScheduleSection({ controller, task, pending }: { controller: BoardController; task: TaskRecord; pending: boolean }) {
  const schedule = task.schedule
  const [cron, setCron] = useState(schedule?.cron ?? '0 9 * * *')
  const [enabled, setEnabled] = useState(schedule?.enabled ?? false)
  const [nextRunAt, setNextRunAt] = useState<number | undefined>(schedule?.nextRunAt)
  const [lastTriggeredAt, setLastTriggeredAt] = useState<number | undefined>(schedule?.lastTriggeredAt)
  const [error, setError] = useState<string | undefined>(undefined)
  const timeZone = controller.getSnapshot().host?.scheduler.timeZone

  // Keep the editor in sync when the task record changes underneath (the
  // schedule rolls forward as runs trigger).
  useEffect(() => {
    setCron(schedule?.cron ?? '0 9 * * *')
    setEnabled(schedule?.enabled ?? false)
    setNextRunAt(schedule?.nextRunAt)
    setLastTriggeredAt(schedule?.lastTriggeredAt)
    setError(undefined)
  }, [task.id, schedule?.enabled, schedule?.cron, schedule?.nextRunAt, schedule?.lastTriggeredAt])

  /** Persist a confirmed cron (spec-tab change or custom-text commit). */
  const commitCron = (value: string): void => {
    const trimmed = value.trim()
    if (trimmed === '' || !isValidCron(trimmed)) {
      setError(t('detail.schedule.invalid'))
      return
    }
    setCron(trimmed)
    setError(undefined)
    if (trimmed !== schedule?.cron) controller.setSchedule(task.id, { cron: trimmed })
  }

  /** Arm/disarm the schedule (arming first persists the edited cron). */
  const toggleEnabled = (next: boolean): void => {
    const trimmed = cron.trim()
    if (next && (trimmed === '' || !isValidCron(trimmed))) {
      setError(t('detail.schedule.invalid'))
      return
    }
    setError(undefined)
    const submitted = controller.setSchedule(task.id, {
      enabled: next,
      ...(next && trimmed !== schedule?.cron ? { cron: trimmed } : {}),
    })
    if (submitted && !controller.isHostBacked()) setEnabled(next)
  }

  const nextLabel = !enabled || nextRunAt === undefined
    ? t('detail.schedule.notScheduled')
    : nextRunAt <= Date.now()
      ? t('detail.schedule.dueSoon')
      : formatHostTimestamp(nextRunAt, timeZone)
  const lastLabel = lastTriggeredAt === undefined ? '—' : formatHostTimestamp(lastTriggeredAt, timeZone)

  return (
    <section className={css.detailSection}>
      <h4>{t('detail.schedule')}</h4>
      <label className={css.scheduleToggle}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={pending}
          onChange={event => { toggleEnabled(event.target.checked) }}
        />
        <span>{t('detail.schedule.enable')}</span>
      </label>
      <ScheduleEditor
        cron={cron}
        onCronChange={commitCron}
        disabled={pending}
        timeZone={timeZone}
      />
      {error !== undefined && <p className={css.formError}>{error}</p>}
      <p className={css.scheduleMeta}>
        {t('detail.schedule.nextRun')} {nextLabel}
        {' · '}{t('detail.schedule.lastTriggered')} {lastLabel}
      </p>
    </section>
  )
}

/**
 * The dependency-gate editor: a multi-select of parent tasks and the derived
 * child list, with the gate state banner. Toggling a parent rewrites the
 * task's parentIds; toggling a child rewrites the inverse childIds set — the
 * update use case maintains both directions atomically.
 */
function DependencySection({ controller, task, pending }: { controller: BoardController; task: TaskRecord; pending: boolean }) {
  const allTasks = controller.getSnapshot().tasks
  const parents = task.parentIds
  const children = childTasks(task, allTasks)
  const pendingParents = pendingParentTasks(task, allTasks)
  const candidates = allTasks.filter(item => item.id !== task.id)

  const toggleParent = (id: string): void => {
    controller.updateTask(task.id, {
      parentIds: parents.includes(id) ? parents.filter(item => item !== id) : [...parents, id],
    })
  }
  const toggleChild = (id: string): void => {
    const childIds = children.map(item => item.id)
    controller.updateTask(task.id, {
      childIds: childIds.includes(id) ? childIds.filter(item => item !== id) : [...childIds, id],
    })
  }

  return (
    <section className={css.detailSection} data-dsh-part="dependency-gate">
      <h4>{t('detail.dependency')}</h4>
      <p className={css.detailText}>{t('detail.dependency.hint')}</p>
      {pendingParents.length > 0 ? (
        <p className={css.formError}>
          {t('detail.dependency.gated', { count: String(pendingParents.length), names: pendingParents.map(item => item.title).join(', ') })}
        </p>
      ) : parents.length > 0 ? (
        <p className={css.gateOpen}>{t('detail.dependency.open')}</p>
      ) : (
        <p className={css.detailMeta}>{t('detail.dependency.none')}</p>
      )}
      <p className={css.detailMeta}>{t('detail.dependency.parents')}</p>
      {candidates.length === 0 ? (
        <p className={css.detailText}>{'—'}</p>
      ) : (
        <div className={css.depList}>
          {candidates.map(candidate => (
            <label key={candidate.id} className={css.depRow}>
              <input
                type="checkbox"
                checked={parents.includes(candidate.id)}
                disabled={pending}
                onChange={() => { toggleParent(candidate.id) }}
              />
              {candidate.serial !== undefined && <span className={css.depSerial}>#{candidate.serial}</span>}
              <span className={css.depTitle}>{candidate.title}</span>
              <span className={css.depStatus} data-status={candidate.status}>{t(STATUS_KEY[candidate.status])}</span>
            </label>
          ))}
        </div>
      )}
      <p className={css.detailMeta}>{t('detail.dependency.children')}</p>
      {children.length === 0 ? (
        <p className={css.detailText}>{'—'}</p>
      ) : (
        <div className={css.depList}>
          {children.map(child => (
            <label key={child.id} className={css.depRow}>
              <input
                type="checkbox"
                checked
                disabled={pending}
                onChange={() => { toggleChild(child.id) }}
              />
              {child.serial !== undefined && <span className={css.depSerial}>#{child.serial}</span>}
              <span className={css.depTitle}>{child.title}</span>
              <span className={css.depStatus} data-status={child.status}>{t(STATUS_KEY[child.status])}</span>
            </label>
          ))}
        </div>
      )}
    </section>
  )
}

/** Task detail overlay. */
export function TaskDetail({ controller, task }: { controller: BoardController; task: TaskRecord }) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showDuplicate, setShowDuplicate] = useState(false)
  const [showRework, setShowRework] = useState(false)

  // Keep the overlay in sync if the task record changes underneath.
  const [latest, setLatest] = useState(task)
  useEffect(() => { setLatest(task) }, [task])
  // A re-used overlay instance must not carry an edit session across tasks.
  useEffect(() => {
    setShowEdit(false)
    setShowDuplicate(false)
    setShowRework(false)
  }, [task.id])
  const current = latest
  const snapshot = controller.getSnapshot()
  const running = current.status === 'running'
  const archived = current.archivedAt !== undefined
  const pending = snapshot.pendingTaskIds.includes(current.id)
  const transportError = snapshot.transportError
  const timeZone = snapshot.host?.scheduler.timeZone
  const permissionPending = requiresPermissionConfirmation(current, snapshot.host?.sessionDefaultPermission)
  // Dependency gate: the card is closed for execution while any EXISTING
  // parent task has not settled to done (archived cards never run, so the
  // gate is moot there and left off).
  const pendingParents = archived ? [] : pendingParentTasks(current, snapshot.tasks)
  const gated = pendingParents.length > 0
  // Rework (reject-and-fix) is offered on settled cards only: a done/failed
  // card whose work finished is what the acceptance verdict applies to.
  const canRework = !archived && !running && (current.status === 'done' || current.status === 'failed')

  return (
    <div className={css.modalBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) controller.closeTask() }}>
      <div className={css.detail} role="dialog" aria-label={t('detail.title')}>
        <header className={css.detailHeader}>
          <h2 className={css.detailTitle}>{current.title}</h2>
          {current.serial !== undefined && (
            <span className={css.detailSerial} title={t('card.serial', { serial: String(current.serial) })}>#{current.serial}</span>
          )}
          <span className={css.statusBadge} data-status={archived ? 'archived' : current.status}>
            {archived ? t('board.archive') : t(STATUS_KEY[current.status])}
          </span>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('detail.close')}
            onClick={() => { controller.closeTask() }}
          >
            ×
          </button>
        </header>

        <div className={css.detailBody}>
          {transportError !== undefined && (
            <div className={css.formError}>
              {t('board.hostError', { error: transportError })}{' '}
              <button type="button" className={css.linkButton} onClick={() => { void controller.retryHostSync() }}>
                {t('board.retryHost')}
              </button>
            </div>
          )}
          <section className={css.detailSection}>
            <h4>{t('detail.description')}</h4>
            <p className={css.detailText}>{current.description !== '' ? current.description : '—'}</p>
          </section>

          {current.sourceSession !== undefined && (
            <section className={css.detailSection} data-dsh-part="source-session">
              <h4>{t('detail.sourceSessionTitle')}</h4>
              <p className={css.detailText}>
                {current.sourceSession.title ?? current.sourceSession.id}{' '}
                <button
                  type="button"
                  className={css.linkButton}
                  title={current.sourceSession.id}
                  onClick={() => { controller.openSession(current.sourceSession?.id ?? '') }}
                >
                  {t('detail.viewSession')} ⌁
                </button>
              </p>
            </section>
          )}

          {current.freeze !== undefined && (
            <section className={css.detailSection} data-dsh-part="freeze">
              <h4>{t('detail.freeze')}</h4>
              {current.freeze.redacted === true && <p className={css.formError}>{t('detail.freeze.redacted')}</p>}
              <p className={css.detailText}><strong>{t('detail.freeze.goal')}</strong></p>
              <pre className={css.promptBlock}>{current.freeze.goal}</pre>
              <p className={css.detailText}><strong>{t('detail.freeze.progress')}</strong></p>
              <pre className={css.promptBlock}>{current.freeze.progress}</pre>
              <p className={css.detailText}><strong>{t('detail.freeze.next')}</strong></p>
              <pre className={css.promptBlock}>{current.freeze.next}</pre>
              <p className={css.detailMeta}>{t('detail.freeze.frozenAt', { time: formatHostTimestamp(current.freeze.frozenAt, timeZone) })}</p>
              {current.freeze.frozenBy !== undefined && (
                <p className={css.detailMeta}>{t('detail.freeze.frozenBy', { session: current.freeze.frozenBy })}</p>
              )}
            </section>
          )}

          {current.handover !== undefined && (
            <section className={css.detailSection} data-dsh-part="handover">
              <h4>{t('detail.handover')}</h4>
              <p className={css.detailText}>
                {t('new.workspace')}: {current.handover.workspaceId ?? t('exec.workspace.recent')}
                {' · '}{t('new.mode')}: {current.handover.mode ?? t('exec.mode.default')}
                {' · '}{t('new.permission')}: {current.handover.permission === undefined ? t('exec.permission.default') : t(`exec.permission.${current.handover.permission}` as TaskBoardKey)}
              </p>
              <p className={css.detailText}><strong>{t('detail.handover.references')}</strong></p>
              <ul className={css.executionList}>
                {current.handover.references.map(reference => (
                  <li key={reference} className={css.executionRow}><code>{reference}</code></li>
                ))}
              </ul>
              <p className={css.detailMeta}>{t('detail.handover.bundledAt', { time: formatHostTimestamp(current.handover.bundledAt, timeZone) })}</p>
            </section>
          )}

          {permissionPending && (
            <section className={css.detailSection} data-dsh-part="permission-gate">
              <p className={css.formError}>{t('detail.permissionPending', { permission: t(`exec.permission.${current.handover?.permission ?? current.permission}` as TaskBoardKey) })}</p>
              <button type="button" className={css.primaryButton} disabled={pending} onClick={() => { void controller.confirmPermission(current.id) }}>
                {t('detail.permissionConfirm')}
              </button>
            </section>
          )}
          {current.permissionConfirmedAt !== undefined && (
            <p className={css.detailMeta}>{t('detail.permissionConfirmed', { time: formatHostTimestamp(current.permissionConfirmedAt, timeZone) })}</p>
          )}

          <section className={css.detailSection}>
            <h4>{t('detail.prompt')}</h4>
            <pre className={css.promptBlock}>{current.prompt !== '' ? current.prompt : current.title}</pre>
          </section>

          {!archived && (
            <>
              <DependencySection controller={controller} task={current} pending={pending} />
              <ExecutionSettingsSection controller={controller} task={current} pending={pending} />
              <ScheduleSection controller={controller} task={current} pending={pending} />
            </>
          )}

          <section className={css.detailSection}>
            <h4>{t('detail.execution')}</h4>
            {current.executions.length === 0 ? (
              <p className={css.detailText}>{t('detail.noExecution')}</p>
            ) : (
              <ul className={css.executionList}>
                {[...current.executions].reverse().map(execution => (
                  <ExecutionRow
                    key={execution.id}
                    execution={execution}
                    timeZone={timeZone}
                    onOpen={sessionId => { controller.openSession(sessionId) }}
                  />
                ))}
              </ul>
            )}
          </section>

          {(current.reworkNotes?.length ?? 0) > 0 && (
            <section className={css.detailSection} data-dsh-part="rework">
              <h4>{t('rework.history')}</h4>
              <ul className={css.executionList}>
                {[...(current.reworkNotes ?? [])].reverse().map((note, index) => (
                  <li key={index} className={css.executionRow}>
                    <span className={css.executionBadge} data-rework={note.consumedAt === undefined ? 'pending' : 'consumed'}>
                      {note.consumedAt === undefined ? t('rework.pending') : t('rework.consumed')}
                    </span>
                    <span className={css.reworkNoteText}>{note.note}</span>
                    <span className={css.executionTimes}>
                      {t('board.created', { time: formatHostTimestamp(note.at, timeZone) })}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!archived && (
            <section className={css.detailSection}>
              <h4>{t('board.status')}</h4>
              <div className={css.moveRow}>
                {MANUAL_STATUSES.map(status => (
                  <button
                    key={status}
                    type="button"
                    className={css.ghostButton}
                    disabled={current.status === status || running || pending}
                    onClick={() => { controller.moveTask(current.id, status) }}
                  >
                    {t(`status.move.${status}` as TaskBoardKey)}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        <footer className={css.detailFooter}>
          {!archived && pending && <span className={css.detailMeta}>{t('board.pending')}…</span>}
          {!archived && canEditTaskContent(current) && (
            <button
              type="button"
              className={css.ghostButton}
              disabled={pending}
              onClick={() => { setShowEdit(true) }}
            >
              {t('detail.edit')}
            </button>
          )}
          {!archived && (
            <button
              type="button"
              className={css.ghostButton}
              disabled={pending}
              onClick={() => { setShowDuplicate(true) }}
              title={canEditTaskContent(current) ? t('detail.duplicate') : t('detail.duplicateAndEdit')}
            >
              {canEditTaskContent(current) ? t('detail.duplicate') : t('detail.duplicateAndEdit')}
            </button>
          )}
          {!archived && (
            <button
              type="button"
              className={css.primaryButton}
              disabled={running || pending || gated}
              title={gated ? t('detail.dependency.gated', { count: String(pendingParents.length), names: pendingParents.map(item => item.title).join(', ') }) : undefined}
              onClick={() => {
                void controller.rerunTask(current.id).then(() => {
                  if (controller.getSnapshot().transportError === undefined) controller.closeTask()
                })
              }}
            >
              {current.executions.length === 0 ? t('detail.run') : t('detail.rerun')}
            </button>
          )}
          {canRework && (
            <button
              type="button"
              className={css.ghostButton}
              disabled={pending || gated || permissionPending}
              title={gated
                ? t('detail.dependency.gated', { count: String(pendingParents.length), names: pendingParents.map(item => item.title).join(', ') })
                : t('detail.reworkHint')}
              onClick={() => { setShowRework(true) }}
            >
              {t('detail.rework')}
            </button>
          )}
          {archived ? (
            <button
              type="button"
              className={css.primaryButton}
              disabled={pending}
              onClick={() => {
                controller.restoreTask(current.id)
              }}
            >
              {t('detail.restore')}
            </button>
          ) : (
            (current.status === 'done' || current.status === 'failed') && (
              <button
                type="button"
                className={css.ghostButton}
                disabled={pending}
                onClick={() => {
                  controller.archiveTask(current.id)
                }}
              >
                {t('detail.archive')}
              </button>
            )
          )}
          <button
            type="button"
            className={css.dangerButton}
            disabled={pending}
            onClick={() => { setConfirmDelete(true) }}
          >
            {t('detail.delete')}
          </button>
          <span className={css.detailMeta}>
            {t('board.created')} {formatTime(current.createdAt, timeZone)}
            {archived && ` · ${t('detail.archivedAt', { time: formatTime(current.archivedAt!, timeZone) })}`}
          </span>
        </footer>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={t('delete.title')}
          message={t('delete.confirm', { name: current.title })}
          confirmLabel={t('delete.ok')}
          danger
          onCancel={() => { setConfirmDelete(false) }}
          onConfirm={() => {
            setConfirmDelete(false)
            controller.deleteTask(current.id)
          }}
        />
      )}

      {showEdit && !archived && canEditTaskContent(current) && (
        <EditTaskModal controller={controller} task={current} onClose={() => { setShowEdit(false) }} />
      )}

      {showDuplicate && !archived && (
        <NewTaskModal
          controller={controller}
          initialTask={current}
          onClose={() => { setShowDuplicate(false) }}
          onDuplicateSuccess={async (sourceId) => {
            await controller.archiveTask(sourceId)
            controller.closeTask()
          }}
          projects={snapshot.projects ?? []}
          defaultProjectId={snapshot.defaultProjectId}
        />
      )}

      {showRework && canRework && (
        <ReworkModal controller={controller} task={current} onClose={() => { setShowRework(false) }} />
      )}
    </div>
  )
}
