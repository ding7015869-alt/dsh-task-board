import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { nextRunAtMs } from './core/schedule.ts'
import { reworkSessionId, reusableSessionId, sourceSessionId } from './core/session-reuse.ts'
import { reworkSection } from './core/rework.ts'
import { HostTaskLedger, type OpenedRun, type OpenExecutionReference } from './host-ledger.ts'
import { HostExecutionRunner, promptText, SessionLaunchError, type SessionCommandDispatcher, type SessionSummary, type TaskBoardWorkspaceRegistry } from './host-runner.ts'
import { PowerInhibitor } from './power-inhibitor.ts'
import { TASK_BOARD_SCHEMA_VERSION, type TaskBoardAction, type TaskBoardAutomationSnapshot, type TaskBoardEventPayload, type TaskBoardSnapshot } from './protocol.ts'
import { DEFAULT_PROJECT_ID } from './core/projects.ts'
import { pendingParentTasks, unconsumedReworkNotes } from './core/tasks.ts'
import { requiresPermissionConfirmation, type TaskPermission } from './core/handover.ts'
import { openExecutionCount, PATROL_STATUSES } from './core/executability.ts'

const SESSION_POLL_MS = 5_000
const SCHEDULE_TICK_MS = 30_000
const RESUME_GAP_MS = SCHEDULE_TICK_MS + 15_000
/** Default patrol interval: same cadence as the cron tick. */
const PATROL_DEFAULT_INTERVAL_MS = SCHEDULE_TICK_MS
/** Lower bound for a configured patrol interval. */
const PATROL_MIN_INTERVAL_MS = 1_000

/** Clamp a configured patrol interval to a usable duration (>= 1000 ms); bad values fall back to the default. */
function normalizePatrolIntervalMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= PATROL_MIN_INTERVAL_MS ? value : PATROL_DEFAULT_INTERVAL_MS
}

export class TaskBoardHostService {
  readonly ledger: HostTaskLedger
  readonly runner: HostExecutionRunner
  readonly power: PowerInhibitor
  private readonly listeners = new Set<() => void>()
  private timers: Array<ReturnType<typeof setInterval>> = []
  private lastScheduleTick: number | undefined
  private disposed = false
  private pollInFlight = false
  private tickInFlight = false
  private active = true
  /**
   * Ids the last roster poll saw as present and idle; undefined while the
   * roster is unknown. Session reuse (issue #1419) requires this positive
   * evidence, so a launch before the first successful poll mints a fresh
   * conversation instead of prompting into a session it cannot see.
   */
  private idleSessionIds: ReadonlySet<string> | undefined
  private preventIdleSleep = false
  private lastPowerJson = ''
  /** The patrol dispatcher's live settings (rebuilt by setConfiguration). */
  private patrolEnabled = false
  private patrolIntervalMs: number
  private patrolTimer: ReturnType<typeof setInterval> | undefined
  private patrolInFlight = false
  private lastPatrolAt: number | undefined
  private readonly now: () => number

  constructor(gateway: TypertGateway, options: {
    ledger?: HostTaskLedger
    power?: PowerInhibitor
    now?: () => number
    commandDispatcher?: SessionCommandDispatcher
    workspaceRegistry?: TaskBoardWorkspaceRegistry
    sessionDefaultPermission?: TaskPermission
    /** The board-wide concurrency cap (>= 1); shared by manual, scheduled, and patrol runs. */
    maxConcurrency?: number
    /** Whether the periodic patrol dispatcher is on. */
    patrolEnabled?: boolean
    /** The patrol scan interval in milliseconds (>= 1000). */
    patrolIntervalMs?: number
  } = {}) {
    this.ledger = options.ledger ?? new HostTaskLedger(undefined, undefined, {
      sessionDefaultPermission: options.sessionDefaultPermission,
      maxConcurrency: options.maxConcurrency,
    })
    this.runner = new HostExecutionRunner(gateway, options.commandDispatcher, options.workspaceRegistry)
    this.power = options.power ?? new PowerInhibitor()
    this.now = options.now ?? Date.now
    this.patrolEnabled = options.patrolEnabled ?? false
    this.patrolIntervalMs = normalizePatrolIntervalMs(options.patrolIntervalMs)
    if (options.maxConcurrency !== undefined) this.ledger.setMaxConcurrency(options.maxConcurrency)
    this.ledger.subscribe(() => {
      this.syncPowerReasons()
      this.emit()
    })
    this.power.subscribe(() => {
      // updateReasons emits on every poll tick even when nothing changed;
      // gate on the actual snapshot so the 5 s heartbeat does not push an
      // empty SSE frame per tab forever.
      const json = JSON.stringify(this.power.snapshot())
      if (json === this.lastPowerJson) return
      this.lastPowerJson = json
      this.emit()
    })
  }

