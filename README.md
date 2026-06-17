# chatdump

Convert public share links into clean, readable Markdown transcripts.

Live app: [https://chatdump.khrees.com](https://chatdump.khrees.com)

Paste a public share link, get back a readable Markdown transcript with syntax highlighting and table support. Copy, download, or continue the conversation in your favorite AI chat platform.

## Supported Platforms

ChatGPT, Claude, Copilot, Gemini, and Grok.

## Features

- **Multiple view modes** — View as raw Markdown, rendered preview with syntax highlighting, or plain text
- **Copy & Download** — Copy to clipboard or download as `.md` file
- **Continue in chat** — Share dropdown lets you copy the conversation and open it in ChatGPT, Claude, Copilot, Gemini, or Grok
- **Recent URLs** — Quick access to previously converted share links


## Quick Start

```bash
bun install
bun run dev
```

## Usage

1. Paste a public share link into the input field
2. Choose your preferred view mode:
   - **Markdown** — Raw markdown text
   - **Preview** — Rendered preview with syntax highlighting
   - **Plain** — Stripped formatting for maximum readability
3. Click **Copy** to copy to clipboard, or **.md** to download
4. Use **Share** to copy with a prompt for continuing the conversation elsewhere

## Supported URLs

```
https://chatgpt.com/share/<id>
https://chat.openai.com/share/<id>
https://copilot.microsoft.com/shares/<id>
https://gemini.google.com/share/<id>
https://g.co/gemini/share/<id>
https://claude.ai/share/<id>
https://grok.com/share/<id>
```

Redirects between supported share domains are handled automatically.

## Why use chatdump?

**Export any AI chat to readable Markdown** — No more copy-pasting messages manually. Copy, save, or continue anywhere.

**Works with any AI platform** — One tool for ChatGPT, Claude, Copilot, Gemini, and Grok. No need to switch between different export methods.

**Continue conversations elsewhere** — Use the Share dropdown to copy a conversation and continue it in ChatGPT, Claude, or any other AI chat. Get a different perspective on the same context.

## CLI

```bash
bun run cli -- https://chatgpt.com/share/<id>
```

Options:

- `-o, --output <path>` — Write to file
- `--stdout` — Print even when writing to file
- `--title <text>` — Override extracted title
- `--no-metadata` — Omit metadata header

## Development

```bash
bun run dev      # Start dev server
bun run build   # Production build
bun run typecheck  # Type checking
```
