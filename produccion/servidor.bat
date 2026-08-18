@echo off
REM Arranca el sistema (compila la primera vez si hace falta). Lo usa el auto-inicio.
cd /d "%~dp0.."
where node >nul 2>nul || (echo No se encontro Node.js & exit /b 1)
if not exist "backend\dist\index.js" call npm run build
call npm run start
