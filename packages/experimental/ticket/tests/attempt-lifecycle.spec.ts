/** The README specification tables are the rendered transition functions, and every pair has a defined result. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import {
  attemptCommands, attemptEventTypes, attemptStateKinds, describeAttemptTransition, durableAttemptStatuses,
  isTerminal, renderAttemptTable, renderCommandTable, transitionAttempt,
} from '../src/attempt-lifecycle.ts'

function region(file: string, slug: string): string {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const begin = `<!-- BEGIN GENERATED ${slug} -->\n`
  const start = text.indexOf(begin)
  const end = text.indexOf(`\n<!-- END GENERATED ${slug} -->`)
  if (start < 0 || end < start) throw new Error(`${file} lacks the ${slug} region`)
  return text.slice(start + begin.length, end)
}

it.each(['README.md', 'README.zh.md'])('%s carries the rendered attempt and command tables', (file) => {
  expect(region(file, 'ticket-attempt-lifecycle')).toBe(renderAttemptTable())
  expect(region(file, 'ticket-attempt-commands')).toBe(renderCommandTable())
})

it('defines a transition or a typed rejection for every phase and event', () => {
  const cells = attemptStateKinds.flatMap(kind => attemptEventTypes.map(type => describeAttemptTransition(kind, type)))
  expect(cells).toHaveLength(attemptStateKinds.length * attemptEventTypes.length)
  expect(durableAttemptStatuses.length * attemptCommands.length).toBeGreaterThan(0)
})

it('never leaves a terminal phase', () => {
  for (const state of [{ kind: 'handed', outcome: 'failed' }, { kind: 'released' }] as const) {
    for (const type of attemptEventTypes) {
      const next = transitionAttempt(state, type === 'producers-settled' ? { type, outcome: 'succeeded' } : { type })
      expect('reason' in next || (isTerminal(next) && next.kind === state.kind)).toBe(true)
    }
  }
})

it('lets a failed observation dominate a cancel intent', () => {
  expect(transitionAttempt({ kind: 'stopping', cancel: true }, { type: 'producers-settled', outcome: 'failed' }))
    .toEqual({ kind: 'handed', outcome: 'failed' })
  expect(transitionAttempt({ kind: 'stopping', cancel: true }, { type: 'producers-settled', outcome: 'succeeded' }))
    .toEqual({ kind: 'handed', outcome: 'cancelled' })
})
