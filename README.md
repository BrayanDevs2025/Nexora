# Mi Centro de Control — versión publicable (Vercel + Supabase)

Tu aplicación **Mi Centro de Control** convertida en una web que puedes abrir desde el computador, el celular o una tablet, con tus datos guardados en tu cuenta y sincronizados entre dispositivos.

> **Publicar la página y sincronizar los datos son dos cosas distintas.**
> - **Vercel** publica la página (el diseño y la lógica).
> - **Supabase** guarda tus datos y gestiona tu cuenta (correo y contraseña).
> Por eso necesitas configurar las dos.

---

## 1. Qué incluye y cómo funciona

- **Tu aplicación, sin rehacer:** mismas secciones, diseño y lógica (Inicio, Mi día, Salud, Finanzas, Empresa, Proyecto, Vida, Calendario, Objetivos, Reportes, Ajustes). Sigue siendo HTML + CSS + JavaScript, sin React ni otro framework.
- **Cuentas:** crear cuenta, iniciar sesión, cerrar sesión y recuperar contraseña por correo.
- **Sincronización:** tus datos se guardan en la nube asociados a tu cuenta. Lo que registras en el celular aparece en el computador y viceversa. El otro dispositivo se actualiza **al volver a la ventana/app o, como máximo, cada ~20 segundos** si la tienes abierta (no es instantáneo).
- **Estado visible:** una etiqueta (abajo a la izquierda en el computador, arriba a la derecha en el celular) muestra: *Sincronizado*, *Sincronizando…*, *Cambios sin subir*, *Sin conexión*, *Error* o *Conflicto*.
- **Sin conexión:** si pierdes internet, la app sigue abriéndose con la copia guardada en ese dispositivo. Tus cambios quedan marcados como pendientes y se suben solos al volver la conexión.
- **No se pisan datos entre dispositivos:** cada subida comprueba la versión de la nube. Si otro dispositivo cambió algo mientras tú estabas sin conexión, **no se sobrescribe nada**: la app te muestra un aviso y eliges qué versión conservar.
- **Copias de seguridad en la nube:** automática (máx. 1 cada 20 h) y antes de cualquier reemplazo (importar, empezar desde cero, restaurar, resolver conflicto). Se conservan las últimas 30. Se restauran desde *Ajustes → Cuenta → Copias de seguridad*.
- **Instalable en el celular (PWA):** ícono propio y pantalla completa.
- **Novedad:** se completó el registro de **hidratación** (vasos de agua) en Salud, que figuraba en tu lista y no existía.

### Cómo se guardan los datos (importante entender)
Los datos se guardan como **un documento por cuenta** (tabla `user_state`) con un número de versión, más las copias de seguridad (`state_snapshots`). Es la forma más sencilla que conserva toda tu aplicación tal cual. La contrapartida: si dos dispositivos cambian cosas distintas a la vez estando desconectados, **no se combinan automáticamente**; se te pide elegir una versión (la otra queda guardada como copia).

---

## 2. Lo que necesitas

Tres cuentas gratuitas (el correo que quieras): **GitHub**, **Supabase** y **Vercel**. Toda la configuración se hace desde el navegador, sin instalar programas.

> Los nombres de botones de los paneles de Supabase/Vercel/GitHub cambian de vez en cuando; si algo no coincide exactamente, busca el equivalente.

---

## 3. Paso a paso

### Paso 1 — Crear el proyecto en Supabase
1. Entra a <https://supabase.com> → **Start your project** → inicia sesión (puedes usar tu cuenta de GitHub).
2. **New project**: ponle nombre (p. ej. `centro-de-control`), elige una **contraseña de base de datos** (guárdala; esta app no la usa) y la región más cercana. Espera 1–2 minutos a que termine.
3. En el menú izquierdo abre **SQL Editor → New query**.
4. Abre el archivo **`supabase/schema.sql`** de este proyecto, copia **todo** su contenido, pégalo en el editor y pulsa **Run**. Debe responder *Success*. (Se puede ejecutar de nuevo sin problema.)
5. Comprueba en **Table Editor** que existen `user_state` y `state_snapshots` y que ambas muestran **RLS enabled**.
6. Ve a **Project Settings → API** y copia dos datos (los necesitarás en el Paso 3):
   - **Project URL** (algo como `https://abcdefgh.supabase.co`)
   - La clave **pública**: *anon public* (o *publishable*).
   - ⛔ **Nunca** uses la clave `service_role` ni `secret`. Esa es privada. (El proyecto se niega a construirse si detecta una.)

