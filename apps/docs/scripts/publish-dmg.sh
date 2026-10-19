#!/bin/bash
#
# publish-dmg.sh — NIHO docs の dmg と自動更新の成果物を GitHub Release に上げる（S4 #18385。NIHO Desktop の
# publish-staff-dmg.sh の写し）
# ============================================================================
#
# 版: PR では版を触らない。公開の workflow（ci-docs-release.sh publish）が次の版を採番して作業場の 5 か所に書き換え（docs-version.mjs
# apply。commit しない）、build-dmg.sh のあとにここを呼ぶ。版は公開済みの docs-v* の tag の最大より大きくなければ上げない。
#
# 何をするか:
#   1. 版が公開済みの docs-v* の tag の最大より大きいこと（同じ版・同じ HEAD の tag が既にあるときは asset の上書きとして通す）。
#      手元で床の版（main の 5 か所の版）のまま公開して、ダウンロードの欄に古い版が出るのを防ぐ。
#   2. apps/docs/release/NIHO-docs-<版>-<sha>.dmg と、自動更新の .app.tar.gz・.sig を探す（無ければ build-dmg.sh を促す）。
#      <sha> は HEAD の 12 桁なので、別の commit から作った dmg は上げない。
#   3. 自動更新の公開鍵（tauri.conf.json の plugins.updater.pubkey）が設定済みで、.sig がその鍵で確かめられること
#      （updater-key.mjs。合わない組を配ると、どの Mac も更新しない）。
#   4. dmg の SHA-256 の .sha256 を作る。
#   5. docs-v<版>-<sha> の GitHub Release を作り（あれば使い回す・prerelease。notes に前の公開からの compare の URL）、4 つを
#      --clobber で上げる。Web の /docs/updater/latest.json がこの Release を読み、各 Mac の NIHO docs が次の起動で更新する。
#
# 使い方（普段は main の merge で docs-release.yml が ci-docs-release.sh publish から呼ぶ。手元は CI が使えないときの予備。
# merge 済み main の commit で、次の版を作業場に書き換えてから）:
#   git ls-remote --tags origin 'refs/tags/docs-v*' | node apps/docs/scripts/docs-version.mjs next   # 次の版
#   node apps/docs/scripts/docs-version.mjs apply <次の版>                                           # 作業場の 5 か所だけ（commit しない）
#   ./apps/docs/scripts/build-dmg.sh
#   ./apps/docs/scripts/publish-dmg.sh
#
# 前提:
#   - `gh` が niho-coliving/niho-app に認証済み（`gh auth status`。CI は GH_TOKEN）。
#   - working tree が clean（版の 5 ファイルの版の行だけの変更＝apply の書き換えは許す。--allow-dirty で緩和）。
#   - HEAD が origin/main に含まれる（--allow-non-main で緩和）。main は速く進むので「先端と一致」は求めない。
#
set -euo pipefail

REPO_SLUG="niho-coliving/niho-app"
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
DOCS_DIR="${REPO_ROOT}/apps/docs"
SCRIPTS_DIR="${DOCS_DIR}/scripts"
OUT_DIR="${DOCS_DIR}/release"

ALLOW_DIRTY=0
ALLOW_NON_MAIN=0
DRY_RUN=0

log() { printf '%s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
publish-dmg.sh [--allow-dirty] [--allow-non-main] [--dry-run] [-h|--help]

オプション:
  --allow-dirty       ワーキングツリーに未コミット変更があっても続行する（版の 5 ファイルの版の行だけの変更＝
                      docs-version.mjs apply の書き換えは、付けなくても通る）。
  --allow-non-main    HEAD が origin/main に含まれていなくても続行する。
  --dry-run           Release の作成・asset の upload をしない（確かめるだけ。自動更新の成果物・公開鍵が無くても止めない）。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --allow-non-main) ALLOW_NON_MAIN=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) log "unknown option: $1"; usage; exit 2 ;;
  esac
  shift
done