  start(): void {
    if (this.disposed || this.timers.length > 0) return
    this.syncPowerReasons()
    this.timers.push(setInterval(() => { this.schedulePoll() }, SESSION_POLL_MS))
    this.timers.push(setInterval(() => { this.scheduleTick(false) }, SCHEDULE_TICK_MS))
    this.schedulePoll()
    this.scheduleTick(true)
    this.startPatrol()
  }

  setConfiguration(active: boolean, preventIdleSleep: boolean, automation?: { maxConcurrency?: number; patrolEnabled?: boolean; patrolIntervalMs?: number }): void {
    const resumed = !this.active && active
    this.active = active
    this.preventIdleSleep = preventIdleSleep
    if (automation !== undefined) this.applyAutomationConfiguration(automation)
    if (resumed) {
      const current = this.power.snapshot()
      this.power.updateReasons({
        runningSessions: current.runningSessions,
        armedSchedules: this.armedSchedules(),
        sessionStateKnown: false,
      })
    }
    this.power.setEnabled(active && preventIdleSleep)
    if (resumed) {
      this.schedulePoll()
      this.scheduleTick(true)
    }
    // Rebuild the patrol timer to match the (possibly updated) active flag
    // and settings: disabling the board tears it down, re-enabling restores it.
    this.startPatrol()
    this.emit()
  }

  /**
   * Update the automation settings live: the concurrency cap moves the gate
   * on the ledger, the patrol settings update this service. Open executions
   * are never touched; the caller's setConfiguration rebuilds the timer.
   */
  private applyAutomationConfiguration(automation: { maxConcurrency?: number; patrolEnabled?: boolean; patrolIntervalMs?: number }): void {
    if (automation.maxConcurrency !== undefined) this.ledger.setMaxConcurrency(automation.maxConcurrency)
    if (automation.patrolEnabled !== undefined) this.patrolEnabled = automation.patrolEnabled
    if (automation.patrolIntervalMs !== undefined) this.patrolIntervalMs = normalizePatrolIntervalMs(automation.patrolIntervalMs)
  }

  /** (Re)build the patrol timer to match the current settings; disabled means no timer. */
  private startPatrol(): void {
    this.stopPatrol()
    if (this.disposed || !this.patrolEnabled || !this.active) return
    this.patrolTimer = setInterval(() => { this.schedulePatrol() }, this.patrolIntervalMs)
  }

  private stopPatrol(): void {
    if (this.patrolTimer !== undefined) {
      clearInterval(this.patrolTimer)
      this.patrolTimer = undefined
    }
  }

  private schedulePatrol(): void {
    if (this.patrolInFlight || this.disposed) return
    this.patrolInFlight = true
    void this.patrolTick().catch(error => {
      console.error('[dsh-task-board] patrol tick failed', error)
    }).finally(() => { this.patrolInFlight = false })
  }

