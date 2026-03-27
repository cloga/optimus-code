<#
.SYNOPSIS
  Lightweight install of the 'optimus' CLI (go, version, help only).
  Copies only the minimal files needed — no roles, agents, skills, or dist bundles.

.DESCRIPTION
  Installs to ~/.optimus/cli/ and adds it to the user PATH.
  After install, 'optimus go' works from any directory.

.EXAMPLE
  .\install-cli.ps1                    # Install from local repo
  .\install-cli.ps1 -Uninstall         # Remove the lightweight CLI
#>
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$cliDir = Join-Path (Join-Path $env:USERPROFILE '.optimus') 'cli'
$binDir = Join-Path $cliDir 'bin'
$commandsDir = Join-Path $binDir 'commands'
$libDir = Join-Path $binDir 'lib'

if ($Uninstall) {
    if (Test-Path $cliDir) {
        Remove-Item $cliDir -Recurse -Force
        Write-Host "✅ Removed $cliDir"
    }
    # Remove from PATH
    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    if ($userPath -and $userPath.Contains($cliDir)) {
        $newPath = ($userPath -split ';' | Where-Object { $_ -ne $cliDir }) -join ';'
        [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
        Write-Host "✅ Removed $cliDir from user PATH"
    }
    Write-Host "Done. Restart your terminal for PATH changes to take effect."
    exit 0
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$pluginBin = Join-Path (Join-Path $repoRoot 'optimus-plugin') 'bin'

# Verify source files exist
$requiredFiles = @(
    (Join-Path $pluginBin 'cli.js'),
    (Join-Path (Join-Path $pluginBin 'commands') 'go.js'),
    (Join-Path (Join-Path $pluginBin 'lib') 'project-registry.js'),
    (Join-Path (Join-Path $pluginBin 'lib') 'go-clients.js')
)
foreach ($f in $requiredFiles) {
    if (-not (Test-Path $f)) {
        Write-Error "Missing source file: $f"
        exit 1
    }
}

# Create directories
New-Item -ItemType Directory -Path $commandsDir -Force | Out-Null
New-Item -ItemType Directory -Path $libDir -Force | Out-Null

# Copy only the needed files
Copy-Item (Join-Path $pluginBin 'cli.js') $binDir -Force
Copy-Item (Join-Path (Join-Path $pluginBin 'commands') 'go.js') $commandsDir -Force
Copy-Item (Join-Path (Join-Path $pluginBin 'lib') 'project-registry.js') $libDir -Force
Copy-Item (Join-Path (Join-Path $pluginBin 'lib') 'go-clients.js') $libDir -Force

# Create a minimal package.json for the 'version' command
$pluginPkg = Join-Path (Join-Path $repoRoot 'optimus-plugin') 'package.json'
$version = (Get-Content $pluginPkg -Raw | ConvertFrom-Json).version
$minPkg = @{ name = 'optimus-cli'; version = $version } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $cliDir 'package.json'), $minPkg)

# Also copy memory.js if it exists (lightweight command)
$memoryJs = Join-Path (Join-Path $pluginBin 'commands') 'memory.js'
if (Test-Path $memoryJs) {
    Copy-Item $memoryJs $commandsDir -Force
}

# Create optimus.cmd wrapper
$cmdWrapper = @"
@echo off
node "%~dp0bin\cli.js" %*
"@
Set-Content (Join-Path $cliDir 'optimus.cmd') $cmdWrapper -Encoding ASCII

# Create optimus.ps1 wrapper for PowerShell
$ps1Wrapper = @'
#!/usr/bin/env pwsh
& node (Join-Path (Join-Path $PSScriptRoot 'bin') 'cli.js') @args
exit $LASTEXITCODE
'@
Set-Content (Join-Path $cliDir 'optimus.ps1') $ps1Wrapper -Encoding UTF8

# Add to user PATH if not already there
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if (-not $userPath -or -not $userPath.Contains($cliDir)) {
    [Environment]::SetEnvironmentVariable('PATH', "$cliDir;$userPath", 'User')
    $env:PATH = "$cliDir;$env:PATH"
    Write-Host "  Added $cliDir to user PATH"
}

# Count installed size
$totalSize = (Get-ChildItem $cliDir -Recurse | Measure-Object -Property Length -Sum).Sum
$sizeKB = [math]::Round($totalSize / 1KB, 1)

Write-Host ""
Write-Host "✅ Optimus CLI installed ($sizeKB KB)"
Write-Host "   Location: $cliDir"
Write-Host ""
Write-Host "   Commands:"
Write-Host "     optimus go              # Launch agent CLI for a project"
Write-Host "     optimus go <name>       # Launch specific project"
Write-Host "     optimus go --cli claude # Use Claude instead of Copilot"
Write-Host "     optimus go --scan       # Discover & register projects"
Write-Host "     optimus version         # Print version"
Write-Host ""
Write-Host "   Restart your terminal if 'optimus' is not recognized."
