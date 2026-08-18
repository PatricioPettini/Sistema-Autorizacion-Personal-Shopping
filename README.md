# Sistema de Autorización de Personal Externo

Sistema para digitalizar la gestión y autorización de ingreso de personal externo
(electricistas, técnicos, mantenimiento, proveedores, contratistas) a los locales de
un shopping. Reemplaza las carpetas físicas de documentación por un flujo digital,
con lectura automática de emails, registro de personas a partir de un Excel y
**verificación y decisión final siempre a cargo de una persona (Administración/Seguridad)**.

> Funciona en **una sola PC con Windows**, sin depender de la nube ni de servicios externos.

---

## 1. Qué es y qué hace

- Lee automáticamente el email del encargado del local (IMAP). El **asunto declara el local**
  (`Solicitud FAO (Local) …`) y un **Excel adjunto opcional** (columnas **CUIL** y **Nombre completo**)
  lista a las personas. Si el email no trae Excel, la solicitud se crea igual y las personas se
  cargan a mano desde el detalle.
- Crea **una solicitud por email**: un **local** con **una o varias personas** a autorizar.
- Cada persona tiene una **ficha con su documentación versionada** (nunca borra el original) y un
  **checklist manual**: cada requisito se aprueba (✓ Verificado) revisando la documentación del email.
- **No autoriza solo**: la verificación de cada documento y la autorización/observación/rechazo los decide un usuario.
  Solo se puede **autorizar** cuando **toda la documentación obligatoria de esa persona está verificada**.
- Autoriza **por persona** y por **rango de fechas** (uno o varios días).
- Permite registrar **ingreso y salida** reales (Administración y Seguridad), ver quién está adentro
  y consultar en segundos si una persona puede entrar.
- Guarda **auditoría** completa de todas las acciones y envía **emails automáticos** (observación, autorización, rechazo).

## 2. Arquitectura

```
Navegador (React)  ──HTTP──▶  Backend (Fastify / Node.js)
                                   │
        ┌──────────────────────────┼───────────────────────────┐
     SQLite (datos)        Almacenamiento de archivos      Lector de Email
   storage/data/sistema.db   storage/documentos/...        IMAP + cola interna
                                   │
              Asunto → Local  +  Excel adjunto (CUIL + Nombre) → Personas
```

- **Backend**: Node.js + TypeScript + Fastify. Módulos separados (auth, personas, locales, documentos, solicitudes, autorizaciones, ingresos, email, procesamiento, notificaciones, auditoría).
- **Frontend**: React + Vite (una sola página, servida por el mismo backend en producción).
- **Base de datos**: SQLite (un solo archivo, sin instalar motores).
- **Lectura de Excel** sin dependencias externas (un `.xlsx` es un ZIP con XML; se lee la primera hoja).
- La verificación de documentación es **manual** (la persona de Seguridad aprueba cada requisito). El proyecto
  conserva los módulos de OCR/reglas para posibles usos futuros, pero **no** intervienen en el flujo actual.

## 3. Requisitos

- **Windows 10 u 11**.
- **Node.js 20, 22 o 24** (LTS). Descarga: https://nodejs.org/es
  > Fuera de ese rango, `better-sqlite3` no tiene binario precompilado y npm intenta
  > compilarlo, lo que requiere Visual Studio Build Tools. Si al iniciar aparece
  > *"Could not locate the bindings file"*, es esto: instalá una de esas versiones de Node,
  > borrá `node_modules` y volvé a ejecutar `Instalar.bat`.
- ~500 MB de disco (más lo que ocupe la documentación).
- (Opcional) Conexión a Internet **solo la primera vez** para descargar los datos de OCR en español.

## 4. Instalación (rápida, para el usuario final)

1. Copiá la carpeta del proyecto a la PC.
2. Doble clic en **`Instalar.bat`** (instala dependencias y compila).
3. Doble clic en **`Iniciar.bat`** (abre el navegador en `http://127.0.0.1:4000`).
4. La primera vez, el sistema te guía para **crear el usuario administrador**.

Ver el paso a paso detallado en [`docs/INSTALACION.md`](docs/INSTALACION.md).

## 5. Instalación (para desarrollo)

```bash
npm install
copy .env.example .env      # y completar valores
npm run build               # compila frontend + backend
npm start                   # inicia en http://127.0.0.1:4000
```

Modo desarrollo (con recarga):

```bash
npm run dev          # backend en :4000
npm run dev:front    # frontend en :5173 (proxy a :4000)
```

## 6. Configuración (variables de entorno)

Toda la configuración vive en `.env` (nunca se sube al repositorio). Ver `.env.example`.
Lo más importante:

