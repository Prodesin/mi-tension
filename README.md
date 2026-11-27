# Mi tensión

App web instalable (PWA) para registrar la tensión arterial, pensada para Jorge Rodriguez Sobreira. Todo en español, sin dependencias: solo HTML, CSS y JavaScript. Desde la mudanza al Mac de casa sincroniza con el backend **Mis apps** (`/workspace/mis-apps`); sin conexión sigue funcionando con su caché local.

> **Orientativo: no sustituye a tu médico.** La clasificación (criterios ESC/ESH) es solo una ayuda visual.

## Qué hace

- **Hoy**: última lectura grande, barras frente al objetivo (alta < 130, baja < 80), medias de 7 y 30 días y formulario rápido.
- **Historial**: todas las lecturas, con editar y borrar (con confirmación). Aquí también están exportar e importar.
- **Evolución**: gráfico de sistólica y diastólica con líneas objetivo, medias y botón «Exportar PDF».
- Funciona sin conexión y se adapta al modo claro y oscuro del iPhone.
- **Aviso de la toma** (en Hoy, si no hay lectura de hoy, hora de Madrid): antes de las 13:30 suave («Hoy toca antes de comer.»), de 13:30 a 16:00 más visible («Es la hora: tómatela antes de comer.») y después suave («Hoy aún no la has apuntado…»).
- El **pulso es opcional** (Coco puede apuntar una medida sin él): se muestra «—» y no cuenta en las medias.
- Solo en la demo local sin backend (GitHub Pages sin red o `file://`) se precargan 8 lecturas de ejemplo (18–25 nov 2026). Servida desde el Mac, la app **no siembra nada**: lee del servidor.

## Dónde viven los datos (mudanza al Mac de casa)

Los datos **ya no viven solo en el teléfono**: la copia de referencia está en el Mac de casa (`https://air-prodesin.tail7b1127.ts.net:8445/mi-tension/`, solo con Tailscale) y el `localStorage` del dispositivo es una caché. Coco apunta medidas con `~/mi-tension/anadir.sh SIS DIA [PULSO] [NOTA]` en el Mac y aparecen en la app al sincronizar.

- **Sincronización** (`sync.js`): al abrir, al volver la red, al volver a la app y cada minuto se envían los cambios pendientes y se baja lo del servidor. Se fusiona sin duplicar: misma `id` = misma lectura; mismo minuto y mismos valores con otra `id` = la misma lectura (se queda la más completa).
- **Cola sin conexión** (`mi-tension:cola`): altas, ediciones y borrados hechos sin red se guardan y se envían al volver. Debajo del título se ve el estado («Sincronizado con el Mac de casa», «Sin conexión con el Mac: se enviará al volver (n pendientes)»).
- **Migración desde el `localStorage` antiguo**: la primera vez que esta versión se abre con el Mac alcanzable (iPhone con Tailscale), sube todo lo que hay en el dispositivo (upsert sin duplicar) y deja la marca `mi-tension:migrado`. Un cambio posterior se sincroniza por la cola. Si no hubo red, se reintenta; no se pierde nada.
- **Origen antiguo (GitHub Pages)**: muestra un **aviso de mudanza** con el enlace nuevo. Debe abrirse **una vez con Tailscale** para subir lo que ya tienes, y no conviene borrar el icono antiguo hasta ver las lecturas en la nueva. Desde Pages solo se pueden **subir** lecturas (alta/edición); los borrados se hacen en la versión del Mac (en Pages se quedan en local).
- **Mismo código en los dos sitios**: `app.js` y `sync.js` detectan dónde están (`github.io` → API absoluta de Tailscale; servida por Mis apps → `/api/...` relativo, con cookie de sesión httpOnly, sin token en el JS). `/workspace/mis-apps/scripts/sincronizar-apps.sh` copia estos ficheros a `mis-apps/apps/mi-tension/`; este repositorio es la fuente de verdad.
- Para pruebas y capturas se puede fijar «ahora» con `window.__MT_NOW` (ms o fecha ISO).

Exportar/importar JSON se mantiene igual (el servidor también exporta: `/api/mi-tension/exportar`). Haz copias de vez en cuando: el Mac hace una diaria a las 04:45.

## Archivos

| Archivo | Función |
|---|---|
| `index.html`, `styles.css`, `app.js` | La app |
| `sync.js` | Sincronización con el backend, fusión y cola sin conexión (se prueba con Node en `mis-apps/tests`) |
| `manifest.webmanifest` | Datos de instalación (PWA) |
| `sw.js` | Service worker (modo sin conexión) |
| `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | Iconos |
| `make_icons.py` | Script que genera los iconos (necesita Pillow) |

Para regenerar los iconos: `python3 make_icons.py`.

## Probar en local

```bash
cd mi-tension
python3 -m http.server 8080
```

Abre <http://127.0.0.1:8080>. En el ordenador funciona con `http://127.0.0.1` o `localhost`, pero **en el iPhone hace falta HTTPS** (no vale la IP de tu red local por HTTP para el modo sin conexión ni para instalar como app).

