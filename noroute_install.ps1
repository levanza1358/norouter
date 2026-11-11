$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 22.5+ is required. Install it from https://nodejs.org, then run install.ps1 again.' }
$version = node -p "process.versions.node"
$major = [int]($version.Split('.')[0])
$minor = [int]($version.Split('.')[1])
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) { throw "Node.js 22.5+ required; found $version." }

if (-not (Test-Path .env)) { Copy-Item .env.example .env }
New-Item -ItemType Directory -Force data | Out-Null
npm link
node bin\norouter.js install
