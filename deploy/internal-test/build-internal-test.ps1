[CmdletBinding()]
param(
  [string]$PnpmCommand = $env:PNPM_COMMAND,
  [string]$ReleaseRoot = '',
  [ValidateSet('development', 'internal-test', 'public')]
  [string]$BuildMode = 'internal-test'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ([string]::IsNullOrWhiteSpace($PnpmCommand)) { $PnpmCommand = 'pnpm' }
if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) { $ReleaseRoot = Join-Path $repoRoot 'deploy\releases' }
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$releaseDir = Join-Path $ReleaseRoot $stamp
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

$previousEnv = @{}
foreach ($name in @('VITE_DEPLOYMENT_MODE', 'VITE_API_BASE', 'VITE_PUBLIC_SITE_URL', 'VITE_ORG_APP_URL')) {
  $previousEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Copy-DirectoryContents([string]$sourceDir, [string]$destinationDir) {
  if (-not (Test-Path -LiteralPath $sourceDir -PathType Container)) {
    throw "Missing source directory: $sourceDir"
  }
  New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
  Copy-Item -Path (Join-Path $sourceDir '*') -Destination $destinationDir -Recurse -Force
}

Push-Location $repoRoot
try {
  $nodeVersionText = (& node --version).Trim().TrimStart('v')
  $nodeVersion = [version]$nodeVersionText
  if ($nodeVersion -lt [version]'22.5.0') { throw "Node.js 22.5+ is required because the database uses node:sqlite; found $nodeVersionText" }
  $env:VITE_DEPLOYMENT_MODE = $BuildMode
  $env:VITE_API_BASE = '/api'
  if ([string]::IsNullOrWhiteSpace($env:VITE_PUBLIC_SITE_URL)) { $env:VITE_PUBLIC_SITE_URL = 'http://internal-test.example' }
  if ([string]::IsNullOrWhiteSpace($env:VITE_ORG_APP_URL)) { $env:VITE_ORG_APP_URL = 'http://org.internal-test.example' }

  & $PnpmCommand run build
  if ($LASTEXITCODE -ne 0) { throw "pnpm build failed with exit code $LASTEXITCODE" }

  foreach ($app in @('admin', 'org', 'student', 'website')) {
    $dist = Join-Path $repoRoot "apps\$app\dist"
    if (-not (Test-Path -LiteralPath (Join-Path $dist 'index.html') -PathType Leaf)) {
      throw "Missing build output: $(Join-Path $dist 'index.html')"
    }
    Copy-DirectoryContents $dist (Join-Path $releaseDir "apps\$app")
  }

  Copy-DirectoryContents (Join-Path $repoRoot 'apps\server\src') (Join-Path $releaseDir 'apps\server\src')
  Copy-DirectoryContents (Join-Path $repoRoot 'packages\database\src') (Join-Path $releaseDir 'packages\database\src')
  Copy-DirectoryContents (Join-Path $repoRoot 'packages\database\src') (Join-Path $releaseDir 'node_modules\@platform\database\src')

  New-Item -ItemType Directory -Force -Path (Join-Path $releaseDir 'apps\server'), (Join-Path $releaseDir 'packages\database'), (Join-Path $releaseDir 'node_modules\@platform\database') | Out-Null
  Copy-Item -LiteralPath (Join-Path $repoRoot 'package.json') -Destination $releaseDir -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot 'pnpm-lock.yaml') -Destination $releaseDir -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot 'pnpm-workspace.yaml') -Destination $releaseDir -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot 'packages\database\package.json') -Destination (Join-Path $releaseDir 'packages\database') -Force
  Copy-Item -LiteralPath (Join-Path $repoRoot 'packages\database\package.json') -Destination (Join-Path $releaseDir 'node_modules\@platform\database') -Force

  @(
    "release=$stamp"
    "commit=$(git rev-parse HEAD)"
    "node=$(node --version)"
    "pnpm=$(& $PnpmCommand --version)"
    "mode=$BuildMode"
  ) | Set-Content -Encoding utf8 -Path (Join-Path $releaseDir 'BUILD-METADATA.txt')

  Write-Output "Internal-test release created: $releaseDir"
}
finally {
  foreach ($name in $previousEnv.Keys) {
    if ($null -eq $previousEnv[$name]) {
      Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
    } else {
      Set-Item -Path "Env:$name" -Value $previousEnv[$name]
    }
  }
  Pop-Location
}


