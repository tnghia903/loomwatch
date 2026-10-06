#!/usr/bin/env bash
# Installs LoomWatch from its newest release, or updates a copy installed this way.
#
#   curl -fsSL https://loomwatch.github.io/install.sh | bash
#
# Downloads the ready-built LoomWatch for this computer from GitHub, checks it against the
# release's checksum, puts it in ~/LoomWatch/app and starts it. Nothing is compiled, nothing needs
# an administrator password, and nothing outside ~/LoomWatch changes, apart from a `loomwatch`
# shortcut in ~/.local/bin when that folder is on your PATH. Running it again updates LoomWatch and
# keeps your settings, teams and history.
#
# Optional settings, read from the environment:
#   LOOMWATCH_APP_DIR    where to install (default: ~/LoomWatch/app)
#   LOOMWATCH_VERSION    a release such as v0.1.0 (default: the newest)
#   LOOMWATCH_NO_START   1 to install without starting LoomWatch
#
# Options: --no-start (install only), --update and --dir DIR (used by `loomwatch update`), and
# --latest, which only prints the newest release's tag, such as v0.1.6.
#
# An update keeps the version it replaces in .previous inside the install folder, for
# `loomwatch rollback`, and replaces nothing at all when any part of it fails.
#
# Written for the bash 3.2 that ships with macOS. Everything runs from main() on the last line, so
# a download cut off halfway never runs half a script.
set -euo pipefail

repo=tnghia903/loomwatch

if [ -t 1 ]; then bold=$(printf '\033[1m'); reset=$(printf '\033[0m'); else bold=; reset=; fi
say() { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$bold" "$*" "$reset"; }
fail() {
  printf '\n%sLoomWatch could not be installed:%s %s\n' "$bold" "$reset" "$*" >&2
  exit 1
}

# The release file for this computer: one macOS file runs on Apple silicon and Intel Macs.
platform() {
  case "$(uname -s)" in
    Darwin) echo macos-universal ;;
    Linux)
      case "$(uname -m)" in
        x86_64 | amd64) echo linux-x86_64 ;;
        aarch64 | arm64) echo linux-arm64 ;;
        *) fail "there is no ready-built LoomWatch for $(uname -m) Linux computers yet. See https://github.com/$repo#build-from-source" ;;
      esac
      ;;
    MINGW* | MSYS* | CYGWIN*)
      fail "Windows is not supported yet. LoomWatch may work inside WSL (Windows Subsystem for Linux): open an Ubuntu window and run this command there."
      ;;
    *) fail "LoomWatch runs on macOS (and, untested, Linux). This computer runs $(uname -s)." ;;
  esac
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    fail "this computer has neither shasum nor sha256sum, so the download cannot be checked."
  fi
}

# The newest published release's tag, such as v0.1.6, from where GitHub's releases/latest page
# leads: a page, not the API, so it never meets the API's hourly limit.
latest_tag() {
  local effective tag
  effective=$(curl -fsSIL --proto '=https' --proto-redir '=https' --retry 2 --max-time 30 -o /dev/null \
    -w '%{url_effective}' "https://github.com/$repo/releases/latest") || return 1
  tag=${effective##*/releases/tag/}
  [ "$tag" != "$effective" ] || return 1
  case $tag in v[0-9]*.[0-9]*.[0-9]*) ;; *) return 1 ;; esac
  case $tag in *[!0-9A-Za-z.+-]*) return 1 ;; esac
  printf '%s\n' "$tag"
}

