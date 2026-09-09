/**
 * Project dimension UI smoke: light mount assertions per the pure-UI
 * smoke-test allowance (repo AGENTS). SSR-renders the switcher, card chip,
 * detail project row, and the dashboard project table; asserts the locale
 * key mirror and the theme palette CSS blocks.
 */
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import { startExecution, settleExecution, createTask, type TaskRecord } from '../src/core/tasks.ts'
import { defaultProject, PROJECT_COLORS, type ProjectRecord } from '../src/core/projects.ts'
import { en, zh } from '../src/client/locales.ts'
import { Dashboard } from '../src/client/board/Dashboard.tsx'
import { ProjectSwitcher } from '../src/client/board/ProjectSwitcher.tsx'
import { TaskCard } from '../src/client/board/TaskCard.tsx'
import { TaskDetail } from '../src/client/board/TaskDetail.tsx'

const NOW = 1_700_000_000_000
const ZONE = 'Asia/Shanghai'

const projects: readonly ProjectRecord[] = [
  defaultProject(NOW),
  { id: 'p1', name: '项目一', color: PROJECT_COLORS[1], createdAt: NOW, updatedAt: NOW },
]

/** A task owned by project p1 with one settled successful run. */
function ownedTask(): TaskRecord {
  const task = createTask({ title: 't', description: '', prompt: '', projectId: 'p1' }, NOW, 'ta')
  const running = startExecution(task, NOW + 1000, 'run1')
  return settleExecution(running.task, 'run1', 'succeeded', NOW + 2000, undefined)
}

/** A task in the default project, archived, with no runs. */
function defaultArchivedTask(): TaskRecord {
  const task = createTask({ title: 'd', description: '', prompt: '', projectId: 'default' }, NOW, 'tb')
  return { ...task, archivedAt: NOW + 5000 }
}

function detailController(task: TaskRecord, extra?: Partial<ControllerSnapshot>): BoardController {
  const snapshot: ControllerSnapshot = {
    tasks: [task],
    pendingTaskIds: [],
    host: {
      scheduler: { timeZone: ZONE },
      sessionDefaultPermission: undefined,
      automation: undefined,
    },
    executionOptions: { workspaces: [], presets: [], models: [], defaultModel: undefined },
    projects,
    defaultProjectId: 'default',
    ...extra,
  } as unknown as ControllerSnapshot
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    openTask: () => {},
    closeTask: () => {},
    openSession: () => {},
    retryHostSync: () => {},
    rerunTask: async () => {},
    moveTask: () => {},
    updateTask: async () => true,
    archiveTask: async () => {},
    deleteTask: async () => {},
  } as unknown as BoardController
}

describe('project dimension locale mirror', () => {
  it('keeps the zh and en key sets identical', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('defines the project-layer keys in both dictionaries', () => {
    for (const key of ['proj.all', 'proj.new', 'proj.locked', 'proj.deleteConfirm', 'new.project', 'detail.project', 'dash.byProject', 'dash.projectScopeHint', 'card.project', 'board.projectUnavailable'] as Array<keyof typeof zh>) {
      expect(zh[key], `zh ${key}`).not.toBe('')
      expect(en[key], `en ${key}`).not.toBe('')
    }
  })
})

describe('project palette css blocks', () => {
  const css = readFileSync(fileURLToPath(new URL('../src/client/board.module.css', import.meta.url)), 'utf8')

  it('defines all 8 color tokens in both the light and the dark block', () => {
    for (let slot = 1; slot <= 8; slot += 1) {
      expect(css.split(`--dsh-tb-project-c${slot}:`).length - 1).toBe(2)
    }
  })

  it('carries the project-layer component classes', () => {
    for (const name of ['projectSwitch', 'projectMenu', 'projectChip', 'projectItem', 'colorSwatch', 'projectTable']) {
      expect(css).toContain(`.${name}`)
    }
    expect(css).toContain('body[data-ds-dark-theme]')
  })

  it('keeps board class names clear of the shared panel click-out selector', () => {
    // panel-mount-core closes the board on ANY click that lands on an element
    // whose class carries one of these sidebar-row substrings (document-level
    // capture listener). Board-local classes must never carry them, or a click
    // inside a modal row would close the whole board (the 0.4.0 acceptance
    // bug: clicking the new-project input switched the view back to chat).
    const tokens = ['sessionRow', 'projectRow', 'searchResultRow', 'searchResultWorkspace', 'newSession']
    const classNames = new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(match => match[1]))
    for (const name of classNames) {
      for (const token of tokens) {
        expect(name, `class .${name} collides with shared click-out token "${token}"`).not.toContain(token)
      }
    }
  })
})

