#!/bin/bash
#
# ci-docs-release.sh — docs-release.yml の中身（S4 #18385・#18744。NIHO Desktop の ci-desktop-release.sh の写しから始まった）
# ============================================================================
#
# PR では版を触らない。main に入ると plan が公開済みの tag（docs-v<版>-<sha12>）から次の版を採番し、publish が作業場の 5 か所を
# その版に書き換えて（docs-version.mjs apply。main には commit しない。公開した版は tag の名前に残る）ビルドして公開する。
# 次の版は max(main の 5 か所の版＝床, 公開済みの最大の patch + 1)。
#
#   plan     公開するかと版を決め、version と publish を GITHUB_OUTPUT に書く（ubuntu で動く）。
#            - 自動更新の公開鍵（tauri.conf.json の plugins.updater.pubkey）がプレースホルダーなら公開しない
#              （自動更新の無い版を配ると、その Mac は次の版に上がれない）。
#            - docs-v* の tag が無い → 公開する（版は床）。
#            - semver が最大の tag の Release に asset がそろっている → その commit から HEAD までに出荷対象が変わっていれば
#              次の版で公開し、変わっていなければ公開しない（workflow_dispatch なら更新フィードがその版を返すかだけ確かめる）。
#            - 最大の tag の asset がそろっていない（途中で落ちた公開）→ その番号は使い回さず、次の版で公開する。
#            - 公開すると決めたときだけ、公開前の前提（apps/docs/release-requirements.json。main のコードが前提にする本番の
#              サーバーの設定）を release-requirements.mjs check で確かめる。enforce: true の項目が満たされない・確かめられない
#              ときは publish=false にして run を赤にする（main のコードは入ったまま、配るのだけ待つ）。
#   publish  plan の version（env NIHO_DOCS_RELEASE_VERSION）が公開済みの最大より大きいことを確かめ、作業場の 5 か所をその版に
#            書き換えて、Environment docs-release の署名鍵（TAURI_SIGNING_PRIVATE_KEY）で build-dmg.sh を通し（sidecar の同梱と
#            照合・dmg・署名付きの updater の成果物・公開鍵での署名の確認・Info.plist の版）、publish-dmg.sh で Release に上げ、
#            更新フィード（https://niho.life/docs/updater/latest.json）が新しい版を返すまで確かめる（macOS で動く）。
#   dry-run  plan と同じく次の版を求め（読むだけ）、作業場の 5 か所をその版に書き換えてから、publish と同じビルドを使い捨ての
#            署名鍵で行う（署名はその公開鍵で確かめる）。公開しない（PR で workflow・scripts・sidecar の lock を変えたとき）。
#
# 必要な env: GH_TOKEN（Release の読み書き）。publish は NIHO_DOCS_RELEASE_VERSION と TAURI_SIGNING_PRIVATE_KEY（と _PASSWORD）も。
# NIHO_DOCS_RELEASE_REQUIREMENTS_FILE を渡すと、公開前の前提をそのファイルで確かめる（手元の試験用。既定は
# apps/docs/release-requirements.json）。
#
set -euo pipefail

MODE="${1:-}"
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
DOCS_DIR="${REPO_ROOT}/apps/docs"
SCRIPTS_DIR="${DOCS_DIR}/scripts"
REPO_SLUG="${GITHUB_REPOSITORY:-niho-coliving/niho-app}"
# apps/docs/src-tauri/tauri.conf.json の plugins.updater.endpoints と同じ（updater.rs のテストが tauri.conf.json 側を確かめる）
UPDATER_FEED_URL="https://niho.life/docs/updater/latest.json"
REQUIREMENTS_FILE="${NIHO_DOCS_RELEASE_REQUIREMENTS_FILE:-${DOCS_DIR}/release-requirements.json}"

log() { printf '%s\n' "$*" >&2; }
summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >>"$GITHUB_STEP_SUMMARY"; fi; }

