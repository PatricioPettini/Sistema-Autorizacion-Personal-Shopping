# Configura el acceso remoto con ngrok (URL fija) + auto-inicio al prender la PC.
# Ejecutar UNA sola vez. Si pide permisos de administrador, clic derecho -> "Ejecutar como administrador".
$ErrorActionPreference = 'Stop'
$prod = $PSScriptRoot
$serverBat = Join-Path $prod 'servidor.bat'

Write-Host "==================================================="
Write-Host "  Acceso remoto (ngrok) + auto-inicio de Windows"
Write-Host "==================================================="
Write-Host ""
Write-Host "Antes de continuar, en https://dashboard.ngrok.com necesitas:" -ForegroundColor Yellow
Write-Host "  1) Tu AUTHTOKEN  (menu: Your Authtoken)"
Write-Host "  2) Tu DOMINIO fijo gratis (menu: Domains -> New Domain, ej: algo.ngrok-free.app)"
Write-Host ""
$token = Read-Host "Pega tu AUTHTOKEN"
$domain = (Read-Host "Pega tu DOMINIO (ej: algo.ngrok-free.app)") -replace '^https?://',''

if (-not $token -or -not $domain) { Write-Host "Falta el token o el dominio." -ForegroundColor Red; Read-Host "Enter para salir"; exit 1 }

# 1) Guardar el authtoken de ngrok
& ngrok config add-authtoken $token
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: no se pudo guardar el authtoken." -ForegroundColor Red; Read-Host "Enter para salir"; exit 1 }

# 2) Lanzadores ocultos (sin ventanas negras)
$appVbs = Join-Path $prod 'iniciar-app.vbs'
$ngrokVbs = Join-Path $prod 'iniciar-ngrok.vbs'
@"
Set sh = CreateObject("WScript.Shell")
sh.Run Chr(34) & "$serverBat" & Chr(34), 0, False
"@ | Set-Content -Path $appVbs -Encoding ASCII
@"
Set sh = CreateObject("WScript.Shell")
sh.Run "ngrok http --url=https://$domain 4000", 0, False
"@ | Set-Content -Path $ngrokVbs -Encoding ASCII

# 3) Tareas que arrancan solas al iniciar sesion
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "SAP-Servidor" -Force -Trigger $trigger -Settings $settings `
  -Action (New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $appVbs + '"')) | Out-Null
Register-ScheduledTask -TaskName "SAP-Ngrok" -Force -Trigger $trigger -Settings $settings `
  -Action (New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $ngrokVbs + '"')) | Out-Null

Write-Host ""
Write-Host "Auto-inicio configurado (tareas 'SAP-Servidor' y 'SAP-Ngrok')." -ForegroundColor Green
Write-Host "Arrancando el tunel ahora..."
Start-Process wscript.exe -ArgumentList ('"' + $ngrokVbs + '"')
Start-Sleep -Seconds 3
Write-Host ""
Write-Host "===================================================" -ForegroundColor Green
Write-Host "  URL PUBLICA:  https://$domain" -ForegroundColor Green
Write-Host "===================================================" -ForegroundColor Green
Write-Host "Abrila en el navegador. La primera vez ngrok muestra una pagina de aviso: clic en 'Visit Site'."
Read-Host "Enter para cerrar"
