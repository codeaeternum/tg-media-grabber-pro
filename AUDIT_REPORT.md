# Auditoría completa — TG Media Grabber Pro

**Fecha:** Marzo 2025  
**Alcance:** Backend (service worker, content script, injected), Frontend (popup + UI inyectada), UX/UI y calidad de código.

---

## 1. Resumen ejecutivo

El proyecto es una **extensión Chrome (Manifest V3)** que descarga medios desde Telegram Web (versiones K y A). La auditoría identifica **fortalezas** (doble estrategia de descarga, soporte K/A, bypass de restricciones) y **áreas de mejora** en seguridad, mantenibilidad, UX y accesibilidad.

**Hallazgos críticos:** 1 (CSS no definido)  
**Hallazgos importantes:** 8  
**Recomendaciones:** 25+

---

## 2. Backend / Lógica de la extensión

### 2.1 Fortalezas

- **Doble estrategia de descarga:** API de Telegram (`appDownloadManager`) + fallback por fetch con Range y reintentos.
- **Detección de versión K/A** bien aislada con selectores por versión (`SEL`).
- **Protección XSS:** Uso de `escapeHtml` en popup y content antes de `innerHTML`.
- **Sanitización de nombres de carpeta/archivo:** caracteres prohibidos y nombres reservados de Windows.
- **Límites de almacenamiento:** historial 200, `downloadedMids` 5000, evitando desbordes.
- **AbortController** para cancelar descargas y escaneos.
- **Reintentos con backoff** en descargas por chunks (injected.js).

### 2.2 Problemas y mejoras

#### Seguridad

| # | Problema | Ubicación | Recomendación |
|---|----------|-----------|---------------|
| 1 | **postMessage con `"*"`** — Cualquier origen puede enviar mensajes al content/injected. | `content.js`, `injected.js` | Validar `event.origin` (p. ej. `location.origin` o lista blanca). En content, comprobar que el mensaje viene de la misma página. |
| 2 | **URL del formulario de feedback** — Google Form URL y entry IDs en código. | `popup.js` L319-321 | Mover a `manifest.json` (no ideal) o a un único objeto de config; documentar que deben reemplazarse para producción. |
| 3 | **Logs en producción** — `console.log/warn` con prefijo `[TG Grabber]` en todo el flujo. | Todos los JS | Añadir nivel de log (ej. `DEBUG`) y no loguear en build de producción o detrás de una opción “Modo desarrollador”. |

#### Robustez y errores

| # | Problema | Ubicación | Recomendación |
|---|----------|-----------|---------------|
| 4 | **sendResponse asíncrono** — En `background.js` se llama `sendResponse` dentro de callbacks de `chrome.downloads.search`/`download`; si el callback tarda, el canal puede cerrarse. | `background.js` | Devolver `true` desde el listener para mantener el canal abierto cuando la respuesta sea asíncrona (ya se hace en download; verificar que no falte en otros casos). |
| 5 | **Falta de timeout en ping** — El popup hace `send({ action: "ping" })` sin timeout; si la pestaña no inyecta content, el estado queda en “Connecting...”. | `popup.js` | Añadir timeout (ej. 2–3 s) y mostrar “Abre web.telegram.org” o “No response” si no hay respuesta. |
| 6 | **Manejo de `chrome.runtime.lastError` en popup** — Se comprueba en `send()` pero no se muestra mensaje claro al usuario. | `popup.js` | Mostrar un mensaje breve en la UI (ej. “No se pudo conectar con la pestaña”) cuando `cb(null)` por error. |

#### Performance y memoria

| # | Problema | Ubicación | Recomendación |
|---|----------|-----------|---------------|
| 7 | **content.js muy grande** — ~3000 líneas en un solo archivo; difícil de mantener y depurar. | `js/content.js` | Dividir en módulos lógicos (detection.js, download.js, gallery.js, bulk.js, messages.js) y concatenar en build, o usar import/export si el entorno lo permite. |
| 8 | **Revocación de blob URLs** — `setTimeout(..., 8000)` para revocar; si hay muchas descargas rápidas, puede haber picos de memoria. | `content.js` downloadBlob | Considerar revocar en el callback de `sendMessage` cuando la descarga se haya encolado, o usar una cola de revocación con delay más corto. |
| 9 | **Polling de API en injected.js** — `setInterval(..., 500)` hasta 30 s. | `injected.js` | Reducir frecuencia tras los primeros segundos (ej. 500 ms → 1 s → 2 s) para bajar uso de CPU en páginas que cargan lento. |