# Shows a path under the home folder the way it is typed: ~/LoomWatch/app.
pretty() {
  case $1 in
    "$HOME"/*) printf '~%s\n' "${1#"$HOME"}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# True while the LoomWatch started from this folder is still running.
still_running() {
  local pid
  pid=$(cat "$1/run/loomwatchd.pid" 2>/dev/null || true)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && case $(ps -p "$pid" -o comm= 2>/dev/null) in
    *loomwatchd*) return 0 ;;
    *) return 1 ;;
  esac
}

# Undoes a half-finished install: removes the files already placed, then moves the old ones back.
put_back() {
  local app_dir=$1 replaced=$2 name item
  for name in $3; do rm -rf "${app_dir:?}/$name"; done
  for item in "$replaced"/* "$replaced"/.[!.]*; do
    [ -e "$item" ] || continue
    mv "$item" "$app_dir/$(basename "$item")" || true
  done
}

main() {
  local app_dir=${LOOMWATCH_APP_DIR:-$HOME/LoomWatch/app} start=1 updating=0 latest_only=0
  if [ "${LOOMWATCH_NO_START:-}" = 1 ]; then start=0; fi
  while [ $# -gt 0 ]; do
    case $1 in
      --no-start) start=0 ;;
      --update) updating=1 start=0 ;;
      --latest) latest_only=1 ;;
      --dir)
        [ $# -ge 2 ] || fail "--dir needs a folder."
        app_dir=$2
        shift
        ;;
      *) fail "unknown option '$1'." ;;
    esac
    shift
  done

  local tool
  for tool in curl tar uname mktemp; do
    command -v "$tool" >/dev/null 2>&1 || fail "this computer is missing '$tool', which the installer needs."
  done
  if [ "$latest_only" = 1 ]; then
    latest_tag || fail "could not ask GitHub for the newest release."
    return 0
  fi

  local target asset base label protocols='=https'
  target=$(platform)
  asset="loomwatch-$target.tar.gz"
  label=macOS
  case $target in linux-*) label="Linux ($target)" ;; esac
  if [ -n "${LOOMWATCH_VERSION:-}" ]; then
    base="https://github.com/$repo/releases/download/$LOOMWATCH_VERSION"
  else
    base="https://github.com/$repo/releases/latest/download"
  fi
  # Testing a release before it is published: point this at a folder served over http.
  if [ -n "${LOOMWATCH_DOWNLOAD_BASE:-}" ]; then
    base=$LOOMWATCH_DOWNLOAD_BASE
    protocols='=https,http'
  fi

  if [ -e "$app_dir" ] && [ ! -x "$app_dir/bin/loomwatchd" ]; then
    if [ -f "$app_dir/Cargo.toml" ]; then
      fail "$(pretty "$app_dir") is a copy of LoomWatch's source code. Update it with ./loomwatch update there, or set LOOMWATCH_APP_DIR to another folder."
    elif [ -n "$(ls -A "$app_dir" 2>/dev/null)" ]; then
      fail "$(pretty "$app_dir") already exists and is not a LoomWatch installed by this script. Move it away, or set LOOMWATCH_APP_DIR to another folder."
    fi
  fi
  if still_running "$app_dir"; then
    fail "LoomWatch is running from $(pretty "$app_dir"). Stop it first (press Ctrl-C in its window, or run $(pretty "$app_dir")/loomwatch stop), then run this again."
  fi

  local parent tmp
  parent=$(dirname "$app_dir")
  mkdir -p "$parent"
  # Unpacked next to the install folder, so putting it in place is a rename on the same disk: a
  # LoomWatch launcher that is updating itself keeps reading the copy it started from.
  tmp=$(mktemp -d "$parent/.loomwatch-download.XXXXXX")
  # shellcheck disable=SC2064 # expand now: the variable is local to main
  trap "rm -rf '$tmp'" EXIT

  step "Downloading LoomWatch for $label"
  if ! curl -fL --progress-bar --proto "$protocols" --proto-redir "$protocols" --retry 2 -o "$tmp/$asset" "$base/$asset"; then
    if [ -n "${LOOMWATCH_VERSION:-}" ]; then
      fail "could not download $asset from release $LOOMWATCH_VERSION. Check the version at https://github.com/$repo/releases"
    fi
    fail "could not download $asset. Check your internet connection, or see https://github.com/$repo/releases"
  fi
  curl -fsSL --proto "$protocols" --proto-redir "$protocols" --retry 2 -o "$tmp/$asset.sha256" "$base/$asset.sha256" ||
    fail "could not download the checksum for $asset, so the download cannot be checked."

  local expected actual
  expected=$(cut -d ' ' -f 1 <"$tmp/$asset.sha256" | tr -d '\r\n')
  actual=$(sha256_of "$tmp/$asset")
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    fail "the download does not match the release's checksum, so it was not installed. Try again; if it keeps happening, report it at https://github.com/$repo/issues"
  fi

  mkdir "$tmp/unpacked"
  tar -xzf "$tmp/$asset" -C "$tmp/unpacked" || fail "the download could not be unpacked."
  local new="$tmp/unpacked/loomwatch"
  if [ ! -x "$new/bin/loomwatchd" ] || [ ! -x "$new/loomwatch" ]; then
    fail "the download is missing parts of LoomWatch."
  fi

  local version
  version=$(cut -d ' ' -f 1 <"$new/VERSION" 2>/dev/null || true)
  step "Installing LoomWatch ${version:-} in $(pretty "$app_dir")"
  mkdir -p "$app_dir" "$tmp/replaced"
  # Every packaged file and folder replaces its old copy. Anything else in the folder stays: your
  # settings (.env), the running state and the version kept from the last update.
  local item name placed=''
  for item in "$new"/* "$new"/.[!.]*; do
    [ -e "$item" ] || continue
    name=$(basename "$item")
    if { [ -e "$app_dir/$name" ] && ! mv "$app_dir/$name" "$tmp/replaced/$name"; } || ! mv "$item" "$app_dir/$name"; then
      put_back "$app_dir" "$tmp/replaced" "$placed"
      fail "LoomWatch could not be put in place in $(pretty "$app_dir"), so the version there was left as it was."
    fi
    placed="$placed $name"
  done
  # The version just replaced, kept whole for `loomwatch rollback` until the next update.
  if [ -n "$(ls -A "$tmp/replaced")" ]; then
    rm -rf "$app_dir/.previous"
    mv "$tmp/replaced" "$app_dir/.previous"
  fi

  # A `loomwatch` command, for the usual install only, when ~/.local/bin is a folder the terminal
  # already searches and nothing else there is called loomwatch.
  local run_with link="$HOME/.local/bin/loomwatch"
  run_with="$(pretty "$app_dir")/loomwatch"
  if [ "$app_dir" = "$HOME/LoomWatch/app" ] && [ -d "$HOME/.local/bin" ]; then
    case ":$PATH:" in
      *":$HOME/.local/bin:"*)
        if [ ! -e "$link" ] && [ ! -L "$link" ]; then ln -s "$app_dir/loomwatch" "$link"; fi
        if [ "$(readlink "$link" 2>/dev/null)" = "$app_dir/loomwatch" ]; then run_with=loomwatch; fi
        ;;
    esac
  fi

  if [ "$updating" = 1 ]; then
    say "Updated LoomWatch to ${version:-the newest release}."
    return 0
  fi
  say "Installed. Start LoomWatch at any time with: $run_with"
  say "Update it with: $run_with update. Remove it with the steps at https://github.com/$repo#remove-loomwatch"
  if [ "$start" = 0 ]; then return 0; fi

  rm -rf "$tmp"
  trap - EXIT
  # The installer arrives on standard input when piped into bash, so LoomWatch gets none.
  exec "$app_dir/loomwatch" </dev/null
}

main "$@"
