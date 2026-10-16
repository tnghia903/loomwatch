#!/usr/bin/env bash
# Tests `loomwatch update`, `rollback`, `version` and `import` on a ready-built copy (ADR 0052),
# and Update and restart from the app, end to end through the real launcher and installer, with
# stand-ins for everything they reach outside:
#
#   loomwatchd  writes down what it was started with, instead of serving. Its run history is a
#             text file at the path the launcher gives it, whose layout (newest table change) a
#             test sets; `backup`, `database-layout` and `import-postgres` act on that file. When
#             a test has left $FAKE/app-asks, it does what the app asked once: names that release
#             for the launcher and exits with 75, as Update and restart does, or exits with exit=N's
#             status
#   docker    the PostgreSQL an earlier version kept the run history in: one container, stopped
#             or running, that a test sets up
#   open      macOS's, so a Docker Desktop that is not running is "started" only when a test says
#   curl      GitHub: the newest release's tag, release archives built here, and the health check
#   lsof      nothing is listening
#
# Nothing touches Docker, the network, or any LoomWatch on this computer.
#
#   scripts/test-update.sh          KEEP=1 keeps its scratch folder, to look at what it left
#
# Each check is a shell condition in single quotes, evaluated when it runs.
# shellcheck disable=SC2016
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/loomwatch-update-test.XXXXXX")
trap '[ -n "${KEEP:-}" ] || rm -rf "$work"' EXIT

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  failures=$((failures + 1))
}
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

export FAKE="$work/fake" HOME="$work/home"
mkdir -p "$FAKE/bin" "$FAKE/docker" "$FAKE/releases" "$HOME"
export FAKE_LOG="$FAKE/log"
: >"$FAKE_LOG"

cat >"$FAKE/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$FAKE_LOG"
state=$FAKE/docker
case $1 in
  info) [ -f "$state/up" ] ;;
  ps)
    # The earlier database's container, found by its Compose labels.
    if [ -f "$state/container" ] && printf '%s\n' "$*" | grep -q "com.docker.compose.project=$(cat "$state/container")"; then
      echo c0ffee
    fi
    ;;
  inspect)
    case $* in
      *State.Running*) if [ -f "$state/running" ]; then echo true; else echo false; fi ;;
      *working_dir*) cat "$state/owner" 2>/dev/null || true ;;
    esac
    ;;
  volume) [ -f "$state/volume" ] ;;
  run) touch "$state/running" && echo temporary ;;
  start) touch "$state/running" ;;
  stop) rm -f "$state/running" ;;
  exec) [ -f "$state/running" ] ;;
  port) echo 127.0.0.1:55432 ;;
esac
EOF

cat >"$FAKE/bin/open" <<'EOF'
#!/usr/bin/env bash
printf 'open %s\n' "$*" >>"$FAKE_LOG"
[ -f "$FAKE/docker/wakes" ] && touch "$FAKE/docker/up"
EOF

cat >"$FAKE/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$FAKE_LOG"
out='' url=''
while [ $# -gt 0 ]; do
  case $1 in
    -o) out=$2; shift ;;
    -w | --proto | --proto-redir | --retry | --max-time) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
case $url in
  */api/health) if [ -f "$FAKE/daemon-up" ]; then printf ok; else exit 7; fi ;;
  */releases/latest)
    [ -n "${FAKE_LATEST:-}" ] || exit 6
    printf 'https://github.com/tnghia903/loomwatch/releases/tag/%s' "$FAKE_LATEST"
    ;;
  */releases/latest/download/*) cp "$FAKE/releases/$FAKE_LATEST/${url##*/}" "$out" 2>/dev/null || exit 22 ;;
  */releases/download/*)
    version=${url#*/releases/download/}
    cp "$FAKE/releases/${version%%/*}/${url##*/}" "$out" 2>/dev/null || exit 22
    ;;
  *) exit 22 ;;
esac
EOF

printf '#!/bin/sh\nexit 1\n' >"$FAKE/bin/lsof"
chmod +x "$FAKE/bin/"*
export PATH="$FAKE/bin:$PATH"

