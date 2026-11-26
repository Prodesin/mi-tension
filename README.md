# Mi tensión

App web instalable (PWA) para registrar la tensión arterial, pensada para Jorge Rodriguez Sobreira. Todo en español, sin backend, sin dependencias: solo HTML, CSS y JavaScript.

> **Orientativo: no sustituye a tu médico.** La clasificación (criterios ESC/ESH) es solo una ayuda visual.

## Qué hace

- **Hoy**: última lectura grande, barras frente al objetivo (alta < 130, baja < 80), medias de 7 y 30 días y formulario rápido.
- **Historial**: todas las lecturas, con editar y borrar (con confirmación). Aquí también están exportar e importar.
- **Evolución**: gráfico de sistólica y diastólica con líneas objetivo, medias y botón «Exportar PDF».
- Funciona sin conexión y se adapta al modo claro y oscuro del iPhone.
- La primera vez que se abre se precargan 8 lecturas (18–25 nov 2026). Solo ocurre una vez.

Los datos se guardan **solo en el `localStorage` del dispositivo**. Borrar los datos de Safari o desinstalar la app los elimina: haz copias de seguridad.

## Archivos

| Archivo | Función |
|---|---|
| `index.html`, `styles.css`, `app.js` | La app |
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

Tras cambiar archivos, sube el número de `CACHE_VERSION` en `sw.js` (por ejemplo `v2`) para que los dispositivos descarguen la versión nueva. Se aplica al abrir la app una o dos veces.

## Clasificación usada

En orden de prioridad: **Baja** (sis < 90 o dia < 60) · **Grado 3** (≥ 180 o ≥ 110) · **Grado 2** (≥ 160 o ≥ 100) · **Grado 1** (≥ 140 o ≥ 90) · **Por encima del objetivo** (≥ 130 o ≥ 80) · **Normal, en objetivo** (sis ≥ 120) · **Óptima, en objetivo** (el resto).
