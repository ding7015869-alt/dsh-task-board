/**
 * Project domain: the board's second-level grouping of task cards. Projects
 * live in the Host ledger (v4) and are presentation-level grouping only — a
 * card's "#N" serial stays GLOBAL (one minting counter for the whole board,
 * never per project), and no project field ever enters the execution,
 * patrol, or continue-dispatch gates.
 *
 * Every card belongs to exactly one project. Unattributed cards (missing or
 * dangling `projectId`) are owned by the fixed default project, whose id is
 * always `default`: it cannot be deleted, but it can be renamed. Deleting
 * another project reassigns all of its cards to the default project.
 */

/** The fixed id of the default project: uncreatable and undeletable. */
export const DEFAULT_PROJECT_ID = 'default'

/**
 * The eight-slot project color palette, as CSS custom-property tokens. The
 * client resolves a token through `var()` at render time (light/dark themes
 * own the concrete swatches in board.module.css), so the ledger stores the
 * token, not a color value.
 */
export const PROJECT_COLORS = [
  '--dsh-tb-project-c1',
  '--dsh-tb-project-c2',
  '--dsh-tb-project-c3',
  '--dsh-tb-project-c4',
  '--dsh-tb-project-c5',
  '--dsh-tb-project-c6',
  '--dsh-tb-project-c7',
  '--dsh-tb-project-c8',
] as const

/** One palette slot. */
export type ProjectColor = (typeof PROJECT_COLORS)[number]

/** Bounded project name (keeps the switcher row and manager list readable). */
export const PROJECT_NAME_MAX_LENGTH = 200

/** Bounded project id (client-minted uuid; the gate is the wire check). */
export const PROJECT_ID_MAX_LENGTH = 64

/** One board project. */
export interface ProjectRecord {
  id: string
  name: string
  color: ProjectColor
  createdAt: number
  updatedAt: number
}

/** Whether an unknown value is one of the eight palette tokens. */
export function isProjectColor(value: unknown): value is ProjectColor {
  return typeof value === 'string' && (PROJECT_COLORS as readonly string[]).includes(value)
}

/**
 * The next free palette slot for a new project: the first color no existing
 * project uses; when all eight are taken, wrap around by project count so
 * colors stay deterministic.
 */
export function autoProjectColor(projects: readonly ProjectRecord[]): ProjectColor {
  const used = new Set(projects.map(project => project.color))
  for (const color of PROJECT_COLORS) {
    if (!used.has(color)) return color
  }
  return PROJECT_COLORS[projects.length % PROJECT_COLORS.length]
}

/** The default project record (minted at ledger load/migration time). */
export function defaultProject(now: number): ProjectRecord {
  return {
    id: DEFAULT_PROJECT_ID,
    name: 'Default',
    color: PROJECT_COLORS[0],
    createdAt: now,
    updatedAt: now,
  }
}

/** A persisted project row is structurally valid. */
export function isProjectRecord(value: unknown): value is ProjectRecord {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || row.id === '') return false
  if (typeof row.name !== 'string') return false
  if (!isProjectColor(row.color)) return false
  if (typeof row.createdAt !== 'number' || !Number.isFinite(row.createdAt)) return false
  if (typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt)) return false
  return true
}

/** The structural fields only: the color is checked separately so a dangling token can be repaired. */
function hasProjectShape(value: unknown): value is { id: string; name: string; createdAt: number; updatedAt: number } {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || row.id === '') return false
  if (typeof row.name !== 'string') return false
  if (typeof row.createdAt !== 'number' || !Number.isFinite(row.createdAt)) return false
  if (typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt)) return false
  return true
}

/**
 * Repair a persisted project list: drop malformed rows, deduplicate ids
 * (first occurrence wins), repair a dangling color back to the first slot,
 * and guarantee the default project is present (unshifted, last-resort
 * mint time). Mirrors the store's repair policy: a bad row never drops the
 * whole document.
 */
export function normalizeProjectList(value: unknown, now: number): ProjectRecord[] {
  const rows = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const result: ProjectRecord[] = []
  for (const row of rows) {
    if (!hasProjectShape(row) || seen.has(row.id)) continue
    seen.add(row.id)
    if (!isProjectColor((row as Record<string, unknown>).color)) {
      // A dangling color token (a palette that changed out from under it)
      // repairs to the first slot instead of dropping the project.
      result.push({ id: row.id, name: row.name, color: PROJECT_COLORS[0], createdAt: row.createdAt, updatedAt: row.updatedAt })
      continue
    }
    result.push({ id: row.id, name: row.name, color: (row as Record<string, unknown>).color as ProjectColor, createdAt: row.createdAt, updatedAt: row.updatedAt })
  }
  if (!seen.has(DEFAULT_PROJECT_ID)) result.unshift(defaultProject(now))
  return result
}

/**
 * The project that owns one task row: its `projectId` when that project
 * exists on the board, the default project otherwise (missing or dangling
 * references always fall back to the default project).
 */
export function projectOf(task: { projectId?: string }, projects: readonly ProjectRecord[]): string {
  if (task.projectId === undefined) return DEFAULT_PROJECT_ID
  const known = new Set(projects.map(project => project.id))
  return known.has(task.projectId) ? task.projectId : DEFAULT_PROJECT_ID
}
