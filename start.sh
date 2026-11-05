#!/usr/bin/env bash
# 允许 `sh start.sh` 直接调用：非 bash 解释器环境下自动切换到 bash
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

echo "YOLO Data Linux 启动向导"
echo "项目目录：$PROJECT_ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js >= 22.5 和 npm。" >&2
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)'; then
  echo "Node.js 版本过低：$(node --version)，需要 >= 22.5。" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm，请修复 Node.js/npm 安装或 PATH 后重试。" >&2
  exit 1
fi

node_ready=false
# 不能只看 node_modules 是否存在：仓库升级后新增依赖会导致启动崩溃。
# 逐个核对 package.json 中声明的 dependencies 是否真的装上了。
if [[ -d "$PROJECT_ROOT/node_modules" ]]; then
  node_ready=true
  missing_deps="$(node -e '
    const fs = require("fs");
    const deps = Object.keys(require("./package.json").dependencies || {});
    const missing = deps.filter((name) => !fs.existsSync(`node_modules/${name}`));
    if (missing.length) console.log(missing.join(" "));
  ')"
  if [[ -n "$missing_deps" ]]; then
    node_ready=false
    echo "检测到缺失的 Node 依赖：$missing_deps"
  fi
fi
python_ready=false
venv_python="$PROJECT_ROOT/.venv/bin/python"
if [[ -x "$venv_python" ]] && "$venv_python" -c 'import pandas, openpyxl' >/dev/null 2>&1; then
  python_ready=true
fi
codex_ready=false
codex_bin="$PROJECT_ROOT/node_modules/.bin/codex"
if [[ -x "$codex_bin" ]] && "$codex_bin" --version >/dev/null 2>&1; then
  codex_ready=true
fi

# 初始化状态只在这里分支一次：就绪时跳过，否则初始化后继续启动。
if [[ "$node_ready" == true && "$python_ready" == true && "$codex_ready" == true ]]; then
  echo "项目已初始化，跳过依赖安装。"
else
  echo "首次启动或检测到运行环境未就绪，需要初始化。"
  npm_choice=""
  pip_choice=""
  if [ -t 0 ]; then
    read -r -p "npm registry（回车沿用当前配置，输入 m 使用 npmmirror）： " npm_choice || npm_choice=""
  fi
  if [[ "$npm_choice" == "m" || "$npm_choice" == "M" ]]; then
    export npm_config_registry="https://registry.npmmirror.com"
  fi
  if [ -t 0 ]; then
    read -r -p "Python 包源（回车沿用当前配置，输入 a 使用阿里云镜像）： " pip_choice || pip_choice=""
  fi
  if [[ "$pip_choice" == "a" || "$pip_choice" == "A" ]]; then
    export PIP_INDEX_URL="https://mirrors.aliyun.com/pypi/simple/"
  fi
  npm run setup
fi

