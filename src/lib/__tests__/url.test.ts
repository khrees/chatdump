import { describe, expect, test } from 'bun:test'
import { normalizeShareUrl } from '../url'

describe('normalizeShareUrl', () => {
  test('canonicalizes ChatGPT share URLs', () => {
    const normalized = normalizeShareUrl(
      'https://chat.openai.com/share/12345678-1234-1234-1234-1234567890ab?ref=app#section',
    )

    expect(normalized.provider).toBe('chatgpt')
    expect(normalized.shareId).toBe('12345678-1234-1234-1234-1234567890ab')
    expect(normalized.url.toString()).toBe(
      'https://chatgpt.com/share/12345678-1234-1234-1234-1234567890ab',
    )
  })

  test('canonicalizes Gemini share URLs, including g.co short links', () => {
    const normalized = normalizeShareUrl(
      'https://g.co/gemini/share/ee5bab956b9f?utm_source=test#copy',
    )

    expect(normalized.provider).toBe('gemini')
    expect(normalized.shareId).toBe('ee5bab956b9f')
    expect(normalized.url.toString()).toBe(
      'https://gemini.google.com/share/ee5bab956b9f',
    )

    const normalizedShareGemini = normalizeShareUrl(
      'https://share.gemini.google/P31DmQU0QsFI?utm_source=test',
    )
    expect(normalizedShareGemini.provider).toBe('gemini')
    expect(normalizedShareGemini.shareId).toBe('P31DmQU0QsFI')
    expect(normalizedShareGemini.url.toString()).toBe(
      'https://gemini.google.com/share/P31DmQU0QsFI',
    )
  })

  test('canonicalizes Claude share URLs', () => {
    const normalized = normalizeShareUrl(
      'https://claude.ai/share/51c6593c-c94b-4708-ba87-92e60b693f7b?foo=bar',
    )

    expect(normalized.provider).toBe('claude')
    expect(normalized.shareId).toBe('51c6593c-c94b-4708-ba87-92e60b693f7b')
    expect(normalized.url.toString()).toBe(
      'https://claude.ai/share/51c6593c-c94b-4708-ba87-92e60b693f7b',
    )
  })

  test('canonicalizes Copilot share URLs', () => {
    const normalized = normalizeShareUrl(
      'https://copilot.microsoft.com/shares/RPq5nxaEsHmgN8dK842Wq?ref=share',
    )

    expect(normalized.provider).toBe('copilot')
    expect(normalized.shareId).toBe('RPq5nxaEsHmgN8dK842Wq')
    expect(normalized.url.toString()).toBe(
      'https://copilot.microsoft.com/shares/RPq5nxaEsHmgN8dK842Wq',
    )
  })

  test('canonicalizes Grok share URLs', () => {
    const normalized = normalizeShareUrl(
      'https://grok.com/share/c2hhcmQtNQ_f461c973-f826-418e-9e7e-8097b676b357?rid=test#copy',
    )

    expect(normalized.provider).toBe('grok')
    expect(normalized.shareId).toBe(
      'c2hhcmQtNQ_f461c973-f826-418e-9e7e-8097b676b357',
    )
    expect(normalized.url.toString()).toBe(
      'https://grok.com/share/c2hhcmQtNQ_f461c973-f826-418e-9e7e-8097b676b357',
    )
  })
})