node "${SCRIPTS_DIR}/docs-version.mjs" check
# 床（main の 5 か所の版）。公開・ビルドする版は、publish・dry-run が apply したあとで VERSION に入れ直す
FLOOR="$(node "${SCRIPTS_DIR}/docs-version.mjs" current)"
VERSION="$FLOOR"
# 公開済みの docs-v* の tag（ls-remote の行）。fetch しない（CI の浅い clone でも同じに見える）。モードの最初に 1 回だけ読む
REMOTE_TAGS=""

load_remote_tags() {
  REMOTE_TAGS="$(git -C "$REPO_ROOT" ls-remote --tags origin 'refs/tags/docs-v*')"
}

next_version() { printf '%s\n' "$REMOTE_TAGS" | node "${SCRIPTS_DIR}/docs-version.mjs" next; }
latest_tag() { printf '%s\n' "$REMOTE_TAGS" | node "${SCRIPTS_DIR}/docs-version.mjs" latest; }

# REMOTE_TAGS に refs/tags/<tag> があるか（grep -q だと pipefail で前段の SIGPIPE を拾うので awk で全部読む）
remote_tag_exists() {
  printf '%s\n' "$REMOTE_TAGS" | awk -v ref="refs/tags/$1" '$2 == ref || $2 == ref "^{}" { found = 1 } END { exit !found }'
}

# Release の asset 名（標準入力）に、その版（$1）の dmg・dmg の .sha256・updater の .app.tar.gz・.sig の 4 つがそろっているか。
# publish-dmg.sh は 4 つを 1 回の gh release upload で並行に上げるので、途中で落ちると一部だけが載る。
# 一部だけの Release を「公開済み」とみなすと、その版の中身が届かないまま次へ進む（README が約束する checksum も戻せない）。
release_assets_complete() {
  local names version_re
  names="$(cat)"
  version_re="${1//./\\.}"
  grep -q "^NIHO-docs-${version_re}-.*\.dmg$" <<<"$names" &&
    grep -q "^NIHO-docs-${version_re}-.*\.dmg\.sha256$" <<<"$names" &&
    grep -q "^NIHO-docs-${version_re}-.*\.app\.tar\.gz$" <<<"$names" &&
    grep -q "^NIHO-docs-${version_re}-.*\.app\.tar\.gz\.sig$" <<<"$names"
}

# tag（$1）の Release の asset 名。Release が無ければ何も出さない。読めない（認証・rate limit など）ときは止める
# （公開済みを未公開と取り違えて、同じ中身を次の番号で出し直さない）。
release_asset_names() {
  local tag="$1" out err status=0
  err="$(mktemp)"
  out="$(gh release view "$tag" --repo "$REPO_SLUG" --json assets --jq '.assets[].name' 2>"$err")" || status=$?
  if [ "$status" -ne 0 ]; then
    if grep -qi 'release not found' "$err"; then
      rm -f "$err"
      return 0
    fi
    log "::error title=Release を読めません::${tag}（gh release view の終了コード ${status}）: $(tr '\n' ' ' <"$err")"
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  printf '%s\n' "$out"
}

# 公開済み（dmg・.sha256・.app.tar.gz・.sig がそろっている）docs-v<$1>-<$2> の tag を 1 つ返す。無ければ空。Release を読めなければ止める。
# $2 は commit の短い sha（省略すると任意の commit）。
published_tag() {
  local version="$1" sha_re="${2:-[0-9a-f]+}" version_re tag names
  version_re="${version//./\\.}"
  for tag in $(printf '%s\n' "$REMOTE_TAGS" | awk '{ print $2 }' | sed -e 's#^refs/tags/##' -e 's#\^{}$##' \
    | { grep -E "^docs-v${version_re}-${sha_re}$" || true; } | sort -u); do
    names="$(release_asset_names "$tag")" || exit 1
    if release_assets_complete "$version" <<<"$names"; then
      printf '%s\n' "$tag"
      return 0
    fi
  done
}

