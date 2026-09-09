/**
 * New-task request bus contract: no-op without a subscriber, one listener
 * at a time (replacement semantics — the overlay owns the bus, a later
 * subscriber takes it over), and unsubscribe restores the previous one.
 */
import { describe, expect, it } from 'vitest'
import { onNewTaskRequest, requestNewTask } from '../src/client/new-task-request.ts'

describe('new-task request bus', () => {
  it('is a no-op while no subscriber is attached', () => {
    expect(() => { requestNewTask({ sourceSession: { id: 's1', title: 't' } }) }).not.toThrow()
  })

  it('delivers the request to the attached listener', () => {
    const seen: unknown[] = []
    const unsubscribe = onNewTaskRequest(request => { seen.push(request) })
    requestNewTask({ sourceSession: { id: 's1', title: '写周报' } })
    unsubscribe()
    expect(seen).toEqual([{ sourceSession: { id: 's1', title: '写周报' } }])
  })

  it('replaces the current listener and restores on unsubscribe', () => {
    const first: unknown[] = []
    const second: unknown[] = []
    const offFirst = onNewTaskRequest(request => { first.push(request) })
    const offSecond = onNewTaskRequest(request => { second.push(request) })

    requestNewTask({ sourceSession: { id: 'a', title: 'a' } })
    offSecond()
    requestNewTask({ sourceSession: { id: 'b', title: 'b' } })
    offFirst()
    expect(() => { requestNewTask({ sourceSession: { id: 'c', title: 'c' } }) }).not.toThrow()

    expect(first).toEqual([{ sourceSession: { id: 'b', title: 'b' } }])
    expect(second).toEqual([{ sourceSession: { id: 'a', title: 'a' } }])
  })
})
