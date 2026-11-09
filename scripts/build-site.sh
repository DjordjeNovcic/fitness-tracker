#!/usr/bin/env bash
# Sklapa sajt za GitHub Pages u _site/: isti fajlovi kao u repou, ali su
# app.js, styles.css i data/*.js sabijeni (esbuild --minify). Kod u repou
# ostaje čitljiv; na telefon ide ~40% manje podataka.
#
#   bash scripts/build-site.sh        # pa npr. python3 -m http.server -d _site
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="_site"
ESBUILD="npx --yes esbuild@0.24.0"

rm -rf "$OUT"
mkdir -p "$OUT/data"

# Statični fajlovi koji se objavljuju kakvi jesu.
cp index.html manifest.webmanifest sw.js firebase.json "$OUT"/
cp -R icons "$OUT"/

$ESBUILD app.js --minify --format=esm --target=es2020 --log-level=warning --outfile="$OUT/app.js"
$ESBUILD styles.css --minify --log-level=warning --outfile="$OUT/styles.css"
for file in data/*.js; do
  $ESBUILD "$file" --minify --log-level=warning --outfile="$OUT/$file"
done

# Pages ne sme da preskoči fajlove/foldere koji počinju sa „_“.
touch "$OUT/.nojekyll"

echo "Sajt je u $OUT/:"
du -sh "$OUT"/app.js "$OUT"/styles.css "$OUT"/data/*.js