#### Mantenibilidad

| # | Problema | Ubicación | Recomendación |
|---|----------|-----------|---------------|
| 10 | **Números mágicos** — Límites 200, 5000, 500, 120000, etc. repartidos por el código. | Varios | Centralizar en un objeto `CONFIG` o constantes al inicio (ej. `MAX_HISTORY = 200`, `DOWNLOAD_TIMEOUT_MS = 120000`). |
| 11 | **Versiones en comentarios** — “v2”, “v3”, “v4.0” en distintos archivos. | Todos | Usar una sola fuente de verdad (ej. `manifest.json` version) y, si hace falta, leerla en runtime para logs. |
| 12 | **Sin tests** — No hay tests automatizados. | Repo | Añadir tests unitarios para: sanitización de nombres, `extractFileName`, `nameKey`, `escapeHtml`, y tests de integración mínimos para el flujo popup → content (por ejemplo con Puppeteer o similar). |

---

## 3. Frontend — Popup

### 3.1 Fortalezas

- **Sistema de diseño** con variables CSS (`:root`) coherentes (colores, radios, sombras).
- **Estados visuales** claros: loading (spinner), disabled, hover.
- **Feedback de progreso** con barra, porcentaje, ETA y nombre de archivo.
- **Panel de ajustes colapsable** y historial colapsable, reduciendo ruido visual.

### 3.2 Bugs

| # | Problema | Ubicación | Acción |
|---|----------|-----------|--------|
| 13 | **Variable CSS inexistente** — `.fb-modal` usa `var(--bg-secondary)` que no está definida en `:root`. | `css/popup.css` L439 (aprox.) | Definir `--bg-secondary` en `:root` (ej. igual a `--bg-card`) o reemplazar por `var(--bg-card)`. |

### 3.3 UX / UI

| # | Problema | Recomendación |
|---|----------|---------------|
| 14 | **Cards de tipo (Photos/Videos/GIFs)** — No se persiste la selección entre aperturas del popup. | Guardar `selectedTypes` en `chrome.storage.local` y restaurar al abrir (igual que el resto de opciones). |
| 15 | **“Download All” deshabilitado** — Si no hay scan reciente, el botón queda disabled sin explicación. | Mostrar tooltip o texto breve: “Escanea primero” o “Haz Scan para ver medios”. |
| 16 | **Idioma mezclado** — Mensajes en inglés (“Connecting...”, “Scan”) y en español (“No pudo abrir la sidebar”). | Unificar idioma (es/en) y/o preparar i18n con `chrome.i18n` y `_locales`. |
| 17 | **Feedback del formulario** — Con `mode: "no-cors"` no se puede saber si el envío falló. | Mostrar “Enviado” asumiendo éxito; opcionalmente intentar un endpoint que devuelva CORS para confirmar. |
| 18 | **Atajos de teclado** — No se muestran en el popup. | Añadir una línea bajo los botones: “Atajos: Ctrl+Shift+D (descargar), Ctrl+Shift+G (galería)”. |

### 3.4 Accesibilidad

| # | Problema | Recomendación |
|---|----------|---------------|
| 19 | **Foco en modal de feedback** — Al abrir el modal, el foco no va al textarea ni se captura Tab. | Al abrir: `fbMessage.focus()`; considerar `aria-modal="true"` y trap de foco (Tab cicla dentro del modal). |
| 20 | **Toggles sin etiqueta para lectores de pantalla** — Los divs `.toggle` no son botones ni tienen `role="switch"`. | Usar `<button type="button" role="switch" aria-checked="true/false">` o añadir `aria-label` a los contenedores actuales. |
| 21 | **Barra de progreso** — No hay `role="progressbar"` ni `aria-valuenow` / `aria-valuemin` / `aria-valuemax`. | Añadir en el contenedor de la barra: `role="progressbar"`, `aria-valuenow`, `aria-valuemin="0"`, `aria-valuemax="100"`. |
| 22 | **Botones solo con icono** — “Settings” solo tiene `title`. | Mantener `title` y añadir `aria-label="Abrir configuración"` (o equivalente). |