### Paso 2 — Subir el proyecto a GitHub (repositorio privado)
1. Descomprime el ZIP en tu computador.
2. En <https://github.com> → **New repository** → nombre `centro-de-control` → marca **Private** → **Create repository**.
3. En la página del repositorio vacío pulsa **uploading an existing file**.
4. Arrastra **el contenido** de la carpeta descomprimida (los archivos y carpetas de adentro: `public`, `scripts`, `supabase`, `tests`, `package.json`, `vercel.json`, `README.md`, `.gitignore`, `.env.example`…), **no** la carpeta contenedora. Si no ves los archivos que empiezan por punto (`.gitignore`, `.env.example`), activa "mostrar archivos ocultos" en tu sistema; si no se suben, la app funciona igual.
5. Pulsa **Commit changes**.
6. ⚠️ **No subas** archivos `.env`, `config.js` ni claves. El ZIP no los contiene.

### Paso 3 — Publicar en Vercel
1. Entra a <https://vercel.com> → **Sign up** con tu cuenta de GitHub.
2. **Add New… → Project** → elige tu repositorio `centro-de-control` → **Import**.
3. En **Framework Preset** deja *Other*. Las órdenes de construcción ya vienen en `vercel.json`; no cambies nada de *Build & Output*.
4. Abre **Environment Variables** y agrega **dos** variables (marca Production, Preview y Development):

   | Nombre | Valor |
   |---|---|
   | `SUPABASE_URL` | el *Project URL* del Paso 1 |
   | `SUPABASE_ANON_KEY` | la clave **anon/publishable** del Paso 1 |

5. Pulsa **Deploy**. En ~1 minuto Vercel te da una dirección como `https://centro-de-control-tunombre.vercel.app`.
6. Si agregas o cambias las variables **después** del primer despliegue: *Deployments → ⋯ → Redeploy* (se leen al construir).
7. Si el despliegue falla, abre el registro: el script de construcción dice en español qué falta (variable ausente, URL inválida o clave secreta).

### Paso 4 — Volver a Supabase para autorizar tu dirección
1. En Supabase: **Authentication → URL Configuration**.
2. **Site URL**: pega tu dirección de Vercel (`https://….vercel.app`).
3. En **Redirect URLs** agrega la misma dirección (y `https://….vercel.app/**`).
4. Guarda. Esto hace que los enlaces de los correos (confirmar cuenta, recuperar contraseña) abran tu app.

### Paso 5 — Crear tu cuenta y empezar
1. Abre tu dirección de Vercel → **Crear cuenta** → correo y contraseña (mínimo 8 caracteres).
2. Si Supabase tiene activada la confirmación por correo (viene activada por defecto), abre el correo y confirma; luego entra. *Si el correo tarda: el servicio de correo gratuito de Supabase tiene límites; revisa spam, espera unos minutos, o desactiva "Confirm email" en Authentication → Sign In / Providers → Email si es solo para uso personal.*
3. La primera vez eliges: **Empezar desde cero**, **Ver datos de demostración** o (si hay datos locales en ese navegador) **Importar**.

### Paso 6 — Migrar los datos que ya tienes en la versión anterior
La versión anterior guardaba los datos en **su propio navegador/página**; el navegador no los comparte con la nueva dirección de Vercel. Por eso la ruta segura es:
1. Abre la **versión anterior**, ve a **Ajustes → Exportar JSON** (se descarga un archivo).
2. Abre la **nueva** app con tu cuenta → **Ajustes → Importar JSON** → elige ese archivo y acepta la confirmación.
3. Antes de reemplazar, la app guarda una copia de seguridad de lo que hubiera en la nube. Comprueba que ves tus datos.

> La detección automática de datos locales (botón *Importar los datos de este navegador*) solo aparece si la versión anterior se abrió **desde esta misma dirección web**. Los datos locales **no se borran** hasta que tú lo pidas (*Ajustes → Borrar copia local anterior*, solo después de una importación verificada).

### Paso 7 — Instalarla en el celular
- **Android (Chrome):** abre tu dirección → menú ⋮ → **Instalar app** / **Añadir a pantalla de inicio**.
- **iPhone (Safari):** abre tu dirección → botón Compartir → **Añadir a pantalla de inicio**.
- Inicia sesión con **la misma cuenta** que en el computador.

