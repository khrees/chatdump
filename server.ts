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

export default createServerEntry({
  fetch(request) {
    if (isChatProxyRequest(request)) {
      return handleChatProxyRequest(request)
    }

    if (isClaudeSnapshotProxyRequest(request)) {
      return handleClaudeSnapshotProxyRequest(request)
    }

    if (isPrivateProviderHealthRequest(request)) {
      return handlePrivateProviderHealthRequest(request)
    }

    return handler.fetch(request)
  },
})
