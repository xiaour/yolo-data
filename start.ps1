$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

Write-Host 'YOLO Data Windows 启动向导'
Write-Host "项目目录：$ProjectRoot"

try {
    $NodeVersionText = (& node --version 2>$null).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'node command failed' }
} catch {
    Write-Error '未找到 Node.js。请先安装 Node.js >= 22.5（包含 npm），然后重新运行 start.ps1。'
    exit 1
}
$NodeVersion = [version]($NodeVersionText.TrimStart('v'))
if ($NodeVersion -lt [version]'22.5') {
    Write-Error "Node.js 版本过低：$NodeVersionText，需要 >= 22.5。"
    exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error '未找到 npm。请修复 Node.js/npm 安装或 PATH 后重试。'
    exit 1
}

$NodeReady = Test-Path (Join-Path $ProjectRoot 'node_modules')
if ($NodeReady) {
    $MissingDeps = (& node -e 'const fs=require("fs");const deps=Object.keys(require("./package.json").dependencies||{});console.log(deps.filter((name)=>!fs.existsSync(`node_modules/${name}`)).join(" "));').Trim()
    $NodeReady = $LASTEXITCODE -eq 0 -and [string]::IsNullOrWhiteSpace($MissingDeps)
    if (-not $NodeReady -and $MissingDeps) { Write-Host "检测到缺失的 Node 依赖：$MissingDeps" }
}
$VenvPython = Join-Path $ProjectRoot '.venv\Scripts\python.exe'
$PythonReady = $false
if (Test-Path $VenvPython) {
    & $VenvPython -c 'import pandas, openpyxl' 2>$null
    $PythonReady = $LASTEXITCODE -eq 0
}
$CodexBin = Join-Path $ProjectRoot 'node_modules\.bin\codex.cmd'
$CodexReady = $false
if (Test-Path $CodexBin) {
    & $CodexBin --version *> $null
    $CodexReady = $LASTEXITCODE -eq 0
}

if ($NodeReady -and $PythonReady -and $CodexReady) {
    Write-Host '项目已初始化，跳过依赖安装。'
} else {
    Write-Host '首次启动或检测到运行环境未就绪，需要初始化。'
    $NpmChoice = Read-Host 'npm registry (Enter keeps current setting; m selects npmmirror)'
    if ($NpmChoice -match '^[mM]$') { $env:npm_config_registry = 'https://registry.npmmirror.com' }
    $PipChoice = Read-Host 'Python package index (Enter keeps current setting; a selects Aliyun mirror)'
    if ($PipChoice -match '^[aA]$') { $env:PIP_INDEX_URL = 'https://mirrors.aliyun.com/pypi/simple/' }
    & npm run setup
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host '正在启动……'
$DevProcess = Start-Process -FilePath 'node' -ArgumentList @('scripts/dev.mjs') -WorkingDirectory $ProjectRoot -NoNewWindow -PassThru
$Port = 8088
try {
    $PortConfig = Get-Content -LiteralPath (Join-Path $ProjectRoot 'yolo-conf.yaml') -Raw
    if ($PortConfig -match '(?m)^\s*port:\s*(\d+)\s*(?:#.*)?$') { $Port = [int]$Matches[1] }
} catch { }
if ($env:PORT -match '^\d+$') { $Port = [int]$env:PORT }
$Url = "http://127.0.0.1:$Port"
$Started = $false
for ($Attempt = 0; $Attempt -lt 60; $Attempt++) {
    if ($DevProcess.HasExited) {
        Write-Error "启动进程已退出，退出码：$($DevProcess.ExitCode)"
        exit $DevProcess.ExitCode
    }
    try {
        $Health = Invoke-RestMethod -Uri "$Url/api/health" -TimeoutSec 2
        if ($Health.status -eq 'ok') { $Started = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
}
if (-not $Started) {
    Write-Error "等待服务启动超时，请检查启动日志（端口 $Port）。"
    exit 1
}
Write-Host "Project start success: $Url"
Wait-Process -Id $DevProcess.Id
exit $DevProcess.ExitCode