# A release archive the way package-release.sh packs one, around a stand-in program.
release() {
  local version=$1 stage="$work/stage-$1"
  mkdir -p "$stage/loomwatch/bin" "$stage/loomwatch/examples" "$FAKE/releases/v$version"
  cat >"$stage/loomwatch/bin/loomwatchd" <<'EOF'
#!/usr/bin/env bash
here=$(cd "$(dirname "$0")/.." && pwd)
db=${LOOMWATCH_DATABASE:-$HOME/state/loomwatch.db}
case $1 in
  database-path) printf '%s\n' "$db"; exit 0 ;;
  database-layout) if [ -f "$db" ]; then sed -n 's/^layout=//p' "$db"; fi; exit 0 ;;
  backup)
    printf 'backup %s\n' "$2" >>"$FAKE_LOG"
    [ ! -f "$FAKE/fail-backup" ] && [ -f "$db" ] && [ ! -e "$2" ] && cp "$db" "$2"
    exit
    ;;
  import-postgres)
    printf 'import from=%s\n' "$LOOMWATCH_IMPORT_FROM" >>"$FAKE_LOG"
    [ ! -f "$FAKE/fail-import" ] || exit 1
    mkdir -p "$(dirname "$db")"
    printf 'layout=20261017000000\ncontent=imported\n' >"$db"
    echo "Imported the run history."
    exit 0
    ;;
esac
pid=other
if [ "$(cat "$here/run/loomwatchd.pid" 2>/dev/null)" = "$$" ]; then pid=same; fi
printf 'started %s install=%s command=%s supervised=%s request=%s pid=%s failed=%s\n' \
  "$(cut -d ' ' -f 1 "$here/VERSION")" "$LOOMWATCH_INSTALL" "$LOOMWATCH_UPDATE_COMMAND" \
  "${LOOMWATCH_SUPERVISED:-}" "${LOOMWATCH_UPDATE_REQUEST:-}" "$pid" "${LOOMWATCH_UPDATE_FAILED:-}" >>"$FAKE_LOG"
# As the program does: the first start sets the run history up.
if [ ! -f "$db" ]; then
  mkdir -p "$(dirname "$db")"
  printf 'layout=20261017000000\ncontent=new\n' >"$db"
fi
if [ -f "$FAKE/app-asks" ]; then
  asked=$(cat "$FAKE/app-asks")
  rm -f "$FAKE/app-asks"
  case $asked in
    exit=*) exit "${asked#exit=}" ;;
    '') exit 75 ;;
    *)
      printf '%s\n' "$asked" >"$LOOMWATCH_UPDATE_REQUEST"
      exit 75
      ;;
  esac
fi
touch "$FAKE/daemon-up"
EOF
  cp "$root/loomwatch" "$root/scripts/install.sh" "$stage/loomwatch/"
  cp "$root/examples/operator-stop.yaml" "$root/examples/operator-stop-harness.py" "$stage/loomwatch/examples/"
  chmod 755 "$stage/loomwatch/bin/loomwatchd" "$stage/loomwatch/loomwatch" "$stage/loomwatch/install.sh"
  printf '%s c0ffee%s\n' "$version" "$(printf '%s' "$version" | tr -d .)" >"$stage/loomwatch/VERSION"
  local folder="$FAKE/releases/v$version" archive
  archive="loomwatch-$(platform).tar.gz"
  COPYFILE_DISABLE=1 tar -C "$stage" -czf "$folder/$archive" loomwatch
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$folder" && sha256sum "$archive" >"$archive.sha256")
  else
    (cd "$folder" && shasum -a 256 "$archive" >"$archive.sha256")
  fi
}
platform() {
  case "$(uname -s)" in
    Darwin) echo macos-universal ;;
    *) case "$(uname -m)" in aarch64 | arm64) echo linux-arm64 ;; *) echo linux-x86_64 ;; esac ;;
  esac
}

for version in 0.1.4 0.1.5 0.1.6; do release "$version"; done

app="$work/app"
export LOOMWATCH_TEAMS_ROOT="$work/teams" LOOMWATCH_BACKUP_DIR="$work/backups" LOOMWATCH_PORT=3399
unset LOOMWATCH_VERSION LOOMWATCH_DOWNLOAD_BASE LOOMWATCH_DATABASE_URL LOOMWATCH_DATABASE \
  COMPOSE_PROJECT_NAME LOOMWATCH_UPDATE_CHECK LOOMWATCH_IMPORT_FROM