| Variable | Descripción |
|---|---|
| `PORT` / `HOST` | Puerto y host del servidor (por defecto `4000` / `127.0.0.1`). |
| `SESSION_SECRET` | Secreto para firmar sesiones y cifrar credenciales guardadas. **Cambialo.** |
| `STORAGE_PATH` | Carpeta de datos y documentos (por defecto `./storage`). |
| `TZ` | Zona horaria (`America/Argentina/Buenos_Aires`). |
| `MAIL_IMAP_*` / `MAIL_SMTP_*` | Credenciales de email (también configurables desde la app). |
| `MAIL_POLL_MINUTES` | Frecuencia de revisión del buzón (0 = desactivado). Valor inicial; después manda lo guardado en la app. |
| `EXPIRY_ALERT_DAYS` | Días de anticipación para avisar vencimientos. |
| `MAX_FILE_MB` / `MAX_ZIP_UNCOMPRESSED_MB` | Límites de tamaño (protección anti ZIP-bomb). |

La configuración de email también se administra desde **Administración → Configuración de email**,
con botón **Probar conexión**. Las contraseñas se guardan **cifradas** y no se muestran.
Al guardar, el lector automático se **reinicia solo** con la frecuencia nueva (no hace falta reiniciar
el sistema). En **Monitoreo** se ve si está corriendo, la última revisión y la próxima.

### Locales

Los locales no hace falta cargarlos de antemano: se crean solos cuando aparece uno nuevo.

- **Desde un email**: el nombre sale del asunto (`Solicitud FAO (Local) …`). Se busca entre los
  cargados con match aproximado (ignora mayúsculas y acentos, y acepta que el nombre venga con
  texto alrededor); si no hay coincidencia, se crea.
- **A mano**: en **Solicitudes → + Nueva solicitud** el campo *Local* se escribe libremente y
  sugiere los ya cargados. Si escribís uno que no existe, se crea junto con la solicitud. La
  comparación ignora mayúsculas, acentos y espacios de más, así que "pizza hut" reusa "Pizza Hut".

Se pueden editar (nombre, email, estado) desde **Administración → Locales**.

## 7. Base de datos

- Motor: **SQLite** (archivo `storage/data/sistema.db`).
- El esquema se crea/actualiza solo al iniciar (`CREATE TABLE IF NOT EXISTS`, idempotente).
- Entidades principales: `users`, `locales`, `personas` (identificadas por **CUIL**), `document_types`,
  `documentos`, `document_versions`, `email_messages`, `processing_jobs`, `solicitudes`,
  `solicitud_personas` (las **varias personas** de una solicitud), `autorizaciones`, `entradas`,
  `comentarios`, `audit_log`, `settings`.

Comandos:

```bash
npm run migrate    # crea el esquema y los tipos de documento obligatorios
npm run seed       # carga datos de DEMOSTRACIÓN (usuarios, locales, personas)
```

## 8. Email (protocolo)

- **Recepción (IMAP)**: revisa el buzón cada `MAIL_POLL_MINUTES` minutos. No borra los emails;
  opcionalmente puede moverlos a una carpeta "Procesados". Es **idempotente**: no procesa dos veces
  el mismo mensaje (se identifica por `Message-ID`).
- **Asunto → Local + Tipo**: el asunto debe empezar con `Solicitud FAO`, seguido del **nombre del local**
  y del **tipo de contratista** (`Empresa` o `Monotributista`).
  El nombre del local se toma, en este orden: **entre paréntesis** → **entre guiones** → **tercera palabra**.
  Ejemplos válidos:
  - `Solicitud FAO (Burger King) Empresa`
  - `Solicitud FAO - Mostaza - Monotributista`
  - `Solicitud FAO Nike Empresa`

  > Si el nombre del local tiene **varias palabras**, ponelo **entre paréntesis** o **entre guiones**
  > para que el sistema no lo corte. Si no coincide con un local cargado, la solicitud queda
  > **"Sin asignar"** y el Administrador lo asigna desde el detalle. El tipo define qué documentación
  > se le exige a cada persona (ver sección 9).
- **Excel de personas (opcional)**: si el email trae **un Excel adjunto** con las columnas **CUIL** y
  **Nombre completo** (formato *Nombre Apellido*), el sistema detecta esas columnas por su encabezado;
  si no hay encabezados, usa la **columna A = CUIL** y **columna B = Nombre**. Con cada fila crea/asocia
  a la persona (por CUIL, sin duplicar) dentro de la solicitud.
  **Si no hay Excel** (o no se puede leer), el email igual se procesa: la solicitud se crea con el local
  del asunto y queda **sin personas**, con un aviso en el detalle para cargarlas a mano
  (una por una o pegando una lista). Los adjuntos del email se ven igual desde la solicitud.
- **Reenvíos**: si el local reenvía documentación corregida (email nuevo con los mismos CUIL de una
  solicitud abierta del mismo local), la solicitud **anterior queda "Reemplazada"** y la nueva pasa a
  **Pendiente** para re-revisar. No se duplica.
- **Envío (SMTP)**: avisos automáticos de observación, autorización y rechazo.
- Con Gmail u Outlook se recomienda usar una **contraseña de aplicación** (no la contraseña normal).