if [ "$(uname -s)" != "Darwin" ]; then
  log "error: macOS でのみ実行できます（uname=$(uname -s)）"
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  log "error: gh CLI が見つかりません。https://cli.github.com/ から入れてください。"
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  log "error: gh の認証が未済です。'gh auth login' を実行してください。"
  exit 1
fi

node "${SCRIPTS_DIR}/docs-version.mjs" check >/dev/null
VERSION="$(node "${SCRIPTS_DIR}/docs-version.mjs" current)"
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
SHORT_SHA="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
TAG="docs-v${VERSION}-${SHORT_SHA}"
# 版の 5 か所のファイル（docs-version.mjs と同じ）。公開の workflow はここの版の行だけを書き換えて（apply）commit しない
VERSION_FILES=(
  apps/docs/package.json
  apps/docs/package-lock.json
  apps/docs/src-tauri/tauri.conf.json
  apps/docs/src-tauri/Cargo.toml
  apps/docs/Cargo.lock
)

# 未コミットの変更が無いか、版の 5 ファイルの版の行（今の版への書き換え）だけか。それ以外の変更・未追跡のファイルがあれば 1。
only_version_changes() {
  local status_lines line file extra version_re
  # 未追跡のファイルも見る（.gitignore にあるビルドの出力は数えない）
  status_lines="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)"
  [ -n "$status_lines" ] || return 0
  while IFS= read -r line; do
    file="${line:3}"
    case " ${VERSION_FILES[*]} " in
      *" ${file} "*) ;;
      *) return 1 ;;
    esac
  done <<<"$status_lines"
  # +/- の行が版の行だけ（+ は今の版）。依存の版などほかの行が 1 つでも変わっていれば dirty
  version_re="${VERSION//./\\.}"
  extra="$(git -C "$REPO_ROOT" diff -U0 --no-color HEAD -- "${VERSION_FILES[@]}" \
    | { grep -E '^[+-]' || true; } \
    | { grep -Ev '^(\+\+\+|---) ' || true; } \
    | { grep -Ev "^\+[[:space:]]*(\"version\": \"${version_re}\",?|version = \"${version_re}\")$" || true; } \
    | { grep -Ev '^-[[:space:]]*("version": "[0-9]+\.[0-9]+\.[0-9]+",?|version = "[0-9]+\.[0-9]+\.[0-9]+")$' || true; })"
  [ -z "$extra" ]
}

if [ "$ALLOW_DIRTY" -ne 1 ]; then
  # タグの HEAD_SHA（と tag の名前の版）から作り直せない中身を配らない
  if ! only_version_changes; then
    log "error: working tree が dirty です（版の 5 ファイルの版の行のほかにも変更があります）。--allow-dirty を付けるか commit してください。"
    git -C "$REPO_ROOT" status --short >&2
    exit 1
  fi
fi

# 版が下がらないこと（公開済みの docs-v* の最大より大きい）。fetch しない（ls-remote）。同じ tag（同じ版・同じ HEAD）が既にあるときは
# asset の上書きとして通す。それ以外で最大以下なら止める（手元で床の版を公開して、ダウンロードの欄に古い版が出るのを防ぐ）
REMOTE_TAGS="$(git -C "$REPO_ROOT" ls-remote --tags origin 'refs/tags/docs-v*')" || {
  log "error: origin の docs-v* の tag を取得できません。ネットワークを確認してから再実行してください。"
  exit 1
}
remote_tag_exists() {
  printf '%s\n' "$REMOTE_TAGS" | awk -v ref="refs/tags/$1" '$2 == ref || $2 == ref "^{}" { found = 1 } END { exit !found }'
}
if remote_tag_exists "$TAG"; then
  log "${TAG} は既にあります — asset の上書きとして続けます"
