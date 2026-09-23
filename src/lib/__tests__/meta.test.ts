import { describe, expect, test } from 'bun:test'
import { load } from 'cheerio'
import {
  extractMetaConversationPayloads,
  normalizeMetaConversation,
} from '../meta'
import { extractMetaDomConversation } from '../extract/dom'

const SOURCE_URL = 'https://meta.ai/share/c/gUOA54aXjX'

function userRow(text: string): string {
  return `<div class="group/message-row"><div class="group/user-message"><div class="bg-accent-surface"><p>${text}</p></div></div></div>`
}

// Thinking UI uses a localized label (e.g. Arabic "عرض التفكير").
// The block is identified structurally via data-testid, never by text.
function thinkingBlock(label: string): string {
  return `<div class="markdown-content"><div data-testid="thinking-status"><div>${label}</div></div><div data-testid="subagent-cot-list"></div></div>`
}

function answerBlock(text: string): string {
  return `<div class="markdown-content"><div><p>${text}</p></div></div>`
}

function assistantRow(...markdownBlocks: string[]): string {
  return `<div class="group/message-row"><div class="group/assistant-message" aria-label="Meta AI response">${markdownBlocks.join('')}</div></div>`
}

describe('extractMetaDomConversation', () => {
  test('returns null for non-Meta share URLs', () => {
    const $ = load(userRow('hi'))
    expect(
      extractMetaDomConversation($, 'https://chatgpt.com/share/abc123'),
    ).toBeNull()
  })

  test('returns null when no message rows exist', () => {
    const $ = load('<html><body><p>nothing here</p></body></html>')
    expect(extractMetaDomConversation($, SOURCE_URL)).toBeNull()
  })

  test('skips localized thinking UI instead of leaking it as a reply', () => {
    const $ = load(
      userRow('tell me one crazy chain that starts from lagos') +
        assistantRow(thinkingBlock('عرض التفكير'), answerBlock('')),
    )
    const conversation = extractMetaDomConversation($, SOURCE_URL)

    expect(conversation).not.toBeNull()
    // Only the user message survives; the Arabic thinking label must
    // not appear anywhere in the transcript.
    expect(conversation?.messages).toHaveLength(1)
    expect(conversation?.messages[0]?.role).toBe('user')
    expect(JSON.stringify(conversation)).not.toContain('عرض التفكير')
    expect(JSON.stringify(conversation)).not.toContain('Show thinking')
  })

  test('keeps real answers while dropping English thinking UI', () => {    const $ = load(
      userRow('it seems there are just three record labels?') +
        assistantRow(
          thinkingBlock('Show thinking'),
          answerBlock('There are three major labels.'),
        ),
    )
    const conversation = extractMetaDomConversation($, SOURCE_URL)

    expect(conversation?.messages).toHaveLength(2)
    const assistant = conversation?.messages[1]
    expect(assistant?.role).toBe('assistant')
    expect(JSON.stringify(assistant?.blocks)).toContain(
      'There are three major labels.',
    )
    expect(JSON.stringify(assistant?.blocks)).not.toContain('Show thinking')
  })
})