# Runs the installed launcher like the operator would, without a terminal to answer questions.
# Sets status, which the checks read through eval.
export status=0
launcher() {
  rm -f "$FAKE/daemon-up"
  : >"$FAKE_LOG"
  set +e
  "$app/loomwatch" "$@" --no-open </dev/null >"$FAKE/out" 2>&1
  status=$?
  set -e
  # Let start's browser-opening helper see the stand-in running, so it ends.
  sleep 1
  rm -f "$FAKE/daemon-up"
}
said() { grep -qF -- "$1" "$FAKE/out"; }
logged() { grep -qF -- "$1" "$FAKE_LOG"; }
version_installed() { cut -d ' ' -f 1 "$app/VERSION"; }
# A copy installed anywhere but ~/LoomWatch/app keeps its run history in its own folder.
export db="$app/.loomwatch/loomwatch.db"
set_database() { printf 'layout=%s\ncontent=%s\n' "$1" "$2" >"$db"; }

echo "Installing 0.1.5"
FAKE_LATEST=v0.1.5 LOOMWATCH_NO_START=1 LOOMWATCH_APP_DIR="$app" bash "$root/scripts/install.sh" </dev/null >"$FAKE/out" 2>&1
check "install puts 0.1.5 in place" '[ "$(version_installed)" = 0.1.5 ]'
check "a first install keeps no earlier version" '[ ! -e "$app/.previous" ]'
launcher start
check "start tells the program how it is updated" 'logged "started 0.1.5 install=release command=$app/loomwatch update"'
check "a copy outside the usual folder keeps its run history in its own folder" '[ -f "$db" ] && said "Your run history is in"'
check "a new copy needs no Docker" '! logged "docker "'
set_database 20261017000000 runs-before-update

echo "Updating when 0.1.5 is the newest"
export FAKE_LATEST=v0.1.5
launcher update
check "update says it is the newest" 'said "LoomWatch 0.1.5 is the newest version."'
check "nothing is downloaded" '! logged "loomwatch-$(platform).tar.gz"'
check "nothing is backed up" '[ ! -d "$work/backups" ]'
check "it starts again" '[ $status = 0 ] && logged "started 0.1.5"'

echo "Version"
FAKE_LATEST=v0.1.6 launcher version
check "version names this one and the newer one" 'said "LoomWatch 0.1.5 (c0ffee015)" && said "LoomWatch 0.1.6 is out. Update with:"'
LOOMWATCH_UPDATE_CHECK=off FAKE_LATEST=v0.1.6 launcher version
check "version asks nobody when checks are off" 'said "Checking for new versions is off" && ! logged "releases/latest"'

echo "A failed backup changes nothing"
export FAKE_LATEST=v0.1.6
touch "$FAKE/fail-backup"
launcher update
rm "$FAKE/fail-backup"
check "update fails" '[ $status != 0 ] && said "could not be saved, so LoomWatch was not changed"'
check "0.1.5 is still installed" '[ "$(version_installed)" = 0.1.5 ] && [ ! -e "$app/.previous" ]'
check "no half-written copy is left" '[ -z "$(find "$work/backups" -name "*.partial" 2>/dev/null)" ]'

echo "A download that fails its checksum changes nothing"
cp "$FAKE/releases/v0.1.6/loomwatch-$(platform).tar.gz.sha256" "$work/good.sha256"
echo "0000  loomwatch-$(platform).tar.gz" >"$FAKE/releases/v0.1.6/loomwatch-$(platform).tar.gz.sha256"
launcher update
cp "$work/good.sha256" "$FAKE/releases/v0.1.6/loomwatch-$(platform).tar.gz.sha256"
check "update fails on the checksum" '[ $status != 0 ] && said "does not match the release" && said "left as it was"'
check "0.1.5 is still installed" '[ "$(version_installed)" = 0.1.5 ] && [ ! -e "$app/.previous" ]'

