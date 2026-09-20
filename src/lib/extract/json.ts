import { hasStructuredPayloadHint, looksLikeJson } from './utils'

export function extractJsonParsePayloads(text: string): string[] {
  const results: string[] = []
  let searchIndex = 0

  while (searchIndex < text.length) {
    const parseIndex = text.indexOf('JSON.parse(', searchIndex)

    if (parseIndex === -1) {
      break
    }

    let index = parseIndex + 'JSON.parse('.length

    while (/\s/.test(text[index] ?? '')) {
      index += 1
    }

    const argument = readJsonParseArgument(text, index)

    if (argument && looksLikeJson(argument.value)) {
      results.push(argument.value)
      searchIndex = argument.end
      continue
    }

    searchIndex = index
  }

  return results
}

function readJsonParseArgument(
  text: string,
  index: number,
): { end: number; value: string } | null {
  if (text.startsWith('decodeURIComponent(', index)) {
    let cursor = index + 'decodeURIComponent('.length

    while (/\s/.test(text[cursor] ?? '')) {
      cursor += 1
    }

    const literal = readQuotedString(text, cursor)

    if (!literal) {
      return null
    }

    cursor = literal.end

    while (/\s/.test(text[cursor] ?? '')) {
      cursor += 1
    }

    if (text[cursor] !== ')') {
      return null
    }

    try {
      return {
        end: cursor + 1,
        value: decodeURIComponent(literal.value),
      }
    } catch {
      return null
    }
  }

  return readQuotedString(text, index)
}

function readQuotedString(
  text: string,
  start: number,
): { end: number; value: string } | null {
  const quote = text[start]

  if (quote !== '"' && quote !== '\'' && quote !== '`') {
    return null
  }

  let value = ''

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]

    if (char === '\\') {
      const escaped = decodeEscapedCharacter(text, index + 1)

      if (!escaped) {
        return null
      }

      value += escaped.value
      index = escaped.end - 1
      continue
    }

    if (char === quote) {
      return {
        end: index + 1,
        value,
      }
    }

    if (quote !== '`' && (char === '\n' || char === '\r')) {
      return null
    }

    value += char
  }

  return null
}

function decodeEscapedCharacter(
  text: string,
  index: number,
): { end: number; value: string } | null {
  const char = text[index]

  if (!char) {
    return null
  }

  switch (char) {
    case '\n':
      return { end: index + 1, value: '' }
    case '\r':
      return {
        end: text[index + 1] === '\n' ? index + 2 : index + 1,
        value: '',
      }
    case 'b':
      return { end: index + 1, value: '\b' }
    case 'f':
      return { end: index + 1, value: '\f' }
    case 'n':
      return { end: index + 1, value: '\n' }
    case 'r':
      return { end: index + 1, value: '\r' }
    case 't':
      return { end: index + 1, value: '\t' }
    case 'v':
      return { end: index + 1, value: '\v' }
    case 'x': {
      const hex = text.slice(index + 1, index + 3)

      if (!/^[\da-fA-F]{2}$/.test(hex)) {
        return null
      }

      return {
        end: index + 3,
        value: String.fromCodePoint(Number.parseInt(hex, 16)),
      }
    }
    case 'u': {
      if (text[index + 1] === '{') {
        const closingIndex = text.indexOf('}', index + 2)

        if (closingIndex === -1) {
          return null
        }

        const codePoint = text.slice(index + 2, closingIndex)

        if (!/^[\da-fA-F]+$/.test(codePoint)) {
          return null
        }

        return {
          end: closingIndex + 1,
          value: String.fromCodePoint(Number.parseInt(codePoint, 16)),
        }
      }

      const hex = text.slice(index + 1, index + 5)

      if (!/^[\da-fA-F]{4}$/.test(hex)) {
        return null
      }

      return {
        end: index + 5,
        value: String.fromCodePoint(Number.parseInt(hex, 16)),
      }
    }
    default:
      return { end: index + 1, value: char }
  }
}

export function extractBalancedJsonObjects(text: string): string[] {
  const results: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  let quote = '"'

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]

    if (start === -1) {
      if (char === '{') {
        start = index
        depth = 1
      }

      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        inString = false
      }

      continue
    }

    if (char === '"' || char === '\'') {
      inString = true
      quote = char
      continue
    }

    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1

      if (depth === 0) {
        const candidate = text.slice(start, index + 1)

        if (hasStructuredPayloadHint(candidate)) {
          results.push(candidate)
        }

        start = -1
      }
    }
  }

  return results
}
