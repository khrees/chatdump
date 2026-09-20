import { timingSafeEqual } from 'node:crypto'
import { convertShareUrlToMarkdown } from './extract'
import type { ShareProvider } from './url'

const DEFAULT_PROVIDER_HEALTH_CACHE_TTL_MS = 5 * 60 * 1000
export const PRIVATE_PROVIDER_HEALTH_PATH = '/api/private/provider-health'
const PROVIDERS: ShareProvider[] = [
  'chatgpt',
  'claude',
  'copilot',
  'gemini',
  'grok',
  'meta',
]

export const PROVIDER_HEALTH_TOKEN_ENV_NAME = 'CHATDUMP_HEALTH_TOKEN'
export const PROVIDER_HEALTH_CACHE_TTL_ENV_NAME = 'CHATDUMP_HEALTH_CACHE_TTL_MS'
export const PROVIDER_HEALTH_URL_ENV_NAMES: Record<ShareProvider, string> = {
  chatgpt: 'CHATDUMP_HEALTH_CHATGPT_URL',
  claude: 'CHATDUMP_HEALTH_CLAUDE_URL',
  copilot: 'CHATDUMP_HEALTH_COPILOT_URL',
  gemini: 'CHATDUMP_HEALTH_GEMINI_URL',
  grok: 'CHATDUMP_HEALTH_GROK_URL',
  meta: 'CHATDUMP_HEALTH_META_URL',
}

export interface ProviderHealthProbeResult {
  checkedAt: string
  configured: boolean
  durationMs: number
  error?: string
  messageCount?: number
  sourceUrl?: string
  status: 'failing' | 'passing' | 'unconfigured'
  title?: string
  warningCount?: number
}

export interface ProviderHealthResponseBody {
  cached: boolean
  checkedAt: string
  ok: boolean
  providers: Partial<Record<ShareProvider, ProviderHealthProbeResult>>
  requestedProviders: ShareProvider[]
}

interface CachedProviderHealthResponse {
  expiresAt: number
  response: ProviderHealthResponseBody
}

interface ProviderHealthHandlerOptions {
  env?: Record<string, string | undefined>
  now?: () => number
  probeProvider?: ProbeProvider
}

interface ProviderProbeResult {
  messageCount: number
  sourceUrl: string
  title: string
  warningCount: number
}

type ProbeProvider = (
  provider: ShareProvider,
  url: string,
) => Promise<ProviderProbeResult>

const providerHealthCache = new Map<string, CachedProviderHealthResponse>()

export function isPrivateProviderHealthRequest(request: Request): boolean {
  return new URL(request.url).pathname === PRIVATE_PROVIDER_HEALTH_PATH
}

export function clearProviderHealthCache() {
  providerHealthCache.clear()
}

export async function handlePrivateProviderHealthRequest(
  request: Request,
  options: ProviderHealthHandlerOptions = {},
): Promise<Response> {
  const env = options.env ?? process.env
  const token = readNonEmptyEnv(env[PROVIDER_HEALTH_TOKEN_ENV_NAME])

  if (!token) {
    return new Response('Not Found', {
      status: 404,
    })
  }

  if (request.method !== 'GET') {
    return jsonResponse(
      {
        error: 'method_not_allowed',
      },
      {
        allow: 'GET',
        status: 405,
      },
    )
  }

  if (!isAuthorizedRequest(request, token)) {
    return jsonResponse(
      {
        error: 'unauthorized',
      },
      {
        headers: {
          'www-authenticate': 'Bearer realm="chatdump-provider-health"',
        },
        status: 401,
      },
    )
  }

  const requestUrl = new URL(request.url)
  const requestedProviders = parseRequestedProviders(requestUrl.searchParams)

  if (!requestedProviders) {
    return jsonResponse(
      {
        error: 'invalid_provider',
        supportedProviders: PROVIDERS,
      },
      {
        status: 400,
      },
    )
  }

  const now = options.now ?? Date.now
  const cacheKey = requestedProviders.join(',')
  const fresh = isTruthyQueryFlag(requestUrl.searchParams.get('fresh'))

  if (!fresh) {
    const cached = getCachedProviderHealthResponse(cacheKey, now())

    if (cached) {
      return jsonResponse({
        ...cached,
        cached: true,
      })
    }
  }

  const response = await buildProviderHealthResponse(requestedProviders, {
    env,
    now,
    probeProvider: options.probeProvider ?? probeProviderShareUrl,
  })

  setCachedProviderHealthResponse(cacheKey, response, now(), getCacheTtlMs(env))

  return jsonResponse(response)
}