  /**
   * One patrol pass: find the new todo tasks that satisfy EVERY
   * executability condition and dispatch them up to the free concurrency
   * slots. The ledger re-checks the full gate at open time, so a candidate
   * that lost its slot (parent, permission, cron ownership, cap) is never
   * started; patrol also never confirms permissions — that stays human.
   */
  private async patrolTick(): Promise<void> {
    if (this.disposed || !this.active || !this.patrolEnabled) return
    const now = this.now()
    this.lastPatrolAt = now
    const state = this.ledger.state()
    let free = Math.max(0, this.ledger.maxConcurrency - openExecutionCount(state.tasks))
    for (const task of state.tasks) {
      if (free <= 0) break
      // Cheap pre-filter; the ledger re-checks every condition at open time.
      if (task.archivedAt !== undefined || !PATROL_STATUSES.includes(task.status) || task.schedule?.enabled === true) continue
      if (task.executions.some(execution => execution.endedAt === undefined)) continue
      const opened = this.ledger.openPatrolRun(task.id, now)
      if (opened === undefined) continue
      free -= 1
      this.scheduleLaunch(opened)
    }
    this.emit()
  }

  /**
   * The settle-driven auto-continuation: after a run settles (or an apply
   * unblocks work — a manual done, a permission confirmation), dispatch the
   * children that just became eligible into the free concurrency slots.
   * Scoped to tasks WITH parents — the parent-to-child pipeline: a fresh
   * independent todo stays the patrol dispatcher's (opt-in) job, so creating
   * a task never auto-starts it. The pre-filter is cheap; the ledger
   * re-checks EVERY condition at open time, so a candidate that lost its
   * slot (a parent, a permission, cron ownership, the cap) is never started
   * and simply waits for the next trigger. It always runs, independent of
   * the opt-in patrol, so a finished parent hands its children to the board
   * without a timer in between.
   */
  private dispatchContinue(): void {
    if (this.disposed || !this.active) return
    const now = this.now()
    const state = this.ledger.state()
    let free = Math.max(0, this.ledger.maxConcurrency - openExecutionCount(state.tasks))
    for (const task of state.tasks) {
      if (free <= 0) break
      // Cheap pre-filter; the ledger re-checks every condition at open time.
      if (task.archivedAt !== undefined || !PATROL_STATUSES.includes(task.status) || task.schedule?.enabled === true) continue
      if (task.executions.some(execution => execution.endedAt === undefined)) continue
      // Continuation is the parent-to-child pipeline: only a task WITH
      // parents can have just unblocked by a settle. Fresh independent todos
      // are the patrol dispatcher's (opt-in) job and stay user-controlled.
      if (task.parentIds.length === 0) continue
      if (pendingParentTasks(task, state.tasks).length > 0) continue
      if (requiresPermissionConfirmation(task, this.ledger.sessionDefaultPermission)) continue
      const opened = this.ledger.openContinueRun(task.id, now)
      if (opened === undefined) continue
      free -= 1
      this.scheduleLaunch(opened)
    }
  }

  snapshot(): TaskBoardSnapshot {
    const state = this.ledger.state()
    return {
      schemaVersion: TASK_BOARD_SCHEMA_VERSION,
      revision: state.revision,
      tasks: state.tasks,
      projects: state.projects,
      defaultProjectId: DEFAULT_PROJECT_ID,
      scheduler: state.scheduler,
      power: this.power.snapshot(),
      sessionDefaultPermission: this.ledger.sessionDefaultPermission,
      automation: this.automationSnapshot(),
      nextSerial: state.nextSerial,
    }
  }

  /** SSE frame payload; deliberately skips the tasks deep-clone of {@link snapshot}. */
  eventPayload(): TaskBoardEventPayload {
    const { revision, scheduler } = this.ledger.summary()
    return { revision, scheduler, power: this.power.snapshot(), automation: this.automationSnapshot() }
  }

