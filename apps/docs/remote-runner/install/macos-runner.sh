#!/bin/bash
# 共有 Mac（R3 #18628）に文字起こし runner を固定 release で入れ、launchd の LaunchDaemon で常設する。
# 手順と判断は ops/runbooks/niho-docs-remote-transcription-runner.md。秘密は表示・引数・plist に出さない。
#
#   stage   <git-sha> <out-dir>                     （一般ユーザー）main の固定 SHA から release を組み立てる
#   install <stg|prod> <release-dir> <runner-id> <ja|ja,en>   （sudo）release・設定・credential・モデル・plist を置く
#   start   <stg|prod>                              （sudo）登録の後に常設を始める（読み込み済みなら外して plist を読み込み直す）
#   stop    <stg|prod>                              （sudo）止め、次の起動でも動かないようにする
#   status  <stg|prod>                              （sudo）launchd の状態と診断ログの末尾
set -euo pipefail
umask 077

SERVICE_USER="niho-docs-runner"
SERVICE_HOME="/Users/${SERVICE_USER}"
RELEASE_ROOT="/usr/local/niho-docs-runner"
# 診断ログは root 所有の領域に置く（専用ユーザーの領域に置くと、launchd や status が root として開くときに、差し替えられた symlink をたどる）。
LOG_ROOT="/Library/Logs/niho-docs-runner"
NODE_BIN="/opt/homebrew/opt/node@24/bin/node"

die() { echo "error: $*" >&2; exit 1; }
need_root() { [[ "${EUID}" -eq 0 ]] || die "sudo で実行してください"; }
check_env() { [[ "${1:-}" == "stg" || "${1:-}" == "prod" ]] || die "環境は stg か prod"; }
label_of() { echo "life.niho.docs-runner.$1"; }
plist_of() { echo "/Library/LaunchDaemons/$(label_of "$1").plist"; }
# 専用ユーザーで、最小の環境・読める cwd から実行する（呼び出し元の Documents へは入れない）。
as_runner() { (cd / && sudo -u "${SERVICE_USER}" /usr/bin/env -i HOME="${SERVICE_HOME}" PATH=/usr/bin:/bin LANG=en_US.UTF-8 "$@"); }

# 専用ユーザーの領域（SERVICE_HOME 以下）の作成・書き込みは、必ず専用ユーザーとして行う。root で install -d・cat・mv をすると、侵害された
# runner が stg や config を root 所有の領域への symlink に差し替えておくだけで、次の install で root がその先の owner・mode を変え、
# ファイルを書いてしまう（権限昇格）。専用ユーザーとして行えば、symlink をたどっても専用ユーザーが元から書ける範囲を出ない。
# 親から順に呼ぶこと（mkdir -m は末端の mode だけを決める）。
private_dir() {
  as_runner /bin/mkdir -p -m 0700 "$1"
  as_runner /bin/chmod 0700 "$1"
  as_runner /bin/chmod -N "$1" 2>/dev/null || true
}

# 診断ログ。ディレクトリは root 所有（専用ユーザーは中のファイルを差し替えられない）、ファイルは専用ユーザー所有の 0600。
# 既にあるログは消さない。
prepare_logs() {
  local dir="${LOG_ROOT}/$1" name
  install -d -o root -g wheel -m 0755 "${LOG_ROOT}" "${dir}"
  for name in runner.log runner.err.log; do
    [[ ! -L "${dir}/${name}" ]] || die "${dir}/${name} が symlink です"
    [[ -e "${dir}/${name}" ]] || install -o "${SERVICE_USER}" -g staff -m 0600 /dev/null "${dir}/${name}"
  done
}

