#!/bin/sh
# Margin — install the review skill into Claude Code.
# Usage:  curl -fsSL __BASE_URL__/install.sh | sh
set -e

DIR="$HOME/.claude/skills/margin"
mkdir -p "$DIR"
curl -fsSL "__BASE_URL__/skill.md" -o "$DIR/SKILL.md"

echo ""
echo "  ✓ Margin skill installed → $DIR/SKILL.md"
echo ""
echo "  Next: open a new Claude Code session and ask it to make something"
echo "  you'd like to review, e.g.:"
echo ""
echo "      \"Make me a one-page summary of X and let me review it in Margin.\""
echo ""
