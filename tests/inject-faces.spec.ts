/**
 * Inject-list contract: the `remote.agentPresets` face must stay injected on
 * this fiber. The cordis traceable proxy only forwards a `remote.<ns>`
 * property when the fiber's inject list declared `remote.<ns>` (an
 * undeclared property throws "cannot get property ... without inject"), so
 * dropping the entry silently degrades the mode picker to the deployment
 * default row (the legacy connection face is absent on 0.1.5-class hosts).
 * `remote.session` is asserted alongside as the same-cohort sibling face the
 * model-catalog feed relies on.
 */
import { describe, expect, it } from 'vitest'
import { inject } from '../src/client/index.ts'

describe('client inject list', () => {
  it('injects the api-remotes preset face so the property chain resolves', () => {
    expect(inject).toContain('remote.agentPresets')
  })

  it('injects the api-remotes session face for the model-catalog feed', () => {
    expect(inject).toContain('remote.session')
  })
})
