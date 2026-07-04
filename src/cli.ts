#!/usr/bin/env bun
import { writeFile } from 'node:fs/promises'
import process from 'node:process'
import { convertShareUrlToMarkdown } from './lib/extract'
import { getErrorMessage } from './lib/errors'

type ParsedArgs = {
  includeMetadata: boolean
  outputPath?: string
  showHelp: boolean
  stdout: boolean
  title?: string
  url?: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    includeMetadata: true,
    showHelp: false,
    stdout: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    switch (token) {
      case '-h':
      case '--help':
        parsed.showHelp = true
        break
      case '-o':
      case '--output':
        parsed.outputPath = argv[index + 1]
        index += 1
        break
      case '--stdout':
        parsed.stdout = true
        break
      case '--title':
        parsed.title = argv[index + 1]
        index += 1
        break
      case '--no-metadata':
        parsed.includeMetadata = false
        break
      default:
        if (!token.startsWith('-') && !parsed.url) {
          parsed.url = token
          break
        }

        throw new Error(`unknown argument: ${token}`)
    }
  }

  return parsed
}

function renderHelp(): string {
  return [
    'Usage: chatdump <share-url> [options]',
    '',
    'Options:',
    '  -o, --output <path>   Write Markdown to a file',
    '  --stdout              Print Markdown to stdout even when writing a file',
    '  --title <text>        Override the extracted title',
    '  --no-metadata         Omit the metadata header',
    '  -h, --help            Show this help text',
  ].join('\n')
}

async function main() {
  let args: ParsedArgs

  try {
    args = parseArgs(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write(`${getErrorMessage(cause)}\n`)
    process.stderr.write(`${renderHelp()}\n`)
    process.exit(1)
    return
  }

  if (args.showHelp || !args.url) {
    process.stdout.write(`${renderHelp()}\n`)
    process.exit(args.showHelp ? 0 : 1)
    return
  }

  try {
    const result = await convertShareUrlToMarkdown(args.url, {
      includeMetadata: args.includeMetadata,
      title: args.title,
    })

    if (args.outputPath) {
      await writeFile(args.outputPath, result.markdown, 'utf8')
    }

    if (!args.outputPath || args.stdout) {
      process.stdout.write(result.markdown)
    }

    if (result.warnings.length > 0) {
      process.stderr.write(`${result.warnings.join('\n')}\n`)
    }
  } catch (cause) {
    process.stderr.write(`${getErrorMessage(cause)}\n`)
    process.exit(1)
  }
}

await main()
