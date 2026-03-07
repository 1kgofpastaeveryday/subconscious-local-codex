# subconscious-local-codex

Local replacement for the [Letta](https://letta.com) cloud server used by the [claude-subconscious](https://github.com/letta-ai/claude-subconscious) plugin.

Instead of sending your session data to Letta's cloud, this runs a local Express server that implements the same API and stores memory as JSON files on disk.

## Features

- Letta-compatible API (drop-in replacement for the plugin)
- LLM backend: **Codex OAuth** (ChatGPT Pro, free) or **OpenRouter** (fallback)
- Memory blocks stored as local JSON files
- Optional Git sync for memory backup
- Tool calling loop (memory management, conversation search)

## Prerequisites

- Node.js >= 18
- [claude-subconscious](https://github.com/letta-ai/claude-subconscious) plugin installed in Claude Code
- One of:
  - **Codex CLI** authenticated (`~/.codex/auth.json` exists) - uses ChatGPT backend for free
  - **OpenRouter API key** set via `OPENROUTER_API_KEY` env var

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Authenticate with Codex (recommended)

Install [Codex CLI](https://github.com/openai/codex) and run `codex` once to complete OAuth login.
This creates `~/.codex/auth.json` which the server reads automatically.

Or set an OpenRouter key instead:
```bash
export OPENROUTER_API_KEY="sk-or-v1-..."
```

### 3. Start the server

```bash
npx tsx server.ts
```

Or run in background on Windows (copy `start-hidden.vbs.example` to `start-hidden.vbs` and edit paths/keys):
```
wscript start-hidden.vbs
```

The server runs on `http://localhost:8990` by default.

### 4. Configure claude-subconscious plugin

Set this environment variable before launching Claude Code:

```bash
export LETTA_BASE_URL=http://localhost:8990
```

The plugin will connect to your local server instead of Letta cloud.

### 5. Import the Subconscious agent

On first run, the plugin auto-imports the agent from `Subconscious.af`.
If you need to re-import manually:

```bash
curl -X POST http://localhost:8990/v1/agents/import \
  -F "file=@/path/to/Subconscious.af"
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LETTA_LOCAL_PORT` | `8990` | Server port |
| `LETTA_LOCAL_DATA_DIR` | `./data` | Directory for agent data |
| `LETTA_LOCAL_MODEL` | `qwen/qwen3-235b-a22b-2507` | OpenRouter model |
| `LETTA_CODEX_MODEL` | `gpt-5.4` | Codex model |
| `LETTA_USE_CODEX` | auto-detected | Set to `1` to force Codex |
| `OPENROUTER_API_KEY` | - | OpenRouter API key (fallback) |

## Data

Agent memory is stored in `./data/`:
- `agent.json` - agent config and system prompt
- `blocks.json` - memory blocks (core directives, guidance, etc.)
- `conversations/` - conversation history

These files are gitignored by default. To enable Git sync for backup, initialize a git repo inside `./data/`.

## Windows Plugin Patches

If you're on Windows, the upstream claude-subconscious plugin may need patches for stability.
See the `patches/` directory for details.

## Credits

Based on [claude-subconscious](https://github.com/letta-ai/claude-subconscious) by [Letta](https://letta.com).
