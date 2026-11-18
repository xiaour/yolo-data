# Python 代码执行隔离

分析代码默认使用 Docker 容器执行，支持通过 SANDBOX_BACKEND=podman 改用 Podman。容器不可用、镜像缺失或后端名称错误时明确失败，不会自动回退到宿主机 Python。普通问数和应用启动不要求容器可用，调用代码分析时才需要它。

## 在执行主机上准备

先安装并启动 Docker，然后在项目根目录构建带 pandas/openpyxl 的专用镜像：

```bash
docker build -f config/sandbox/Dockerfile -t yolo-data-sandbox:local .
```

默认配置：

```yaml
codeExecution:
  sandbox:
    backend: container
    image: yolo-data-sandbox:local
    allowUnsafeInprocess: false
    seccomp: ""
```

环境变量 SANDBOX_BACKEND、SANDBOX_IMAGE、SANDBOX_ALLOW_UNSAFE_INPROCESS 和 SANDBOX_SECCOMP 可覆盖 YAML。留空的 seccomp 使用容器引擎的默认策略。

每次执行使用独立、非 root、无网络的容器，限制 CPU、内存和进程数。只读挂载本轮运行目录，仅 output/ 可写；不挂载项目源码、.env 或其他会话目录，也不向分析容器传入应用环境变量。执行超时会按本次生成的唯一名称强制删除容器，清理失败会显式报错。失败和超时产生的文件不会发布到工作区。

应用进程需要有权调用本机 Docker/Podman。远程容器引擎必须能够访问相同的运行目录；仅设置远程地址不能完成文件传输。如果 YOLO 本身运行在容器里，默认镜像没有配置容器引擎访问能力，不能只构建分析镜像就认为隔离执行已接通。需要在具有相同文件路径的独立执行主机上配置运行环境。不要向分析容器挂载 Docker socket。

## 验证

普通安全回归不需要 Docker：

```bash
node --test tests/codeSandbox.test.js
```

构建镜像后，可执行真实容器验收，包括输入读取、pandas 导出及宿主机测试文件不可读：

```bash
# Linux / macOS
YOLO_SANDBOX_TEST=1 node --test tests/codeSandbox.container.test.js
```

```powershell
# Windows PowerShell
$env:YOLO_SANDBOX_TEST = "1"
node --test tests/codeSandbox.container.test.js
```

## 可信本地开发

只有需要执行自己可信代码的开发机，才可主动选择以下不安全配置：

```yaml
codeExecution:
  sandbox:
    backend: inprocess
    allowUnsafeInprocess: true
```

该模式以应用账号权限在宿主机运行 Python。Python 内部的路径检查和 import 过滤只能减少误操作，不能隔离恶意代码。公网环境、多人环境和真实业务环境保持容器模式。
