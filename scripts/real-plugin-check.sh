#!/usr/bin/env bash
# scripts/real-plugin-check.sh — 在真实 DSH 进程里验证插件（不进你的 web profile）。
#
# 做法：把 web profile **整目录复制**成一次性的 rotationtest（拿到与当前 dsh 版本匹配的
# 基础 bundle），再把本仓库的 tgz 装进去 —— 这样既不碰你的日常 profile，又能在真宿主里跑。
#
#   ./scripts/real-plugin-check.sh install     # 复制 profile + 安装本插件
#   ./scripts/real-plugin-check.sh boot        # 起在 64600 端口（后台）
#   ./scripts/real-plugin-check.sh probe       # 打 /rotation/api/health 等
#   ./scripts/real-plugin-check.sh stop        # 停掉
#   ./scripts/real-plugin-check.sh clean       # 删除一次性 profile（释放约 400MB）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${PROFILE:-rotationtest}"
PORT="${PORT:-64600}"
PROFILES="$HOME/.dsh/profiles"
TGZ="$ROOT/dsh-rotation-dashboard-0.2.2.tgz"

case "${1:-}" in
  install)
    [ -f "$TGZ" ] || (cd "$ROOT" && npm pack)
    rm -rf "$PROFILES/$PROFILE"
    echo "== 复制 web profile → $PROFILE（约 400MB）"
    cp -R "$PROFILES/web" "$PROFILES/$PROFILE"
    python3 - "$PROFILES/$PROFILE/package.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d['name'] = 'dsh-profile-rotationtest'
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2)
open(p, 'a').write('\n')
PY
    echo "== 安装插件（用 app 自带 pnpm，store 与 profile 一致）"
    dsh plugin --profile "$PROFILE" add "$TGZ"
    ;;
  boot)
    echo "== 启动 $PROFILE :$PORT"
    (dsh --profile "$PROFILE" --port "$PORT" --no-open > "/tmp/$PROFILE-boot.log" 2>&1 & echo $! > "/tmp/$PROFILE.pid")
    sleep 20
    grep -oE "http://127\.0\.0\.1:$PORT[^ ]*" "/tmp/$PROFILE-boot.log" | tail -1 || true
    ;;
  probe)
    for path in /rotation/api/health /rotation/app/ /rotation/api/cards; do
      printf '%-24s ' "$path"
      curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT$path"
    done
    curl -s "http://127.0.0.1:$PORT/rotation/api/health"; echo
    ;;
  stop)
    [ -f "/tmp/$PROFILE.pid" ] && kill "$(cat "/tmp/$PROFILE.pid")" 2>/dev/null || true
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill || true
    echo "stopped"
    ;;
  clean)
    rm -rf "$PROFILES/$PROFILE"
    echo "removed $PROFILES/$PROFILE"
    ;;
  *)
    echo "usage: $0 {install|boot|probe|stop|clean}"; exit 1;;
esac
