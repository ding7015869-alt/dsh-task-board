/**
 * Project manager modal: the full CRUD surface of the project layer.
 * Create (name + optional palette color, auto-assign when left blank),
 * rename (inline row editor), recolor (the 8-swatch picker), and delete
 * (confirmed; the default project is locked). Deleting a project moves its
 * cards to the default project on the Host; the confirm copy says so.
 */
import { useMemo, useState } from 'react'
import type { BoardController } from '../../core/controller.ts'
import { PROJECT_COLORS, PROJECT_NAME_MAX_LENGTH, projectOf, type ProjectColor, type ProjectRecord } from '../../core/projects.ts'
import type { TaskRecord } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import { projectColorVar } from './ProjectSwitcher.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import css from '../board.module.css'

/** The 8-slot palette picker: selecting a swatch colors the project now. */
function ColorSwatches({ value, onSelect }: { value?: string; onSelect: (color: ProjectColor) => void }) {
  return (
    <span className={css.colorSwatches} role="radiogroup" aria-label={t('proj.color')}>
      {PROJECT_COLORS.map(color => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          className={css.colorSwatch}
          data-on={value === color || undefined}
          style={{ background: `var(${color})` }}
          title={color}
          onClick={() => { onSelect(color) }}
        />
      ))}
    </span>
  )
}

/**
 * Project manager overlay. Only ever mounted with a non-empty project list
 * (the board hides the project UI on legacy Hosts and the localStorage
 * fallback), so a default project is guaranteed to be present.
 */