else
  NEXT_VERSION="$(printf '%s\n' "$REMOTE_TAGS" | node "${SCRIPTS_DIR}/docs-version.mjs" next)"
  if [ "$NEXT_VERSION" != "$VERSION" ]; then
    log "error: ${VERSION} は公開済みの最大（$(printf '%s\n' "$REMOTE_TAGS" | node "${SCRIPTS_DIR}/docs-version.mjs" latest)）以下です。"
    log "       次の版は ${NEXT_VERSION} です: node apps/docs/scripts/docs-version.mjs apply ${NEXT_VERSION}（作業場だけ。commit しない）→ build-dmg.sh → publish-dmg.sh"
    exit 1
  fi
fi
# 前の公開（この tag を除いて semver が最大の tag）。notes に compare の URL を載せ、どの PR が入ったかを見られるようにする
PREVIOUS_TAG="$(printf '%s\n' "$REMOTE_TAGS" | awk -v ref="refs/tags/${TAG}" '$2 != ref && $2 != ref "^{}"' \
  | node "${SCRIPTS_DIR}/docs-version.mjs" latest)"

if [ "$ALLOW_NON_MAIN" -ne 1 ]; then
  # fetch しない（CI の浅い checkout でも同じに判定できるよう、main の先端は ls-remote、包含は GitHub の compare API で見る。
  # HEAD が push されていなければ compare が 404 になる）。
  ORIGIN_MAIN_SHA="$(git -C "$REPO_ROOT" ls-remote origin refs/heads/main | awk '{ print $1 }')"
  if [ -z "$ORIGIN_MAIN_SHA" ]; then
    log "error: origin/main を取得できません。ネットワークを確認してから再実行してください。"
    exit 1
  fi
  MAIN_STATUS="$(gh api "repos/${REPO_SLUG}/compare/${HEAD_SHA}...${ORIGIN_MAIN_SHA}" --jq .status 2>/dev/null || true)"
  case "$MAIN_STATUS" in
    identical|ahead) ;;
    *)
      log "error: HEAD (${SHORT_SHA}) は origin/main ($(printf '%s' "$ORIGIN_MAIN_SHA" | cut -c1-12)) に含まれていません（compare: ${MAIN_STATUS:-取得できない}）。"
      log "       配布は merge 済み main の commit から作ってください。意図的なら --allow-non-main を付けてください。"
      exit 1
      ;;
  esac
fi

DMG_PATH="${OUT_DIR}/NIHO-docs-${VERSION}-${SHORT_SHA}.dmg"
UPDATER_TARBALL="${OUT_DIR}/NIHO-docs-${VERSION}-${SHORT_SHA}.app.tar.gz"
UPDATER_SIG="${UPDATER_TARBALL}.sig"
if [ ! -f "$DMG_PATH" ]; then
  log "error: この版と commit の dmg がありません: ${DMG_PATH}"
  OTHER_DMGS="$(find "$OUT_DIR" -maxdepth 1 -name 'NIHO-docs-*.dmg' -type f 2>/dev/null | sort || true)"
  if [ -n "$OTHER_DMGS" ]; then
    log "       release/ には別の版・commit の dmg があります:"
    printf '%s\n' "$OTHER_DMGS" | sed 's/^/         - /' >&2
  fi
  log "       ./apps/docs/scripts/build-dmg.sh を（この commit で）実行してください。"
  exit 1
fi

UPLOAD_ASSETS=("$DMG_PATH")
if [ -f "$UPDATER_TARBALL" ] && [ -f "$UPDATER_SIG" ]; then
  KEY_STATUS=0
  node "${SCRIPTS_DIR}/updater-key.mjs" status >/dev/null 2>&1 || KEY_STATUS=$?
  if [ "$KEY_STATUS" -eq 0 ]; then
    node "${SCRIPTS_DIR}/updater-key.mjs" verify --file "$UPDATER_TARBALL" --sig "$UPDATER_SIG"
  elif [ "$DRY_RUN" -eq 1 ]; then
    log "dry-run: tauri.conf.json の updater の pubkey が未設定なので、署名は確かめません"
  else
    node "${SCRIPTS_DIR}/updater-key.mjs" status
    exit 1
  fi
  UPLOAD_ASSETS+=("$UPDATER_TARBALL" "$UPDATER_SIG")
