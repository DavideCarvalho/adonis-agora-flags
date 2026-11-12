#!/usr/bin/env bash
# Runs examples/app — a real AdonisJS app (SQLite, @adonisjs/auth, Bouncer, Edge) — against the
# packages as npm would ship them: build, `pnpm pack`, install the tarballs, then the app's Japa
# suite over real HTTP, then `node ace configure @adonis-agora/flags` on a pristine copy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/examples/app"

echo "== build"
(cd "$ROOT" && pnpm exec turbo run build --force >/dev/null)

echo "== pack"
rm -rf "$APP/.packs" && mkdir -p "$APP/.packs"
for pkg in core:flags-core adonis:flags; do
  dir="${pkg%%:*}"; name="${pkg##*:}"
  (cd "$ROOT/packages/$dir" && pnpm pack --pack-destination "$APP/.packs" >/dev/null)
  mv "$APP/.packs"/adonis-agora-"$name"-[0-9]*.tgz "$APP/.packs/$name.tgz"
done

echo "== install"
cd "$APP"
[ -f .env ] || cp .env.example .env
rm -rf node_modules/@adonis-agora pnpm-lock.yaml
pnpm install --no-frozen-lockfile --config.confirmModulesPurge=false >/dev/null

echo "== typecheck"
pnpm exec tsc --noEmit

echo "== tests"
rm -rf tmp && mkdir -p tmp
node ace test "$@"

echo "== configure on a pristine copy"
PRISTINE="$APP/tmp/pristine"
rm -rf "$PRISTINE" && mkdir -p "$PRISTINE"
trap 'rm -rf "$PRISTINE"' EXIT
tar -C "$APP" --exclude=./node_modules --exclude=./tmp --exclude=./.packs -cf - . | tar -C "$PRISTINE" -xf -
ln -s "$APP/node_modules" "$PRISTINE/node_modules"
cd "$PRISTINE"
rm -rf tmp config/flags.ts config/flags_dashboard.ts app/flags
sed -i "/@adonis-agora\/flags/d" adonisrc.ts start/kernel.ts
sed -i "/FLAGS_ENVIRONMENT/d" start/env.ts
sed -i "s#\.use(middleware\.flag({ flag: 'new_checkout' }))##" start/routes.ts
node ace configure @adonis-agora/flags >/dev/null
grep -q "@adonis-agora/flags/flags_provider" adonisrc.ts
grep -q "@adonis-agora/flags/flags_middleware" start/kernel.ts
test -f config/flags.ts && test -f config/flags_dashboard.ts
mkdir -p tmp
DB_FILE=tmp/configure.sqlite3 node ace list:routes --json | grep -q '"/flags"'
echo "configure: providers, middleware, configs and the console route are in place"
echo "== e2e OK"
