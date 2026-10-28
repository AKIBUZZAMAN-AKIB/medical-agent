#!/bin/bash
# Installs the Super-Power Doctor AI icons, page title and web-app manifest into
# the running LibreChat-API container (client/dist is served from the image).
# Run after branding/make_icons.py, then `docker commit` the container so it
# survives restarts. The app title in the UI itself comes from APP_TITLE in .env.
set -euo pipefail
cd "$(dirname "$0")"
C=${CONTAINER:-LibreChat-API}
D=/app/client/dist
for f in logo.svg favicon-16x16.png favicon-32x32.png apple-touch-icon-180x180.png icon-192x192.png maskable-icon.png; do
  docker cp "out/$f" "$C:$D/assets/$f"
done
docker exec -u 0 "$C" sh -c "
  set -e
  cd $D
  sed -i 's#<title>[^<]*</title>#<title>Super-Power Doctor AI</title>#' index.html
  sed -i 's#<meta name=\"theme-color\" content=\"[^\"]*\"#<meta name=\"theme-color\" content=\"\#1565C0\"#' index.html
  grep -q 'name=\"description\"' index.html || sed -i 's#</title>#</title><meta name=\"description\" content=\"Health assistant for Bangladesh with sourced answers\" />#' index.html
  sed -i -e 's#\"name\":\"[^\"]*\"#\"name\":\"Super-Power Doctor AI\"#' -e 's#\"short_name\":\"[^\"]*\"#\"short_name\":\"Doctor AI\"#' \
         -e 's#\"description\":\"[^\"]*\"#\"description\":\"Health assistant for Bangladesh\"#' \
         -e 's#\"theme_color\":\"[^\"]*\"#\"theme_color\":\"\#1565C0\"#' -e 's#\"background_color\":\"[^\"]*\"#\"background_color\":\"\#ffffff\"#' manifest.webmanifest
  for f in index.html manifest.webmanifest assets/logo.svg; do
    [ -f \$f.gz ] && gzip -9 -k -f \$f || true
    [ -f \$f.br ] && rm -f \$f.br || true
  done
"
echo "branding applied to $C"
