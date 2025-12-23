#!/bin/bash
set -euo pipefail

echo "This repository uses semantic-release as the single release authority."
echo
echo "Releases are produced by GitHub Actions on pushes to main (after CI passes)."
echo "Do not run local scripts to bump versions, tag, or publish."
echo
echo "For local validation you can run:"
echo "  npx semantic-release --dry-run --no-ci"
echo
exit 1