async function buildProviderHealthResponse(
  requestedProviders: ShareProvider[],
  options: Required<Pick<ProviderHealthHandlerOptions, 'env' | 'now' | 'probeProvider'>>,
): Promise<ProviderHealthResponseBody> {
  const checkedAt = new Date(options.now()).toISOString()
  const providers: Partial<Record<ShareProvider, ProviderHealthProbeResult>> = {}

  for (const provider of requestedProviders) {
    const probeUrl = readNonEmptyEnv(options.env[PROVIDER_HEALTH_URL_ENV_NAMES[provider]])

    if (!probeUrl) {
      providers[provider] = {
        checkedAt,
        configured: false,
        durationMs: 0,
        status: 'unconfigured',
      }
      continue
    }

    const startedAt = options.now()

    try {
      const result = await options.probeProvider(provider, probeUrl)

      providers[provider] = {
        checkedAt,
        configured: true,
        durationMs: options.now() - startedAt,
        messageCount: result.messageCount,
        sourceUrl: result.sourceUrl,
        status: 'passing',
        title: result.title,
        warningCount: result.warningCount,
      }
    } catch (cause) {
      providers[provider] = {
        checkedAt,
        configured: true,
        durationMs: options.now() - startedAt,
        error: getErrorMessage(cause),
        status: 'failing',
      }
    }
  }

  return {
    cached: false,
    checkedAt,
    ok: requestedProviders.every((provider) => providers[provider]?.status === 'passing'),
    providers,
    requestedProviders,
  }
}

async function probeProviderShareUrl(
  provider: ShareProvider,
  url: string,
): Promise<ProviderProbeResult> {
  const result = await convertShareUrlToMarkdown(url, {
    disableCache: true,
    exportedAt: new Date(),
  })

  return {
    messageCount: result.conversation.messages.length,
    sourceUrl: result.conversation.sourceUrl,
    title: result.conversation.title,
    warningCount: result.warnings.length,
  }
}

function parseRequestedProviders(searchParams: URLSearchParams): ShareProvider[] | null {
  const rawProviders = [...searchParams.getAll('provider'), ...searchParams.getAll('providers')]
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)

  if (rawProviders.length === 0) {
    return [...PROVIDERS]
  }

  const requestedProviders = new Set<ShareProvider>()

  for (const provider of rawProviders) {
    if (!isShareProvider(provider)) {
      return null
    }

    requestedProviders.add(provider)
  }

  return PROVIDERS.filter((provider) => requestedProviders.has(provider))
}

function isAuthorizedRequest(request: Request, expectedToken: string): boolean {
  const suppliedToken =
    readBearerToken(request.headers.get('authorization')) ??
    readNonEmptyEnv(request.headers.get('x-chatdump-health-token'))

  if (!suppliedToken) {
    return false
  }

  return secureEquals(suppliedToken, expectedToken)
}

function readBearerToken(authorizationHeader: string | null): string | null {
  const authorizationMatch = authorizationHeader?.match(/^Bearer\s+(.+)$/i)
  return readNonEmptyEnv(authorizationMatch?.[1] ?? null)
}

function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)

  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }

  return timingSafeEqual(leftBuffer, rightBuffer)
}

function getCachedProviderHealthResponse(
  cacheKey: string,
  now: number,
): ProviderHealthResponseBody | null {
  pruneExpiredProviderHealthResponses(now)

  const cached = providerHealthCache.get(cacheKey)

  if (!cached) {
    return null
  }

  return cloneProviderHealthResponse(cached.response)
}

function setCachedProviderHealthResponse(
  cacheKey: string,
  response: ProviderHealthResponseBody,
  now: number,
  ttlMs: number,
) {
  if (ttlMs <= 0) {
    return
  }

  providerHealthCache.set(cacheKey, {
    expiresAt: now + ttlMs,
    response: cloneProviderHealthResponse(response),
  })
}

function pruneExpiredProviderHealthResponses(now: number) {
  for (const [cacheKey, cached] of providerHealthCache.entries()) {
    if (cached.expiresAt <= now) {
      providerHealthCache.delete(cacheKey)
    }
  }
}

function getCacheTtlMs(env: Record<string, string | undefined>): number {
  const rawValue = readNonEmptyEnv(env[PROVIDER_HEALTH_CACHE_TTL_ENV_NAME])

  if (!rawValue) {
    return DEFAULT_PROVIDER_HEALTH_CACHE_TTL_MS
  }

  const parsedValue = Number(rawValue)

  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    return DEFAULT_PROVIDER_HEALTH_CACHE_TTL_MS
  }

  return Math.floor(parsedValue)
}

function isTruthyQueryFlag(value: string | null): boolean {
  if (!value) {
    return false
  }

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
      return true
    default:
      return false
  }
}

function isShareProvider(value: string): value is ShareProvider {
  return PROVIDERS.some((provider) => provider === value)
}

function cloneProviderHealthResponse(
  response: ProviderHealthResponseBody,
): ProviderHealthResponseBody {
  if (typeof structuredClone === 'function') {
    return structuredClone(response)
  }

  return JSON.parse(JSON.stringify(response))
}

function jsonResponse(
  body: unknown,
  options: {
    allow?: string
    headers?: Record<string, string>
    status?: number
  } = {},
): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      ...(options.allow ? { allow: options.allow } : {}),
      ...options.headers,
    },
    status: options.status ?? 200,
  })
}

function readNonEmptyEnv(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function getErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'unknown error'
}