## Publicarla por HTTPS

La app son archivos estáticos con rutas relativas: sirve desde la raíz o desde un subdirectorio.

**GitHub Pages**
1. Crea un repositorio y sube estos archivos.
2. En *Settings → Pages*, elige la rama `main` y la carpeta `/ (root)`.
3. Tu dirección será `https://TU-USUARIO.github.io/NOMBRE-REPO/`.

**Netlify Drop**
1. Entra en <https://app.netlify.com/drop>.
2. Arrastra la carpeta `mi-tension`.
3. Obtendrás una dirección `https://…netlify.app`.

Vale cualquier otro hosting estático con HTTPS.

## Instalarla en el iPhone

1. Abre la dirección HTTPS en **Safari**.
2. Pulsa el botón **Compartir** (cuadrado con flecha hacia arriba).
3. Elige **«Añadir a pantalla de inicio»** y pulsa **Añadir**.

Se abrirá a pantalla completa, como una app.

## iPhone Duo (plegable) y otras pantallas

Medidas reales (puntos = px CSS, escala 3x; simulador iOS 27.1 y kit Figma iOS 27):

| Pantalla | Viewport | Navegación | Contenido |
|---|---|---|---|
| iPhone normal | 390×844 | tab bar abajo | 1 columna |
| Exterior vertical | 466×678 | rail 84 px a la derecha | 1 columna compacta, 382 px útiles |
| Exterior horizontal | 678×466 | rail 84 px (lado de la cámara) | 1 columna compacta |
| Interior apaisado (al abrir) | 951×669 | rail 84 px | 2 columnas: lectura + formulario + medias, gráfico + historial |
| Interior vertical | 669×951 | tab bar abajo (sin rail) | 2 columnas a todo el ancho |
| Split View estrecho | < 430 px | tab bar abajo | 1 columna |

- **Rail**: ocupa la franja de 84 pt del sistema, `max(84px, env(safe-area-inset-<lado>))`, y **no se suma** al safe area. Pestañas abajo y ~56 px libres arriba para reloj/cámara. En horizontal va al lado donde esté el safe area grande (sondeo de `env()` → `data-rail`).
- **Sin huecos**: no hay `max-width` centrado; el contenido usa todo el ancho (14–16 px al borde libre, 0 junto al rail). El fondo llega al borde.
- Dos layouts base (compacto / regular): al plegar, abrir o girar el layout se expande y no se pierde lo escrito (el formulario no se recrea).
- Safe areas independientes por lado en cabecera, contenido, rail, tab bar, toasts y diálogos.

## Exportar e importar datos

En **Historial → Copia de seguridad**:
- **Exportar datos** descarga `mi-tension-AAAA-MM-DD.json`.
- **Importar datos** abre el selector de archivos. La importación **fusiona**: añade lecturas nuevas y actualiza las que tengan el mismo `id`; no borra las existentes. Las lecturas no válidas se omiten y se avisa.

Formato del JSON:

```json
{
  "app": "mi-tension",
  "version": 1,
  "timezone": "Europe/Madrid",
  "exportedAt": "2026-11-26T09:00:00.000Z",
  "readings": [
    { "id": "seed-2026-11-25", "datetime": "2026-11-25T13:21:00+01:00",
      "systolic": 136, "diastolic": 92, "pulse": 88, "note": "" }
  ]
}
```

`datetime` es ISO 8601 con el desfase de Madrid (+01:00 en invierno, +02:00 en verano).

## Exportar el PDF

En **Evolución**, elige el periodo (7 días, 30 días o Todo) y pulsa **Exportar PDF**. Se abre la ventana de impresión con un informe limpio (nombre, periodo, medias, tabla y aviso). Elige **Guardar como PDF** (en iPhone: Compartir → Guardar en Archivos, o imprime y guarda). Si lo imprimes, queda en A4, texto negro sobre blanco.

## Actualizar la app

Tras cambiar archivos, sube el número de `CACHE_VERSION` en `sw.js` (ahora es `v4`; la siguiente, `v5`) para que los dispositivos descarguen la versión nueva. Se aplica al abrir la app una o dos veces. El service worker no cachea nunca `/api/*`.

## Clasificación usada

En orden de prioridad: **Baja** (sis < 90 o dia < 60) · **Grado 3** (≥ 180 o ≥ 110) · **Grado 2** (≥ 160 o ≥ 100) · **Grado 1** (≥ 140 o ≥ 90) · **Por encima del objetivo** (≥ 130 o ≥ 80) · **Normal, en objetivo** (sis ≥ 120) · **Óptima, en objetivo** (el resto).
