# Cómo probar la extensión (TG Media Grabber Pro)

## Cargar la extensión en Chrome

1. Abre Chrome y ve a **`chrome://extensions/`**.
2. Activa **"Modo desarrollador"** (arriba a la derecha).
3. Pulsa **"Cargar descomprimida"**.
4. Selecciona la carpeta del proyecto:  
   `d:\Proyectos_Sincronizados\tg_media_grabber_pro`  
   (la que contiene `manifest.json`, `popup.html`, `js/`, `css/`, etc.).
5. La extensión debería aparecer en la lista. Si ya estaba cargada, usa **⟳ Recargar** en su tarjeta para aplicar cambios.

---

## Checklist de pruebas (cambios post-auditoría)

### Popup

| Qué probar | Cómo |
|------------|------|
| **Conexión** | Abre el popup **sin** tener Telegram Web abierto → debe mostrar "Open web.telegram.org first" en ~2,5 s y los botones deshabilitados. |
| **Tooltip Download All** | Con el popup abierto y sin conectar: pasa el ratón sobre "Download All" → tooltip "Open web.telegram.org first". Con Telegram Web abierto y conectado → "Download all selected media". |
| **Tipos guardados** | En el popup, quita la selección a un tipo (p. ej. GIFs). Cierra el popup y ábrelo de nuevo → la selección debe seguir igual (Photos/Videos/GIFs persistidos). |
| **Atajos en la UI** | Comprueba que debajo de "Download All" aparece la línea: "Ctrl+Shift+D — Download current · Ctrl+Shift+G — Gallery". |
| **Ajustes** | Abre el panel de ajustes (icono engranaje). Cambia carpeta, toggles o tamaño máximo de vídeo; cierra y abre el popup → los valores se mantienen. |
| **Modal de feedback** | Pulsa "Send Feedback" → se abre el modal. Pulsa **Escape** → el modal se cierra. Comprueba que el foco va al textarea al abrir. |
| **Historial** | Abre "History" en el popup; si hay descargas recientes, deberían listarse. "Clear history" debe vaciarlo. |

### Con Telegram Web abierto

1. Abre **https://web.telegram.org/** (versión K o A) e inicia sesión.
2. Entra en un chat que tenga fotos/vídeos.

| Qué probar | Cómo |
|------------|------|
| **Estado conectado** | Abre el popup → debe decir "Connected — Telegram Web K" (o A) y el punto en verde. Botones Scan, Re-scan, Gallery, Download All activos. |
| **Scan** | Pulsa "Scan" → deben actualizarse los números en Photos/Videos/GIFs. "Re-scan" fuerza un nuevo escaneo. |
| **Botones en mensajes** | Pasa el ratón sobre una foto o vídeo en el chat → debe aparecer el botón de descarga. Descarga un medio y comprueba que funciona. |
| **Atajo Ctrl+Shift+D** | Con el foco en un mensaje con media (o en el visor de medios), pulsa **Ctrl+Shift+D** → debe descargar el medio actual. |
| **Atajo Ctrl+Shift+G** | Pulsa **Ctrl+Shift+G** → debe abrir la galería de medios del chat. |
| **Galería desde popup** | En el popup, pulsa "Gallery" → se abre la galería. Filtros (chips), selección y descarga desde la galería. |
| **Download All** | Selecciona tipos (Photos, Videos, GIFs), pulsa "Download All" → debe iniciarse la descarga masiva, barra de progreso en el popup y toasts en la página. Comprueba Skip/Stop en el toast si aparece. |
| **Toasts y z-index** | Durante la descarga, el toast debe verse bien (sin quedar tapado). La galería debe mostrarse por encima del contenido de Telegram. |
| **Mensajes en inglés** | Si falla la apertura del panel de media en bulk, el toast debe decir "Could not open media sidebar". Al terminar una descarga masiva, mensaje tipo "Done: X downloaded, Y skipped". |

### Accesibilidad (opcional)

- Con un lector de pantalla o inspección: barra de progreso con `role="progressbar"` y `aria-valuenow`; toggles con `role="switch"` y `aria-checked`; modal de feedback con foco en el textarea y cierre con Escape.

---

## Si algo falla

- **Popup no conecta:** Comprueba que la pestaña activa es realmente Telegram Web (web.telegram.org). Recarga la página de Telegram y vuelve a abrir el popup.
- **Errores en consola:** Abre DevTools (F12) en la pestaña de Telegram Web para el content script; en `chrome://extensions/` → "Inspeccionar vistas: service worker" para el background; en el popup, clic derecho → Inspeccionar para el popup.
- **Recargar extensión:** Tras cambiar código, en `chrome://extensions/` pulsa ⟳ en la tarjeta de la extensión y recarga la pestaña de Telegram Web.