cmd_stage() {
  local sha="${1:-}" out="${2:-}"
  [[ "${sha}" =~ ^[0-9a-f]{40}$ ]] || die "40 桁の SHA を指定してください"
  [[ -n "${out}" && "${out}" == /* ]] || die "出力先は絶対パス"
  [[ ! -e "${out}" ]] || die "出力先が既にあります: ${out}"
  local repo src
  repo="$(git rev-parse --show-toplevel)"
  git -C "${repo}" merge-base --is-ancestor "${sha}" origin/main || die "${sha} は origin/main にありません"
  src="$(mktemp -d)"
  git -C "${repo}" archive "${sha}" apps/docs/sidecar apps/docs/remote-runner packages/apple-speech scripts/dev/docs-runner-credential.mjs | tar -x -C "${src}"
  swift build -c release --package-path "${src}/apps/docs/sidecar/niho-speech"
  local build="${src}/apps/docs/sidecar/niho-speech/.build/release"
  mkdir -p "${out}/bin" "${out}/apps/docs/remote-runner" "${out}/scripts/dev"
  echo "${sha}" > "${out}/RELEASE"
  cp "${src}/apps/docs/remote-runner/"*.mjs "${src}/apps/docs/remote-runner/package.json" "${out}/apps/docs/remote-runner/"
  cp "${src}/scripts/dev/docs-runner-credential.mjs" "${out}/scripts/dev/"
  # 話者分離モデルの manifest などの bundle は実行ファイルと同じ場所から探される。
  ditto "${build}/niho-speech" "${out}/bin/niho-speech"
  local bundle
  for bundle in "${build}"/*.bundle; do ditto "${bundle}" "${out}/bin/$(basename "${bundle}")"; done
  chmod -R a+rX,go-w "${out}"
  rm -rf "${src}"
  "${out}/bin/niho-speech" version
  echo "staged: ${out}"
}

cmd_install() {
  need_root
  local env="${1:-}" release="${2:-}" runner_id="${3:-}" languages="${4:-}"
  check_env "${env}"
  [[ -n "${release}" && -f "${release}/RELEASE" ]] || die "release directory が見つかりません"
  [[ "${runner_id}" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || die "runner ID が不正です"
  [[ "${languages}" == "ja" || "${languages}" == "ja,en" ]] || die "言語は ja か ja,en"
  local sha
  sha="$(tr -d '[:space:]' < "${release}/RELEASE")"
  [[ "${sha}" =~ ^[0-9a-f]{40}$ ]] || die "RELEASE が不正です"
  for f in apps/docs/remote-runner/cli.mjs scripts/dev/docs-runner-credential.mjs bin/niho-speech; do
    [[ -f "${release}/${f}" ]] || die "release に ${f} がありません"
  done
  dscl . -read "/Users/${SERVICE_USER}" UniqueID >/dev/null 2>&1 || die "専用ユーザー ${SERVICE_USER} がありません（runbook の手順で先に作る）"
  [[ -x "${NODE_BIN}" ]] || die "${NODE_BIN} がありません"
  [[ "$("${NODE_BIN}" --version)" == v24.* ]] || die "Node 24 が必要です"

  # 1. 固定 release（root 所有・書き込み不可）。同じ SHA で中身が違えば退避してから置き直す。
  local dest="${RELEASE_ROOT}/${env}/${sha}"
  install -d -o root -g wheel -m 0755 "${RELEASE_ROOT}" "${RELEASE_ROOT}/${env}"
  if [[ -e "${dest}" ]] && ! diff -rq "${release}" "${dest}" >/dev/null 2>&1; then
    mv "${dest}" "${dest}.replaced-$(date +%Y%m%d%H%M%S)"
  fi
  if [[ ! -e "${dest}" ]]; then
    ditto "${release}" "${dest}"
    chown -R root:wheel "${dest}"
    chmod -R a+rX,go-w "${dest}"
  fi
  echo "release: ${dest}"

  # 2. 専用ユーザーだけが入れる設定・credential・作業の領域（0700・ACL なし）と、root 所有の診断ログ。
  local base="${SERVICE_HOME}/${env}"
  private_dir "${base}"
  private_dir "${base}/config"
  private_dir "${base}/credentials"
  private_dir "${base}/work"
  prepare_logs "${env}"

  # 3. credential は実行機で作り、秘密はファイルに残す。表示するのは ADMIN が登録に使う fingerprint だけ。
  local credential="${base}/credentials/runner.json" action="create"
  [[ -e "${credential}" ]] && action="fingerprint"
  echo "credential fingerprint（登録に使う）:"
  as_runner "${NODE_BIN}" "${dest}/scripts/dev/docs-runner-credential.mjs" "${action}" "${credential}" "${runner_id}" \
    || die "credential を作れませんでした（既存の credential の runner ID が違う場合は stop してから別名で入れる）"

  # 4. 言語モデル（runner は自分で取得しない）。足りない言語だけ明示的に取得する。
  local language probe
  local -a language_list
  IFS=',' read -r -a language_list <<< "${languages}"
  for language in "${language_list[@]}"; do
    probe="$(as_runner "${dest}/bin/niho-speech" probe --language "${language}" || true)"
    if [[ "${probe}" != *'"available":true'* || "${probe}" != *'"needsDownload":false'* ]]; then
      echo "model ${language}: downloading"
      as_runner "${dest}/bin/niho-speech" download --language "${language}" | tail -n 1
      probe="$(as_runner "${dest}/bin/niho-speech" probe --language "${language}" || true)"
    fi
    [[ "${probe}" == *'"available":true'* && "${probe}" == *'"needsDownload":false'* ]] || die "model ${language} を用意できませんでした: ${probe}"
    echo "model ${language}: ready"
  done

  # 5. 設定（0600）。API の宛先は runner が environment から固定する。
  local config="${base}/config/runner.json" langs_json config_json
  langs_json="$(printf '"%s",' "${language_list[@]}")"
  langs_json="[${langs_json%,}]"
  config_json="{\"environment\":\"${env}\",\"runnerId\":\"${runner_id}\",\"sidecarPath\":\"${dest}/bin/niho-speech\",\"workRoot\":\"${base}/work\",\"languages\":${langs_json}}"
  # 専用ユーザーとして、一時ファイルに書いて置き換える（root で書くと、差し替えられた symlink の先に書いてしまう）
  # shellcheck disable=SC2016 # $1 と $$ は内側の sh が展開する（ここでは展開しない）
  printf '%s\n' "${config_json}" | as_runner /bin/sh -c 'set -e; umask 077; tmp="$1.tmp.$$"; cat > "$tmp"; chmod 0600 "$tmp"; chmod -N "$tmp" 2>/dev/null || true; mv -f "$tmp" "$1"' sh "${config}"

  # 6. LaunchDaemon（秘密なし・固定 PATH）。ここでは起動しない（登録してから start）。
  local plist tmp_plist
  plist="$(plist_of "${env}")"
  tmp_plist="$(mktemp)"
  cat > "${tmp_plist}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(label_of "${env}")</string>
  <key>UserName</key><string>${SERVICE_USER}</string>
  <key>GroupName</key><string>staff</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${dest}/apps/docs/remote-runner/cli.mjs</string>
    <string>--config</string><string>${config}</string>
    <string>--credential</string><string>${credential}</string>
  </array>
  <key>WorkingDirectory</key><string>${base}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin</string>
    <key>HOME</key><string>${SERVICE_HOME}</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>Umask</key><integer>63</integer>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string>${LOG_ROOT}/${env}/runner.log</string>
  <key>StandardErrorPath</key><string>${LOG_ROOT}/${env}/runner.err.log</string>
</dict>
</plist>
PLIST
  plutil -lint "${tmp_plist}" >/dev/null
  install -o root -g wheel -m 0644 "${tmp_plist}" "${plist}"
  rm -f "${tmp_plist}"
  echo "plist: ${plist}"
  echo "次: fingerprint を登録（ops:docs-runner-register）してから sudo $0 start ${env}"
}

cmd_start() {
  need_root
  local env="${1:-}"
  check_env "${env}"
  local label plist
  label="$(label_of "${env}")"
  plist="$(plist_of "${env}")"
  [[ -f "${plist}" ]] || die "先に install してください"
  launchctl enable "system/${label}"
  # 読み込み済みなら、いったん外して新しい plist を読み込み直す。kickstart -k は読み込み済みの旧い定義（旧 release の cli.mjs）のまま
  # 再起動するだけで、install が書いた新しい ProgramArguments は使われない。
  if launchctl print "system/${label}" >/dev/null 2>&1; then
    launchctl bootout "system/${label}" 2>/dev/null || true
    local waited=0
    while launchctl print "system/${label}" >/dev/null 2>&1; do
      (( waited += 1 ))
      (( waited <= 30 )) || die "${label} を外せませんでした（launchctl print で状態を確かめる）"
      sleep 1
    done
  fi
  launchctl bootstrap system "${plist}"
  sleep 5
  cmd_status "${env}"
}

cmd_stop() {
  need_root
  local env="${1:-}"
  check_env "${env}"
  local label
  label="$(label_of "${env}")"
  launchctl bootout "system/${label}" 2>/dev/null || true
  launchctl disable "system/${label}"
  echo "stopped: ${label}"
}

cmd_status() {
  need_root
  local env="${1:-}"
  check_env "${env}"
  local label
  label="$(label_of "${env}")"
  launchctl print "system/${label}" 2>/dev/null | grep -E '^\s*(state|pid|last exit code|runs) =' || echo "not loaded: ${label}"
  # 診断ログは固定 event/code だけ（本文・URL・秘密は出ない）。
  tail -n 5 "${LOG_ROOT}/${env}/runner.log" 2>/dev/null || true
  tail -n 5 "${LOG_ROOT}/${env}/runner.err.log" 2>/dev/null || true
}

case "${1:-}" in
  stage) shift; cmd_stage "$@" ;;
  install) shift; cmd_install "$@" ;;
  start) shift; cmd_start "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  status) shift; cmd_status "$@" ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
