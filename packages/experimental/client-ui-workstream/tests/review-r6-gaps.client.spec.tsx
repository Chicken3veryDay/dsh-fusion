// @vitest-environment jsdom

import { afterEach, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { ChangesView } from '../src/client/views.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import { ROOT, WORKER } from './fixtures.client.ts'

afterEach(cleanup)

it.each(Object.entries({ de, en, es, fr, ja, pt, ru, zh }))(
  'R6-C4 Changes localizes both typed gap variants in %s without rendering the model diagnostic',
  async (_locale, dictionary) => {
    const t = makeTranslate(dictionary, commonEn)
    await act(async () => {
      render(<ChangesView sessionId={ROOT} nameOf={() => 'reviewer'} t={t} changeRequests={async () => ({
        ok: true,
        value: {
          complete: false,
          changeRequests: [],
          diagnostics: ['MODEL-ONLY HOST DIAGNOSTIC'],
          gaps: [{ kind: 'forge-unavailable' }, { kind: 'session-not-loaded', sessionId: WORKER }],
        },
      })} />)
    })
    expect(screen.getByRole('status').textContent).toBe(t('changes.incomplete', {
      reasons: `${t('changes.gap.forge')}; ${t('changes.gap.session', { name: 'reviewer' })}`,
    }))
    expect(screen.queryByText('MODEL-ONLY HOST DIAGNOSTIC')).toBeNull()
    expect(screen.getByText(dictionary['changes.empty'])).toBeTruthy()
  },
)