---

## 4. Frontend — UI inyectada (Telegram Web)

### 4.1 Estilos (`css/styles.css`)

- **Consistencia:** Variables `--primary-gradient`, `--glass-bg` alineadas con el popup.
- **Selectores K y A** bien agrupados para botones y hover.

**Mejoras:**

| # | Problema | Recomendación |
|---|----------|---------------|
| 23 | **Z-index muy altos** — 100000, 100002, 100003. | Revisar si Telegram usa capas por encima; si no, bajar a valores más bajos (ej. 9999) para evitar conflictos con otras extensiones. |
| 24 | **Contraste en chips de galería** — `.tg-gallery-chip` con color `#8b949e` sobre fondos oscuros. | Comprobar ratio de contraste (WCAG 4.5:1) y subir claridad si hace falta. |
| 25 | **Toasts y galería en pantallas pequeñas** — `min-width: 280px` y paddings fijos. | Añadir `max-width: 100vw` y padding responsive para móvil/ventanas pequeñas. |

### 4.2 Contenido generado desde content.js

- Botones con SVG inline; estados `.downloading` y `.done` claros.
- **Riesgo:** Si algún nombre de chat o nombre de archivo llegara sin escapar al DOM (p. ej. en galería o historial inyectado), podría haber XSS. En el código revisado se usa `escapeHtml`; asegurarse de que **todo** contenido dinámico pase por él.

---

## 5. Manifest y configuración

| # | Observación | Recomendación |
|---|-------------|---------------|
| 26 | **Permisos** — `notifications` y `downloads` están justificados por la funcionalidad. | Mantener; documentar en la descripción de la extensión para transparencia. |
| 27 | **CSP** — Solo extension pages; content scripts no están restringidos por esta CSP. | Correcto; no relajar CSP. |
| 28 | **Sin optional_host_permissions** — Si en el futuro se añadieran más orígenes, usar permisos opcionales donde sea posible. | Valorar para futuras versiones. |

---

## 6. Plan de acción priorizado

### Crítico (hacer ya)

1. **Corregir `--bg-secondary`** en `popup.css` (definir variable o usar `--bg-card`).

### Alta prioridad

2. Validar origen en `postMessage` (content + injected).  
3. Persistir tipos seleccionados (Photos/Videos/GIFs) en el popup.  
4. Timeout y mensaje claro cuando el popup no recibe respuesta al ping.  
5. Mejorar accesibilidad: barra de progreso (ARIA), toggles (role/aria-checked), foco en modal.  
6. Unificar idioma o preparar i18n.

### Media prioridad

7. Extraer constantes y configuración (CONFIG).  
8. Documentar/reducir logs en producción.  
9. Mensaje cuando “Download All” está deshabilitado (tooltip o texto).  
10. Mostrar atajos de teclado en el popup.  
11. Revisar z-index de overlay/toast/galería.

### Baja prioridad / refactor

12. Dividir `content.js` en módulos.  
13. Tests unitarios (sanitización, helpers).  
14. Ajustar polling en injected.js (backoff).  
15. Cola/revocación de blob URLs más controlada.

---

## 7. Checklist rápida

- [x] Definir o reemplazar `--bg-secondary` en popup.css  
- [x] Validar `event.origin` en listeners de `postMessage` (content.js + injected.js)  
- [x] Persistir y restaurar `selectedTypes` en popup  
- [x] Timeout en ping del popup (2,5 s + mensaje claro)  
- [x] ARIA en barra de progreso y toggles (`role="progressbar"`, `role="switch"`, `aria-checked`)  
- [x] Foco en textarea al abrir modal de feedback; `aria-modal` y `aria-hidden`  
- [x] Unificar idioma (mensajes de toast en content.js en inglés)  
- [x] Constantes en un solo lugar: `CONFIG` en `content.js`  
- [x] Documentar atajos en la UI (línea `.shortcuts-hint` en popup)  
- [x] Revisar z-index de la UI inyectada (reducidos a 9999–10002 en styles.css)  

Si quieres, el siguiente paso puede ser implementar los puntos críticos y de alta prioridad en el código (empezando por el bug de CSS y la validación de `postMessage`).