### Paso 8 — Comprobar que se sincroniza (hazlo tú, una vez)
1. En el **celular**: *Vida → Hábitos →* marca un hábito como **Hecho**. Espera a que la etiqueta diga **Sincronizado**.
2. En el **computador** (con la app abierta): vuelve a la ventana o espera ~20 s; aparece un aviso "Datos actualizados desde otro dispositivo" y el hábito marcado.
3. En el **computador**: registra un movimiento en *Finanzas*. En el celular, abre/vuelve a la app y compruébalo.
4. Prueba sin conexión: modo avión en el celular → registra algo → la etiqueta dice *Sin conexión / Cambios sin subir* → quita el modo avión → pasa a *Sincronizado*.
5. Revisa en Supabase (*Table Editor → user_state*) que existe **una fila** con tu usuario.

---

## 4. Seguridad: qué está hecho y qué te toca

**Está hecho (y probado en un PostgreSQL local, ver sección 6):**
- Las dos tablas tienen **RLS activado**: cada usuario solo puede leer/escribir **sus** filas; sin sesión no hay acceso; nadie puede borrar `user_state` ni modificar copias de seguridad desde la app.
- El servidor rechaza escrituras con versión desactualizada o saltada.
- En la web solo hay la **URL** y la **clave pública**. El script de construcción **se niega** a usar una clave `service_role` o `sb_secret_…`.
- El *service worker* solo guarda archivos estáticos públicos; **nunca** datos ni respuestas de Supabase. Al cerrar sesión se borra la copia local de esa cuenta en ese dispositivo.
- Cabeceras básicas en `vercel.json` (`X-Frame-Options`, `nosniff`, etc.).

**Te toca a ti / recomendado:**
- La clave pública es pública **por diseño**; lo que protege los datos es el SQL con RLS. **No omitas el Paso 1.4.**
- Cuando hayas creado tu cuenta, desactiva nuevos registros si solo la usarás tú: Supabase → *Authentication → Sign In / Providers →* "Allow new users to sign up" (el nombre puede variar). Así nadie más puede crear cuentas en tu proyecto.
- Usa una contraseña larga y única. Mantén el repositorio **privado**.
- **No** se aplicó una *Content-Security-Policy* estricta porque no pude probarla en un navegador real de producción y un error dejaría la app en blanco. Es una mejora opcional.
- En un dispositivo compartido, usa **Cerrar sesión** al terminar.
- Plan gratuito de Supabase: los proyectos inactivos pueden **pausarse** tras un tiempo (consulta el plazo vigente) y hay que reactivarlos. Revisa también los términos del plan gratuito de Vercel si lo usarás con fines comerciales.

---

## 5. Límites conocidos (sin maquillar)

- **Sincronización por documento:** no hay fusión automática entre dispositivos; ante conflicto eliges una versión (la otra se guarda como copia).
- **No es en tiempo real:** el otro dispositivo se entera al volver a la ventana o en ≤ ~20 s con la app abierta.
- **Sin conexión:** se pueden **leer y registrar** datos, pero no iniciar sesión ni crear cuenta. Si la sesión caduca estando sin conexión, se abre la copia local y se renueva al volver internet.
- **Una pestaña por navegador:** no abras la app en dos pestañas del mismo navegador a la vez.
- **Tamaño:** el documento tiene un tope de 4 MB (hay margen para años de uso normal).
- **Recordatorios y notificaciones push** no están implementados (el calendario y las alertas de "Lo que necesita atención" sí funcionan dentro de la app).
- **Perfil físico:** se guarda y sincroniza, pero el generador de rutinas todavía solo usa nivel, tiempo e historial.
- Limitaciones de la versión anterior que se mantienen: algunas áreas cuentan el mismo entrenamiento en Vida y Salud; no hay historial unificado único.
- Desde la 1.ª versión: el progreso nunca se sube a mano; los objetivos sin medición no se pueden marcar como completados.

---

## 6. Lista de comprobación

### ✅ Verificado por mí (en mi entorno de pruebas)
| Prueba | Cómo |
|---|---|
| `schema.sql` se ejecuta y es repetible | PostgreSQL 16 local |
| **RLS**: A no lee, modifica, inserta ni borra datos de B; sin sesión y rol `anon` sin acceso; solo versión siguiente; copias inmutables y limitadas a 30; borrado en cascada | 30 comprobaciones SQL (`tests/rls_test.py`) |
| La app arranca, las 11 secciones se muestran y no hay errores de JavaScript | Chromium real |
| Registro, inicio y cierre de sesión (cierra solo ese dispositivo); mensajes de error en español | Chromium + Supabase simulado |
| Los datos sobreviven a la recarga | Chromium |
| Un hábito/movimiento hecho en un dispositivo aparece en otro | 2 contextos de navegador + PostgreSQL real |
| Sin conexión: cambios pendientes, apertura con copia local, subida al volver; sesión caducada sin red | Chromium |
| Conflicto entre dispositivos: no sobrescribe; ambas elecciones funcionan; copia previa guardada | Chromium + PostgreSQL |
| Dos cuentas en el mismo dispositivo no ven los datos de la otra | Chromium |
| Importar datos locales / JSON: confirma antes de reemplazar, no duplica, guarda copia previa, **no borra lo local** | Chromium |
| Meta financiera vinculada a objetivo: mismo progreso, ahorro sin doble conteo | Chromium |
| Móvil (390 px): sin desbordamiento horizontal en las 11 secciones | Chromium |
| PWA: manifest, iconos, *service worker* activo, la caché solo contiene archivos estáticos propios, abre sin internet | Chromium |
| El script de construcción rechaza: sin variables, URL inválida, `service_role`, `sb_secret_`; acepta `anon` | Node (con la librería simulada) |

