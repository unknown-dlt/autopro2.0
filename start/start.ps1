param(
    [switch]$SkipInstall
)

Write-Host "=== AutoPro local start ==="

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

function Ensure-Command {
    param(
        [Parameter(Mandatory = $true)][string]$Name
    )

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Host "Required command not found: $Name"
        throw "Please install $Name and try again."
    }
}

Write-Host ""
Write-Host "Checking required tools..."
Ensure-Command -Name "node"
Ensure-Command -Name "npm"
Ensure-Command -Name "docker"

if (-not $SkipInstall) {
    Write-Host ""
    Write-Host "Installing / updating dependencies..."

    if (Test-Path "$ProjectRoot\package.json") {
        Write-Host "npm install (root)..."
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install (root) failed." }
    }

    if (Test-Path "$ProjectRoot\backend\package.json") {
        Write-Host "npm install (backend)..."
        Push-Location "$ProjectRoot\backend"
        npm install
        if ($LASTEXITCODE -ne 0) {
            Pop-Location
            throw "npm install (backend) failed."
        }
        Pop-Location
    }

    if (Test-Path "$ProjectRoot\frontend\package.json") {
        Write-Host "npm install (frontend)..."
        Push-Location "$ProjectRoot\frontend"
        npm install
        if ($LASTEXITCODE -ne 0) {
            Pop-Location
            throw "npm install (frontend) failed."
        }
        Pop-Location
    }
} else {
    Write-Host ""
    Write-Host "Skipping dependency install (-SkipInstall flag)."
}

Write-Host ""
Write-Host "Starting PostgreSQL in Docker..."
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw "docker compose up -d failed." }

Write-Host ""
Write-Host "Starting project (backend + frontend)..."

npm run dev

if ($LASTEXITCODE -ne 0) {
    Write-Host "npm run dev failed with exit code $LASTEXITCODE."
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "AutoPro stopped."

