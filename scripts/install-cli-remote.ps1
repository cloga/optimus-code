<#
.SYNOPSIS
  One-line remote installer for the Optimus lightweight CLI.
  Downloads only the files needed for 'optimus go' from GitHub.

.EXAMPLE
  irm https://raw.githubusercontent.com/cloga/optimus-code/master/scripts/install-cli-remote.ps1 | iex
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$baseUrl = 'https://raw.githubusercontent.com/cloga/optimus-code/master/optimus-plugin'
$cliDir = Join-Path (Join-Path $env:USERPROFILE '.optimus') 'cli'
$binDir = Join-Path $cliDir 'bin'
$commandsDir = Join-Path $binDir 'commands'
$libDir = Join-Path $binDir 'lib'

Write-Host "Installing Optimus CLI to $cliDir ..."

# Create directories
New-Item -ItemType Directory -Path $commandsDir -Force | Out-Null
New-Item -ItemType Directory -Path $libDir -Force | Out-Null

# Download files from GitHub
$files = @(
    @{ Url = "$baseUrl/bin/cli.js";                   Dest = Join-Path $binDir 'cli.js' }
    @{ Url = "$baseUrl/bin/commands/go.js";            Dest = Join-Path $commandsDir 'go.js' }
    @{ Url = "$baseUrl/bin/lib/project-registry.js";   Dest = Join-Path $libDir 'project-registry.js' }
    @{ Url = "$baseUrl/package.json";                  Dest = Join-Path $cliDir 'package.json' }
)

foreach ($f in $files) {
    Write-Host "  Downloading $($f.Url | Split-Path -Leaf) ..."
    Invoke-WebRequest -Uri $f.Url -OutFile $f.Dest -UseBasicParsing
}

# Create optimus.cmd wrapper
$cmdContent = "@echo off`nnode `"%~dp0bin\cli.js`" %*"
[System.IO.File]::WriteAllText((Join-Path $cliDir 'optimus.cmd'), $cmdContent)

# Create optimus.ps1 wrapper
$ps1Content = "#!/usr/bin/env pwsh`n& node (Join-Path (Join-Path `$PSScriptRoot 'bin') 'cli.js') @args`nexit `$LASTEXITCODE"
[System.IO.File]::WriteAllText((Join-Path $cliDir 'optimus.ps1'), $ps1Content)

# Add to user PATH if not already there
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if (-not $userPath -or -not $userPath.Contains($cliDir)) {
    [Environment]::SetEnvironmentVariable('PATH', "$cliDir;$userPath", 'User')
    $env:PATH = "$cliDir;$env:PATH"
    Write-Host "  Added to user PATH"
}

Write-Host ""
Write-Host "Done! Optimus CLI installed."
Write-Host ""
Write-Host "  optimus go              # Launch Copilot for a project"
Write-Host "  optimus go <name>       # Launch specific project"
Write-Host "  optimus go --scan       # Discover & register projects"
Write-Host ""
Write-Host "  Restart terminal if 'optimus' is not recognized."
