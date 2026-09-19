/**
 * New-task modal: title + description + the prompt that execution will send.
 * Creates through the Host and closes only after the Host confirms it.
 */
import { useEffect, useState } from 'react'
import type { BoardController } from '../../core/controller.ts'
import { isValidCron } from '../../core/schedule.ts'
import { parseFreezeRequest } from '../../core/freeze-snapshot.ts'
import { TASK_PERMISSIONS, type TaskPermission, type TaskRecord } from '../../core/tasks.ts'
import { DEFAULT_PROJECT_ID, type ProjectRecord } from '../../core/projects.ts'
import { t, type TaskBoardKey } from '../locales.ts'
import { readLastUsed, writeLastUsed, type LastUsedSettings } from '../last-used.ts'
import { defaultModelName, groupModelOptions, modelOptionLabel, reasoningEffortLabel, reasoningEffortOptionsFor } from './model-options.ts'
import { ModalShell, TaskContentFields } from './TaskForm.tsx'
import { ScheduleEditor } from './ScheduleEditor.tsx'
import css from '../board.module.css'

export interface NewTaskModalProps {
  controller: BoardController
  onClose: () => void
  /** Optional task template to clone/duplicate from. */
  initialTask?: TaskRecord
  /** Optional callback after successful duplication (e.g. to archive source). */
  onDuplicateSuccess?: (sourceTaskId: string) => Promise<void>
  /** The board's project roster; empty hides the project picker (legacy Host). */
  projects?: readonly ProjectRecord[]
  /**
   * The default project id for fresh cards: the board passes the currently
   * selected project (so "new" lands where the user is looking) or the
   * ledger's default project. A duplicated card keeps its source project
   * regardless of this.
   */
  defaultProjectId?: string
  /**
   * The session this card is created from (session-row "add as task card"
   * entry): pre-fills the title with the session's title and BINDS the new
   * card to that session — executions continue inside it while it is idle
   * and still present (Host launcher's source-session rule). The binding is
   * carried into the create payload; ignored while duplicating
   * (`initialTask` wins) — the duplicate flow owns the form.
   */
  sourceSession?: { id: string; title: string }
}

