/**
 * Dashboard dimension switcher (today/total): a light mount assertion per the
 * pure-UI smoke-test allowance. SSR-renders the Dashboard panel and checks
 * the default tab, the tab buttons' aria state, and that the today window
 * actually slices the overview numbers (created-today tiles + settled-today
 * runs).
 */
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BoardController } from '../src/core/controller.ts'
import { startOfDayMs } from '../src/core/dashboard.ts'
import { createTask, settleExecution, startExecution } from '../src/core/tasks.ts'
import { Dashboard } from '../src/client/board/Dashboard.tsx'

// The SSR node runtime has no document, so the dictionary falls back to zh.
const controller = {
  openTask: () => {},
  rerunTask: async () => {},
  moveTask: () => {},
} as unknown as BoardController

const ZONE = 'Asia/Shanghai'

function boardAroundToday(): string {
  const start = startOfDayMs(Date.now(), ZONE)
  // Yesterday's task: created and settled before the window.
  let old = createTask({ title: 'old', description: '', prompt: '' }, start - 60_000, 'old')
  const { task: oldRunning } = startExecution(old, start - 50_000, 'old-run')
  old = settleExecution(oldRunning, 'old-run', 'succeeded', start - 1000, undefined)
  // Today's task: created after the window, settled inside it.
  let fresh = createTask({ title: 'fresh', description: '', prompt: '' }, start + 1000, 'fresh')
  const { task: freshRunning } = startExecution(fresh, start + 2000, 'fresh-run')
  fresh = settleExecution(freshRunning, 'fresh-run', 'succeeded', start + 3000, undefined)
  const html = renderToString(createElement(Dashboard, {
    controller,
    tasks: [old, fresh],
    timeZone: ZONE,
  }))
  return html
}

describe('dashboard dimension switcher', () => {
  it('renders both tab buttons with "today" selected by default', () => {
    const html = boardAroundToday()
    expect(html).toMatch(/<button[^>]*aria-selected="true"[^>]*>今日<\/button>/)
    expect(html).toMatch(/<button[^>]*aria-selected="false"[^>]*>总计<\/button>/)
  })

  it('slices the overview to the today window on the default tab', () => {
    const html = boardAroundToday()
    // Only the created-today task settles a run inside the window, so the
    // today tally is exactly one success (yesterday's run is excluded).
    expect(html).toContain('成功 1')
    expect(html).not.toContain('成功 2')
  })
})