echo "Updating to 0.1.6"
printf 'LOOMWATCH_PORT=3399\n' >"$app/.env"
launcher update
export backup
# The newest: a download that failed its checksum above had already saved one.
backup=$(find "$work/backups" -name 'loomwatch-*-0.1.5.db' | sort | tail -n 1)
check "update succeeds and starts 0.1.6" '[ $status = 0 ] && logged "started 0.1.6" && [ "$(version_installed)" = 0.1.6 ]'
check "the run history was copied first, by the program" '[ -n "$backup" ] && grep -q runs-before-update "$backup" && logged "backup $backup.partial"'
check "the copy is private" '[ "$(ls -l "$backup" | cut -c1-10)" = "-rw-------" ]'
check "the copies are kept per copy of LoomWatch" '[ "$(dirname "$backup")" = "$work/backups/$(cd "$work/backups" && ls)" ]'
check "0.1.5 is kept for rollback" '[ "$(cut -d " " -f 1 "$app/.previous/VERSION")" = 0.1.5 ] && [ -x "$app/.previous/bin/loomwatchd" ]'
check "rollback knows the copy and the layout" 'grep -qx "backup=$backup" "$app/.previous/ROLLBACK" && grep -qx "layout=20261017000000" "$app/.previous/ROLLBACK"'
check "settings and the run history survive the update" '[ -f "$app/.env" ] && grep -q runs-before-update "$db"'
check "update says how to go back" 'said "rollback goes back to 0.1.5"'

echo "Version after updating"
launcher version
check "version mentions the kept version" 'said "This is the newest release." && said "The version it replaced, 0.1.5, is kept"'

echo "Rollback that has to put the run history back"
# 0.1.6 changed the run history's layout and recorded more runs, with a write-ahead log open.
set_database 20261024000000 runs-after-update
echo stale-log >"$db-wal"
launcher rollback
check "without --yes and no terminal, nothing changes" '[ $status != 0 ] && said "nothing was changed" && [ "$(version_installed)" = 0.1.6 ] && grep -q runs-after-update "$db"'
launcher rollback --yes
check "rollback succeeds and starts 0.1.5" '[ $status = 0 ] && logged "started 0.1.5" && [ "$(version_installed)" = 0.1.5 ]'
check "the run history is the copy from before the update" 'grep -q runs-before-update "$db" && grep -q "layout=20261017000000" "$db"'
check "the old write-ahead log is gone with the file it belonged to" '[ ! -e "$db-wal" ] && [ ! -e "$db.restoring" ]'
export saved
saved=$(find "$work/backups" -name 'loomwatch-*-0.1.6-before-rollback.db' | head -n 1)
check "what 0.1.6 recorded is saved first" '[ -n "$saved" ] && grep -q runs-after-update "$saved"'
check "the kept version is used up" '[ ! -e "$app/.previous" ] && [ -z "$(find "$app" -maxdepth 1 -name ".loomwatch-rollback.*")" ]'

echo "Rollback with nothing kept"
launcher rollback --yes
check "rollback explains there is nothing to go back to" '[ $status != 0 ] && said "no earlier version is kept"'

echo "Rollback when the layout did not change"
launcher update
set_database 20261017000000 runs-on-0.1.6
launcher rollback
check "rollback succeeds without asking" '[ $status = 0 ] && [ "$(version_installed)" = 0.1.5 ]'
check "the run history is left alone" 'grep -q runs-on-0.1.6 "$db" && ! logged "before-rollback"'

echo "A failed restore changes nothing"
launcher update
set_database 20261024000000 runs-after-second-update
export unreadable
unreadable=$(sed -n 's/^backup=//p' "$app/.previous/ROLLBACK")
chmod 000 "$unreadable"
launcher rollback --yes
chmod 600 "$unreadable"
check "rollback fails" '[ $status != 0 ] && said "could not be restored, so nothing was changed"'
check "0.1.6 and its run history are untouched" '[ "$(version_installed)" = 0.1.6 ] && grep -q runs-after-second-update "$db" && [ -d "$app/.previous" ] && [ ! -e "$db.restoring" ]'