/** New-task form overlay. */
export function NewTaskModal({ controller, onClose, initialTask, onDuplicateSuccess, projects = [], defaultProjectId = DEFAULT_PROJECT_ID, sourceSession }: NewTaskModalProps) {
  const isDuplicate = initialTask !== undefined
  // 复制任务时以被复制任务为准；新建时预填「上次创建任务用过的设置」。
  const [defaults] = useState<LastUsedSettings>(() => (isDuplicate ? {} : readLastUsed()))
  // 源会话入口（会话菜单「添加为任务卡」）：标题预填会话标题，用户可改。
  const [title, setTitle] = useState(initialTask?.title ?? sourceSession?.title ?? '')
  const [description, setDescription] = useState(initialTask?.description ?? '')
  const [prompt, setPrompt] = useState(initialTask?.prompt ?? '')
  const [workspaceId, setWorkspaceId] = useState(initialTask?.workspaceId ?? defaults.workspaceId ?? '')
  const [mode, setMode] = useState(initialTask?.mode ?? defaults.mode ?? '')
  const [permission, setPermission] = useState(initialTask?.permission ?? defaults.permission ?? '')
  const [model, setModel] = useState(initialTask?.model ?? defaults.model ?? '')
  // 推理强度跟随所选模型：切模型即重置（各模型的强度档位不同）。
  const [effort, setEffort] = useState(initialTask?.reasoningEffort ?? defaults.reasoningEffort ?? '')
  const [reuseSession, setReuseSession] = useState(initialTask?.reuseSession ?? defaults.reuseSession ?? false)
  const [scheduleEnabled, setScheduleEnabled] = useState(initialTask?.schedule?.enabled ?? defaults.scheduleEnabled ?? false)
  const [scheduleCron, setScheduleCron] = useState(initialTask?.schedule?.cron ?? defaults.scheduleCron ?? '')
  const [scheduleError, setScheduleError] = useState<string | undefined>(undefined)
  const [freezeText, setFreezeText] = useState('')
  const [freezeError, setFreezeError] = useState<string | undefined>(undefined)
  const [handoverText, setHandoverText] = useState(
    initialTask?.handover?.references !== undefined ? initialTask.handover.references.join('\n') : '',
  )
  const [archiveOriginal, setArchiveOriginal] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const [options, setOptions] = useState(controller.getSnapshot().executionOptions)
  const [allTasks, setAllTasks] = useState(controller.getSnapshot().tasks)
  /** Selected parent task ids (dependency gate): the new task stays closed until every one is done. */
  const [parentIds, setParentIds] = useState<string[]>(initialTask?.parentIds ?? [])
  // The owning project: a duplicated card keeps its source project; a fresh
  // card lands in the board's selected project (passed as defaultProjectId)
  // or the ledger's default project. Hidden entirely without a project layer.
  const [projectId, setProjectId] = useState<string>(initialTask?.projectId ?? defaultProjectId)

  // The workspace list, preset roster, and existing task roster arrive from
  // the runtime after mount; follow them so the pickers never freeze on an
  // empty snapshot.
  useEffect(
    () => controller.subscribe(() => {
      setOptions(controller.getSnapshot().executionOptions)
      setAllTasks(controller.getSnapshot().tasks)
    }),
    [controller],
  )

  const toggleParent = (id: string): void => {
    setParentIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  }

  const submit = async (): Promise<void> => {
    if (scheduleEnabled) {
      const cron = scheduleCron.trim()
      if (cron === '' || !isValidCron(cron)) {
        setScheduleError(t('detail.schedule.invalid'))
        return
      }
    }
    // Optional continuation-card snapshot: parse the freeze block through the
    // T2 gate (structure + redaction + taint + size); a malformed block stops
    // submission with the parser's error instead of creating a plain task.
    let freeze: Parameters<typeof controller.createTaskConfirmed>[0]['freeze'] = undefined
    if (freezeText.trim() !== '') {
      const parsed = parseFreezeRequest(freezeText)
      if (!parsed.ok) {
        setFreezeError(parsed.error.message)
        return
      }
      freeze = { ...parsed.snapshot, ...(parsed.warnings.includes('redacted') ? { redacted: true } : {}) }
    }
    // Optional handover bundle: non-empty reference lines attach the picked
    // triplet (workspace/mode/permission above) plus the references.
    const references = handoverText.split('\n').map(line => line.trim()).filter(line => line !== '')
    const handover = references.length === 0 ? undefined : {
      references,
      workspaceId: workspaceId === '' ? undefined : workspaceId,
      mode: mode === '' ? undefined : mode,
      permission: permission === '' ? undefined : permission as TaskPermission,
    }
    // 推理强度只随模型选择生效（select-model 契约要求 provider+model）：
    // 用户在「宿主默认」路由上选了强度时，自动钉住默认路由使强度可落地。
    const effectiveModel = model !== '' ? model : (effort !== '' ? options.defaultModel ?? '' : '')
    // 源会话绑定（会话菜单「添加为任务卡」）：新卡与该会话绑定，执行在其
    // 空闲且仍在场时于其中继续；复制流（initialTask）不携带绑定。
    const sourceSessionBinding = !isDuplicate && sourceSession !== undefined
      ? { sourceSession: { id: sourceSession.id, title: sourceSession.title } }
      : {}
    setPending(true)
    const task = await controller.createTaskConfirmed({
      title,
      description,
      prompt,
      freeze,
      handover,
      workspaceId: workspaceId === '' ? undefined : workspaceId,
      mode: mode === '' ? undefined : mode,
      permission: permission === '' ? undefined : permission as TaskPermission,
      model: effectiveModel === '' ? undefined : effectiveModel,
      reasoningEffort: effort === '' ? undefined : effort,
      ...(parentIds.length > 0 ? { parentIds } : {}),
      ...(projects.length > 0 ? { projectId } : {}),
      ...(reuseSession ? { reuseSession: true } : {}),
      ...sourceSessionBinding,
      schedule: scheduleEnabled ? { enabled: true, cron: scheduleCron.trim() } : undefined,
    })
    if (task === undefined) {
      setPending(false)
      setError(controller.getSnapshot().transportError ?? t('new.required'))
      return
    }
    // 记住这次用过的执行目标，供下一次新建表单预填。
    writeLastUsed({
      workspaceId,
      mode,
      permission,
      model,
      reasoningEffort: effort,
      reuseSession,
      scheduleEnabled,
      scheduleCron: scheduleEnabled ? scheduleCron.trim() : '',
    })
    if (isDuplicate && archiveOriginal && initialTask !== undefined) {
      if (onDuplicateSuccess !== undefined) {
        await onDuplicateSuccess(initialTask.id)
      } else {
        await controller.archiveTask(initialTask.id)
      }
    }
    onClose()
  }

  const modalTitle = isDuplicate ? t('new.duplicateTitle') : t('board.new')

  // 当前有效路由（钉住的模型，未钉住时落到宿主默认路由）声明的强度档位；
  // 目录未声明档位且没有残留选择时整个强度字段隐藏。
  const effortOptions = reasoningEffortOptionsFor(model, options.defaultModel, options.models ?? [])
  const showEffort = effortOptions.length > 0 || effort !== ''

  return (
    <ModalShell
      ariaLabel={modalTitle}
      title={modalTitle}
      error={error}
      pending={pending}
      submitLabel={t('new.submit')}
      onSubmit={() => { void submit() }}
      onClose={onClose}
    >
      {sourceSession !== undefined && !isDuplicate && (
        <p className={css.scheduleMeta}>
          {t('new.sourceSession', { session: sourceSession.title })}
        </p>
      )}
      <TaskContentFields
        title={title}
        description={description}
        prompt={prompt}
        onTitleChange={value => { setTitle(value); setError(undefined) }}
        onDescriptionChange={setDescription}
        onPromptChange={setPrompt}
      />

      {projects.length > 0 && (
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.project')}</span>
          <select
            className={css.select}
            value={projectId}
            onChange={event => { setProjectId(event.target.value) }}
          >
            {projects.map(project => (
              <option key={project.id} value={project.id}>
                {project.name}{project.id === defaultProjectId ? t('proj.defaultTag') : ''}
              </option>
            ))}
          </select>
        </label>
      )}

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.freeze')}</span>
          <textarea
            className={css.input}
            rows={4}
            value={freezeText}
            placeholder={t('new.freezePlaceholder')}
            spellCheck={false}
            onChange={event => { setFreezeText(event.target.value); setFreezeError(undefined) }}
          />
        </label>
        {freezeError !== undefined && <p className={css.formError}>{freezeError}</p>}

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.handover')}</span>
          <textarea
            className={css.input}
            rows={3}
            value={handoverText}
            placeholder={t('new.handoverPlaceholder')}
            spellCheck={false}
            onChange={event => { setHandoverText(event.target.value) }}
          />
        </label>

        <div className={css.field}>
          <span className={css.fieldLabel}>{t('new.parents')}</span>
          <p className={css.detailText}>{t('new.parentsHint')}</p>
          {allTasks.length === 0 ? (
            <p className={css.detailText}>{'—'}</p>
          ) : (
            <div className={css.depList}>
              {allTasks.map(candidate => (
                <label key={candidate.id} className={css.depRow}>
                  <input
                    type="checkbox"
                    checked={parentIds.includes(candidate.id)}
                    onChange={() => { toggleParent(candidate.id) }}
                  />
                  <span className={css.depTitle}>{candidate.title}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <label className={css.field}>
          <span className={css.fieldLabel}>{t('new.workspace')}</span>
          <select
            className={css.select}
            value={workspaceId}
            onChange={event => { setWorkspaceId(event.target.value) }}
          >
            <option value="">{t('exec.workspace.recent')}</option>
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
            onChange={event => { setMode(event.target.value) }}
          >
            <option value="">{t('exec.mode.default')}</option>
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
            onChange={event => { setPermission(event.target.value) }}
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
            onChange={event => { setModel(event.target.value); setEffort('') }}
          >
            <option value="">{options.defaultModel === undefined || options.defaultModel === ''
              ? t('exec.model.default')
              : t('exec.model.hostDefault', { model: defaultModelName(options.defaultModel, options.models ?? []) })}</option>
            {model !== '' && !(options.models ?? []).some(item => item.id === model) && (
              <option value={model}>{model}{t('exec.model.unknown')}</option>
            )}
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

        {showEffort && (
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('new.effort')}</span>
            <select
              className={css.select}
              value={effort}
              onChange={event => { setEffort(event.target.value) }}
            >
              <option value="">{t('exec.effort.default')}</option>
              {effort !== '' && !effortOptions.some(item => item.id === effort) && (
                <option value={effort}>{effort}{t('exec.effort.unknown')}</option>
              )}
              {effortOptions.map(item => (
                <option key={item.id} value={item.id}>{reasoningEffortLabel(item)}</option>
              ))}
            </select>
          </label>
        )}

        <label className={css.scheduleToggle}>
          <input
            type="checkbox"
            checked={reuseSession}
            onChange={event => { setReuseSession(event.target.checked) }}
          />
          <span>{t('exec.reuseSession')}</span>
        </label>
        <p className={css.detailText}>{t('exec.reuseSessionHint')}</p>

        <section className={css.detailSection}>
          <h4>{t('detail.schedule')}</h4>
          <label className={css.scheduleToggle}>
            <input
              type="checkbox"
              checked={scheduleEnabled}
              onChange={event => {
                setScheduleEnabled(event.target.checked)
                if (!event.target.checked) setScheduleError(undefined)
              }}
            />
            <span>{t('detail.schedule.enable')}</span>
          </label>
          {scheduleEnabled && (
            <>
              <ScheduleEditor
                cron={scheduleCron}
                onCronChange={value => { setScheduleCron(value); setScheduleError(undefined) }}
                showPreview
                timeZone={controller.getSnapshot().host?.scheduler.timeZone}
              />
              {scheduleError !== undefined && <p className={css.formError}>{scheduleError}</p>}
            </>
          )}
        </section>
        {isDuplicate && (
          <label className={css.checkboxLabel} style={{ marginTop: '12px' }}>
            <input
              type="checkbox"
              checked={archiveOriginal}
              onChange={event => { setArchiveOriginal(event.target.checked) }}
            />
            <span>{t('new.archiveOriginal')}</span>
          </label>
        )}
    </ModalShell>
  )
}
