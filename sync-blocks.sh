#!/bin/bash
# Sync blocks.json between git repo and local Letta server data directory
# Mac: actual blocks at data/data/blocks.json (server uses data/ subdir within data/)
# Windows: actual blocks at data/blocks.json
# Git tracks: data/blocks.json (canonical)

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
GIT_BLOCKS="$REPO_DIR/data/blocks.json"

# Detect OS and set runtime blocks path
if [[ "$(uname)" == "Darwin" ]]; then
    RUNTIME_BLOCKS="$REPO_DIR/data/data/blocks.json"
else
    RUNTIME_BLOCKS="$REPO_DIR/data/blocks.json"
fi

case "${1:-sync}" in
    push)
        # Copy runtime blocks to git-tracked location and push
        if [[ "$RUNTIME_BLOCKS" != "$GIT_BLOCKS" ]]; then
            cp "$RUNTIME_BLOCKS" "$GIT_BLOCKS"
        fi
        cd "$REPO_DIR"
        git add data/blocks.json
        git diff --cached --quiet data/blocks.json && echo "No changes to push" && exit 0
        git commit -m "Sync subconscious memory blocks $(date +%Y-%m-%d)"
        git push
        echo "Pushed blocks to GitHub"
        ;;
    pull)
        # Pull from git and copy to runtime location
        cd "$REPO_DIR"
        git pull --rebase
        if [[ "$RUNTIME_BLOCKS" != "$GIT_BLOCKS" ]] && [[ -f "$GIT_BLOCKS" ]]; then
            cp "$GIT_BLOCKS" "$RUNTIME_BLOCKS"
            echo "Copied git blocks to runtime location"
        fi
        echo "Pulled blocks from GitHub"
        ;;
    sync)
        # Pull first, then push local changes
        "$0" pull
        "$0" push
        ;;
    *)
        echo "Usage: $0 [push|pull|sync]"
        exit 1
        ;;
esac