echo "Updating while LoomWatch runs"
touch "$FAKE/daemon-up"
set +e
"$app/loomwatch" update --no-open </dev/null >"$FAKE/out" 2>&1
status=$?
set -e
rm -f "$FAKE/daemon-up"
check "with no one to ask, update refuses and changes nothing" '[ $status != 0 ] && said "still running" && [ "$(version_installed)" = 0.1.6 ]'

echo "Installing a particular, older release"
LOOMWATCH_VERSION=v0.1.4 launcher update
check "a release asked for by name is installed even when older" '[ $status = 0 ] && [ "$(version_installed)" = 0.1.4 ] && [ "$(cut -d " " -f 1 "$app/.previous/VERSION")" = 0.1.6 ]'

echo "Update and restart in the app"
export FAKE_LATEST=v0.1.6
set_database 20261017000000 runs-before-app-update
# The release the app showed, which need not be the newest the launcher would find.
echo v0.1.5 >"$FAKE/app-asks"
launcher start
export app_backup
app_backup=$(find "$work/backups" -name 'loomwatch-*-0.1.4.db' | sort | tail -n 1)
check "LoomWatch is told a launcher stays beside it, and where to name a release" 'grep -q "^started 0.1.4 install=release command=$app/loomwatch update supervised=1 request=/.*/app/run/update-request " "$FAKE_LOG"'
check "stop finds LoomWatch, not the script, in the process file" 'logged "started 0.1.4 " && ! logged "pid=other"'
check "exit 75 installs the release LoomWatch named, then starts it" '[ $status = 0 ] && [ "$(version_installed)" = 0.1.5 ] && logged "started 0.1.5 "'
check "the run history was copied first" '[ -n "$app_backup" ] && grep -q runs-before-app-update "$app_backup"'
check "0.1.4 is kept for rollback" '[ "$(cut -d " " -f 1 "$app/.previous/VERSION")" = 0.1.4 ] && grep -qx "backup=$app_backup" "$app/.previous/ROLLBACK"'
check "the window says what happened" 'said "Updating LoomWatch 0.1.4 to 0.1.5, as asked in the app" && said "Updated LoomWatch to 0.1.5." && said "rollback goes back to 0.1.4"'
check "the new version runs beside its own launcher, told of no failure" 'grep -q "^started 0.1.5 .* supervised=1 .* failed=$" "$FAKE_LOG"'
check "the request is used up" '[ ! -e "$app/run/update-request" ]'

echo "An update from the app that does not finish"
echo v0.1.9 >"$FAKE/app-asks"
launcher start
check "the version that was running starts again" '[ $status = 0 ] && [ "$(version_installed)" = 0.1.5 ] && [ "$(grep -c "^started 0.1.5 " "$FAKE_LOG")" = 2 ]'
check "only the start after the failure is told why" 'grep "^started 0.1.5 " "$FAKE_LOG" | head -n 1 | grep -q "failed=$" && logged "failed=the download did not finish, and LoomWatch 0.1.5 was left as it was. The window running LoomWatch says why."'
check "the window says so" 'said "could not download" && said "Starting LoomWatch 0.1.5 again"'
check "nothing was replaced" '[ "$(cut -d " " -f 1 "$app/.previous/VERSION")" = 0.1.4 ] && [ ! -e "$app/run/update-failed" ]'

echo "Update and restart that names no release, or an older one"
: >"$FAKE/app-asks"
launcher start
check "with none named, nothing is installed and LoomWatch is told why" '[ $status = 0 ] && [ "$(version_installed)" = 0.1.5 ] && logged "failed=LoomWatch did not say which version to install."'
echo v0.1.4 >"$FAKE/app-asks"
launcher start
check "an older release is never installed from the app" '[ $status = 0 ] && [ "$(version_installed)" = 0.1.5 ] && logged "failed=0.1.4 is not newer than LoomWatch 0.1.5, so nothing was changed."'

echo "LoomWatch stopping any other way"
echo exit=3 >"$FAKE/app-asks"
launcher start
check "ends the launcher with LoomWatch's status, as before" '[ $status = 3 ] && [ "$(grep -c "^started" "$FAKE_LOG")" = 1 ] && [ ! -e "$app/run/launcher.pid" ]'

echo "Three copies are kept"
check "older copies are removed" '[ "$(find "$work/backups" -name "*.db" | wc -l | tr -d " ")" = 3 ]'

