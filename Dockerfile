# YOLO Data 一体化镜像。
# 零构建（纯 Node ESM），平台库为内置 SQLite，不需要外部数据库即可运行。
#
# 构建：docker build -t yolo-data .
# 运行：docker run -d -p 8088:8088 -v yolo-data:/app/data --restart unless-stopped yolo-data
# 或直接用仓库里的 docker-compose.yml：docker compose up -d
FROM node:22-alpine

# Python 3 + pandas/openpyxl 是分析脚本执行（execute_analysis_code）与 XLSX 生成的必选运行时。
# 上传的 xlsx 读取是纯 JS 实现（node:zlib），不依赖 Python。
# 构建期直接导入一次，依赖缺失时让镜像构建失败，而不是等到服务启动后才告警。
RUN apk add --no-cache python3 py3-pandas py3-openpyxl \
    && python3 -c "import pandas, openpyxl"
ENV PYTHON_BIN=/usr/bin/python3

WORKDIR /app
ENV PORT=8088

# 先拷贝依赖清单以利用层缓存：改动源码不会触发重新装依赖。
# 锁文件与 package.json 必须同步，否则 npm ci 会失败（这是有意的保险）。
COPY package.json package-lock.json ./
# 可选 PostgreSQL 镜像：docker build --build-arg INSTALL_PG=true -t yolo-data .
ARG INSTALL_PG=false
RUN case "$INSTALL_PG" in true|false) ;; *) echo 'INSTALL_PG must be true or false' >&2; exit 1 ;; esac \
    && npm ci --omit=dev \
    && if [ "$INSTALL_PG" = true ]; then npm install --omit=dev --no-save --package-lock=false pg@8; fi \
    && ./node_modules/.bin/codex --version \
    && npm cache clean --force

COPY . .

# 平台全部持久状态都在 data/：platform.db（SQLite，首次启动自动建库建表）、
# .datasource-key（数据源加密密钥）、code-runs/（分析脚本暂存目录）。
# 运行时只需此目录可写；代码目录以只读方式使用，故以非 root 用户运行。
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 8088

# /api/health 无需鉴权；用 Node 内置 fetch 探活，避免为健康检查引入 curl/wget。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8088)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