# 自動更新の公開鍵: 0 = 設定済み / 4 = プレースホルダー（配布しない）。壊れた値（1）は止める。
pubkey_status() {
  local status=0
  node "${SCRIPTS_DIR}/updater-key.mjs" status >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 0 ] && [ "$status" -ne 4 ]; then
    node "${SCRIPTS_DIR}/updater-key.mjs" status || true
    log "::error title=自動更新の公開鍵が壊れています::apps/docs/src-tauri/tauri.conf.json の plugins.updater.pubkey を tauri signer generate の .pub の中身にしてください。"
    exit 1
  fi
  return "$status"
}

# tag（$1）の commit から HEAD までに変わった出荷対象のファイル
shipped_changed_since() {
  local tag="$1" tag_sha
  # 注釈付きタグなら ^{} の commit、軽量タグ（publish-dmg.sh の gh release create）ならそのまま
  tag_sha="$(printf '%s\n' "$REMOTE_TAGS" | awk -v ref="refs/tags/${tag}" \
    '$2 == ref "^{}" { peeled = $1 } $2 == ref { plain = $1 } END { print (peeled != "" ? peeled : plain) }')"
  if [ -z "$tag_sha" ]; then
    log "::error title=tag の commit が分かりません::${tag} が ls-remote にありません。"
    exit 1
  fi
  # 手元の完全な clone で --depth=1 を付けると、その commit が shallow の境界として書き込まれ、
  # 履歴がそこで切れる（worktree 全部に効く）。無いときだけ取り、--depth は CI の浅い clone だけで付ける。
  if ! git -C "$REPO_ROOT" cat-file -e "${tag_sha}^{commit}" 2>/dev/null; then
    if [ "$(git -C "$REPO_ROOT" rev-parse --is-shallow-repository)" = "true" ]; then
      git -C "$REPO_ROOT" fetch --quiet --depth=1 origin "$tag_sha"
    else
      git -C "$REPO_ROOT" fetch --quiet origin "$tag_sha"
    fi
  fi
  node "${SCRIPTS_DIR}/docs-version.mjs" shipped-changed --from "$tag_sha" --to HEAD
}

write_plan_outputs() {
  log "version=$1 publish=$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'version=%s\npublish=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
  fi
}

# 公開前の前提（release-requirements.json）。満たされなければ publish=false を書いて run を赤にする
check_release_requirements() {
  local version="$1" status=0
  node "${SCRIPTS_DIR}/release-requirements.mjs" check --file "$REQUIREMENTS_FILE" || status=$?
  [ "$status" -eq 0 ] && return 0
  if [ "$status" -eq 1 ]; then
    log "NIHO docs ${version} は公開しません（公開前の前提を満たしていない）。summary の「どうすれば」をそろえてから gh workflow run docs-release.yml --ref main"
    summary "**NIHO docs ${version} は公開しません**（公開前の前提を満たしていない）。main のコードは入ったままです。上の「どうすれば」をそろえてから \`gh workflow run docs-release.yml --ref main\` でやり直すと公開されます。"
  else
    log "::error title=公開前の前提を確かめられません::${REQUIREMENTS_FILE#"${REPO_ROOT}/"} の形か release-requirements.mjs の使い方が誤っています（終了コード ${status}）。"
    summary "**NIHO docs ${version} は公開しません**（公開前の前提のファイル \`${REQUIREMENTS_FILE#"${REPO_ROOT}/"}\` を読めない・形が誤っている）。"
  fi
  write_plan_outputs "$version" false
  exit 1
}

