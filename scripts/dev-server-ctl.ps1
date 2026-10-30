#!/usr/bin/env pwsh
# Gestion du dev server T3CodeQC (npx pnpm dev) sur Windows : Start / Stop / Restart / Status
#
# Usage:
#   ./scripts/dev-server-ctl.ps1 -Action Start
#   ./scripts/dev-server-ctl.ps1 -Action Stop
#   ./scripts/dev-server-ctl.ps1 -Action Restart
#   ./scripts/dev-server-ctl.ps1 -Action Status

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Start", "Stop", "Restart", "Status")]
    [string]$Action
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $env:TEMP "t3code-dev-server"
$pidFile = Join-Path $stateDir "server.pid"
$logFile = Join-Path $stateDir "server.log"

if (-not (Test-Path $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir | Out-Null
}

function Get-RunningPid {
    if (Test-Path $pidFile) {
        $storedPid = Get-Content $pidFile -ErrorAction SilentlyContinue
        if ($storedPid -and (Get-Process -Id $storedPid -ErrorAction SilentlyContinue)) {
            return [int]$storedPid
        }
    }
    return $null
}

function Start-Server {
    $existing = Get-RunningPid
    if ($existing) {
        Write-Host "[!] Deja demarre (PID $existing). Utilise -Action Status ou Restart."
        return
    }

    Write-Host "[..] Demarrage du dev server..."
    "" | Set-Content $logFile
    $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npx pnpm dev" `
        -WorkingDirectory $repoRoot `
        -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" `
        -WindowStyle Hidden -PassThru
    $proc.Id | Set-Content $pidFile

    Write-Host "[..] PID $($proc.Id). Attente de l'URL locale (max 60s)..."
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        $content = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
        if ($content -match "(http://localhost:\d+)/?") {
            Write-Host "[OK] Pret: $($Matches[1])"
            return
        }
        if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) {
            Write-Host "[ERROR] Le processus s'est arrete avant d'etre pret. Voir le log: $logFile.err"
            Remove-Item $pidFile -ErrorAction SilentlyContinue
            return
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Host "[!] Timeout apres 60s, pas encore d'URL detectee. Verifie le log: $logFile"
}

function Stop-Server {
    $existingPid = Get-RunningPid
    if (-not $existingPid) {
        Write-Host "[!] Rien a arreter."
        Remove-Item $pidFile -ErrorAction SilentlyContinue
        return
    }
    Write-Host "[..] Arret du PID $existingPid (et ses processus enfants : node, vite, etc.)..."
    taskkill /PID $existingPid /T /F | Out-Null
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    Write-Host "[OK] Arrete."
}

function Show-Status {
    $existingPid = Get-RunningPid
    if (-not $existingPid) {
        Write-Host "Statut: ARRETE"
        return
    }
    Write-Host "Statut: EN MARCHE (PID $existingPid)"
    $content = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
    if ($content -match "(http://localhost:\d+)/?") {
        Write-Host "URL: $($Matches[1])"
    }
    Write-Host "Log: $logFile"
}

switch ($Action) {
    "Start"   { Start-Server }
    "Stop"    { Stop-Server }
    "Restart" { Stop-Server; Start-Sleep -Seconds 1; Start-Server }
    "Status"  { Show-Status }
}
