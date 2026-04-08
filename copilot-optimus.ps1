param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $repoRoot '.copilot\mcp-config.json'

if (-not (Test-Path $configPath)) {
    Write-Error "Missing Copilot MCP config: $configPath`nRun 'optimus init' or 'optimus upgrade' first."
    exit 1
}

Push-Location $repoRoot
try {
    & copilot '--additional-mcp-config' "@$configPath" @Args
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
