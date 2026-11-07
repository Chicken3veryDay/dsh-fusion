// @vitest-environment jsdom

import { expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { failureText } from '../src/client/views.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en, commonEn)

it('localizes membership and shutdown refusals and preserves the refusal detail', () => {
  expect(failureText({ code: 'not-member', message: 'host detail' }, t)).toBe(en['error.notMember'])
  expect(failureText({ code: 'workstream-stopping', message: 'host detail' }, t)).toBe(en['error.stopping'])
  expect(failureText({ code: 'workstream-refused', message: 'provider unavailable' }, t))
    .toBe(t('error.workstream', { message: 'provider unavailable' }))
  expect(failureText({ code: 'workstream-refused', message: 'provider unavailable' }, t))
    .toContain('provider unavailable')
})
