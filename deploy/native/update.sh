#!/usr/bin/env bash
# Stable entry: always execute the fetched revision's installer, never the old current release.
set -Eeuo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Use sudo/root.' >&2; exit 1; }
SOURCE_REPO=${CHUNMO_SOURCE_REPO:-/opt/chunmo-source}
export CHUNMO_SOURCE_REPO="$SOURCE_REPO"
branch=feat/chunmo-project-manager
remote=$(git -C "$SOURCE_REPO" remote get-url origin)
[[ $remote == https://github.com/qq850576557-debug/aaa.git || $remote == git@github.com:qq850576557-debug/aaa.git ]] || { echo 'Unexpected origin; refusing root execution.' >&2; exit 1; }
exec 8>/run/lock/chunmo-staging-update.lock
flock -n 8 || { echo 'Another update is preparing; retry later.' >&2; exit 1; }
git -C "$SOURCE_REPO" fetch origin "refs/heads/$branch:refs/remotes/origin/$branch"
commit=$(git -C "$SOURCE_REPO" rev-parse "refs/remotes/origin/$branch^{commit}")
[[ $commit =~ ^[a-f0-9]{40}$ ]]
work=$(mktemp -d /tmp/chunmo-update.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
# Only deployment code is extracted; the source checkout, local commits and stash are untouched.
git -C "$SOURCE_REPO" archive "$commit" deploy/native | tar -x -C "$work"
if [[ ${1:-} == --install ]]; then
  [[ ! -L /usr/local/sbin/chunmo-update ]] || { echo 'Refusing symlinked update entry.' >&2; exit 1; }
  if [[ -e /usr/local/sbin/chunmo-update ]]; then
    grep -q '^# Stable entry:' /usr/local/sbin/chunmo-update || { echo 'Existing unmanaged update command; preserve and review first.' >&2; exit 1; }
  fi
  install -o root -g root -m 0755 "$work/deploy/native/update.sh" /usr/local/sbin/chunmo-update
elif [[ $# != 0 ]]; then
  echo 'Usage: update.sh [--install]' >&2; exit 1
fi
printf 'Updating managed deployment to GitHub commit %s; source edits retained.\n' "$commit"
bash "$work/deploy/native/deploy.sh" --ref "$commit"
printf 'PASS update %s\n' "$commit"
