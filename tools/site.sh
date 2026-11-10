#!/bin/sh
# Arma en una carpeta (por defecto, site/) sólo lo que el juego carga en el navegador, para publicarlo
# (.github/workflows/deploy.yml). Para probarlo en local: tools/site.sh && python3 -m http.server -d site 8124
set -eu
cd "$(dirname "$0")/.."
out="${1:-site}"
rm -rf "$out"
mkdir -p "$out"
# los archivos de git (no las redes que estén sin commitear en models/)
git ls-files index.html src tracks cars models | while read -r f; do
  mkdir -p "$out/$(dirname "$f")"
  cp "$f" "$out/$f"
done
echo "Sitio armado en $out/ ($(du -sh "$out" | cut -f1))"
