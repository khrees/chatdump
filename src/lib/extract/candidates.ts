import { asRecord } from './utils'

export function findKnownConversationCandidates(root: unknown): unknown[] {
  const candidates: unknown[] = []
  const seen = new Set<unknown>()

  function add(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value)) {
      return
    }

    seen.add(value)
    candidates.push(value)
  }

  const record = asRecord(root)

  if (!record) {
    return candidates
  }

  add(record.shareData)
  add(record.conversation)
  add(asRecord(record.serverResponse)?.data)
  add(record.data)

  const props = asRecord(record.props)
  const pageProps = asRecord(props?.pageProps)
  add(pageProps?.shareData)
  add(pageProps?.conversation)
  add(pageProps?.data)

  collectKnownLoaderCandidates(record.loaderData, add)
  collectKnownLoaderCandidates(asRecord(record.state)?.loaderData, add)

  return candidates
}

function collectKnownLoaderCandidates(
  loaderData: unknown,
  add: (value: unknown) => void,
) {
  const record = asRecord(loaderData)

  if (!record) {
    return
  }

  for (const value of Object.values(record)) {
    add(value)
    add(asRecord(value)?.data)
    add(asRecord(asRecord(value)?.serverResponse)?.data)
  }
}

export function findConversationCandidates(root: unknown): unknown[] {
  const seen = new Set<unknown>()
  const candidates: unknown[] = []

  function visit(value: unknown) {
    if (!value || typeof value !== 'object' || seen.has(value)) {
      return
    }

    seen.add(value)

    if (looksLikeMappingConversation(value) || looksLikeMessagesConversation(value)) {
      candidates.push(value)
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item)
      }
      return
    }

    for (const child of Object.values(value as Record<string, unknown>)) {
      visit(child)
    }
  }

  visit(root)

  return candidates
}

export function looksLikeMappingConversation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const mapping = (value as Record<string, unknown>).mapping

  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return false
  }

  return Object.values(mapping).some((node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return false
    }

    const candidate = node as Record<string, unknown>
    return 'message' in candidate || 'children' in candidate
  })
}

export function looksLikeMessagesConversation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const messages = (value as Record<string, unknown>).messages

  return (
    Array.isArray(messages) &&
    messages.some((message) => looksLikeMessageRecord(message))
  )
}

export function looksLikeMessageRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const record = value as Record<string, unknown>
  return (
    typeof record.role === 'string' ||
    typeof (record.author as Record<string, unknown> | undefined)?.role === 'string' ||
    'content' in record
  )
}