export function ProjectManagerModal({ controller, projects, defaultProjectId, tasks, transportError, onClose }: {
  controller: BoardController
  projects: readonly ProjectRecord[]
  defaultProjectId: string
  /** The full board set (archived included); rows show unarchived card counts. */
  tasks: readonly TaskRecord[]
  transportError?: string
  onClose: () => void
}) {
  const [createName, setCreateName] = useState('')
  const [createColor, setCreateColor] = useState<ProjectColor | undefined>(undefined)
  const [createError, setCreateError] = useState<string | undefined>(undefined)
  const [createPending, setCreatePending] = useState(false)
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState<string | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState<ProjectRecord | undefined>(undefined)

  // Unarchived card counts per project (dangling pins count under default).
  const counts = useMemo(() => {
    const byProject = new Map<string, number>()
    for (const task of tasks) {
      if (task.archivedAt !== undefined) continue
      const owned = projectOf(task, projects)
      byProject.set(owned, (byProject.get(owned) ?? 0) + 1)
    }
    return byProject
  }, [tasks, projects])

  const nameConflict = (name: string, ignoreId?: string): boolean =>
    projects.some(project => project.id !== ignoreId && project.name.toLowerCase() === name.toLowerCase())

  const submitCreate = async (): Promise<void> => {
    const name = createName.trim()
    if (name === '') {
      setCreateError(t('proj.nameRequired'))
      return
    }
    if (name.length > PROJECT_NAME_MAX_LENGTH) {
      setCreateError(t('proj.nameTooLong', { max: String(PROJECT_NAME_MAX_LENGTH) }))
      return
    }
    if (nameConflict(name)) {
      setCreateError(t('proj.nameTaken'))
      return
    }
    setCreatePending(true)
    await controller.createProject(name, createColor)
    setCreatePending(false)
    setCreateName('')
    setCreateColor(undefined)
    setCreateError(undefined)
  }

  const startRename = (project: ProjectRecord): void => {
    setRenamingId(project.id)
    setRenameValue(project.name)
    setRenameError(undefined)
  }

  const submitRename = async (): Promise<void> => {
    if (renamingId === undefined) return
    const name = renameValue.trim()
    if (name === '') {
      setRenameError(t('proj.nameRequired'))
      return
    }
    if (name.length > PROJECT_NAME_MAX_LENGTH) {
      setRenameError(t('proj.nameTooLong', { max: String(PROJECT_NAME_MAX_LENGTH) }))
      return
    }
    if (nameConflict(name, renamingId)) {
      setRenameError(t('proj.nameTaken'))
      return
    }
    const accepted = await controller.renameProject(renamingId, name)
    if (accepted) {
      setRenamingId(undefined)
      setRenameError(undefined)
    } else {
      setRenameError(controller.getSnapshot().transportError ?? t('proj.nameTaken'))
    }
  }

  const deleteCount = confirmDelete === undefined ? 0 : (counts.get(confirmDelete.id) ?? 0)
  const deleteMessage = confirmDelete === undefined ? '' : deleteCount === 0
    ? t('proj.deleteEmptyConfirm', { name: confirmDelete.name })
    : t('proj.deleteConfirm', {
      name: confirmDelete.name,
      count: String(deleteCount),
      defaultName: projects.find(project => project.id === defaultProjectId)?.name ?? t('proj.all'),
    })

  return (
    <>
      <div className={css.modalBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
        <div className={css.modal} role="dialog" aria-label={t('proj.title')}>
          <h2 className={css.modalTitle}>{t('proj.title')}</h2>

          {transportError !== undefined && (
            <p className={css.formError}>{t('board.hostError', { error: transportError })}</p>
          )}

          {projects.map(project => {
            const isDefault = project.id === defaultProjectId
            const count = counts.get(project.id) ?? 0
            const editing = renamingId === project.id
            return (
              <div key={project.id} className={css.projectItem}>
                <span
                  className={css.projectDot}
                  aria-hidden="true"
                  style={{ background: projectColorVar(project) }}
                />
                <div className={css.projectItemMain}>
                  {editing ? (
                    <label className={css.field}>
                      <input
                        className={css.input}
                        value={renameValue}
                        autoFocus
                        onChange={event => { setRenameValue(event.target.value); setRenameError(undefined) }}
                        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void submitRename() } }}
                      />
                    </label>
                  ) : (
                    <span className={css.projectItemName}>
                      {project.name}
                      {isDefault && <span className={css.projectMenuTag}> {t('proj.defaultTag')}</span>}
                    </span>
                  )}
                  <div className={css.projectItemCount}>
                    {t('proj.cards', { count: String(count) })}
                    {isDefault && ` · ${t('proj.locked')}`}
                  </div>
                  {renameError !== undefined && editing && <p className={css.formError}>{renameError}</p>}
                </div>
                <div className={css.projectItemActions}>
                  {editing ? (
                    <>
                      <button
                        type="button"
                        className={css.primaryButton}
                        onClick={() => { void submitRename() }}
                      >
                        {t('proj.rename')}
                      </button>
                      <button type="button" className={css.ghostButton} onClick={() => { setRenamingId(undefined); setRenameError(undefined) }}>
                        {t('new.cancel')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={css.linkButton}
                      onClick={() => { startRename(project) }}
                      title={t('proj.renameHint')}
                    >
                      {t('proj.rename')}
                    </button>
                  )}
                  <ColorSwatches
                    value={project.color}
                    onSelect={color => { void controller.setProjectColor(project.id, color) }}
                  />
                  <button
                    type="button"
                    className={css.dangerButton}
                    disabled={isDefault}
                    title={isDefault ? t('proj.locked') : undefined}
                    onClick={() => { setConfirmDelete(project) }}
                  >
                    {t('delete.ok')}
                  </button>
                </div>
              </div>
            )
          })}

          <div className={css.projectItem}>
            <div className={css.projectItemMain}>
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('proj.new')}</span>
                <input
                  className={css.input}
                  value={createName}
                  placeholder={t('proj.namePlaceholder')}
                  onChange={event => { setCreateName(event.target.value); setCreateError(undefined) }}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void submitCreate() } }}
                />
              </label>
            </div>
            <div className={css.projectItemActions}>
              <ColorSwatches value={createColor} onSelect={setCreateColor} />
              <button
                type="button"
                className={css.primaryButton}
                disabled={createPending}
                onClick={() => { void submitCreate() }}
              >
                {t('proj.new')}
              </button>
            </div>
          </div>

          {createError !== undefined && <p className={css.formError}>{createError}</p>}

          <footer className={css.modalFooter}>
            <button type="button" className={css.ghostButton} onClick={onClose}>
              {t('new.cancel')}
            </button>
          </footer>
        </div>
      </div>

      {confirmDelete !== undefined && (
        <ConfirmDialog
          title={t('delete.title')}
          message={deleteMessage}
          confirmLabel={t('delete.ok')}
          danger
          onCancel={() => { setConfirmDelete(undefined) }}
          onConfirm={() => {
            const target = confirmDelete
            setConfirmDelete(undefined)
            void controller.deleteProject(target.id)
          }}
        />
      )}
    </>
  )
}
