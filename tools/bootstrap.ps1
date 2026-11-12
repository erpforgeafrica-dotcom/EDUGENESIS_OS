<#
.SYNOPSIS
  EduGenesis OS — portable bootstrap (Windows PowerShell 5.1 and PowerShell 7+).

.DESCRIPTION
  Makes this folder runnable on a machine that has never seen this project:

    1. Work out the required Node version from the root package.json.
    2. Use the portable runtime in .toolchain\ if it is new enough.
    3. Otherwise use a system Node if it is new enough.
    4. Otherwise DOWNLOAD a portable Node runtime INTO THIS FOLDER
       (.toolchain\). Nothing is ever installed globally.
    5. Run "npm install" when node_modules is absent.
    6. Run "npm run build".

  Every path is derived from $PSScriptRoot. No absolute path, user name or
  drive letter appears in this script, so the folder can be copied anywhere.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\bootstrap.ps1
#>
[CmdletBinding()]
param(
  # Skip the "npm install" step (useful when the tree is already installed).
  [switch]$SkipInstall,
  # Skip the "npm run build" step.
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$ToolchainDir = Join-Path $Root '.toolchain'
$NodeDir = Join-Path $ToolchainDir 'node'
$ManifestPath = Join-Path $Root 'package.json'

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Info { param([string]$Message) Write-Host "    $Message" -ForegroundColor DarkGray }
function Write-Bad  { param([string]$Message) Write-Host "ERROR: $Message" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# 1. The required Node version
# ---------------------------------------------------------------------------

function Get-VersionInfo {
  param([string]$Text)
  $match = [regex]::Match($Text, 'v?(\d+)\.(\d+)\.(\d+)')
  if (-not $match.Success) { return $null }
  return [version]::new(
    [int]$match.Groups[1].Value,
    [int]$match.Groups[2].Value,
    [int]$match.Groups[3].Value
  )
}

if (-not (Test-Path -LiteralPath $ManifestPath)) {
  Write-Bad "package.json not found at the project root."
  exit 1
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$requiredText = [string]$manifest.engines.node
$requiredMatch = [regex]::Match($requiredText, '(\d+)\.(\d+)\.(\d+)')
if (-not $requiredMatch.Success) {
  Write-Bad "Could not read the required Node version from package.json (engines.node = '$requiredText')."
  exit 1
}
$RequiredVersion = [version]::new(
  [int]$requiredMatch.Groups[1].Value,
  [int]$requiredMatch.Groups[2].Value,
  [int]$requiredMatch.Groups[3].Value
)
Write-Step "Required Node version: >= $RequiredVersion"

# ---------------------------------------------------------------------------
# 2. Locate a usable Node
# ---------------------------------------------------------------------------

function Get-NodeVersionOf {
  param([string]$Executable)
  try {
    $output = & $Executable --version 2>$null
    return Get-VersionInfo ([string]$output)
  } catch {
    return $null
  }
}

function Find-UsableNode {
  # The portable runtime that ships with this folder wins.
  $portable = Join-Path $NodeDir 'node.exe'
  if (Test-Path -LiteralPath $portable) {
    $version = Get-NodeVersionOf $portable
    if ($version -and $version -ge $RequiredVersion) {
      Write-Info "Using the portable runtime in .toolchain ($version)."
      return $portable
    }
  }

  $system = Get-Command -Name 'node' -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($system) {
    $version = Get-NodeVersionOf $system.Source
    if ($version -and $version -ge $RequiredVersion) {
      Write-Info "Using the system Node at $($system.Source) ($version)."
      return $system.Source
    }
    if ($version) {
      Write-Info "The system Node ($version) is older than $RequiredVersion."
    }
  }

  return $null
}

# ---------------------------------------------------------------------------
# 3. Download a portable Node into this folder
# ---------------------------------------------------------------------------

function Get-PortableNodeVersion {
  # Prefer the live release index; fall back to a pinned LTS.
  $pinned = '22.11.0'
  $override = $env:EDUGENESIS_NODE_VERSION
  if ($override -and $override.Trim().Length -gt 0) {
    $pinned = $override.Trim().TrimStart('v')
  }
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing -TimeoutSec 30
    foreach ($release in $index) {
      $version = ([string]$release.version).TrimStart('v')
      if ($version -like '22.*' -and $release.lts) {
        return $version
      }
    }
  } catch {
    Write-Info "The release index is unreachable; using the pinned version $pinned."
  }
  return $pinned
}

function Install-PortableNode {
  $version = Get-PortableNodeVersion
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($arch -eq 'ARM64') { $archName = 'arm64' } else { $archName = 'x64' }
  $archiveName = "node-v$version-win-$archName.zip"
  $url = "https://nodejs.org/dist/v$version/$archiveName"

  Write-Step "Downloading a portable Node runtime into .toolchain"
  Write-Info "$url"

  if (-not (Test-Path -LiteralPath $ToolchainDir)) {
    New-Item -ItemType Directory -Path $ToolchainDir -Force | Out-Null
  }
  $archivePath = Join-Path $ToolchainDir $archiveName
  $stagingDir = Join-Path $ToolchainDir "node-v$version-win-$archName"

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $client = New-Object System.Net.WebClient
    $client.DownloadFile($url, $archivePath)
  } catch {
    Write-Bad "Could not download the portable Node runtime: $($_.Exception.Message)"
    exit 1
  }

  Write-Info 'Extracting…'
  Expand-Archive -LiteralPath $archivePath -DestinationPath $ToolchainDir -Force
  Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue

  if (-not (Test-Path -LiteralPath (Join-Path $stagingDir 'node.exe'))) {
    Write-Bad "The archive did not contain the expected runtime."
    exit 1
  }
  if (Test-Path -LiteralPath $NodeDir) {
    Remove-Item -LiteralPath $NodeDir -Recurse -Force
  }
  Move-Item -LiteralPath $stagingDir -Destination $NodeDir

  Write-Info "Portable Node $version is now in .toolchain\node."
}

$NodeExe = Find-UsableNode
if (-not $NodeExe) {
  Install-PortableNode
  $NodeExe = Join-Path $NodeDir 'node.exe'
  $installed = Get-NodeVersionOf $NodeExe
  if (-not $installed -or $installed -lt $RequiredVersion) {
    Write-Bad "The portable runtime is still older than $RequiredVersion."
    exit 1
  }
  Write-Info "Portable Node $installed is ready."
}

# Put the chosen Node first on PATH so npm and every child process use it.
$nodeDirectory = Split-Path -Parent $NodeExe
$env:PATH = "$nodeDirectory;$env:PATH"

$npmCommand = Get-Command -Name 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $npmCommand) {
  $npmCommand = Get-Command -Name 'npm' -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
}
if (-not $npmCommand) {
  Write-Bad 'npm was not found next to the selected Node runtime.'
  exit 1
}

