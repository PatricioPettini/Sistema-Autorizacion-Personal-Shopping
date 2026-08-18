# Desactiva el auto-inicio (quita las tareas programadas) y detiene el tunel ngrok.
$ErrorActionPreference = 'SilentlyContinue'
Unregister-ScheduledTask -TaskName "SAP-Servidor" -Confirm:$false
Unregister-ScheduledTask -TaskName "SAP-Ngrok" -Confirm:$false
Stop-Process -Name ngrok -Force
Write-Host "Auto-inicio desactivado. (El sistema sigue corriendo hasta que cierres su ventana o reinicies.)"
Read-Host "Enter para cerrar"