describe('normalizeMetaConversation (flight snapshot payload)', () => {
  const ANSWER_ONE = 'Yes, that is exactly right.{{IE_0}}726eb0b5{{/IE_0}}'
  const ANSWER_TWO = 'One Dance **is** the biggest song.'

  function flightPayload(): string {
    const edges = [
      {
        cursor: 'MA==',
        node: {
          __typename: 'UserMessage',
          content: 'are there just three labels?',
          conversationId: 'snapshot:gUOA54aXjX',
          createdAt: '2026-09-20T10:57:00.000Z',
          id: '1432848442278501',
        },
      },
      {
        cursor: 'MQ==',
        node: {
          __typename: 'AssistantMessage',
          content: '$89',
          conversationId: 'snapshot:gUOA54aXjX',
          createdAt: '2026-09-20T10:57:13.000Z',
          error: null,
          id: '1406745121566856',
        },
      },
      {
        cursor: 'Mg==',
        node: {
          __typename: 'UserMessage',
          content: "is One Dance Drake's biggest?",
          createdAt: '2026-09-20T10:58:44.000Z',
          id: '4431313233799052',
        },
      },
      {
        cursor: 'Mw==',
        node: {
          __typename: 'AssistantMessage',
          content: ANSWER_TWO,
          createdAt: '2026-09-20T10:58:50.000Z',
          error: null,
          id: '1406745121566857',
        },
      },
      {
        cursor: 'NA==',
        node: {
          __typename: 'AssistantMessage',
          content: '$missing',
          createdAt: '2026-09-20T11:00:00.000Z',
          error: null,
          id: '1406745121566858',
        },
      },
      {
        cursor: 'Ng==',
        node: {
          __typename: 'AssistantMessage',
          content: 'should be skipped',
          createdAt: '2026-09-20T11:01:00.000Z',
          error: { message: 'upstream failed' },
          id: '1406745121566859',
        },
      },
    ]
    const answerHex = ANSWER_ONE.length.toString(16)
    return `prefix 89:T${answerHex},${ANSWER_ONE} middle "messages":{"edges":${JSON.stringify(edges)}} suffix`
  }

  test('extracts ordered messages, resolves refs, strips citations', () => {
    const conversation = normalizeMetaConversation(
      [flightPayload()],
      SOURCE_URL,
      'The music industry oligopoly',
    )

    expect(conversation).not.toBeNull()
    expect(conversation?.title).toBe('The music industry oligopoly')
    expect(conversation?.conversationId).toBe('snapshot:gUOA54aXjX')
    // Unresolvable $missing ref and errored turn are skipped.
    expect(conversation?.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])

    const [userOne, assistantOne, userTwo, assistantTwo] =
      conversation?.messages ?? []
    expect(JSON.stringify(userOne?.blocks)).toContain(
      'are there just three labels?',
    )
    expect(userOne?.id).toBe('meta-1432848442278501')
    expect(userOne?.createdAt).toBe('2026-09-20T10:57:00.000Z')
    // Citation marker stripped, prose kept.
    expect(JSON.stringify(assistantOne?.blocks)).toContain(
      'Yes, that is exactly right.',
    )
    expect(JSON.stringify(assistantOne?.blocks)).not.toContain('{{IE_0}}')
    expect(JSON.stringify(assistantOne?.blocks)).not.toContain('726eb0b5')
    expect(JSON.stringify(assistantTwo?.blocks)).toContain(
      '**is** the biggest song',
    )
  })

  test('resolves prefixed row ids referenced in short form', () => {
    // Meta emits rows like `ll8d:T…` referenced as `$8d`.
    const answer = 'A chain that starts in Lagos traffic.'
    const payload =
      `xxll8d:T${answer.length.toString(16)},${answer} ` +
      `"messages":{"edges":${JSON.stringify([
        {
          cursor: 'Mg==',
          node: {
            __typename: 'AssistantMessage',
            content: '$8d',
            createdAt: '2026-09-20T10:58:50.000Z',
            error: null,
            id: '1',
          },
        },
      ])}}`
    const conversation = normalizeMetaConversation(
      [payload],
      SOURCE_URL,
      'T',
    )
    expect(conversation?.messages).toHaveLength(1)
    expect(JSON.stringify(conversation?.messages[0]?.blocks)).toContain(
      'A chain that starts in Lagos traffic.',
    )
  })

  test('returns null when payloads hold no usable messages', () => {
    expect(normalizeMetaConversation([], SOURCE_URL, 'T')).toBeNull()
    expect(
      normalizeMetaConversation(['no flight data here'], SOURCE_URL, 'T'),
    ).toBeNull()
    expect(
      normalizeMetaConversation(
        ['"messages":{"edges":[]}'],
        SOURCE_URL,
        'T',
      ),
    ).toBeNull()
  })

  test('extractMetaConversationPayloads pulls flight push strings', () => {
    const html = `<script>self.__next_f.push([1, "hello"]);self.__next_f.push([2, "nope]</script>`
    // Second push is malformed JSON and must be skipped.
    expect(extractMetaConversationPayloads(html)).toEqual(['hello'])
  })
})