# ---------- 平台数据库配置检查 ----------
# 平台库为 MySQL 且连接信息不全（或连不上）时，引导用户现场填写。
db_state=0
db_probe_out="$(node scripts/platform-db-setup.mjs probe 2>&1)" || db_state=$?
if [ "$db_state" != 0 ]; then
  printf '%s\n' "$db_probe_out" | sed -n '2,$p'
  if [ ! -t 0 ]; then
    echo "非交互环境无法输入，请用环境变量提供：PLATFORM_DB_HOST / PLATFORM_DB_PORT / PLATFORM_DB_NAME / PLATFORM_DB_USER / PLATFORM_DB_PASSWORD" >&2
    exit 1
  fi
  echo ""
  echo "请选择平台数据库："
  echo "  1) 本地 SQLite（零配置，无需数据库服务）"
  echo "  2) 连接 MySQL（输入地址、库名、账号、密码）"
  echo "  3) 退出"
  printf "请选择 [1/2/3]（直接回车 = 2）："
  read -r db_choice || db_choice=""
  case "${db_choice:-2}" in
    1)
      export PLATFORM_DB_BACKEND=sqlite
      echo "将使用本地 SQLite（不改动 yolo-conf.yaml）。"
      ;;
    3)
      echo "已退出。排查后可重新执行 sh start.sh。" >&2
      exit 1
      ;;
    *)
      export PLATFORM_DB_BACKEND=mysql
      db_ok=false
      db_attempt=0
      while [ "$db_attempt" -lt 3 ]; do
        printf "数据库地址（IP 或域名，如 10.0.0.5）: "
        if ! read -r PLATFORM_DB_HOST; then
          echo "" >&2
          echo "输入已结束（EOF），退出。" >&2
          exit 1
        fi
        printf "端口 [3306]: "
        read -r db_port || db_port=""
        PLATFORM_DB_PORT="${db_port:-3306}"
        printf "库名: "
        read -r PLATFORM_DB_NAME || PLATFORM_DB_NAME=""
        printf "账号: "
        read -r PLATFORM_DB_USER || PLATFORM_DB_USER=""
        printf "密码（输入不回显）: "
        read -r -s PLATFORM_DB_PASSWORD || PLATFORM_DB_PASSWORD=""
        echo ""
        if [ -z "$PLATFORM_DB_HOST" ] || [ -z "$PLATFORM_DB_NAME" ] \
          || [ -z "$PLATFORM_DB_USER" ] || [ -z "$PLATFORM_DB_PASSWORD" ]; then
          echo "地址、库名、账号、密码都不能为空，请重新输入（本次不计入失败次数）。"
          echo ""
          continue
        fi
        export PLATFORM_DB_HOST PLATFORM_DB_PORT PLATFORM_DB_NAME PLATFORM_DB_USER PLATFORM_DB_PASSWORD
        if node scripts/platform-db-setup.mjs test; then
          db_ok=true
          break
        fi
        db_attempt=$((db_attempt + 1))
        echo "第 ${db_attempt}/3 次连接失败，请重新输入。"
        echo ""
      done
      if [ "$db_ok" != true ]; then
        echo "数据库连接三次均失败，已退出。请检查地址、账号口令或网络（VPN）后重试。" >&2
        exit 1
      fi
      printf "是否写入 yolo-conf.yaml，下次启动免输入？[y/N]："
      read -r db_save || db_save=""
      case "$db_save" in
        y|Y)
          node scripts/platform-db-setup.mjs save
          echo "提示：yolo-conf.yaml 受 git 跟踪，明文口令有泄漏风险，请勿提交。"
          ;;
        *)
          echo "本次仅用环境变量生效，未写入配置文件。"
          ;;
      esac
      ;;
  esac
  echo ""
fi

echo "正在启动……"
npm run dev &
dev_pid=$!
port="${PORT:-8088}"
if [[ -z "${PORT:-}" ]] && [[ -f yolo-conf.yaml ]]; then
  configured_port="$(sed -nE 's/^[[:space:]]*port:[[:space:]]*([0-9]+)[[:space:]]*(#.*)?$/\1/p' yolo-conf.yaml | head -n 1)"
  [[ -n "$configured_port" ]] && port="$configured_port"
fi
url="http://127.0.0.1:${port}"
# dev.mjs 会先停掉本项目旧实例再起新进程，所以启动前先记录端口是否已有服务在跑。
# 若已有服务，必须先等到它下线，否则会把"旧实例还活着"误判成新实例启动成功。
port_busy_before=false
if printf '%s' "$(curl --silent --noproxy '*' --max-time 2 "$url/api/health" 2>/dev/null || true)" \
  | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  port_busy_before=true
  echo "检测到旧实例仍在运行，等待其重启切换到新进程……"
fi
service_down=false
[ "$port_busy_before" = false ] && service_down=true
# 平台库指向远程 MySQL 时，启动要跑上百次带网络往返的初始化查询，60 秒往往不够。
wait_seconds="${START_WAIT_SECONDS:-240}"
started=false
elapsed=0
while [ "$elapsed" -lt "$wait_seconds" ]; do
  if ! kill -0 "$dev_pid" 2>/dev/null; then
    wait "$dev_pid" || exit $?
    exit 0
  fi
  health_body="$(curl --silent --noproxy '*' --fail --max-time 2 "$url/api/health" 2>/dev/null || true)"
  health_ok=false
  if printf '%s' "$health_body" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    health_ok=true
  fi
  if [ "$service_down" = false ]; then
    # 旧实例尚未退出，继续等它下线
    [ "$health_ok" = false ] && service_down=true
  elif [ "$health_ok" = true ]; then
    started=true
    break
  fi
  sleep 1
  elapsed=$((elapsed + 1))
  if [ $((elapsed % 20)) -eq 0 ]; then
    echo "  仍在启动中（已等待 ${elapsed}s / 上限 ${wait_seconds}s）……平台库为远程 MySQL 时较慢属正常"
  fi
done
if [ "$started" != true ]; then
  echo "等待服务启动超时（${wait_seconds}s），端口 ${port} 未就绪。" >&2
  echo "  可延长等待：START_WAIT_SECONDS=600 sh start.sh" >&2
  kill "$dev_pid" 2>/dev/null || true
  exit 1
fi
echo "Project start success: ${url}"
wait "$dev_pid"
