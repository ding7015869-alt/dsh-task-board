/**
 * Project use cases: create / rename / recolor / delete on the board's
 * project list (Host ledger v4). Pure ledger transitions (no persistence or
 * notify — the Host ledger orchestrates those), each throwing on a rejected
 * transition so the ledger can surface a bounded wire error.
 *
 * Semantics (approved scope):
 * - the default project (id "default") is always present, can be renamed,
 *   and can NEVER be deleted;
 * - creating a project mints a client-supplied id, a bounded trimmed name,
 *   and the next free palette color (or an explicit one);
 * - names are unique on the board (case-insensitive) to keep the switcher
 *   row and manager list unambiguous;
 * - deleting a project reassigns all of its cards to the default project in
 *   the same transition: card serials, execution history, and status are
 *   untouched; only `projectId` and `updatedAt` move.
 */
import {
  DEFAULT_PROJECT_ID,
  PROJECT_ID_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  autoProjectColor,
  isProjectColor,
  type ProjectColor,
  type ProjectRecord,
} from '../projects.ts'
import { normalizeTargetId, type TaskRecord } from '../tasks.ts'

/** Bounded, trimmed project name (the shared create/rename gate). */
function normalizeProjectName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > PROJECT_NAME_MAX_LENGTH) throw new Error('project name is required (max 200 characters)')
  return trimmed
}

/** Bounded, trimmed project id (client-minted uuid on the wire path). */
function normalizeProjectId(id: string): string {
  const trimmed = id.trim()
  if (trimmed === '' || trimmed.length > PROJECT_ID_MAX_LENGTH) throw new Error('invalid project id')
  return trimmed
}

/** Whether two project names collide (case-insensitive). */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Create a project with an auto-assigned (or explicit) color. */
export function applyCreateProject(
  projects: readonly ProjectRecord[],
  id: string,
  name: string,
  color: string | undefined,
  now: number,
): readonly ProjectRecord[] {
  const projectId = normalizeProjectId(id)
  if (projectId === DEFAULT_PROJECT_ID) throw new Error('the default project id is reserved')
  if (projects.some(project => project.id === projectId)) throw new Error('project id already exists')
  const projectName = normalizeProjectName(name)
  if (projects.some(project => sameName(project.name, projectName))) throw new Error('a project with this name already exists')
  const projectColor: ProjectColor = color !== undefined
    ? (isProjectColor(color) ? color : (() => { throw new Error('unknown project color') })())
    : autoProjectColor(projects)
  const project: ProjectRecord = { id: projectId, name: projectName, color: projectColor, createdAt: now, updatedAt: now }
  return [...projects, project]
}

/** Rename a project (the default project may be renamed too). */
export function applyRenameProject(
  projects: readonly ProjectRecord[],
  id: string,
  name: string,
  now: number,
): readonly ProjectRecord[] {
  const target = projects.find(project => project.id === id)
  if (target === undefined) throw new Error('project not found')
  const projectName = normalizeProjectName(name)
  if (projectName !== target.name && projects.some(project => project.id !== id && sameName(project.name, projectName))) {
    throw new Error('a project with this name already exists')
  }
  return projects.map(project => project.id === id ? { ...project, name: projectName, updatedAt: now } : project)
}

/** Recolor a project to one of the eight palette slots. */
export function applySetProjectColor(
  projects: readonly ProjectRecord[],
  id: string,
  color: string,
  now: number,
): readonly ProjectRecord[] {
  if (!isProjectColor(color)) throw new Error('unknown project color')
  const target = projects.find(project => project.id === id)
  if (target === undefined) throw new Error('project not found')
  return projects.map(project => project.id === id ? { ...project, color, updatedAt: now } : project)
}

/**
 * Delete a project: the default project is reserved (never deletable). Every
 * card owned by the deleted project is reassigned to the default project in
 * the same transition — card serials, execution history, status, and
 * dependencies are left untouched; only `projectId` and `updatedAt` move.
 */
export function applyDeleteProject(
  projects: readonly ProjectRecord[],
  tasks: readonly TaskRecord[],
  id: string,
  now: number,
): { projects: readonly ProjectRecord[]; tasks: readonly TaskRecord[] } {
  if (id === DEFAULT_PROJECT_ID) throw new Error('the default project cannot be deleted')
  const target = projects.find(project => project.id === id)
  if (target === undefined) throw new Error('project not found')
  const nextProjects = projects.filter(project => project.id !== id)
  const nextTasks = tasks.map(task => task.projectId === id
    ? { ...task, projectId: DEFAULT_PROJECT_ID, updatedAt: now }
    : task
  )
  return { projects: nextProjects, tasks: nextTasks }
}

/** Normalize an optional owning-project input: blank collapses to undefined. */
export function normalizeProjectIdInput(value: string | undefined): string | undefined {
  return normalizeTargetId(value)
}