elif [ "$DRY_RUN" -eq 1 ]; then
  log "dry-run: 自動更新の成果物（.app.tar.gz・.sig）がありません（署名鍵なしのビルド）"
else
  log "error: 自動更新の成果物がありません: ${UPDATER_TARBALL}（+ .sig）"
  log "       署名鍵（TAURI_SIGNING_PRIVATE_KEY か ~/.niho/docs-updater.key）を置いて build-dmg.sh をやり直してください。"
  log "       自動更新の無い Release は配りません（各 Mac が次の版に上がれない）。"
  exit 1
fi

SHA_PATH="${DMG_PATH}.sha256"
shasum -a 256 "$DMG_PATH" | awk '{ print $1 }' >"$SHA_PATH"
SHA256_HEX="$(cat "$SHA_PATH")"
DMG_SIZE_BYTES="$(stat -f%z "$DMG_PATH" 2>/dev/null || stat -c%s "$DMG_PATH")"
DMG_SIZE_MB="$(awk -v b="$DMG_SIZE_BYTES" 'BEGIN { printf "%.1f", b/1048576 }')"
UPLOAD_ASSETS+=("$SHA_PATH")
log "build artifact:"
log "  dmg     : ${DMG_PATH}（${DMG_SIZE_MB} MiB）"
log "  version : ${VERSION}"
log "  tag     : ${TAG}"
log "  previous: ${PREVIOUS_TAG:-（初めての公開）}"
log "  sha256  : ${SHA256_HEX}"
log "  assets  : $(for asset in "${UPLOAD_ASSETS[@]}"; do printf '%s ' "$(basename "$asset")"; done)"

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry-run: GitHub Release への作成・upload はしません"
  exit 0
fi

NOTES_FILE="$(mktemp "${TMPDIR:-/tmp}/niho-docs-release-notes.XXXXXX")"
trap 'rm -f "$NOTES_FILE"' EXIT
cat >"$NOTES_FILE" <<EOF
NIHO docs（Apple Silicon の Mac・未公証）の配布 .dmg と自動更新の成果物。

- version: \`${VERSION}\`
- built from commit: \`${HEAD_SHA}\`
- dmg: \`$(basename "$DMG_PATH")\`（${DMG_SIZE_MB} MiB）
- sha-256: \`${SHA256_HEX}\`
EOF
if [ -n "$PREVIOUS_TAG" ]; then
  # tag の名前の版は main の 5 か所の版（床）と違うので、入った PR は tag どうしの compare で見る
  printf -- '- 前の公開（%s）からの変更: https://github.com/%s/compare/%s...%s\n' \
    "$PREVIOUS_TAG" "$REPO_SLUG" "$PREVIOUS_TAG" "$TAG" >>"$NOTES_FILE"
fi
cat >>"$NOTES_FILE" <<'EOF'

入れ方は apps/docs/README.md「配布」。未公証なので、ブラウザで落とした dmg の初回だけ
システム設定 →「プライバシーとセキュリティ」→「このまま開く」で許可が要ります。
入れた後は https://niho.life/docs/updater/latest.json を見て、次の起動で自動更新します。
EOF

if gh release view "$TAG" --repo "$REPO_SLUG" >/dev/null 2>&1; then
  log "release ${TAG} はあります — asset を上書きします"
else
  log "creating release ${TAG}"
  gh release create "$TAG" \
    --repo "$REPO_SLUG" \
    --target "$HEAD_SHA" \
    --title "NIHO docs ${VERSION} (${SHORT_SHA})" \
    --notes-file "$NOTES_FILE" \
    --prerelease
fi

log "uploading assets"
gh release upload "$TAG" --repo "$REPO_SLUG" --clobber "${UPLOAD_ASSETS[@]}"

log ""
log "done. release URL:"
gh release view "$TAG" --repo "$REPO_SLUG" --json url --template '{{.url}}{{"\n"}}'
log "自動更新は /docs/updater/latest.json が新しい Release を拾い、各 Mac の NIHO docs が次の起動で適用します。"
