# Desactiva el auto-inicio (quita los lanzadores de la carpeta de Inicio) y detiene el tunel.
$ErrorActionPreference = 'SilentlyContinue'
$startup = [Environment]::GetFolderPath('Startup')
Remove-Item (Join-Path $startup 'SAP-Servidor.vbs') -Force
Remove-Item (Join-Path $startup 'SAP-Ngrok.vbs') -Force
Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "Auto-inicio desactivado. (El sistema sigue corriendo hasta que cierres su ventana o reinicies.)"
Read-Host "Enter para cerrar"
