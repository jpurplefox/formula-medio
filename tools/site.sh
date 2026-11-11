#!/bin/sh
# Builds in a folder (site/ by default) only what the game loads in the browser, to publish it
# (.github/workflows/deploy.yml). To try it locally: tools/site.sh && python3 -m http.server -d site 8124
set -eu
cd "$(dirname "$0")/.."
out="${1:-site}"
rm -rf "$out"
mkdir -p "$out"
# the files in git (not the uncommitted networks in models/)
git ls-files index.html src tracks cars models | while read -r f; do
  mkdir -p "$out/$(dirname "$f")"
  cp "$f" "$out/$f"
done
echo "Site built in $out/ ($(du -sh "$out" | cut -f1))"