  /** The board's automation block: concurrency usage vs cap and the patrol state. */
  automationSnapshot(): TaskBoardAutomationSnapshot {
    return {
      maxConcurrency: this.ledger.maxConcurrency,
      openExecutions: this.ledger.runtimeView().openExecutions.length,
      patrolEnabled: this.patrolEnabled,
      patrolIntervalMs: this.patrolIntervalMs,
      ...(this.lastPatrolAt === undefined ? {} : { lastPatrolAt: this.lastPatrolAt }),
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  apply(requestId: string, action: TaskBoardAction, initiator?: string): TaskBoardSnapshot {
    if (!this.active) throw new Error('task board is disabled')
    const result = this.ledger.applyRequest(requestId, action, initiator)
    if (result.run !== undefined) this.scheduleLaunch(result.run)
    // An apply can unblock work (a manual done, a permission confirmation):
    // hand the newly eligible tasks to the board right away.
    this.dispatchContinue()
    return {
      schemaVersion: TASK_BOARD_SCHEMA_VERSION,
      revision: result.state.revision,
      tasks: result.state.tasks,
      projects: result.state.projects,
      defaultProjectId: DEFAULT_PROJECT_ID,
      scheduler: result.state.scheduler,
      power: this.power.snapshot(),
      automation: this.automationSnapshot(),
      nextSerial: result.state.nextSerial,
    }
  }

  dispose(): void {
    this.disposed = true
    this.stopPatrol()
    for (const timer of this.timers.splice(0)) clearInterval(timer)
    this.power.dispose()
    this.ledger.dispose()
    this.listeners.clear()
  }

  private async launch(opened: OpenedRun): Promise<void> {
    try {
      // Rework (reject-and-fix) execution: the card was sent back with
      // modification requirements. The fix continues in the ORIGINAL
      // execution session (the last settled execution's recorded session id,
      // no roster check) and queues ONLY the notes — the original prompt
      // already lives in the session history. Only a card that never ran to
      // a recorded session falls back to a fresh one carrying the full task
      // prompt plus the notes, so no context is lost either way.
      const isRework = opened.execution.rework === true
      const notes = isRework ? unconsumedReworkNotes(opened.task) : []
      let reuseSessionId: string | undefined
      let promptOverride: string | undefined
      if (isRework && notes.length > 0) {
        const target = reworkSessionId(opened.task)
        if (target !== undefined) {
          reuseSessionId = target
          promptOverride = reworkSection(notes)
        } else {
          promptOverride = `${promptText(opened.task)}\n\n${reworkSection(notes)}`
        }
      } else {
        // The card's source session (the session-row "add as task card"
        // entry) anchors execution ahead of the generic reuse rule: a card
        // created from a session keeps running in that conversation while
        // the roster confirms it idle. Without a source session (or with an
        // unknown roster / busy session) the previous-run reuse rule or a
        // fresh conversation applies as before.
        reuseSessionId = sourceSessionId(opened.task, this.idleSessionIds)
          ?? reusableSessionId(opened.task, this.idleSessionIds)
      }
      const options: { reuseSessionId?: string; promptOverride?: string } = {}
      if (reuseSessionId !== undefined) options.reuseSessionId = reuseSessionId
      if (promptOverride !== undefined) options.promptOverride = promptOverride
      const sessionId = await this.runner.launch(opened.task, options)
      this.ledger.attachSession(opened.task.id, opened.execution.id, sessionId)
      // The prompt actually reached the session: mark the card's pending
      // modification notes as consumed. A launch that failed before the
      // prompt was queued keeps them unconsumed, so the next execution
      // re-queues them instead of silently dropping a rework round.
      if (isRework && notes.length > 0) this.ledger.consumeRework(opened.task.id, opened.execution.id)
    } catch (error) {
      if (error instanceof SessionLaunchError) {
        this.ledger.attachSession(opened.task.id, opened.execution.id, error.sessionId)
      }
      this.ledger.settle(opened.task.id, opened.execution.id, 'failed', error instanceof Error ? error.message : String(error))
      // A failed parent still settles its children's dependency gate.
      this.dispatchContinue()
    }
  }

  private async pollSessions(): Promise<void> {
    if (this.disposed) return
    if (!this.active && this.ledger.runtimeView().openExecutions.length === 0) return
    const running = await this.runner.listRunning()
    const previous = this.power.snapshot()
    if (!running.known) {
      this.idleSessionIds = undefined
      this.power.updateReasons({
        runningSessions: previous.runningSessions,
        armedSchedules: this.ledger.armedScheduleCount(),
        sessionStateKnown: false,
      })
      return
    }
    this.idleSessionIds = new Set(running.items.filter(item => !item.running).map(item => item.sessionId))
    // Read after the RPC so executions attached while it was in flight are
    // included in this pass, matching the former full-state snapshot timing.
    const runtime = this.ledger.runtimeView()
    this.power.updateReasons({
      runningSessions: running.count,
      armedSchedules: runtime.armedSchedules,
      sessionStateKnown: true,
    })
    // No unconditional emit here: real changes already emit through the
    // ledger subscription (settles) and the gated power listener above.
    await this.reconcileExecutions(running.items, runtime.openExecutions)
  }

  /** Reuse the session list this poll already fetched: one list RPC per tick, not 1 + E. */
  private async reconcileExecutions(
    sessions: readonly SessionSummary[],
    executions: readonly OpenExecutionReference[],
  ): Promise<void> {
    for (const execution of executions) {
      if (execution.sessionId === undefined) continue
      try {
        const result = await this.runner.inspect(execution.sessionId, execution.startedAt, sessions)
        if (result.outcome === 'pending') continue
        this.ledger.settle(execution.taskId, execution.executionId, result.outcome, 'error' in result ? result.error : undefined)
      } catch {
        // A transient inspection failure never settles a running execution.
      }
    }
    // Settles in this pass can unblock children: hand them to the board now
    // instead of waiting for the next poll or patrol interval.
    this.dispatchContinue()
  }

  private async tickSchedule(first: boolean): Promise<void> {
    if (this.disposed || !this.active) return
    const now = this.now()
    const recovered = first || (this.lastScheduleTick !== undefined && now - this.lastScheduleTick > RESUME_GAP_MS)
    this.lastScheduleTick = now
    this.ledger.setScheduler({ lastTickAt: now })
    if (recovered) {
      this.ledger.skipMissed(now)
      // A parent can have settled to done while the host was down: catch up
      // and hand its newly eligible children to the board on the first tick.
      this.dispatchContinue()
      return
    }
    for (const schedule of this.ledger.dueSchedules(now)) {
      const next = nextRunAtMs(schedule.cron, schedule.nextRunAt)
      const opened = this.ledger.openScheduled(schedule.taskId, next, now)
      if (opened !== undefined) this.scheduleLaunch(opened)
    }
  }

  private armedSchedules(): number {
    return this.ledger.armedScheduleCount()
  }

  private scheduleLaunch(opened: OpenedRun): void {
    void this.launch(opened).catch(error => {
      console.error('[dsh-task-board] execution launch settlement failed', error)
    })
  }

  private schedulePoll(): void {
    if (this.pollInFlight || this.disposed) return
    this.pollInFlight = true
    void this.pollSessions().catch(error => {
      console.error('[dsh-task-board] session polling failed', error)
    }).finally(() => { this.pollInFlight = false })
  }

  private scheduleTick(first: boolean): void {
    if (this.tickInFlight || this.disposed) return
    this.tickInFlight = true
    void this.tickSchedule(first).catch(error => {
      console.error('[dsh-task-board] scheduler tick failed', error)
    }).finally(() => { this.tickInFlight = false })
  }

  private syncPowerReasons(): void {
    const current = this.power.snapshot()
    this.power.updateReasons({
      runningSessions: current.runningSessions,
      armedSchedules: this.armedSchedules(),
      sessionStateKnown: current.sessionStateKnown,
    })
    this.power.setEnabled(this.active && this.preventIdleSleep)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
