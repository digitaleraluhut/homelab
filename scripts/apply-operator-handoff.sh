#!/bin/bash
# Apply workflow changes handed off by the operator (AI agent).
#
# The operator's GitHub App may not push .github/workflows/ (deliberately, see
# README "Operator (AI agent)"). It leaves the files plus a manifest in the
# handoff directory; the owner runs THIS reviewed script, which pushes them
# with the owner's credentials. The operator supplies data only, never code.
#
#   scripts/apply-operator-handoff.sh            # interactive: shows each diff, asks
#   HANDOFF_DIR=... BASE=... scripts/apply-operator-handoff.sh
#
# Manifest $HANDOFF_DIR/handoff.tsv, one tab-separated line per file:
#   <repo>  <branch | new:branch>  <file in HANDOFF_DIR>  <commit message / PR title>
# - repo: homelab | homelab-apps | local-ai | homelab-wiki
# - branch: an existing branch with an OPEN pull request, or new:<name> for a
#   new branch from main plus a new pull request
# - the file lands at .github/workflows/<basename>; nothing else is written
# Nothing is ever merged.
set -u

HANDOFF_DIR=${HANDOFF_DIR:-/tmp/aioperator-handoff}
BASE=${BASE:-$HOME/projects/privat/digitaleraluhut}
ORG=digitaleraluhut
REPOS=" homelab homelab-apps local-ai homelab-wiki "
MANIFEST="$HANDOFF_DIR/handoff.tsv"

die() { echo "error: $*" >&2; exit 1; }
confirm() {
  [ "${HANDOFF_YES:-}" = 1 ] && return 0
  local answer
  read -r -p "$1 [y/N] " answer </dev/tty
  [ "$answer" = y ] || [ "$answer" = Y ]
}

[ -f "$MANIFEST" ] || die "no manifest at $MANIFEST"
n=0
while IFS=$'\t' read -r repo branch file message; do
  n=$((n + 1))
  case "$repo" in ''|'#'*) continue ;; esac
  echo; echo "=== [$n] $repo $branch $file"

  [[ $REPOS == *" $repo "* ]] || { echo "skip: unknown repo '$repo'"; continue; }
  name=$(basename -- "$file")
  [[ $name =~ ^[a-z0-9._-]+\.ya?ml$ ]] || { echo "skip: '$name' is not a workflow file name"; continue; }
  src=$(realpath -e -- "$HANDOFF_DIR/$file" 2>/dev/null) || { echo "skip: $file not found"; continue; }
  [[ $src == "$(realpath "$HANDOFF_DIR")"/* && -f $src ]] || { echo "skip: $file is outside the handoff dir"; continue; }
  [ -n "$message" ] || { echo "skip: no commit message"; continue; }

  dir="$BASE/$repo"
  [ -d "$dir/.git" ] || { echo "skip: no clone at $dir"; continue; }
  [ -z "$(git -C "$dir" status --porcelain --untracked-files=no)" ] || { echo "skip: $dir has uncommitted changes"; continue; }
  previous=$(git -C "$dir" branch --show-current)

  if [[ $branch == new:* ]]; then
    branch=${branch#new:}; new=1
    git -C "$dir" fetch -q origin main && git -C "$dir" switch -q -C "$branch" origin/main || { echo "skip: cannot create $branch"; continue; }
  else
    new=0
    state=$(cd "$dir" && gh pr view "$branch" --json state -q .state 2>/dev/null)
    [ "$state" = OPEN ] || { echo "skip: no open pull request for $branch"; continue; }
    git -C "$dir" fetch -q origin "$branch" && git -C "$dir" switch -q -C "$branch" "origin/$branch" || { echo "skip: cannot check out $branch"; continue; }
  fi

  mkdir -p "$dir/.github/workflows"
  cp -- "$src" "$dir/.github/workflows/$name"
  git -C "$dir" add ".github/workflows/$name"
  if git -C "$dir" diff --cached --quiet; then
    echo "no change"
  else
    git -C "$dir" --no-pager diff --cached --stat
    git -C "$dir" --no-pager diff --cached
    if confirm "Commit and push to $repo:$branch?"; then
      git -C "$dir" -c commit.gpgsign=false commit -q -m "$message" \
        && git -C "$dir" push -q -u origin "$branch" \
        && echo "pushed $repo:$branch"
      if [ "$new" = 1 ]; then
        (cd "$dir" && gh pr create -R "$ORG/$repo" --base main --head "$branch" --title "$message" \
          --body "Workflow change handed off by the operator (scripts/apply-operator-handoff.sh).")
      fi
    else
      git -C "$dir" reset -q --hard
      echo "skipped by owner"
    fi
  fi
  [ -n "$previous" ] && git -C "$dir" switch -q "$previous"
done <"$MANIFEST"
echo; echo "Done. Review and merge the pull requests; nothing was merged."