# ---------------------------------------------------------------------------
# 4. Install dependencies
# ---------------------------------------------------------------------------

$ModulesDir = Join-Path $Root 'node_modules'
if (-not (Test-Path -LiteralPath $ModulesDir)) {
  Write-Step 'Installing dependencies (npm install)'
  Push-Location $Root
  try {
    & $npmCommand.Source install
    if ($LASTEXITCODE -ne 0) {
      Write-Bad 'npm install failed.'
      exit 1
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Step 'Dependencies are already installed (node_modules is present).'
}

# ---------------------------------------------------------------------------
# 5. Build
# ---------------------------------------------------------------------------

if ($SkipBuild) {
  Write-Step 'Skipping the build (-SkipBuild).'
} else {
  Write-Step 'Building (npm run build)'
  Push-Location $Root
  try {
    & $npmCommand.Source run build
    if ($LASTEXITCODE -ne 0) {
      Write-Bad 'npm run build failed.'
      exit 1
    }
  } finally {
    Pop-Location
  }
}

Write-Step 'Bootstrap complete.'
Write-Host '    node apps/cli/dist/doctor.js   # environment check' -ForegroundColor DarkGray
Write-Host '    node apps/cli/dist/serve.js    # local server and Settings UI' -ForegroundColor DarkGray
exit 0
