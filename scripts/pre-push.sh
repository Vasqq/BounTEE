#!/usr/bin/env bash
# Pre-push guard for the BounTEE repo. It refuses to push anything that must stay local, and
# scans the outgoing commits for secrets and personal data. Installed as the repo's common
# pre-push hook (every worktree shares it). Bypass is never the right move; fix the push.
#
# For each ref being pushed it:
#   1. refuses a protected ref (the protected branch, and its namespace if it has one);
#   2. refuses outgoing commits that ADD a protected path (a local fallback list, plus any
#      path that exists only on the protected branch and not in the pushed tree);
#   3. refuses any outgoing blob whose content equals a blob the protected branch added, or
#      contains a protected identifier (catches a protected file under a new name);
#   4. runs gitleaks on the outgoing commits;
#   5. greps the lines the outgoing commits add for personal emails and home paths.
#
# Everything it protects is configured locally, under the repo's common git dir, and never
# pushed; this script names nothing protected itself:
#   info/sealed-branch      first line: the protected branch
#   info/sealed-paths       protected paths, one per line
#   info/sealed-patterns    protected identifiers, fixed strings, one per line
#   info/personal-patterns  extra personal-data patterns (extended regexes), one per line
set -euo pipefail

remote_name="${1:-origin}"
common_dir="$(git rev-parse --git-common-dir)"
[[ "$common_dir" = /* ]] || common_dir="$(git rev-parse --show-toplevel)/$common_dir"

branch_file="$common_dir/info/sealed-branch"
paths_file="$common_dir/info/sealed-paths"
patterns_file="$common_dir/info/sealed-patterns"
personal_file="$common_dir/info/personal-patterns"
zero="0000000000000000000000000000000000000000"

fail() { echo "pre-push: $*" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Non-empty lines of a local config file (nothing if it is absent).
lines_of() { if [ -f "$1" ]; then grep -v '^[[:space:]]*$' "$1" || true; fi; }

# The protected branch and the ref names it covers: the branch, and its namespace when its
# name has one (a/b protects every refs/heads/a/...).
protected_branch="$(lines_of "$branch_file" | head -n1 | tr -d '[:space:]')"
# Fail closed: without its local config the guard can't tell what to protect, so it refuses.
[ -n "$protected_branch" ] || fail "no protected branch configured ($branch_file); refusing the push"
[ -s "$paths_file" ] || fail "no protected paths configured ($paths_file); refusing the push"
protected_ref_exact=""
protected_ref_prefix=""
protected_tree=""
if [ -n "$protected_branch" ]; then
  protected_ref_exact="refs/heads/$protected_branch"
  case "$protected_branch" in
    */*) protected_ref_prefix="refs/heads/${protected_branch%/*}/" ;;
  esac
  if git rev-parse --verify --quiet "$protected_ref_exact" >/dev/null; then
    protected_tree="$protected_ref_exact"
  fi
fi

lines_of "$paths_file" | sort -u > "$TMP/declared-paths"
lines_of "$patterns_file" > "$TMP/sealed-patterns"
lines_of "$personal_file" > "$TMP/personal-patterns"

# Blob oids among the objects a rev-list selects, sorted.
blobs_of() {
  git rev-list --objects "$@" | cut -d' ' -f1 \
    | git cat-file --batch-check='%(objectname) %(objecttype)' \
    | awk '$2 == "blob" { print $1 }' | sort -u
}

while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "${local_ref:-}" ] || continue

  # (1) A protected ref must never be pushed, under its local or its remote name.
  for ref in "$local_ref" "$remote_ref"; do
    if [ -n "$protected_ref_exact" ] && [ "$ref" = "$protected_ref_exact" ]; then
      fail "refusing to push a protected ref: $ref"
    fi
    if [ -n "$protected_ref_prefix" ]; then
      case "$ref" in "$protected_ref_prefix"*) fail "refusing to push a protected ref: $ref" ;; esac
    fi
  done

  # Deleting a ref pushes nothing to scan.
  [ "$local_sha" = "$zero" ] && continue

  # Outgoing commits: those the remote's ref lacks, or, for a new ref (or a remote tip this
  # clone doesn't have), those no remote-tracking ref reaches.
  if [ "$remote_sha" != "$zero" ] && git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
    range=("$local_sha" --not "$remote_sha")
  else
    range=("$local_sha" --not --remotes="$remote_name")
  fi
  git rev-list "${range[@]}" > "$TMP/commits"
  [ -s "$TMP/commits" ] || continue

  # Every blob the outgoing commits carry that the remote doesn't already reach, built for
  # this ref before any check reads it.
  blobs_of "${range[@]}" > "$TMP/out-blobs"

  # (2) Paths any outgoing commit adds (a root commit's included) must not be protected.
  cp "$TMP/declared-paths" "$TMP/protected-paths"
  if [ -n "$protected_tree" ]; then
    comm -23 \
      <(git ls-tree -r --name-only "$protected_tree" | sort) \
      <(git ls-tree -r --name-only "$local_sha" | sort) >> "$TMP/protected-paths"
  fi
  sort -u -o "$TMP/protected-paths" "$TMP/protected-paths"
  { git log --format= --name-only --diff-filter=A "${range[@]}" | grep -v '^$' || true; } | sort -u > "$TMP/added"
  offending="$(comm -12 "$TMP/added" "$TMP/protected-paths")"
  [ -z "$offending" ] || fail "refusing to push a protected path:"$'\n'"$offending"

  # (3a) Outgoing blobs equal to a blob the protected branch added since it left the pushed
  # line of history (the same content under any name).
  if [ -n "$protected_tree" ]; then
    bases=()
    while IFS= read -r b; do bases+=("$b"); done < <(git merge-base --all "$protected_tree" "$local_sha" || true)
    if [ ${#bases[@]} -gt 0 ]; then
      blobs_of "$protected_tree" --not "${bases[@]}" > "$TMP/protected-blobs"
    else
      blobs_of "$protected_tree" > "$TMP/protected-blobs"
    fi
    match="$(comm -12 "$TMP/out-blobs" "$TMP/protected-blobs")"
    [ -z "$match" ] || fail "refusing to push a protected blob (content matches a local-only file), oid(s):"$'\n'"$match"
  fi

  # (3b) Outgoing blob contents containing a protected identifier.
  if [ -s "$TMP/sealed-patterns" ]; then
    while IFS= read -r oid; do
      if git cat-file blob "$oid" | grep -qF -f "$TMP/sealed-patterns"; then
        fail "refusing to push content matching a protected pattern, blob $oid"
      fi
    done < "$TMP/out-blobs"
  fi

  # (4) Secret scan on the outgoing commits.
  command -v gitleaks >/dev/null 2>&1 || fail "gitleaks is not installed; install it before pushing"
  gitleaks git --no-banner --redact --log-opts="${range[*]}" . \
    || fail "gitleaks found a potential secret in the outgoing commits"

  # (5) Personal emails and home paths in the lines the outgoing commits add (a root commit's
  # against the empty tree; a merge's only where it differs from every parent).
  home_re='/(Users|home)/[A-Za-z0-9._-]+/'
  email_re='[a-zA-Z0-9._%+-]+@(hotmail|gmail|googlemail|outlook|live|yahoo|icloud|me|proton|protonmail)\.'
  { git log -p --cc --format= "${range[@]}" | grep '^+' | grep -v '^+++ ' || true; } > "$TMP/added-lines"
  leak="$(grep -nE -e "$home_re" -e "$email_re" "$TMP/added-lines" || true)"
  if [ -s "$TMP/personal-patterns" ]; then
    leak+="$(grep -nE -f "$TMP/personal-patterns" "$TMP/added-lines" || true)"
  fi
  [ -z "$leak" ] || fail "outgoing commits add a personal email or home path:"$'\n'"$leak"
done

exit 0