# --- Coming from a version that kept the run history in PostgreSQL in Docker -------------------
# What such a version leaves in the folder: its settings, naming the database and its password.
earlier_settings() {
  printf 'POSTGRES_USER=loomwatch\nPOSTGRES_PASSWORD=0123abcd\nPOSTGRES_DB=loomwatch\nPOSTGRES_PORT=5433\nCOMPOSE_PROJECT_NAME=loomwatch-test\n' >"$app/.env"
}

echo "The first start after updating from a version that used Docker"
earlier_settings
rm -f "$db"
echo loomwatch-test >"$FAKE/docker/container"
touch "$FAKE/docker/up" "$FAKE/docker/volume"
rm -f "$FAKE/docker/running"
launcher start
check "the earlier database is started and its history brought over" 'logged "docker start c0ffee" && logged "import from=postgres://loomwatch:0123abcd@127.0.0.1:55432/loomwatch" && grep -q imported "$db"'
check "it is stopped again and kept" '[ ! -f "$FAKE/docker/running" ] && logged "docker stop c0ffee" && ! logged "docker rm" && ! logged "volume rm" && said "kept in Docker as it was"'
check "then LoomWatch starts" '[ $status = 0 ] && logged "started 0.1.5"'
launcher start
check "the next start brings nothing over again" '[ $status = 0 ] && ! logged "import from" && ! logged "docker "'

echo "The first start after updating, with Docker not running"
rm -f "$db" "$FAKE/docker/up"
launcher start
check "says once how to bring the history over later, and starts" '[ $status = 0 ] && said "To bring it over, start Docker Desktop and run:" && ! logged "import from" && logged "started 0.1.5"'
launcher import
check "import refuses plainly while Docker is not running" '[ $status != 0 ] && said "Docker is not available"'
touch "$FAKE/docker/up"
launcher import
check "import brings it over later" '[ $status = 0 ] && logged "import from=postgres://loomwatch:0123abcd@127.0.0.1:55432/loomwatch" && grep -q imported "$db"'
touch "$FAKE/daemon-up"
set +e
"$app/loomwatch" import </dev/null >"$FAKE/out" 2>&1
status=$?
set -e
rm -f "$FAKE/daemon-up"
check "import refuses while LoomWatch runs" '[ $status != 0 ] && said "Stop it first"'

echo "The first start after updating, when the database was another copy's"
rm -f "$db"
echo "$work" >"$FAKE/docker/owner"
touch "$work/docker-compose.yml"
launcher start
check "another copy's history is left alone" '[ $status = 0 ] && ! logged "import from" && ! logged "docker start"'
rm -f "$FAKE/docker/owner" "$work/docker-compose.yml"

echo "Rollback to a version that keeps the run history in Docker"
set_database 20261017000000 runs-since-the-update
mkdir -p "$app/.previous/bin"
cp "$app/bin/loomwatchd" "$app/.previous/bin/loomwatchd"
printf '0.1.3 legacy\n' >"$app/.previous/VERSION"
# Its launcher, with the function such launchers have.
printf '#!/usr/bin/env bash\nuses_docker_database() { [ -z "${LOOMWATCH_DATABASE_URL:-}" ]; }\nprintf "earlier launcher %%s\\n" "$*" >>"$FAKE_LOG"\n' >"$app/.previous/loomwatch"
chmod 755 "$app/.previous/loomwatch"
printf 'version=0.1.5\nlayout=20261006000000\nbackup=%s\n' "$work/backups/loomwatch-app/x.dump" >"$app/.previous/ROLLBACK"
launcher rollback
check "goes back without asking, and starts the earlier version" '[ $status = 0 ] && [ "$(version_installed)" = 0.1.3 ] && logged "earlier launcher start --no-open"'
check "says the history since the update stays in the file" 'said "keeps its run history in Docker" && said "import brings over"'
check "the file is left alone and nothing is restored" 'grep -q runs-since-the-update "$db" && ! logged "backup "'

if [ "$failures" -gt 0 ]; then
  printf '\n%s check(s) failed. Last output:\n' "$failures"
  cat "$FAKE/out"
  exit 1
fi
printf '\nAll update checks passed.\n'
