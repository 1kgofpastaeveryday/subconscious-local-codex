# Windows Plugin Patches

These patches fix stability issues with the upstream `claude-subconscious` plugin on Windows.

## What they fix

- **session_start.patch**: Skip HTTP calls on Windows + local server (tsx cold start + PseudoConsole cause hangs)
- **agent_config.patch**: Skip model availability HTTP check when model is already configured
- **pretool_sync.patch**: Skip PreToolUse hook on Windows (tsx cold start exceeds 5s timeout)
- **plan_checkpoint.patch**: Same tsx timeout fix for plan checkpoint hook

## How to apply

After installing the claude-subconscious plugin, find its cache directory:

```
# Windows
~/.claude/plugins/cache/claude-subconscious/claude-subconscious/<version>/scripts/

# The exact path varies by version
```

Then apply each patch:

```bash
cd ~/.claude/plugins/cache/claude-subconscious/claude-subconscious/<version>/
patch -p0 < /path/to/patches/session_start.patch
patch -p0 < /path/to/patches/agent_config.patch
patch -p0 < /path/to/patches/pretool_sync.patch
patch -p0 < /path/to/patches/plan_checkpoint.patch
```

Note: These patches need to be re-applied after plugin updates.
