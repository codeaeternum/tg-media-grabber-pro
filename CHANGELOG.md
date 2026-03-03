# Changelog

All notable changes to TG Media Grabber Pro are documented here. Version numbers follow the extension’s `manifest.json`.

---

## [4.2] — 2025-03

### Added
- Keyboard shortcut hint in popup: Ctrl+Shift+D (download current), Ctrl+Shift+G (gallery).
- Tooltip on "Download All" when disabled ("Open web.telegram.org first") and when connected ("Download all selected media").
- Close feedback modal with Escape key.
- "For developers" section in README with links to GEMINI.md and AUDIT_REPORT.md.

### Changed
- **Security:** All `postMessage` listeners (content + injected) now validate `event.origin === location.origin`.
- **Popup:** Selected media types (Photos/Videos/GIFs) are persisted and restored when reopening the popup.
- **Popup:** Ping to content script has a 2.5 s timeout; clear message when tab is not Telegram Web or unreachable.
- **Accessibility:** Progress bar uses ARIA (`role="progressbar"`, `aria-valuenow`); toggles are `<button role="switch" aria-checked>`; feedback modal has `aria-modal`, focus on textarea when opened, and proper labels.
- **UI:** Z-index of injected UI (viewer button, toast, gallery overlay) reduced from 100000+ to 9999–10002 to avoid conflicts with other extensions.
- **Toast & gallery:** Responsive width and padding for small viewports (`max-width: min(350px, calc(100vw - 48px))`, `clamp` padding on gallery grid).
- **Contrast:** Gallery filter chips use a lighter gray (`#b1bac4`) for better WCAG contrast on dark background.
- **Feedback form:** Google Form URL and entry IDs moved into a single `FEEDBACK_CONFIG` object in popup.js (easier to replace for production).
- **Constants:** Magic numbers in content.js centralized in a `CONFIG` object (e.g. `MAX_HISTORY`, `DOWNLOAD_TIMEOUT_MS`).
- **Language:** User-facing messages unified to English (toasts and in-content strings).
- **Versioning:** Removed hardcoded version numbers from script headers; single source of truth is `manifest.json`.
- **Injected script:** API and rootScope polling use backoff (500 ms → 1 s → 2 s over 30 s) to reduce CPU usage on slow page load.
- **README & store listing:** Shortcuts and usage updated; second shortcut (Ctrl+Shift+G) documented.

### Fixed
- Popup CSS: defined missing variable `--bg-secondary` used by the feedback modal.
- Toggles in settings are now `<button>` elements for correct semantics and accessibility.
- Duplicate downloads: same media no longer downloaded twice (claim by msgId in `downloadItem`, video stem in `getExistingFiles` and pre-filter so `video_MSGID.mp4` matches existing `video_MSGID_duration.mp4`).

---

For full audit details and checklist, see [AUDIT_REPORT.md](AUDIT_REPORT.md). For project context and conventions, see [GEMINI.md](GEMINI.md).
