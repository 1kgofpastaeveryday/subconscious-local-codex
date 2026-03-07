# subconscious-local-codex

A modified version of [claude-subconscious](https://github.com/letta-ai/claude-subconscious) that replaces the Letta cloud backend with a local server. Your session memory stays on your machine.

## What's in this repo

- `plugin/` - The claude-subconscious plugin (upstream v1.5.1 + Windows stability patches)
- `server.ts` - Local Letta-compatible API server
- `openai-oauth.ts` - Experimental Codex token helper (optional)
- `oauth-login.ts` - Auth helper (optional)

## How it works

```
Claude Code  -->  claude-subconscious plugin (plugin/)
                        |
                        v
                  Local server (server.ts)  -->  OpenRouter / other LLM
                        |
                        v
                  Local JSON files (data/)
```

The plugin observes your Claude Code sessions and sends transcripts to the local server.
The server uses an LLM to process them, manage memory blocks, and provide guidance back.

## Setup

### 1. Clone and install

```bash
git clone https://github.com/1kgofpastaeveryday/subconscious-local-codex.git
cd subconscious-local-codex
npm install
```

### 2. Configure LLM backend

Set your OpenRouter API key:

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."
```

You can use any model available on [OpenRouter](https://openrouter.ai). The default is `qwen/qwen3-235b-a22b-2507`.

> **Experimental: Codex CLI integration**
>
> If you have [Codex CLI](https://github.com/openai/codex) installed and authenticated,
> the server can optionally use its OAuth tokens (`~/.codex/auth.json`) as an alternative backend.
> This is **experimental, unsupported, and entirely at your own risk**.
> The server auto-detects Codex auth if present; set `LETTA_USE_CODEX=0` to disable.

### 3. Install the plugin in Claude Code

```bash
claude plugin add /path/to/subconscious-local-codex/plugin
```

### 4. Set the local server URL

Add to your shell profile (`.bashrc`, `.zshrc`, etc.):

```bash
export LETTA_BASE_URL=http://localhost:8990
```

### 5. Start the server

```bash
npx tsx server.ts
```

For background startup on Windows, copy `start-hidden.vbs.example` to `start-hidden.vbs` and edit the paths.

### 6. Launch Claude Code

```bash
claude
```

The plugin will auto-import the Subconscious agent on first run.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LETTA_BASE_URL` | - | Set to `http://localhost:8990` (required for plugin) |
| `LETTA_LOCAL_PORT` | `8990` | Server port |
| `LETTA_LOCAL_DATA_DIR` | `./data` | Directory for agent data |
| `LETTA_LOCAL_MODEL` | `qwen/qwen3-235b-a22b-2507` | OpenRouter model |
| `LETTA_USE_CODEX` | auto-detected | Set to `0` to disable Codex auto-detection |
| `OPENROUTER_API_KEY` | - | OpenRouter API key |

## Windows Patches (included)

The plugin code in `plugin/` already includes these fixes over upstream v1.5.1:

- `scripts/session_start.ts` - Skip HTTP calls on Windows + local server
- `scripts/agent_config.ts` - Skip model availability check when already configured
- `scripts/pretool_sync.ts` - Skip PreToolUse hook on Windows (tsx cold start timeout)
- `scripts/plan_checkpoint.ts` - Same tsx timeout fix
- `hooks/hooks.json` - Increased SessionStart timeout (5s -> 30s)

## Data

Agent memory is stored in `./data/` (gitignored):
- `agent.json` - agent config and system prompt
- `blocks.json` - memory blocks
- `conversations/` - conversation history

To back up memory with Git, initialize a repo inside `./data/`.

## License

- Plugin code (`plugin/`): MIT License, Copyright (c) 2026 Letta, Inc.
- Local server code: MIT License
