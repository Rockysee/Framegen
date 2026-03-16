#!/bin/bash
set -euo pipefail

# Use CLAUDE_PROJECT_DIR if set (remote), otherwise fall back to local path
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/users/hemantithackeray/desktop/Hemant's Stack/framegen/framegen}"

cd "$PROJECT_DIR"

# Install server dependencies
echo "Installing server dependencies..."
npm install

# Install client dependencies
echo "Installing client dependencies..."
npm install --prefix client
