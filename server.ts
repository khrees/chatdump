import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import {
  handleChatProxyRequest,
  isChatProxyRequest,
} from './src/lib/chat-proxy'
import {
  handleClaudeSnapshotProxyRequest,
  isClaudeSnapshotProxyRequest,
} from './src/lib/claude-proxy'
import {
  handlePrivateProviderHealthRequest,
  isPrivateProviderHealthRequest,
} from './src/lib/provider-health'
import {
  createRateLimiter,
  forbiddenResponse,
  getClientIp,
  isSameOriginRequest,
  rateLimitedResponse,
} from './src/lib/security'

// Per-endpoint flood guards (per server instance — see security.ts).
// These endpoints burn paid resources per call (proxy bandwidth,
// browser launches, streamed LLM responses).
const chatProxyLimiter = createRateLimiter({ max: 30, windowMs: 60_000 })
const snapshotLimiter = createRateLimiter({ max: 30, windowMs: 60_000 })
const serverFnLimiter = createRateLimiter({ max: 120, windowMs: 60_000 })
const healthLimiter = createRateLimiter({ max: 60, windowMs: 60_000 })

function guardEndpoint(
  request: Request,
  limiter: ReturnType<typeof createRateLimiter>,
  options: { checkOrigin: boolean; name: string },
): Response | null {
  const ip = getClientIp(request)

  if (options.checkOrigin && !isSameOriginRequest(request)) {
    console.warn('[chatdump] Rejected cross-origin API request', {
      name: options.name,
    })
    return forbiddenResponse()
  }

  const limit = limiter.check(`${options.name}:${ip}`)
  if (!limit.allowed) {
    console.warn('[chatdump] Rate-limited API request', {
      name: options.name,
      retryAfterMs: limit.retryAfterMs,
    })
    return rateLimitedResponse(limit.retryAfterMs)
  }

  return null
}

export default createServerEntry({
  fetch(request) {
    if (isChatProxyRequest(request)) {
      const blocked = guardEndpoint(request, chatProxyLimiter, {
        checkOrigin: true,
        name: 'chat-proxy',
      })
      if (blocked) return blocked
      return handleChatProxyRequest(request)
    }

    if (isClaudeSnapshotProxyRequest(request)) {
      const blocked = guardEndpoint(request, snapshotLimiter, {
        checkOrigin: true,
        name: 'claude-snapshot',
      })
      if (blocked) return blocked
      return handleClaudeSnapshotProxyRequest(request)
    }

    if (isPrivateProviderHealthRequest(request)) {
      // Token-gated (see provider-health.ts); external monitors may call
      // without browser origin headers, so no origin check here.
      const blocked = guardEndpoint(request, healthLimiter, {
        checkOrigin: false,
        name: 'provider-health',
      })
      if (blocked) return blocked
      return handlePrivateProviderHealthRequest(request)
    }

    if (new URL(request.url).pathname.startsWith('/_serverFn/')) {
      const blocked = guardEndpoint(request, serverFnLimiter, {
        checkOrigin: true,
        name: 'server-fn',
      })
      if (blocked) return blocked
    }

    return handler.fetch(request)
  },
})