plan() {
  local publish=true key_status=0 version latest latest_version tag changed
  pubkey_status || key_status=$?
  load_remote_tags
  version="$(next_version)"
  latest="$(latest_tag)"
  if [ "$key_status" -eq 4 ]; then
    publish=false
    version="$FLOOR"
    log "::warning title=NIHO docs はまだ公開しません::自動更新の公開鍵（apps/docs/src-tauri/tauri.conf.json の plugins.updater.pubkey）がプレースホルダーのままです。apps/docs/README.md「配布」の手順で鍵を作り、Environment docs-release の secret と pubkey を設定してください。"
    summary "### NIHO docs はまだ公開しません（自動更新の公開鍵が未設定）"
    summary ""
    summary "apps/docs/README.md「配布」の手順で \`tauri signer generate\` の鍵を作り、秘密鍵を Environment \`docs-release\` の secret \`TAURI_SIGNING_PRIVATE_KEY\` に、公開鍵を \`tauri.conf.json\` の \`plugins.updater.pubkey\` に置く PR を main に入れると公開されます。"
  elif [ -z "$latest" ]; then
    summary "NIHO docs はまだ公開されていません。${version} としてビルドして公開します。"
  else
    latest_version="${latest#docs-v}"
    latest_version="${latest_version%-*}"
    tag="$(published_tag "$latest_version")"
    if [ -n "$tag" ]; then
      changed="$(shipped_changed_since "$tag")"
      if [ -z "$changed" ]; then
        publish=false
        version="$latest_version"
        summary "NIHO docs ${latest_version} は公開済み（${tag}）。公開するものはありません。"
        # やり直し（workflow_dispatch）は、公開済みの版でも更新フィードを確かめる。最初の公開で upload は済んだのに feed の確認だけ
        # 落ちた版を、publish job を飛ばして緑で終えない（feed を直してから dispatch すると、ここで新しい版を返すまで待つ）
        if [ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ]; then
          wait_for_feed "$latest_version" "NIHO docs ${latest_version} は公開済み（${tag}）です。"
        fi
      else
        summary "### NIHO docs ${version} の公開"
        summary ""
        summary "${latest_version}（${tag}）のあと、出荷対象が変わりました（公開前の前提を満たせば ${version} として公開します）:"
        summary ""
        summary '```'
        summary "$changed"
        summary '```'
        summary ""
      fi
    else
      log "::warning title=NIHO docs の前の公開が途中で止まっています::${latest} の Release に 4 つの asset（dmg・.sha256・.app.tar.gz・.sig）がそろっていません。その番号は使い回さず、${version} として公開します。"
      summary "NIHO docs ${latest_version}（${latest}）の公開は途中で止まっていました（asset がそろっていない）。番号は使い回さず、${version} としてビルドして公開します。"
    fi
  fi
  if [ "$publish" = true ]; then
    check_release_requirements "$version"
  fi
  write_plan_outputs "$version" "$publish"
}

# 公開する版（VERSION。apply の後）が、公開済みの最大より大きいこと。同じ版・同じ HEAD の tag が既にある（asset が欠けた公開の
# 上げ直し）ときだけ通す。並行の run や手元の公開で番号が先に使われていたら、古い plan の版で上げない
require_new_version() {
  local head_tag next
  head_tag="docs-v${VERSION}-$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
  next="$(next_version)"
  if [ "$next" = "$VERSION" ]; then
    return 0
  fi
  if remote_tag_exists "$head_tag"; then
    log "${head_tag} は既にあります（asset が欠けた公開の上げ直し）"
    return 0
  fi
  log "::error title=NIHO docs ${VERSION} は公開済みの版以下です::公開済みの最大は $(latest_tag) です。docs-release.yml をやり直してください（gh workflow run docs-release.yml --ref main。plan が次の版 ${next} を採番します）。"
  exit 1
}

build() {
  local work="${RUNNER_TEMP:-$(mktemp -d)}/niho-docs-release"
  rm -rf "$work"
  mkdir -p "$work"

  # 署名鍵。dry-run は使い捨ての鍵で署名し、その公開鍵で確かめる（build-dmg.sh の NIHO_DOCS_UPDATER_PUBKEY）
  if [ "$MODE" = "dry-run" ]; then
    npm -C "$DOCS_DIR" exec -- tauri signer generate --ci -w "${work}/ephemeral.key" >/dev/null
    export TAURI_SIGNING_PRIVATE_KEY="${work}/ephemeral.key"
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
    NIHO_DOCS_UPDATER_PUBKEY="$(cat "${work}/ephemeral.key.pub")"
    export NIHO_DOCS_UPDATER_PUBKEY
  else
    unset NIHO_DOCS_UPDATER_PUBKEY
    if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
      log "::error title=署名鍵がありません::Environment docs-release の secret TAURI_SIGNING_PRIVATE_KEY を登録してください（apps/docs/README.md「配布」）。"
      exit 1
    fi
  fi

  "${SCRIPTS_DIR}/build-dmg.sh"
}

