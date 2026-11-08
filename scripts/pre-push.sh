#!/usr/bin/env bash
# Pre-push guard for the BounTEE repo. It refuses to push anything that must stay local, and
# scans the outgoing commits for secrets and personal data. Installed as the repo's common
# pre-push hook (every worktree shares it). Bypass is never the right move; fix the push.
#
# For each ref being pushed it:
#   1. refuses a protected ref (a local-only branch namespace that must never leave the machine);
#   2. refuses outgoing commits that ADD a protected path (a committed fallback list, plus any
#      path that exists only on the protected branch and not in the pushed tree);
#   3. refuses any outgoing blob whose content equals a protected blob, or matches a protected
#      identifier pattern (catches a protected file re-added under a new name);
#   4. runs gitleaks on the outgoing commits;
#   5. greps the outgoing diff for personal emails and home paths.
#
# The protected path list and identifier patterns live under the repo's common git dir
# (info/sealed-paths, info/sealed-patterns): local, never pushed. This script names no protected
# file itself.
set -euo pipefail

remote_name="${1:-origin}"
common_dir="$(git rev-parse --git-common-dir)"
[[ "$common_dir" = /* ]] || common_dir="$(git rev-parse --show-toplevel)/$common_dir"

protected_ref_glob="refs/heads/sealed/"
protected_branch="sealed/position-exploit"
paths_file="$common_dir/info/sealed-paths"
patterns_file="$common_dir/info/sealed-patterns"
zero="0000000000000000000000000000000000000000"

fail() { echo "pre-push: $*" >&2; exit 1; }

# Protected branch's tree (for path/blob comparison), if the branch exists locally.
protected_tree=""
if git rev-parse --verify --quiet "$protected_branch" >/dev/null; then
  protected_tree="$protected_branch"
fi

# The set of blob oids that exist only on the protected branch for a given pushed tree.
protected_blobs_for() {
  local pushed_ref="$1"
  [ -n "$protected_tree" ] || return 0
  # Paths present on the protected branch but absent from the pushed tree: the local-only files.
  comm -23 \
    <(git ls-tree -r --name-only "$protected_tree" | sort) \
    <(git ls-tree -r --name-only "$pushed_ref" 2>/dev/null | sort) \
  | while IFS= read -r p; do
      [ -n "$p" ] || continue
      git rev-parse "$protected_tree:$p" 2>/dev/null || true
    done
}

protected_paths_for() {
  local pushed_ref="$1"
  { [ -f "$paths_file" ] && grep -v '^[[:space:]]*$' "$paths_file" || true; } | sort -u > "$TMP/declared"
  if [ -n "$protected_tree" ]; then
    comm -23 \
      <(git ls-tree -r --name-only "$protected_tree" | sort) \
      <(git ls-tree -r --name-only "$pushed_ref" 2>/dev/null | sort) >> "$TMP/declared"
  fi
  sort -u "$TMP/declared"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Protected blob oids across history, deduped (a rename keeps the same oid).
protected_blob_set="$TMP/protected-blobs"
: > "$protected_blob_set"
if [ -n "$protected_tree" ]; then
  git ls-tree -r "$protected_tree" | awk '{print $3}' > "$TMP/ptree-blobs" || true
fi

while read -r local_ref local_sha remote_ref remote_sha; do
  [ -n "${local_ref:-}" ] || continue

  # (1) A protected ref must never be pushed.
  case "$local_ref" in
    "$protected_ref_glob"*) fail "refusing to push a protected ref: $local_ref" ;;
  esac

  # Deleting a ref pushes nothing to scan.
  [ "$local_sha" = "$zero" ] && continue

  # Outgoing commit range.
  if [ "$remote_sha" = "$zero" ]; then
    range=("$local_sha" --not --remotes="$remote_name")
  else
    range=("$remote_sha..$local_sha")
  fi

  git rev-list "${range[@]}" > "$TMP/commits"
  [ -s "$TMP/commits" ] || continue
  oldest="$(tail -n1 "$TMP/commits")"

  base_args=()
  if [ "$remote_sha" = "$zero" ]; then
    base_args=("${oldest}^" "$local_sha")
  else
    base_args=("$remote_sha" "$local_sha")
  fi

  # (2) Added paths in this push must not be protected.
  protected_paths_for "$local_sha" > "$TMP/protected-paths"
  git diff --diff-filter=A --name-only "${base_args[@]}" 2>/dev/null | sort -u > "$TMP/added" || true
  if [ -s "$TMP/added" ] && [ -s "$TMP/protected-paths" ]; then
    offending="$(comm -12 "$TMP/added" "$TMP/protected-paths" || true)"
    [ -n "$offending" ] && fail "refusing to push a protected path:"$'\n'"$offending"
  fi

  # (3a) Outgoing blobs equal to a protected blob (same content under any name).
  if [ -s "${TMP}/ptree-blobs" ]; then
    git diff --diff-filter=ACMR --raw "${base_args[@]}" 2>/dev/null \
      | awk '{print $4}' | grep -v '^0\{40\}$' | sort -u > "$TMP/out-blobs" || true
    if [ -s "$TMP/out-blobs" ]; then
      sort -u "$TMP/ptree-blobs" > "$TMP/ptree-blobs-sorted"
      match="$(comm -12 "$TMP/out-blobs" "$TMP/ptree-blobs-sorted" || true)"
      [ -n "$match" ] && fail "refusing to push a protected blob (content matches a local-only file), oid(s):"$'\n'"$match"
    fi
  fi

  # (3b) Outgoing blob contents matching a protected identifier pattern.
  if [ -f "$patterns_file" ] && [ -s "$TMP/out-blobs" ]; then
    while IFS= read -r pat; do
      [ -n "$pat" ] || continue
      while IFS= read -r oid; do
        [ -n "$oid" ] || continue
        if git cat-file -p "$oid" 2>/dev/null | grep -qF "$pat"; then
          fail "refusing to push content matching a protected pattern: $pat"
        fi
      done < "$TMP/out-blobs"
    done < <(grep -v '^[[:space:]]*$' "$patterns_file")
  fi

  # (4) Secret scan on the outgoing commits.
  if command -v gitleaks >/dev/null 2>&1; then
    if [ "$remote_sha" = "$zero" ]; then
      logopts="${oldest}^..$local_sha"
    else
      logopts="$remote_sha..$local_sha"
    fi
    gitleaks git --no-banner --redact --log-opts="$logopts" . \
      || fail "gitleaks found a potential secret in the outgoing commits"
  else
    fail "gitleaks is not installed; install it before pushing"
  fi

  # (5) Personal emails and home paths in the outgoing diff.
  home_re='/(Users|home)/[A-Za-z0-9._-]+/'
  email_re='[a-zA-Z0-9._%+-]+@(hotmail|gmail|getlinkedup|outlook|icloud|proton)'
  leak="$(git diff "${base_args[@]}" 2>/dev/null \
    | grep -nE "$home_re|$email_re" || true)"
  if [ -n "$leak" ]; then
    fail "outgoing diff contains a personal email or home path:"$'\n'"$leak"
  fi
done

exit 0
