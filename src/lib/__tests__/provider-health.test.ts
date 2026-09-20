import { beforeEach, describe, expect, test } from 'bun:test'
import {
  clearProviderHealthCache,
  handlePrivateProviderHealthRequest,
  PRIVATE_PROVIDER_HEALTH_PATH,
  PROVIDER_HEALTH_CACHE_TTL_ENV_NAME,
  PROVIDER_HEALTH_TOKEN_ENV_NAME,
  PROVIDER_HEALTH_URL_ENV_NAMES,
} from '../provider-health'

const healthUrl = `https://chatdump.vercel.app${PRIVATE_PROVIDER_HEALTH_PATH}`

describe('handlePrivateProviderHealthRequest', () => {
  beforeEach(() => {
    clearProviderHealthCache()
  })

  test('returns not found when the private health token is not configured', async () => {
    const response = await handlePrivateProviderHealthRequest(new Request(healthUrl), {
      env: {},
    })

    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Not Found')
  })

  test('requires a matching bearer token when the endpoint is enabled', async () => {
    const response = await handlePrivateProviderHealthRequest(new Request(healthUrl), {
      env: {
        [PROVIDER_HEALTH_TOKEN_ENV_NAME]: 'top-secret',
      },
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('Bearer')
    await expect(response.json()).resolves.toEqual({
      error: 'unauthorized',
    })
  })

  test('returns provider probe results and reuses the short-lived health cache', async () => {
    let probeCalls = 0
    let now = 1_000

    const env = {
      [PROVIDER_HEALTH_CACHE_TTL_ENV_NAME]: '60000',
      [PROVIDER_HEALTH_TOKEN_ENV_NAME]: 'top-secret',
      [PROVIDER_HEALTH_URL_ENV_NAMES.chatgpt]: 'https://chatgpt.com/share/example',
      [PROVIDER_HEALTH_URL_ENV_NAMES.claude]: 'https://claude.ai/share/example',
      [PROVIDER_HEALTH_URL_ENV_NAMES.copilot]:
        'https://copilot.microsoft.com/shares/example',
    }
    const request = new Request(healthUrl, {
      headers: {
        authorization: 'Bearer top-secret',
      },
    })

    const probeProvider = async (
      provider:
        | 'chatgpt'
        | 'claude'
        | 'copilot'
        | 'gemini'
        | 'grok'
        | 'meta',
    ) => {
      probeCalls += 1

      if (provider === 'claude') {
        throw new Error('blocked by upstream challenge')
      }

      return {
        messageCount: 12,
        sourceUrl: `https://${provider}.example.com/share/example`,
        title: `${provider} probe`,
        warningCount: provider === 'chatgpt' ? 1 : 0,
      }
    }

    const firstResponse = await handlePrivateProviderHealthRequest(request, {
      env,
      now: () => now,
      probeProvider,
    })
    const firstBody = await firstResponse.json()

    expect(firstResponse.status).toBe(200)
    expect(firstBody.cached).toBe(false)
    expect(firstBody.ok).toBe(false)
    expect(firstBody.requestedProviders).toEqual([
      'chatgpt',
      'claude',
      'copilot',
      'gemini',
      'grok',
      'meta',
    ])
    expect(firstBody.providers.chatgpt.status).toBe('passing')
    expect(firstBody.providers.chatgpt.warningCount).toBe(1)
    expect(firstBody.providers.claude.status).toBe('failing')
    expect(firstBody.providers.claude.error).toContain('blocked by upstream challenge')
    expect(firstBody.providers.copilot.status).toBe('passing')
    expect(firstBody.providers.gemini.status).toBe('unconfigured')
    expect(firstBody.providers.grok.status).toBe('unconfigured')
    expect(firstBody.providers.meta.status).toBe('unconfigured')
    expect(probeCalls).toBe(3)

    now += 10

    const secondResponse = await handlePrivateProviderHealthRequest(request, {
      env,
      now: () => now,
      probeProvider,
    })
    const secondBody = await secondResponse.json()

    expect(secondBody.cached).toBe(true)
    expect(secondBody.providers.claude.status).toBe('failing')
    expect(probeCalls).toBe(3)
  })

  test('supports provider filtering and a fresh override', async () => {
    let probeCalls = 0

    const env = {
      [PROVIDER_HEALTH_CACHE_TTL_ENV_NAME]: '60000',
      [PROVIDER_HEALTH_TOKEN_ENV_NAME]: 'top-secret',
      [PROVIDER_HEALTH_URL_ENV_NAMES.claude]: 'https://claude.ai/share/example',
    }
    const request = new Request(`${healthUrl}?providers=claude&fresh=1`, {
      headers: {
        'x-chatdump-health-token': 'top-secret',
      },
    })

    const probeProvider = async () => {
      probeCalls += 1

      return {
        messageCount: 4,
        sourceUrl: 'https://claude.ai/share/example',
        title: 'Claude probe',
        warningCount: 0,
      }
    }

    const firstResponse = await handlePrivateProviderHealthRequest(request, {
      env,
      probeProvider,
    })
    const firstBody = await firstResponse.json()
    const secondResponse = await handlePrivateProviderHealthRequest(request, {
      env,
      probeProvider,
    })
    const secondBody = await secondResponse.json()

    expect(firstBody.requestedProviders).toEqual(['claude'])
    expect(firstBody.ok).toBe(true)
    expect(firstBody.providers.claude.messageCount).toBe(4)
    expect(firstBody.cached).toBe(false)
    expect(secondBody.cached).toBe(false)
    expect(probeCalls).toBe(2)
  })
})