## 9. Documentación por tipo de contratista (aprobación manual)

Según el tipo declarado en el asunto, a cada persona se le exige:

| Empresa | Monotributista |
|---|---|
| Formulario 931 | Seguro de Vida Colectivo (mín. $20.000.000) |
| Pago de ARCA | Pago del Monotributo |
| Nómina ART | — |
| Cláusula de No Repetición (a favor de Cencosud SA) | Cláusula de No Repetición (a favor de Cencosud SA) |

- La documentación llega **adjunta al email** y se ve **embebida** dentro de la solicitud.
- Para cada persona hay un **checklist**; Seguridad revisa y marca cada requisito como **✓ Aprobar**
  o **✕ Falta / Rechazar**. No hay detección automática: un requisito solo cuenta como cumplido al aprobarlo.
- **Vencimiento**: al aprobar un documento se puede cargar una **fecha de vencimiento**. Al llegar esa
  fecha el documento deja de valer, la persona **no puede ingresar** hasta renovarlo, y aparece en el
  panel (contador *Vencimientos*) y en **Reportes → Vencimientos**.
- Solo se puede **autorizar** a una persona cuando **todos sus requisitos obligatorios están aprobados y vigentes**.

## 10. Ejecución

```bash
npm start                 # producción (sirve el frontend compilado)
```
Luego abrir `http://127.0.0.1:4000`.

## 11. Tests

```bash
npm test
```
Cubren seguridad de archivos (ZIP Slip, extensiones), lectura del Excel de personas,
no-duplicación de personas por **CUIL**, verificación manual de documentación (un requisito solo
cuenta como cumplido al verificarlo), versionado de documentos, solicitudes creadas sin personas
(email sin Excel) y vigencia de autorizaciones por **rango de fechas**.

## 12. Backups

```bash
npm run backup        # o doble clic en Backup.bat
```
Copia la base de datos y la documentación a `storage/backups/backup_<fecha>` sin sobrescribir
backups anteriores.

## 13. Restauración

1. Detener el sistema (cerrar la ventana de `Iniciar.bat`).
2. Reemplazar el contenido de `storage/data` y `storage/documentos` por el del backup deseado.
3. Volver a iniciar.

## 14. Instalación en otra PC (Windows)

1. Copiar toda la carpeta del proyecto (sin `node_modules` ni `storage` si querés empezar limpio).
2. Instalar **Node.js LTS** en la PC destino.
3. Ejecutar `Instalar.bat` y luego `Iniciar.bat`.

> **Nota OneDrive**: si la carpeta está dentro de OneDrive, conviene excluir `node_modules` y
> `storage` de la sincronización para evitar lentitud.

## 15. Solución de problemas (Troubleshooting)

| Problema | Solución |
|---|---|
| "No se encontró Node.js" | Instalar Node.js LTS desde nodejs.org y reabrir `Instalar.bat`. |
| "Could not locate the bindings file" | La versión de Node no es compatible con `better-sqlite3`. Instalá Node **20, 22 o 24**, borrá `node_modules` y volvé a correr `Instalar.bat`. |
| El puerto 4000 está ocupado | Cambiar `PORT` en `.env`. |
| No lee emails | Revisar credenciales IMAP y usar contraseña de aplicación; probar conexión desde la app. |
| El email quedó en ERROR | No se pudo leer el email guardado o falló el procesamiento. Ver el detalle en Monitoreo. |
| La solicitud quedó sin personas | El email no traía Excel (o no se pudo leer). Cargalas a mano desde el detalle de la solicitud. |
| No revisa el buzón solo | Verificá en **Monitoreo** que el lector figure activo y con próxima revisión. Si dice "no está corriendo", falta el servidor IMAP o la frecuencia está en 0. |
| La solicitud quedó "Sin asignar" | El local del asunto no coincide con uno cargado. Asignalo desde el detalle de la solicitud. |
| Olvidé la contraseña de admin | Ver `docs/INSTALACION.md` (restablecer usuario). |

---

## Roles

- **Administrador**: gestiona usuarios, locales, tipos de documento, email, monitoreo, auditoría y backups;
  verifica documentación, autoriza / observa / rechaza / revoca, registra ingresos y salidas.
- **Seguridad**: consulta personas, verifica documentación, autoriza / observa / rechaza / revoca, registra ingresos y salidas.

## Seguridad

Autenticación por sesión (cookie httpOnly), contraseñas con **bcrypt**, credenciales de email
**cifradas** (AES-256-GCM), validación de entradas (Zod), protección contra **Zip Slip / path traversal**,
documentos servidos **solo** por rutas autenticadas (nunca por URL pública), y **auditoría** de todas las
acciones relevantes.

## Datos de demostración

Tras `npm run seed`:

- **admin@shopping.local** / `Admin1234` (Administrador)
- **seguridad@shopping.local** / `Seguridad1234` (Seguridad)

> Datos ficticios. No usar documentación ni CUIL reales en pruebas.