Resultado: **94 comprobaciones de navegador y 30 de SQL, todas correctas**, repetidas varias veces (se corrigió una condición de carrera de la propia prueba).

### ⚠️ NO verificado (lo debes comprobar tú tras configurar tus cuentas)
1. Que `npm install` + `npm run build` funcionen **en Vercel** con la librería oficial `@supabase/supabase-js` (aquí no pude descargarla; usé una librería simulada con la misma interfaz).
2. El servicio **real** de Supabase Auth: correo de confirmación, enlace de recuperación de contraseña, redirecciones del Paso 4.
3. Que el SQL funcione en **tu** proyecto Supabase (aquí se probó en PostgreSQL 16 con `auth.uid()` simulado).
4. La sincronización con la red real y la **instalación en iPhone/Android** (aquí probé con un Chromium de escritorio simulando pantalla móvil).
5. Rendimiento con muchos meses de datos.
6. La prueba del **Paso 8** completa.

Si algo del 1–3 falla, el mensaje de error de Vercel/Supabase indica la causa; las más probables están en la sección 7.

---

## 7. Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| Vercel: "SUPABASE_URL falta o no es válida" | Falta la variable o tiene espacios/slash; corrígela y *Redeploy*. |
| Vercel: "Esa clave es SECRETA…" | Pusiste `service_role`/`secret`. Usa la clave **anon/publishable**. |
| Vercel: "No se encontró @supabase/supabase-js" | `package.json` no se subió a GitHub. |
| La app muestra "La sincronización no está configurada" | Las variables no estaban al construir. Agrégalas y *Redeploy*. |
| "Faltan las tablas en Supabase" | No ejecutaste `supabase/schema.sql` (Paso 1.4). |
| "El servidor rechazó la operación (permisos)" | El SQL se ejecutó incompleto. Vuelve a ejecutarlo entero. |
| No llega el correo de confirmación | Spam, límites del correo gratuito, o desactiva "Confirm email" (uso personal). |
| El enlace del correo abre otra dirección | Corrige *Site URL / Redirect URLs* (Paso 4). |
| Etiqueta "Conflicto" | Normal si usaste dos dispositivos sin conexión: elige una versión; la otra queda en copias de seguridad. |
| Etiqueta "Error al sincronizar" | Pasa el cursor para ver el detalle. Se reintenta solo. Tus datos siguen guardados en el dispositivo. |

---

## 8. Estructura del proyecto

```
public/                 ← lo que se publica
  index.html            Página
  css/styles.css        Estilos (tu diseño original + cuenta/sincronización)
  js/app.js             Tu aplicación (lógica y pantallas)
  js/sync.js            Cuentas, copia local, sincronización, conflictos, copias de seguridad
  sw.js                 Service worker (solo archivos estáticos)
  manifest.webmanifest  PWA
  icons/                Iconos
  (config.js y js/vendor/supabase.js los genera "npm run build"; no se suben)
scripts/build.mjs       Valida variables, genera config.js, copia la librería de Supabase
supabase/schema.sql     Tablas + RLS + triggers (ejecutar en Supabase)
vercel.json             Construcción y cabeceras
package.json            Dependencia: @supabase/supabase-js
.env.example            Plantilla de variables (sin secretos)
tests/                  Pruebas opcionales (RLS y navegador)
```

## 9. Desarrollo local (opcional)
```bash
cp .env.example .env     # edita con tus valores (nunca lo subas)
npm install
export $(grep -v '^#' .env | xargs) && npm start      # http://localhost:3000
# solo modo local, sin cuentas:  npm run local
```
Pruebas (requieren PostgreSQL y Playwright): `python3 tests/rls_test.py <socket> <puerto>` y `NODE_PATH=<playwright> node tests/e2e.cjs <socket> <puerto>`.
#   N e x o r a  
 