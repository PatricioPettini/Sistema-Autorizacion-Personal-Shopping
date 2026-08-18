# Poner el sistema online (ngrok, URL fija gratis)

Con esto el sistema queda accesible desde internet con una **URL fija** (siempre la misma), y
**arranca solo** cuando se prende la PC e inicia sesión. Nadie tiene que ejecutar comandos.

> La PC de tu papá sigue siendo el servidor: mientras esté **prendida y con internet**, el sistema
> funciona. Si la apaga, nadie puede entrar hasta que la prenda de nuevo (ahí arranca solo).

---

## Configuración (una sola vez)

### 1) Cuenta y dominio en ngrok (gratis)
1. Entrá a **https://dashboard.ngrok.com** y creá una cuenta gratis (o iniciá sesión).
2. En el menú **"Your Authtoken"** → copiá el **AUTHTOKEN** (una cadena larga).
3. En el menú **"Domains"** → **NO crees uno nuevo** (el plan gratis pide upgrade para eso).
   Usá el **dominio "dev" que ya viene asignado** en la lista, tipo
   **`algo-algo.ngrok-free.dev`**. Copialo tal cual (con `.ngrok-free.dev`).

> El script NO necesita administrador. Si Windows lo bloquea, ver el paso 2.

### 2) Ejecutar el configurador
1. Entrá a la carpeta `produccion`.
2. Clic derecho en **`Configurar-Deploy.ps1`** → **"Ejecutar con PowerShell"**.
   - Si te da un error de permisos, clic derecho → **"Ejecutar como administrador"**.
   - Si Windows bloquea el script, abrí PowerShell como administrador y corré una vez:
     `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (respondé "S").
3. Cuando te lo pida, **pegá el AUTHTOKEN** y **el DOMINIO**.
4. Listo: te muestra la **URL pública** y deja todo configurado para que arranque solo.

La primera vez que abrís la URL, ngrok muestra una página de aviso: clic en **"Visit Site"**.

---

## Uso diario (tu papá no hace nada)
- **Prende la PC e inicia sesión** → en ~1 minuto el sistema y el túnel arrancan solos, con la
  **misma URL de siempre**.
- **Apaga la PC** → el sistema queda offline hasta la próxima vez que la prenda.
- No hace falta abrir `Iniciar.bat` ni ninguna ventana. (Si lo abrís a mano además del auto-inicio,
  puede dar error de "puerto en uso": usá solo uno.)

## Verificar que está andando
- Abrí la URL `https://TU-DOMINIO.ngrok-free.app` en cualquier dispositivo → debería aparecer el login.
- Panel de ngrok: en `https://dashboard.ngrok.com` → "Endpoints" ves si el túnel está activo.

## Cambiar el dominio o desactivar el auto-inicio
- **Cambiar dominio / token:** volvé a correr `Configurar-Deploy.ps1` con los datos nuevos.
- **Desactivar el auto-inicio:** clic derecho en `Detener-AutoInicio.ps1` → "Ejecutar con PowerShell".

## Seguridad (importante)
- La URL es **pública**: cualquiera que la tenga llega a la **pantalla de login** (no a los datos).
  Por eso: usá **contraseñas fuertes** para los usuarios y no compartas la URL de más.
- Los documentos y la base siguen **en la PC** (no en la nube), lo cual es bueno para datos sensibles.
