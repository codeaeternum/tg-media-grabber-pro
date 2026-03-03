# TG Media Grabber Pro — Contexto para IA / futuras referencias

Documento de contexto del proyecto para sesiones de IA y desarrollo futuro. Actualizar aquí decisiones, estructura y convenciones.

---

## 1. Qué es el proyecto

**TG Media Grabber Pro** es una **extensión de Chrome (Manifest V3)** que permite descargar fotos, vídeos, GIFs y documentos desde **Telegram Web** (versiones K y A: `web.telegram.org/k/` y `/a/`). Todo corre en el navegador; no hay backend propio.

- **Nombre en manifest:** TG Media Grabber Pro  
- **Versión actual:** 4.2 (en `manifest.json`)  
- **Idioma del código/comentarios:** inglés; mensajes de usuario en inglés (unificado).
- **Repositorio:** [GitHub — GalindoAsc/tg-media-grabber-pro](https://github.com/GalindoAsc/tg-media-grabber-pro). **MCP de GitHub:** servidor `user-GitHub`; herramientas útiles: `list_issues`, `list_releases`, `list_pull_requests`, `list_commits`, `search_issues`, `create_pull_request`, etc. (ver `mcps/user-GitHub/tools/` en el proyecto Cursor). Al listar releases, comprobar owner/repo (p. ej. upstream puede ser `codeaeternum/tg-media-grabber-pro`).

---

## 2. Estructura del repositorio

```
tg_media_grabber_pro/
├── manifest.json          # MV3, permisos, content scripts, commands
├── popup.html             # UI del popup
├── popup.js               # Lógica del popup (js/)
├── popup.css              # Estilos del popup (css/)
├── js/
│   ├── background.js      # Service worker: descargas, badge, notificaciones, comandos
│   ├── content.js         # Script inyectado en Telegram Web (lógica principal)
│   ├── injected.js        # Script en main world (acceso a APIs de Telegram)
├── css/
│   └── styles.css         # Estilos inyectados en la página (botones, toast, galería)
├── icons/                 # icon16.png, icon48.png, icon128.png
├── store/                  # LISTING.md (texto Chrome Web Store)
├── AUDIT_REPORT.md         # Auditoría detallada (Marzo 2025)
├── CHANGELOG.md            # Historial de versiones y cambios
├── GEMINI.md               # Este archivo
└── README.md
```

- **Versiones Anteriores/** — Copias antiguas (v2–v3.4); no forma parte del build actual.

---

## 3. Stack técnico

| Capa | Tecnología |
|------|------------|
| Plataforma | Chrome Extension API (Manifest V3) |
| Lenguaje | JavaScript (vanilla, sin framework) |
| UI | HTML + CSS (popup e inyección en página) |
| Persistencia | `chrome.storage.local` (opciones, historial, downloadedMids) |
| Descargas | `chrome.downloads` API |

No hay Node/npm, bundler, ni tests automatizados en el repo actual.

---

## 4. Flujo de datos y comunicación

- **Popup ↔ Content:** `chrome.tabs.sendMessage` / `chrome.runtime.onMessage` (tab activa).
- **Content ↔ Background:** `chrome.runtime.sendMessage` (descargas, badge, notificaciones).
- **Content ↔ Injected:** `window.postMessage` (origen debe ser `window` / misma página). El content script y el injected viven en contextos distintos; el injected corre en el “main world” para acceder a `window.appDownloadManager`, `window.rootScope`, etc.

**Acciones principales que el popup envía al content:** `ping`, `scan`, `scanAll`, `bulkDownload`, `openGallery`, `getHistory`, `clearHistory`, `updateSettings`, `getCachedScan`, `getDownloadStatus`, `command`.

---

## 5. Lógica de descarga

1. **Estrategia principal:** API de Telegram (`appDownloadManager.downloadMedia`) vía `injected.js` (msgId + peerId).
2. **Fallback:** Fetch con cabeceras `Range` en chunks (512 KB), desde el contexto de la página (Service Worker de Telegram), manejado en `injected.js`.
3. **Duplicados:** Por historial de Chrome (`chrome.downloads.search`) y por `downloadedMids` (chatName:msgId) en storage.
4. **Bulk:** Abre la pestaña “Media” del chat, hace scroll, escanea grid por `data-mid`, descarga por ítem con reintentos.

---

## 6. Convenciones y decisiones

- **Constantes:** En `content.js`, objeto `CONFIG` al inicio (MAX_HISTORY, MAX_DOWNLOADED_MIDS, DOWNLOAD_TIMEOUT_MS, etc.). En popup, constantes locales (p. ej. `PING_TIMEOUT_MS`).
- **Z-index (UI inyectada):** En `css/styles.css`, botón en mensajes 999; viewer 9999; toast 10001; overlay galería 10002 (orden: mensaje < viewer < toast < galería).
- **Prefijo de logs:** `[TG Grabber]` (content/injected), `[TG Grabber BG]` (background).
- **Sanitización:** Nombres de carpeta/archivo sin `<>:"/\|?*` y sin nombres reservados de Windows; `escapeHtml` antes de cualquier `innerHTML` con datos dinámicos.
- **Versión:** La fuente de verdad es `manifest.json` → `version`. Evitar versiones hardcodeadas en comentarios en otros archivos.
- **Idioma UI:** Mensajes de usuario en inglés; constantes y CONFIG documentados en GEMINI. Para i18n futuro usar `chrome.i18n` y `_locales`.

---

## 7. Archivos de referencia

- **AUDIT_REPORT.md** — Auditoría completa con mejoras priorizadas y checklist.
- **CHANGELOG.md** — Historial de versiones y cambios por release.
- **store/LISTING.md** — Texto y checklist para publicar en Chrome Web Store.
- **README.md** — Instalación, uso, privacidad, disclaimer.

---

## 8. Cambios recientes (para contexto)

- **Marzo 2025 — Auditoría e implementación:**
  - Corregido bug CSS: definida variable `--bg-secondary` en `popup.css`.
  - **Seguridad:** Validación de `event.origin === location.origin` en todos los listeners de `postMessage` en `content.js` e `injected.js` (incl. handlers puntuales de checkApiReady y getMetadata).
  - **Popup:** Persistencia de `selectedTypes` en `chrome.storage.local`; se restauran al abrir el popup.
  - **Popup:** Ping con timeout de 2,5 s; si no hay respuesta se muestra "Open web.telegram.org first" o "Could not reach tab" y se deshabilitan los botones.
  - **Accesibilidad:** Barra de progreso con `role="progressbar"`, `aria-valuenow`/`min`/`max`; toggles como `<button role="switch" aria-checked>`; modal de feedback con `aria-modal`, `aria-hidden`, foco en el textarea al abrir; `aria-label` en botón de ajustes y en cierre del modal.
  - Toggles de ajustes cambiados de `<div>` a `<button>` para mejor semántica y accesibilidad.
- **Segunda ronda (misma sesión):**
  - **Atajos en la UI:** Línea bajo "Download All" con texto "Ctrl+Shift+D — Download current · Ctrl+Shift+G — Gallery" (clase `.shortcuts-hint`).
  - **Constantes:** Objeto `CONFIG` al inicio de `content.js` con `MAX_HISTORY`, `MAX_DOWNLOADED_MIDS`, `DOWNLOAD_TIMEOUT_MS`, `BLOB_REVOKE_DELAY_MS`, `GET_METADATA_TIMEOUT_MS`, `CHECK_API_TIMEOUT_MS`; usadas en _saveHistory, _saveMids, downloadBlob, downloadViaInjected, downloadViaAPI, getMetadata, checkApiReady.
  - **Idioma:** Mensajes de toast en content unificados a inglés ("Could not open media sidebar", "Done: X downloaded, Y skipped").
- **Tercera ronda:**
  - **Z-index:** En `css/styles.css`, capas de la UI inyectada bajadas de 100000–100003 a 9999 (viewer btn), 10001 (toast), 10002 (gallery overlay) para reducir conflictos con otras extensiones.
- **Cuarta ronda:**
  - **Tooltip "Download All":** Al estar deshabilitado muestra "Open web.telegram.org first"; al conectar "Download all selected media" (popup.js + title en popup.html).
  - **Cerrar modal de feedback con Escape:** listener `keydown` en document que cierra el modal si `e.key === "Escape"`.
  - **Toast/galería responsive:** Toast con `max-width: min(350px, calc(100vw - 48px))` y `min-width: 200px`; grid de galería con `padding: clamp(...)` para viewports pequeños.
- **Quinta ronda:**
  - **Contraste chips galería:** En `styles.css`, color de `.tg-gallery-chip` de `#8b949e` a `#b1bac4` para mejor ratio WCAG sobre fondo oscuro.
  - **Config feedback:** En `popup.js`, URL y entry IDs del formulario Google agrupados en objeto `FEEDBACK_CONFIG` con comentario para reemplazar en producción.
  - **Versión en comentarios:** Eliminadas versiones hardcodeadas (v2, v3.0, v4.0) en cabeceras de `background.js`, `content.js`, `injected.js`, `popup.js`; versión única en `manifest.json`. Logs de "ready" sin número de versión.
- **Sexta ronda:**
  - **README:** Atajos ampliados (Ctrl+Shift+G para galería); uso de tipos seleccionados e historial/feedback en Usage; nueva sección "For developers" con enlaces a GEMINI.md y AUDIT_REPORT.md.
- **Séptima ronda:**
  - **Polling con backoff en injected.js:** Sustituido `setInterval(500)` fijo por polling con backoff: 500 ms los primeros 5 s, luego 1 s hasta 20 s, luego 2 s hasta 30 s (API y rootScope). Reduce uso de CPU cuando Telegram Web tarda en cargar.
- **Octava ronda:**
  - **CHANGELOG.md:** Añadido en la raíz con versión 4.2 y resumen de cambios (Added, Changed, Fixed) de la auditoría e implementación de Marzo 2025. Enlazado desde GEMINI (estructura y archivos de referencia).

---

## 9. Cómo seguir

- Al añadir features o tocar descargas/storage, revisar **AUDIT_REPORT.md** para no reintroducir problemas (y tachar ítems del checklist si se aplican).
- Al cambiar mensajes entre content/injected, validar siempre `event.origin === location.origin` (o `ALLOWED_ORIGIN`) en los listeners de `postMessage`.
- Actualizar este **GEMINI.md** cuando se tomen decisiones de arquitectura, convenciones o se añadan archivos clave.
- **GitHub:** Con el MCP de GitHub se pueden crear issues, revisar PRs, crear releases/tags o leer el estado del repo cuando haga falta.