# 更新フィードがその版（$1）を返すまで待つ（最大 5 分）。返さなければ赤にする（公開したのに届かない状態を緑で終えない）。
wait_for_feed() {
  local version="$1" done_message="$2" attempt feed
  for attempt in $(seq 1 20); do
    feed="$(curl -fsS --max-time 15 "${UPDATER_FEED_URL}?t=$(date +%s)" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version??"")}catch{console.log("")}})' || true)"
    if [ "$feed" = "$version" ]; then
      log "更新フィードが ${version} を返しました（${attempt} 回目）"
      summary "${done_message} 更新フィードも ${version} です（各 Mac は次の起動で更新）。"
      return 0
    fi
    sleep 15
  done
  log "::error title=更新フィードが新しい版になりません::${UPDATER_FEED_URL} が ${version} を返しません（最後: ${feed:-取得できない}）。Web に /docs/updater/latest.json が配備済みか、DESKTOP_RELEASE_GH_TOKEN と Release の asset を確認してください。"
  exit 1
}

case "$MODE" in
  plan)
    plan
    ;;
  dry-run)
    # PR の dry-run も、main で公開するときと同じく採番した版を作業場に書き換えてからビルドする（apply → tauri build →
    # build-dmg.sh の Info.plist の版の照合まで通ることを確かめる。読むだけで、tag も Release も作らない）
    load_remote_tags
    VERSION="$(next_version)"
    node "${SCRIPTS_DIR}/docs-version.mjs" apply "$VERSION"
    build
    log "dry-run: 公開しません"
    summary "dry-run: NIHO docs ${VERSION}（次に公開する版を作業場だけに書き換え）をビルドしました（niho-speech 同梱・使い捨ての鍵で署名と検証・公開しない）。"
    ;;
  publish)
    if pubkey_status; then :; else
      log "::error title=自動更新の公開鍵が未設定::プレースホルダーのままでは公開しません（plan が publish=false にするはず）。"
      exit 1
    fi
    RELEASE_VERSION="${NIHO_DOCS_RELEASE_VERSION:-}"
    if [ -z "$RELEASE_VERSION" ]; then
      log "::error title=公開する版がありません::env NIHO_DOCS_RELEASE_VERSION（plan の version）を渡してください。"
      exit 2
    fi
    load_remote_tags
    # 「公開済み」として何もせず成功にするのは、同じ版を今の HEAD で公開したときだけ（再試行）。plan のあとに別の commit が同じ版を
    # 使っていたら、ここで成功にせず require_new_version で赤にして再採番させる（今回の出荷変更を未公開のまま緑で終えない）
    TAG="$(published_tag "$RELEASE_VERSION" "$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)")"
    if [ -n "$TAG" ]; then
      log "${RELEASE_VERSION} はもう公開されています（${TAG}）。更新フィードだけ確かめます"
      wait_for_feed "$RELEASE_VERSION" "NIHO docs ${RELEASE_VERSION} は公開済みです（何もしませんでした）。"
      exit 0
    fi
    # 作業場の 5 か所だけを書き換える（commit しない。publish-dmg.sh は版の 5 ファイルの版の行だけの変更を clean と見なす）
    node "${SCRIPTS_DIR}/docs-version.mjs" apply "$RELEASE_VERSION"
    VERSION="$RELEASE_VERSION"
    require_new_version
    build
    "${SCRIPTS_DIR}/publish-dmg.sh"
    wait_for_feed "$VERSION" "NIHO docs ${VERSION} を公開しました。"
    ;;
  *)
    log "使い方: ci-docs-release.sh <plan|publish|dry-run>"
    exit 2
    ;;
esac
