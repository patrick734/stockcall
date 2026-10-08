# Starts the keeper bot. Asks for the keeper private key with hidden input, so it never lands in
# shell history or a file; it lives only in this PowerShell process until the bot stops.
#
#   .\start.ps1           dry run: simulates every action, sends nothing (safe first run)
#   .\start.ps1 -Live     sends real transactions from the keeper wallet
#   .\start.ps1 -Once     one cycle instead of the loop (combine with -Live if wanted)
param([switch]$Live, [switch]$Once)

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

if (-not (Test-Path "node_modules")) { npm install }

$env:DRY_RUN = if ($Live) { "0" } else { "1" }
if ($Once) { $env:KEEPER_ONCE = "1" } else { Remove-Item env:KEEPER_ONCE -ErrorAction SilentlyContinue }

try {
  if ($Live) {
    $secure = Read-Host "Paste the KEEPER wallet private key (hidden; right-click or Ctrl+Shift+V to paste)" -AsSecureString
    $env:KEEPER_PRIVATE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    $env:KEEPER_PRIVATE_KEY = ($env:KEEPER_PRIVATE_KEY -replace '\s', '')
    if ($env:KEEPER_PRIVATE_KEY -notmatch '^(0x)?[0-9a-fA-F]{64}$') {
      if ($env:KEEPER_PRIVATE_KEY -match '[\x00-\x1F]' -or $env:KEEPER_PRIVATE_KEY.Length -lt 8) {
        Write-Host -ForegroundColor Red "The paste didn't reach the prompt (this terminal types Ctrl+V as a character). Run it again and paste with right-click or Ctrl+Shift+V."
      } else {
        Write-Host -ForegroundColor Red "That isn't a private key (64 hexadecimal characters). Copy it again from your wallet's export screen."
      }
      exit 1
    }
    $addr = node -e "try { const k=process.env.KEEPER_PRIVATE_KEY.trim(); console.log(new (require('ethers').Wallet)(k.startsWith('0x')?k:'0x'+k).address) } catch { process.exit(1) }"
    if ($LASTEXITCODE -ne 0 -or -not $addr) { Write-Host "That doesn't look like a valid private key." -ForegroundColor Red; exit 1 }
    Write-Host "Keeper wallet: $addr" -ForegroundColor Cyan
    Write-Host "LIVE mode: this sends real transactions. Ctrl+C stops it." -ForegroundColor Yellow
  } else {
    Write-Host "DRY RUN: simulating only, nothing is sent. Use -Live to send." -ForegroundColor Cyan
  }
  node src/index.js
} finally {
  Remove-Item env:KEEPER_PRIVATE_KEY -ErrorAction SilentlyContinue
}
