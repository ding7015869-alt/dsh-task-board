/**
 * Project switcher: the toolbar chip that filters the board (columns,
 * archive view, and the dashboard scope) by project. Purely a display
 * dimension — it never touches dispatch gating, serials, or task state.
 *
 * Collapsed it reads `● <project name> (n)` or `全部项目 (n)`; expanded it
 * lists every project with its unarchived card count. Selecting the active
 * project again (or "All projects") clears the filter. The footer opens the
 * manager modal, where create/rename/recolor/delete live.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BoardController } from '../../core/controller.ts'
import { projectOf, type ProjectRecord } from '../../core/projects.ts'
import type { TaskRecord } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'

/** The color token of one project, resolved through the theme CSS variables. */
export function projectColorVar(project: ProjectRecord): string {
  return `var(${project.color})`
}

/**
 * Toolbar switcher. Hidden by the board entirely when the snapshot has no
 * project layer (legacy Host or the localStorage fallback), so this
 * component is only ever mounted with a non-empty project list.
 */
export function ProjectSwitcher({ controller, projects, defaultProjectId, selectedProjectId, tasks, onManage }: {
  controller: BoardController
  projects: readonly ProjectRecord[]
  defaultProjectId: string
  selectedProjectId?: string
  /** The full board set (archived included); rows count unarchived cards. */
  tasks: readonly TaskRecord[]
  onManage: () => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Close on outside press or Escape, the NewTaskModal backdrop contract.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onPointer = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target instanceof Node ? event.target : null)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer)
    }
  }, [open])

  // Unarchived card counts per project; missing/dangling pins count under
  // the default project, mirroring the ledger's load-time backfill.
  const counts = useMemo(() => {
    const byProject = new Map<string, number>()
    for (const task of tasks) {
      if (task.archivedAt !== undefined) continue
      byProject.set(projectOf(task, projects), (byProject.get(projectOf(task, projects)) ?? 0) + 1)
    }
    return byProject
  }, [tasks, projects])

  const total = [...counts.values()].reduce((sum, value) => sum + value, 0)
  const selected = selectedProjectId !== undefined ? projects.find(project => project.id === selectedProjectId) : undefined
  const label = selected === undefined ? t('proj.all') : selected.name

  const select = (id: string | undefined): void => {
    controller.setSelectedProject(id)
    setOpen(false)
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className={css.projectSwitch}
        aria-haspopup="true"
        aria-expanded={open}
        title={selected === undefined ? t('proj.all') : selected.name}
        onClick={() => { setOpen(value => !value) }}
      >
        <span
          className={css.projectDot}
          aria-hidden="true"
          style={selected === undefined ? undefined : { background: projectColorVar(selected) }}
        />
        <span className={css.projectSwitchName}>{label}</span>
        <span className={css.projectMenuCount}>
          {selected === undefined ? total : counts.get(selected.id) ?? 0}
        </span>
      </button>
      {open && (
        <div className={css.projectMenu} role="menu">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selectedProjectId === undefined}
            className={css.projectMenuRow}
            data-selected={selectedProjectId === undefined || undefined}
            onClick={() => { select(undefined) }}
          >
            <span className={css.projectMenuName}>{t('proj.all')}</span>
            <span className={css.projectMenuCount}>{total}</span>
          </button>
          {projects.map(project => (
            <button
              key={project.id}
              type="button"
              role="menuitemradio"
              aria-checked={selectedProjectId === project.id}
              className={css.projectMenuRow}
              data-selected={selectedProjectId === project.id || undefined}
              onClick={() => { select(selectedProjectId === project.id ? undefined : project.id) }}
            >
              <span
                className={css.projectDot}
                aria-hidden="true"
                style={{ background: projectColorVar(project) }}
              />
              <span className={css.projectMenuName}>{project.name}</span>
              {project.id === defaultProjectId && (
                <span className={css.projectMenuTag}>{t('proj.defaultTag')}</span>
              )}
              <span className={css.projectMenuCount}>{counts.get(project.id) ?? 0}</span>
            </button>
          ))}
          <div className={css.projectMenuFoot}>
            <button type="button" className={css.linkButton} onClick={() => { setOpen(false); onManage() }}>
              {t('proj.manage')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