describe('project switcher (SSR mount)', () => {
  const controller = {
    setSelectedProject: () => {},
  } as unknown as BoardController

  it('renders the collapsed "all projects" chip with the board total', () => {
    const html = renderToString(createElement(ProjectSwitcher, {
      controller,
      projects,
      defaultProjectId: 'default',
      tasks: [ownedTask(), defaultArchivedTask()],
      onManage: () => {},
    }))
    expect(html).toContain('全部项目')
    // One on-board card (the archived one does not count) and no project selected.
    expect(html).toContain('1')
  })

  it('renders the selected project name and count in the chip', () => {
    const html = renderToString(createElement(ProjectSwitcher, {
      controller,
      projects,
      defaultProjectId: 'default',
      selectedProjectId: 'p1',
      tasks: [ownedTask()],
      onManage: () => {},
    }))
    // Collapsed chip: the selected project name, its own card count, and the
    // palette token resolved through the theme variable.
    expect(html).toContain('项目一')
    expect(html).toContain('1')
    expect(html).toContain('var(--dsh-tb-project-c2)')
  })
})

describe('task card project chip (SSR mount)', () => {
  it('shows the owning project on the card and hides it without a roster', () => {
    const task = ownedTask()
    const withRoster = renderToString(createElement(TaskCard, {
      task,
      pending: false,
      onClick: () => {},
      onOpenSession: () => {},
      gateCount: 0,
      projects,
    }))
    expect(withRoster).toContain('项目一')
    const withoutRoster = renderToString(createElement(TaskCard, {
      task,
      pending: false,
      onClick: () => {},
      onOpenSession: () => {},
      gateCount: 0,
    }))
    expect(withoutRoster).not.toContain('项目一')
  })
})

describe('task detail project row (SSR mount)', () => {
  it('renders the 所属项目 select with the owning project selected', () => {
    const html = renderToString(createElement(TaskDetail, {
      controller: detailController(ownedTask()),
      task: ownedTask(),
    }))
    expect(html).toContain('所属项目')
    expect(html).toContain('value="p1"')
  })

  it('hides the row when the snapshot carries no project layer', () => {
    const controller = detailController(ownedTask(), { projects: [], defaultProjectId: undefined })
    const html = renderToString(createElement(TaskDetail, { controller, task: ownedTask() }))
    expect(html).not.toContain('所属项目')
  })
})

describe('dashboard project dimension (SSR mount)', () => {
  it('adds the per-project table in "all" scope, row values included', () => {
    const tasks = [ownedTask()]
    const allTasks = [ownedTask(), defaultArchivedTask()]
    const html = renderToString(createElement(Dashboard, {
      controller: detailController(tasks[0]),
      tasks,
      allTasks,
      timeZone: ZONE,
      projects,
    }))
    expect(html).toContain('按项目统计')
    expect(html).toContain('项目一')
    // p1: one on-board card, no archive, one settled success.
    expect(html).toContain('100%')
    // The archived default-project card shows up only in its archive column.
    expect(html).toContain('Default')
  })

  it('scopes the panel to one project and drops the table', () => {
    const tasks = [ownedTask()]
    const html = renderToString(createElement(Dashboard, {
      controller: detailController(tasks[0]),
      tasks,
      timeZone: ZONE,
      projects,
      selectedProjectId: 'p1',
      onSelectProject: () => {},
    }))
    expect(html).toContain('统计范围：项目一')
    // The per-project table only renders in "all" scope; the scoped view
    // carries no table element at all.
    expect(html).not.toContain('<table')
  })
})
