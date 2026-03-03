/**
 * TG Media Grabber Pro — Content Script
 * Full support for web.telegram.org/k/ AND /a/
 * Features: individual DL, bulk DL, auto-scroll, gallery preview,
 *           restricted content bypass, media viewer DL, stories DL,
 *           keyboard shortcuts, drag-select
 */
(function () {
  "use strict";

  // =============================================
  // CONSTANTS & STATE
  // =============================================
  const CONFIG = {
    MAX_HISTORY: 200,
    MAX_DOWNLOADED_MIDS: 5000,
    DOWNLOAD_TIMEOUT_MS: 120000,
    BLOB_REVOKE_DELAY_MS: 8000,
    GET_METADATA_TIMEOUT_MS: 3000,
    CHECK_API_TIMEOUT_MS: 500,
  };

  const LOG = "[TG Grabber]";
  const log = {
    i: (m) => console.log(`${LOG} ${m}`),
    w: (m) => console.warn(`${LOG} ${m}`),
    e: (m) => console.error(`${LOG} ${m}`),
  };

  const DOWNLOAD_ICON_UNI = "\ue977"; // K app icon font codepoint
  const FORWARD_ICON_UNI = "\ue995";
  const RANGE_RE = /^bytes (\d+)-(\d+)\/(\d+)$/;

  const S = {
    isK: location.pathname.startsWith("/k") || location.host.startsWith("webk"),
    isA: location.pathname.startsWith("/a") || location.host.startsWith("webz"),
    buttonsEnabled: true,
    restrictedEnabled: true,
    folderName: "TG_Media",
    maxFileSizeMB: 2048, // Default 2 GB, 0 = no limit
    downloading: false,
    observerActive: false,
    galleryOpen: false,
    scannedMedia: [],
    downloadHistory: [],
    abortController: null,
    capturedMedia: new Map(), // URL -> { blobUrl, mime, size, fileName }
    pendingDownloads: new Map(), // URL -> { resolve, reject, fileName }
    _bulkExistingFiles: null, // Set of nameKeys for duplicate checking during bulk download
    downloadedMids: new Set(), // Set of "chatName:msgId" for message-ID-based dedup
  };

  // =============================================
  // SVG ICONS
  // =============================================
  const ICO = {
    dl: `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`,
    ok: `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
    spin: `<svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>`,
  };

  // =============================================
  // HELPERS
  // =============================================
  const hashStr = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };

  const extFromMime = (m) => {
    const map = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm", "audio/ogg": "ogg", "audio/mpeg": "mp3" };
    return map[m] || (m ? m.split("/")[1] : "bin") || "bin";
  };

  const humanSize = (b) => {
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
    return (b / 1073741824).toFixed(2) + " GB";
  };

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // XSS protection for innerHTML interpolation
  const escapeHtml = (str) => {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  };

  // Persist download history to storage (capped)
  function _saveHistory() {
    try {
      const trimmed = S.downloadHistory.length > CONFIG.MAX_HISTORY ? S.downloadHistory.slice(-CONFIG.MAX_HISTORY) : S.downloadHistory;
      S.downloadHistory = trimmed;
      chrome.storage.local.set({ downloadHistory: trimmed });
    } catch (_) { }
  }

  // Persist downloaded message IDs (capped)
  function _saveMids() {
    try {
      let arr = Array.from(S.downloadedMids);
      if (arr.length > CONFIG.MAX_DOWNLOADED_MIDS) arr = arr.slice(-CONFIG.MAX_DOWNLOADED_MIDS);
      S.downloadedMids = new Set(arr);
      chrome.storage.local.set({ downloadedMids: arr });
    } catch (_) { }
  }

  // Get current chat/channel name for subfolder organization
  function getChatName() {
    try {
      const v = detectVersion();
      let name = null;
      if (v === "K") {
        name = document.querySelector(".chat-info .peer-title, .top .peer-title, .chat-utils .peer-title")?.textContent?.trim();
      } else {
        name = document.querySelector("#MiddleColumn .ChatInfo .title, .middle-column-header .chat-title, h3.fullName")?.textContent?.trim();
      }
      if (name) {
        // Sanitize for filesystem
        return name.replace(/[<>:"/\\|?*]/g, "").replace(/\.+$/g, "").trim().substring(0, 60) || "General";
      }
    } catch (_) { }
    return "General";
  }

  // Update badge count on extension icon
  function updateBadge(count) {
    try {
      chrome.runtime.sendMessage({ action: "updateBadge", count });
    } catch (_) { }
  }

  // Try to extract original filename from Telegram's stream URL or element
  function extractFileName(src, element, type) {
    // Method 1: Parse from stream URL metadata JSON
    if (src) {
      try {
        const parts = src.split("/");
        const last = decodeURIComponent(parts[parts.length - 1]);
        const meta = JSON.parse(last);
        if (meta.fileName) return meta.fileName;
      } catch (_) { }
    }

    // Method 2: From document name element (K)
    if (element) {
      const nameEl = element.closest?.(".bubble, .Message")?.querySelector(
        ".document-name, .text-bold, .File .content .title, .document-attribute-file-name"
      );
      if (nameEl?.textContent?.trim()) return nameEl.textContent.trim();
    }

    // Method 3: From download attribute on existing links
    if (element) {
      const link = element.closest?.(".bubble, .Message")?.querySelector("a[download]");
      if (link?.download) return link.download;
    }

    // Method 4: Generate a name preserving the original hash for traceability
    const hash = src ? hashStr(src) : ((Math.random() + 1).toString(36).substring(2, 8));
    const extMap = { photo: "jpg", video: "mp4", gif: "mp4", audio: "ogg", doc: "bin" };
    return `${hash}.${extMap[type] || "bin"}`;
  }

  // =============================================
  // DOWNLOAD ENGINE
  // =============================================
  async function downloadBlob(blob, fileName, { force = false } = {}) {
    // Button clicks set S._forceDownload to skip duplicate checking
    const isForced = force || S._forceDownload;
    const url = URL.createObjectURL(blob);
    const chatName = getChatName();
    const fullPath = `${S.folderName}/${chatName}/${fileName}`;
    const doFallback = () => {
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: "download",
          url,
          fileName: fullPath,
          force: isForced,
        }, (response) => {
          if (chrome.runtime.lastError || !response) {
            doFallback();
          } else if (response.skipped) {
            log.i(`⏭ Skipped (duplicate): ${fileName}`);
          } else {
            // Track in history
            const entry = { name: fileName, type: "file", time: Date.now(), chat: chatName };
            S.downloadHistory.push(entry);
            _saveHistory();
            log.i(`✓ ${fileName} → ${S.folderName}/${chatName}/`);
          }
        });
      } else {
        doFallback();
      }
    } catch (_) {
      doFallback();
    }
    setTimeout(() => URL.revokeObjectURL(url), CONFIG.BLOB_REVOKE_DELAY_MS);
  }

  async function downloadUrl(url, fileName) {
    try {
      const blob = await (await fetch(url)).blob();
      const ext = extFromMime(blob.type);
      // Fix extension if we got a generic name
      if (fileName.endsWith(".bin") || fileName.endsWith(".undefined")) {
        fileName = fileName.replace(/\.[^.]+$/, `.${ext}`);
      }
      await downloadBlob(blob, fileName);
      return true;
    } catch (e) {
      log.e(`Fetch error: ${e.message}`);
      return false;
    }
  }

  // Chunked video download with progress (like the Neet-Nestor approach)
  async function downloadVideoChunked(url, fileName, onProgress) {
    let blobs = [];
    let offset = 0;
    let total = null;

    while (true) {
      if (S.abortController?.signal.aborted) throw new Error("Aborted");

      const res = await fetch(url, {
        method: "GET",
        headers: { Range: `bytes=${offset}-` },
        signal: S.abortController?.signal,
      });

      if (![200, 206].includes(res.status)) throw new Error(`HTTP ${res.status}`);

      const mime = res.headers.get("Content-Type")?.split(";")[0] || "video/mp4";
      const rangeHeader = res.headers.get("Content-Range");

      if (rangeHeader) {
        const m = rangeHeader.match(RANGE_RE);
        if (m) {
          offset = parseInt(m[2]) + 1;
          total = parseInt(m[3]);
        }
      }

      const blob = await res.blob();
      blobs.push(blob);

      if (total && onProgress) {
        onProgress(Math.min(100, Math.round((offset / total) * 100)));
      }

      // If full response (200) or we've got everything
      if (res.status === 200 || !total || offset >= total) break;
    }

    const finalBlob = new Blob(blobs, { type: "video/mp4" });
    // Fix extension from actual MIME
    const ext = extFromMime(finalBlob.type);
    if (!fileName.match(/\.(mp4|webm|mkv|mov|avi)$/i)) {
      fileName = fileName.replace(/\.[^.]+$/, `.${ext}`);
    }
    await downloadBlob(finalBlob, fileName);
    return true;
  }

  // =============================================
  // MEDIA DETECTION — DUAL ENGINE (K + A)
  // =============================================
  function detectVersion() {
    // Check URL first (most reliable)
    const path = location.pathname;
    const host = location.host;
    if (path.startsWith("/a") || host.startsWith("webz")) return "A";
    if (path.startsWith("/k") || host.startsWith("webk")) return "K";
    // Then check DOM
    if (document.querySelector("#MiddleColumn, .MessageList, #MediaViewer")) return "A";
    if (document.querySelector(".bubbles-inner, #column-center, .media-viewer-whole")) return "K";
    return "K"; // default
  }

  /** Selectors for each version */
  const SEL = {
    K: {
      chatContainer: ".bubbles-inner, #column-center .bubbles",
      message: ".bubble",
      mediaViewer: ".media-viewer-whole",
      mediaViewerMedia: ".media-viewer-movers .media-viewer-aspecter",
      mediaViewerButtons: ".media-viewer-topbar .media-viewer-buttons",
      mediaViewerVideo: ".ckin__player video, video",
      mediaViewerImg: "img.thumbnail",
      stories: "#stories-viewer",
      storyVideo: "video.media-video",
      storyImg: "img.media-photo",
    },
    A: {
      chatContainer: ".MessageList, .messages-container, #MiddleColumn, #middle-column-portals",
      message: ".Message, .message, [class*='Message ']",
      mediaViewer: "#MediaViewer, [class*='MediaViewer']",
      mediaViewerMedia: ".MediaViewerSlide--active .MediaViewerContent, [class*='MediaViewerSlide'] [class*='MediaViewerContent']",
      mediaViewerButtons: ".MediaViewerActions, [class*='MediaViewerActions']",
      mediaViewerVideo: ".VideoPlayer video, [class*='VideoPlayer'] video, video",
      mediaViewerImg: "img.full-media, img[class*='full-media'], .MediaViewerContent > div > img, img:not(.emoji):not(.sticker-media):not([class*='avatar'])",
      stories: "#StoryViewer, [class*='StoryViewer']",
      storyVideo: "video",
      storyImg: "img[class*='full-media'], img:not(.emoji)",
    },
  };

  function findMediaInMessage(msg, version) {
    const media = [];
    const v = version || detectVersion();
    const seenEls = new Set(); // Track DOM elements to prevent duplicates

    // — PHOTOS —
    if (v === "K") {
      // K: photos in .media-photo containers, .attachment, grouped albums
      msg.querySelectorAll(".media-photo, .media-container-photo, .grouped-item, .album-item").forEach((container) => {
        if (container.closest(".quote")) return;
        // Skip if this container has video indicators (it's a video thumbnail, not a photo)
        if (container.querySelector("video, .video-play, .btn-circle.video-play, span.video-time, .video-time")) return;
        // Also skip if the parent attachment/media-container has video indicators
        const parentContainer = container.closest(".attachment, .media-container");
        if (parentContainer && parentContainer.querySelector("video, .video-play, .btn-circle.video-play, span.video-time, .video-time")) return;
        const img = container.querySelector("img");
        if (img) {
          const src = img.src || img.dataset?.src;
          if (!src || /avatar|emoji|sticker|profile/i.test(src)) return;
          if (img.width < 40 && img.height < 40) return;
          if (seenEls.has(img)) return;
          // Capture per-item data-mid for grouped/album items (each photo has its own mid)
          const itemMid = container.dataset?.mid || container.closest("[data-mid]")?.dataset?.mid;
          const photoItem = { type: "photo", el: img, src, thumb: src, name: extractFileName(src, img, "photo") };
          if (itemMid) photoItem._msgId = itemMid;
          media.push(photoItem);
          seenEls.add(img);
          return;
        }
        const canvas = container.querySelector("canvas");
        if (canvas && !seenEls.has(canvas)) {
          const itemMid = container.dataset?.mid || container.closest("[data-mid]")?.dataset?.mid;
          const canvasItem = { type: "photo", el: canvas, src: null, thumb: null, name: extractFileName(null, canvas, "photo"), isCanvas: true };
          if (itemMid) canvasItem._msgId = itemMid;
          media.push(canvasItem);
          seenEls.add(canvas);
        }
      });
      // Standalone img.media-photo (skip if inside a video container)
      msg.querySelectorAll("img.media-photo").forEach((img) => {
        if (seenEls.has(img)) return;
        // Skip if this img is inside a container with video indicators
        const parentContainer = img.closest(".attachment, .media-container");
        if (parentContainer && parentContainer.querySelector("video, .video-play, .btn-circle.video-play, span.video-time, .video-time")) return;
        const src = img.src || img.dataset?.src;
        if (!src || /avatar|emoji|sticker|profile/i.test(src)) return;
        if (img.width < 40 && img.height < 40) return;
        media.push({ type: "photo", el: img, src, thumb: src, name: extractFileName(src, img, "photo") });
        seenEls.add(img);
      });
    } else {
      msg.querySelectorAll(".Photo img, .media-inner img, img.full-media, img.thumbnail, [class*='Photo'] img, img[class*='full-media']").forEach((img) => {
        const src = img.src || img.dataset?.src;
        if (!src || /avatar|emoji|sticker|profile/i.test(src)) return;
        if (img.width < 40 && img.height < 40) return;
        media.push({ type: "photo", el: img, src, thumb: src, name: extractFileName(src, img, "photo") });
        seenEls.add(img);
      });
    }

    // — VIDEOS —
    if (v === "K") {
      // Loaded videos
      msg.querySelectorAll("video").forEach((vid) => {
        const isGif = vid.hasAttribute("loop") || vid.closest(".media-gif, .media-round");
        if (isGif) return;
        const src = vid.src || vid.currentSrc || vid.querySelector("source")?.src;
        if (!src) return;
        media.push({ type: "video", el: vid, src, thumb: vid.poster || null, name: extractFileName(src, vid, "video") });
        seenEls.add(vid);
      });
      // Unloaded videos: thumbnail + play button, no <video> yet
      msg.querySelectorAll(".bubble-content .attachment, .media-container").forEach((container) => {
        if (container.querySelector("video")) return;
        if (seenEls.has(container)) return;
        const hasVideo = container.querySelector(".video-play, .btn-circle.video-play, span.video-time, .video-time");
        if (!hasVideo) return;
        const thumb = container.querySelector("img, canvas");
        const thumbSrc = thumb?.src || thumb?.dataset?.src || null;
        // Try to get a meaningful name from time display or message
        const timeEl = container.querySelector("span.video-time, .video-time");
        const duration = timeEl?.textContent?.trim() || "";
        const msgId = msg.dataset?.mid || msg.dataset?.peerId || "";
        const vidName = `video_${msgId || ((Math.random() + 1).toString(36).substring(2, 8))}${duration ? "_" + duration.replace(/:/g, "m") : ""}.mp4`;
        media.push({ type: "video", el: container, src: null, thumb: thumbSrc, name: vidName, unloaded: true });
        seenEls.add(container);
      });
    } else {
      msg.querySelectorAll(".VideoPlayer video, video.full-media, [class*='VideoPlayer'] video, video:not([loop])").forEach((vid) => {
        const src = vid.src || vid.currentSrc || vid.querySelector("source")?.src;
        if (!src) return;
        media.push({ type: "video", el: vid, src, thumb: vid.poster || null, name: extractFileName(src, vid, "video") });
        seenEls.add(vid);
      });
    }

    // — GIFs —
    if (v === "K") {
      msg.querySelectorAll(".media-gif video, video[loop], .media-round video").forEach((g) => {
        if (seenEls.has(g)) return;
        const src = g.src || g.currentSrc;
        if (!src) return;
        media.push({ type: "gif", el: g, src, thumb: g.poster || null, name: extractFileName(src, g, "gif") });
        seenEls.add(g);
      });
      // Unloaded GIFs
      msg.querySelectorAll(".media-gif").forEach((container) => {
        if (container.querySelector("video")) return;
        if (seenEls.has(container)) return;
        const thumb = container.querySelector("img, canvas");
        media.push({ type: "gif", el: container, src: null, thumb: thumb?.src || null, name: extractFileName(null, container, "gif"), unloaded: true });
        seenEls.add(container);
      });
    } else {
      msg.querySelectorAll("video[loop], .gif-video").forEach((g) => {
        if (seenEls.has(g)) return;
        const src = g.src || g.currentSrc;
        if (!src) return;
        media.push({ type: "gif", el: g, src, thumb: g.poster || null, name: extractFileName(src, g, "gif") });
        seenEls.add(g);
      });
    }

    // — AUDIO —
    if (v === "K") {
      msg.querySelectorAll("audio-element, audio, .audio-container").forEach((a) => {
        if (seenEls.has(a)) return;
        const audioEl = a.audio || a;
        const src = audioEl?.src || audioEl?.querySelector?.("source")?.src;
        if (src) media.push({ type: "audio", el: a, src, thumb: null, name: extractFileName(src, a, "audio") });
      });
    } else {
      msg.querySelectorAll(".Audio audio, audio").forEach((a) => {
        const src = a.src || a.querySelector("source")?.src;
        if (src) media.push({ type: "audio", el: a, src, thumb: null, name: extractFileName(src, a, "audio") });
      });
    }

    // — DOCUMENTS —
    const docSels = v === "K" ? ".document-container, .document" : ".Document, .File";
    msg.querySelectorAll(docSels).forEach((d) => {
      if (d.querySelector("audio, audio-element")) return;
      if (seenEls.has(d)) return;
      const nameEl = d.querySelector(".document-name, .text-bold, .title, .file-name, .document-attribute-file-name");
      const name = nameEl?.textContent?.trim() || "document";
      media.push({ type: "doc", el: d, src: null, thumb: null, name });
      seenEls.add(d);
    });

    return media;
  }

  // =============================================
  // INJECT PAGE-CONTEXT INTERCEPTOR
  // =============================================
  function injectInterceptor() {
    try {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("js/injected.js");
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
      log.i("Network interceptor injected");
    } catch (e) {
      log.w("Could not inject interceptor: " + e.message);
    }
  }

  // =============================================
  // DOWNLOAD A SINGLE MEDIA ITEM
  // =============================================

  let _dlRequestId = 0;
  const _dlPendingRequests = new Map(); // requestId -> { resolve, reject }

  /**
   * Listen for responses from injected.js
   */
  const ALLOWED_ORIGIN = location.origin;
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== ALLOWED_ORIGIN) return;
    const { type, requestId } = event.data || {};

    if (type === "TG_GRABBER_DOWNLOAD_COMPLETE" && _dlPendingRequests.has(requestId)) {
      const pending = _dlPendingRequests.get(requestId);
      _dlPendingRequests.delete(requestId);
      pending.resolve(event.data);
    }

    if (type === "TG_GRABBER_DOWNLOAD_ERROR" && _dlPendingRequests.has(requestId)) {
      const pending = _dlPendingRequests.get(requestId);
      _dlPendingRequests.delete(requestId);
      pending.reject(new Error(event.data.error));
    }

    if (type === "TG_GRABBER_DOWNLOAD_CANCELLED" && _dlPendingRequests.has(requestId)) {
      const pending = _dlPendingRequests.get(requestId);
      _dlPendingRequests.delete(requestId);
      pending.reject(new Error("__SKIPPED__"));
    }

    if (type === "TG_GRABBER_DOWNLOAD_PROGRESS") {
      const { pct, received, total } = event.data;
      if (pct % 20 === 0) {
        log.i(`Downloading: ${pct}% (${humanSize(received)}/${humanSize(total)})`);
      }
    }

    // API-based download responses
    if (type === "TG_GRABBER_API_DOWNLOAD_COMPLETE" && _dlPendingRequests.has(requestId)) {
      const pending = _dlPendingRequests.get(requestId);
      _dlPendingRequests.delete(requestId);
      pending.resolve(event.data);
    }
    if (type === "TG_GRABBER_API_DOWNLOAD_ERROR" && _dlPendingRequests.has(requestId)) {
      const pending = _dlPendingRequests.get(requestId);
      _dlPendingRequests.delete(requestId);
      pending.reject(new Error(event.data.error));
    }
    if (type === "TG_GRABBER_API_PROGRESS") {
      const { fileName, progress } = event.data;
      if (progress % 20 === 0) {
        log.i(`API downloading: ${fileName} ${progress}%`);
      }
    }
    // API readiness status
    if (type === "TG_GRABBER_API_STATUS") {
      S._apiReady = event.data.apiReady;
    }
    if (type === "TG_GRABBER_METADATA_RESULT" && _dlPendingRequests.has(requestId)) {
      const pending = _dlPendingRequests.get(requestId);
      _dlPendingRequests.delete(requestId);
      pending.resolve(event.data.metadata);
    }
  });

  // Track currently active download requestId for cancellation
  let _activeDlRequestId = null;

  function cancelActiveDownload() {
    if (_activeDlRequestId !== null) {
      // Cancel SW download in injected.js
      window.postMessage({ type: "TG_GRABBER_CANCEL_DOWNLOAD", requestId: _activeDlRequestId }, "*");
      // Also reject the pending promise in content.js
      const pending = _dlPendingRequests.get(_activeDlRequestId);
      if (pending) {
        _dlPendingRequests.delete(_activeDlRequestId);
        pending.reject(new Error("__SKIPPED__"));
      }
      _activeDlRequestId = null;
    }
  }

  /**
   * Download a video/audio by sending the stream URL to injected.js,
   * which fetches through Telegram's Service Worker in page context.
   */
  function downloadViaInjected(streamUrl, timeoutMs = CONFIG.DOWNLOAD_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const requestId = ++_dlRequestId;
      _activeDlRequestId = requestId;
      const timer = setTimeout(() => {
        _dlPendingRequests.delete(requestId);
        if (_activeDlRequestId === requestId) _activeDlRequestId = null;
        reject(new Error("SW download timeout"));
      }, timeoutMs);

      _dlPendingRequests.set(requestId, {
        resolve: (data) => { clearTimeout(timer); if (_activeDlRequestId === requestId) _activeDlRequestId = null; resolve(data); },
        reject: (err) => { clearTimeout(timer); if (_activeDlRequestId === requestId) _activeDlRequestId = null; reject(err); },
      });

      window.postMessage({
        type: "TG_GRABBER_DOWNLOAD_REQUEST",
        streamUrl,
        requestId,
      }, "*");
    });
  }

  /**
   * Get the current chat's peerId from Telegram's URL.
   * K: /k/#-1001234567890 → peerId is -1001234567890
   * A: /a/#-1001234567890 → same
   */
  function getPeerId() {
    try {
      const hash = location.hash || "";
      // Match patterns like #-1001234567890 or #1234567890
      const m = hash.match(/#(-?\d+)/);
      if (m) return m[1];
      // Try data attribute on chat container
      const chatEl = document.querySelector("[data-peer-id], [data-chat-id]");
      if (chatEl) return chatEl.dataset.peerId || chatEl.dataset.chatId || null;
    } catch (_) { }
    return null;
  }

  /**
   * Check if the Telegram API is available for direct downloads.
   */
  function checkApiReady() {
    return new Promise((resolve) => {
      const handler = (event) => {
        if (event.source !== window || event.origin !== ALLOWED_ORIGIN) return;
        if (event.data?.type === "TG_GRABBER_API_STATUS") {
          window.removeEventListener("message", handler);
          resolve(event.data.apiReady);
        }
      };
      window.addEventListener("message", handler);
      window.postMessage({ type: "TG_GRABBER_CHECK_API" }, "*");
      setTimeout(() => {
        window.removeEventListener("message", handler);
        resolve(false);
      }, CONFIG.CHECK_API_TIMEOUT_MS);
    });
  }

  /**
   * Download a file via Telegram's appDownloadManager API (primary strategy).
   * Returns { blobUrl, fileName, mediaType, size, mimeType } or throws.
   */
  function downloadViaAPI(msgId, peerId, includeVideo = false, timeoutMs = CONFIG.DOWNLOAD_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const requestId = ++_dlRequestId;
      _activeDlRequestId = requestId;
      const timer = setTimeout(() => {
        _dlPendingRequests.delete(requestId);
        if (_activeDlRequestId === requestId) _activeDlRequestId = null;
        reject(new Error("API download timeout"));
      }, timeoutMs);

      _dlPendingRequests.set(requestId, {
        resolve: (data) => { clearTimeout(timer); if (_activeDlRequestId === requestId) _activeDlRequestId = null; resolve(data); },
        reject: (err) => { clearTimeout(timer); if (_activeDlRequestId === requestId) _activeDlRequestId = null; reject(err); },
      });

      window.postMessage({
        type: "TG_GRABBER_API_DOWNLOAD",
        msgId: parseInt(msgId),
        peerId: parseInt(peerId),
        includeVideo,
        requestId,
      }, "*");
    });
  }

  /**
   * Revoke a blob URL previously created by injected.js
   */
  function revokeInjectedUrl(url) {
    window.postMessage({ type: "TG_GRABBER_REVOKE_URL", url }, "*");
  }

  /**
   * Get media metadata (filename, size, etc.) WITHOUT downloading.
   * Uses injected.js getMediaMetadata() to read Telegram's internal data.
   */
  function getMetadata(msgId, peerId) {
    return new Promise((resolve) => {
      const requestId = ++_dlRequestId;
      const timer = setTimeout(() => resolve(null), CONFIG.GET_METADATA_TIMEOUT_MS);
      const handler = (event) => {
        if (event.source !== window || event.origin !== ALLOWED_ORIGIN) return;
        if (event.data?.type === "TG_GRABBER_METADATA_RESULT" && event.data.requestId === requestId) {
          clearTimeout(timer);
          window.removeEventListener("message", handler);
          resolve(event.data.metadata);
        }
      };
      window.addEventListener("message", handler);
      window.postMessage({
        type: "TG_GRABBER_GET_METADATA",
        msgId: parseInt(msgId),
        peerId: parseInt(peerId),
        requestId,
      }, "*");
    });
  }

  /**
   * Extract stream URL from a video element.
   * Telegram K: <video src="/k/stream/{json}"> — parseable
   * Telegram A: <video src="blob:..."> — need different approach
   */
  function getStreamUrl(videoEl) {
    const src = videoEl?.src || videoEl?.currentSrc || "";

    // Non-blob URL = stream URL (K version usually)
    if (src && !src.startsWith("blob:")) return src;

    // Check <source> elements
    const source = videoEl?.querySelector?.("source");
    if (source?.src && !source.src.startsWith("blob:")) return source.src;

    return src; // Return blob: as fallback
  }

  /**
   * Extract fileName from stream URL metadata
   */
  function fileNameFromStreamUrl(url) {
    try {
      const decoded = decodeURIComponent(url);
      const idx = decoded.indexOf("/stream/");
      if (idx !== -1) {
        const meta = JSON.parse(decoded.substring(idx + 8));
        if (meta.fileName) return meta.fileName;
      }
    } catch (_) { }
    return null;
  }

  /**
   * Smart video download with multiple strategies
   */
  async function downloadVideoSmart(videoEl, fileName, onProgress) {
    if (!videoEl) { log.w("Video element null"); return false; }

    const streamUrl = getStreamUrl(videoEl);
    log.i(`Video: ${streamUrl.substring(0, 100)}...`);

    // Get real filename from stream URL if possible
    const realName = fileNameFromStreamUrl(streamUrl) || fileName;

    // Strategy 1: Non-blob URL → send to injected.js for SW download
    // Includes retry with backoff for Telegram rate limits (LIMIT_INVALID)
    if (streamUrl && !streamUrl.startsWith("blob:")) {
      const MAX_RETRIES = 3;
      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        try {
          if (retry > 0) {
            const waitSec = retry * 15; // Increased from 5 to 15
            log.i(`Retrying in ${waitSec}s (attempt ${retry + 1}/${MAX_RETRIES + 1})...`);
            await sleep(waitSec * 1000);
          }
          log.i(`Downloading via Service Worker: ${realName}`);
          const result = await downloadViaInjected(streamUrl, 300000); // 5 min timeout for large files
          if (result?.blobUrl) {
            const finalName = result.fileName || realName;
            log.i(`SW completó: ${finalName} (${humanSize(result.size)})`);
            await downloadBlob(await (await fetch(result.blobUrl)).blob(), finalName);
            URL.revokeObjectURL(result.blobUrl);
            return true;
          }
        } catch (e) {
          const isRateLimit = e.message?.includes("LIMIT_INVALID") || e.message?.includes("FLOOD");
          if (isRateLimit && retry < MAX_RETRIES) {
            log.w(`Rate limit detected for ${realName}, retrying...`);
            continue;
          }
          log.w(`SW download failed: ${e.message}`);
          break;
        }
      }
    }

    // Strategy 2: Blob URL → fetch directly (works for images, small videos)
    if (streamUrl?.startsWith("blob:")) {
      try {
        const resp = await fetch(streamUrl);
        const blob = await resp.blob();
        if (blob.size > 50000) { // > 50KB seems complete
          log.i(`Blob directo: ${realName} (${humanSize(blob.size)})`);
          const ext = extFromMime(blob.type);
          const fixedName = realName.match(/\.(mp4|webm|mkv|mov|avi|ogg|mp3)$/i)
            ? realName : realName.replace(/\.[^.]+$/, `.${ext}`);
          await downloadBlob(blob, fixedName);
          return true;
        }
        log.w(`Blob too small: ${humanSize(blob.size)}, trying MediaRecorder...`);
      } catch (e) {
        log.w(`Blob fetch failed: ${e.message}`);
      }
    }

    // Strategy 3: MediaRecorder as last resort
    try {
      log.i("Usando MediaRecorder...");
      const stream = videoEl.captureStream ? videoEl.captureStream() : videoEl.mozCaptureStream?.();
      if (!stream) throw new Error("captureStream no disponible");

      const chunks = [];
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : MediaRecorder.isTypeSupported("video/webm")
          ? "video/webm" : "video/mp4";

      return new Promise((resolve) => {
        const recorder = new MediaRecorder(stream, { mimeType });
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = async () => {
          const blob = new Blob(chunks, { type: mimeType });
          const ext = mimeType.includes("webm") ? "webm" : "mp4";
          const fixedName = realName.replace(/\.[^.]+$/, `.${ext}`);
          log.i(`MediaRecorder: ${fixedName} (${humanSize(blob.size)})`);
          await downloadBlob(blob, fixedName);
          resolve(true);
        };
        recorder.onerror = () => resolve(false);

        const wasPaused = videoEl.paused;
        const oldTime = videoEl.currentTime;
        videoEl.currentTime = 0;
        recorder.start(100); // collect data every 100ms

        videoEl.addEventListener("ended", function onEnd() {
          videoEl.removeEventListener("ended", onEnd);
          recorder.stop();
          if (wasPaused) videoEl.pause();
          videoEl.currentTime = oldTime;
        });

        // Safety timeout
        setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 600000);
        if (videoEl.paused) videoEl.play().catch(() => { });
      });
    } catch (e) {
      log.e(`MediaRecorder failed: ${e.message}`);
    }

    // Strategy 4: download whatever blob we can get
    if (streamUrl) {
      try {
        await downloadUrl(streamUrl, realName);
        return true;
      } catch (_) { }
    }

    log.e(`Could not download: ${realName}`);
    return false;
  }

  // Download a shared media item by opening it in Telegram's Media Viewer
  // This gives us access to the full-resolution photo or video stream URL
  async function downloadViaMediaViewer(item) {
    const { el, name, type, _msgId } = item;

    // Step 1: Make sure the shared media sidebar is visible and on the Media tab
    let searchSuper = document.querySelector(".search-super");

    // If not found, try to re-open it (retry logic from sharedMediaScan)
    if (!searchSuper) {
      log.w(`Shared Media sidebar closed, re-opening for ${name}...`);
      try {
        const clickTargets = [
          ".chat-info .content", ".chat-info .person", ".top .person",
          ".chat-info .peer-title", ".top .peer-title", ".chat-info .avatar-element"
        ];
        for (const sel of clickTargets) {
          const t = document.querySelector(sel);
          if (t) { t.click(); await sleep(800); break; }
        }
        // Wait for it
        for (let i = 0; i < 15; i++) {
          searchSuper = document.querySelector(".search-super");
          if (searchSuper) break;
          await sleep(300);
        }
      } catch (e) {
        log.w(`Failed to re-open sidebar: ${e.message}`);
      }
    }

    if (!searchSuper) {
      log.w(`Shared Media sidebar not open, can't download ${name}`);
      return false;
    }

    // Ensure Media tab is active
    const mediaTab = searchSuper.querySelector(".search-super-container-media");
    if (mediaTab && !mediaTab.classList.contains("active")) {
      const nav = searchSuper.querySelector("nav.search-super-tabs");
      if (nav) {
        const tabs = nav.querySelectorAll(".menu-horizontal-div-item");
        tabs.forEach(t => {
          if ((t.textContent || "").trim().toLowerCase().includes("media")) t.click();
        });
        await sleep(800);
      }
    }

    // Step 2: Find the grid item in the DOM
    let gridItem = null;
    if (_msgId) {
      gridItem = document.querySelector(`.grid-item.search-super-item[data-mid="${_msgId}"]`);
    }
    if (!gridItem && el && document.contains(el)) {
      gridItem = el;
    }

    if (!gridItem) {
      // Scroll sidebar to find the item
      const scrollContainer = document.querySelector("#column-right .sidebar-content > .scrollable.scrollable-y")
        || searchSuper.closest(".scrollable");
      if (scrollContainer && _msgId) {
        // First try scrolling to top
        scrollContainer.scrollTop = 0;
        await sleep(300);
        gridItem = document.querySelector(`.grid-item.search-super-item[data-mid="${_msgId}"]`);

        if (!gridItem) {
          // Scroll down to find it
          for (let attempt = 0; attempt < 100; attempt++) {
            scrollContainer.scrollTop += scrollContainer.clientHeight * 0.6;
            await sleep(250);
            gridItem = document.querySelector(`.grid-item.search-super-item[data-mid="${_msgId}"]`);
            if (gridItem) break;
          }
        }
      }
      if (!gridItem) {
        log.w(`Grid item ${_msgId} not found in DOM`);
        return false;
      }
    }

    // Step 3: Scroll the grid item into view before clicking
    gridItem.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(300); // Increased from 200

    // Step 4: Hide gallery overlay temporarily so viewer is accessible
    const galleryOverlay = document.getElementById("tg-gallery");
    if (galleryOverlay) galleryOverlay.style.display = "none";

    // Step 5: Click the grid item to open in Media Viewer
    gridItem.click();

    // Step 6: Wait for Media Viewer to appear with content
    let viewer = null;
    let contentReady = false;
    for (let i = 0; i < 50; i++) { // Increased wait time
      await sleep(200);
      viewer = document.querySelector(".media-viewer-whole");
      if (viewer) {
        // Check if actual content (video or img) has loaded
        const mediaArea = viewer.querySelector(".media-viewer-movers .media-viewer-aspecter");
        if (mediaArea) {
          const video = mediaArea.querySelector("video");
          const img = mediaArea.querySelector("img:not(.emoji):not([class*='avatar'])");
          if ((video && video.src) || (img && img.src && img.naturalWidth > 0)) {
            contentReady = true;
            break;
          }
        }
      }
    }

    if (!viewer) {
      log.w(`Media viewer no se abrió para ${name}`);
      if (galleryOverlay) galleryOverlay.style.display = "";
      return false;
    }

    // Extra wait for content to stabilize (Telegram sometimes swaps img src)
    if (!contentReady) await sleep(1500);
    else await sleep(300);

    // Step 7: Download from viewer
    let success = false;
    let realFileName = null;
    try {
      const result = await downloadFromViewer(viewer, name);
      if (typeof result === "object" && result !== null) {
        success = result.success;
        realFileName = result.realFileName;
      } else {
        success = !!result;
      }
    } catch (err) {
      log.e(`Error downloading via viewer: ${err.message}`);
    }

    // Step 8: Close the Media Viewer
    await closeMediaViewer(viewer);

    // Step 9: Restore gallery overlay
    if (galleryOverlay) galleryOverlay.style.display = "";

    // Step 10: Rate limit protection — shorter delays
    if (type === "video" || type === "gif") {
      log.i("Enfriamiento post-video (1.5s)...");
      await sleep(1500);
    } else {
      await sleep(200);
    }

    return { success, realFileName };
  }

  // Download the currently displayed item from an open Media Viewer
  // Polls for content to appear, handling async loading
  async function downloadFromViewer(viewer, fallbackName) {
    // Poll for media content — Telegram loads it asynchronously
    let video = null;
    let img = null;

    for (let attempt = 0; attempt < 15; attempt++) {
      const mediaArea = viewer.querySelector(".media-viewer-movers .media-viewer-aspecter");
      if (mediaArea) {
        video = mediaArea.querySelector("video") || viewer.querySelector(".ckin__player video");
        if (video && video.src) break;

        // Look for full-res img (not emoji, not avatar, not tiny loader)
        const imgs = mediaArea.querySelectorAll("img");
        for (const candidate of imgs) {
          if (candidate.src &&
            !candidate.src.includes("emoji") &&
            !candidate.className.includes("avatar") &&
            candidate.naturalWidth > 100) {
            img = candidate;
            break;
          }
        }
        if (img) break;
      }
      await sleep(300);
    }

    if (video && video.src) {
      const vName = extractFileName(video.src || video.currentSrc, video, "video") || fallbackName;
      // Check duplicate before downloading (real name may differ from scan name)
      if (S._bulkExistingFiles && S._bulkExistingFiles.has(nameKey(vName))) {
        log.i(`⏭ Skipped via viewer (duplicate): ${vName}`);
        return { success: true, realFileName: vName };
      }
      log.i(`Downloading video via viewer: ${vName}`);
      const success = await downloadVideoSmart(video, vName, null);
      return { success, realFileName: vName };
    }

    if (img?.src) {
      const pName = extractFileName(img.src, img, "photo") || fallbackName;
      // Check duplicate before downloading
      if (S._bulkExistingFiles && S._bulkExistingFiles.has(nameKey(pName))) {
        log.i(`⏭ Skipped via viewer (duplicate): ${pName}`);
        return { success: true, realFileName: pName };
      }
      log.i(`Downloading photo via viewer: ${pName}`);
      const success = await downloadUrl(img.src, pName);
      return { success, realFileName: pName };
    }

    log.w(`No video/img found in viewer for ${fallbackName}`);
    return { success: false, realFileName: null };
  }

  // Close the media viewer
  async function closeMediaViewer(viewer) {
    if (!viewer) viewer = document.querySelector(".media-viewer-whole");
    if (!viewer) return;

    // Try the close button first
    const closeBtn = viewer.querySelector(".btn-icon.media-viewer-close") ||
      viewer.querySelector(".media-viewer-close");
    if (closeBtn) {
      closeBtn.click();
    } else {
      // Fallback: Escape key
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", code: "Escape", keyCode: 27,
        bubbles: true, cancelable: true
      }));
    }
    // Wait for viewer to fully close
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      if (!document.querySelector(".media-viewer-whole")) return;
    }
    // Force: try escape again
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", code: "Escape", keyCode: 27,
      bubbles: true, cancelable: true
    }));
    await sleep(500);
  }

  async function downloadItem(item, onProgress) {
    const { type, src, el, name, isCanvas, unloaded } = item;

    // ── Strategy 1: Try Telegram API download (fastest, most reliable) ──
    if (item._msgId) {
      const peerId = getPeerId();
      if (peerId) {
        // Pre-download duplicate check: get real filename from metadata BEFORE downloading
        if (S._bulkExistingFiles) {
          try {
            const meta = await getMetadata(item._msgId, peerId);
            if (meta?.fileName) {
              const metaKey = nameKey(meta.fileName);
              if (S._bulkExistingFiles.has(metaKey)) {
                log.i(`⏭ Skipped (metadata pre-check): ${meta.fileName}`);
                return { success: true, realFileName: meta.fileName, skipped: true };
              }
            }
            // Skip files larger than user-configured max size
            if (S.maxFileSizeMB > 0 && meta?.size) {
              const maxBytes = S.maxFileSizeMB * 1024 * 1024;
              if (meta.size > maxBytes) {
                const sizeMB = (meta.size / 1048576).toFixed(0);
                log.w(`⏭ Skipped (too large: ${sizeMB} MB, max ${S.maxFileSizeMB} MB): ${meta?.fileName || name}`);
                return { success: true, realFileName: meta?.fileName || name, skipped: true };
              }
            }
          } catch (_) { /* metadata check failed, proceed with download */ }
        }

        try {
          const isVideo = type === "video" || type === "gif";
          const result = await downloadViaAPI(item._msgId, peerId, isVideo, 90000);
          if (result?.blobUrl) {
            const realName = result.fileName || name;
            const blob = await (await fetch(result.blobUrl)).blob();
            await downloadBlob(blob, realName);
            revokeInjectedUrl(result.blobUrl);
            log.i(`✓ API download: ${realName} (${humanSize(blob.size)})`);
            return { success: true, realFileName: realName };
          }
        } catch (e) {
          log.w(`API download failed for ${name}: ${e.message}, falling back to viewer`);
        }
      }
    }

    // ── Strategy 2: Shared Media viewers (fallback) ──
    if (item._fromSharedMedia) {
      if (S._viewerConsecFails >= 3) {
        log.w(`⏭ Skipped viewer fallback (${S._viewerConsecFails} consecutive failures): ${name}`);
        return { success: false, realFileName: null };
      }
      const result = await downloadViaMediaViewer(item);
      const ok = typeof result === "object" ? result.success : !!result;
      if (ok) {
        S._viewerConsecFails = 0;
      } else {
        S._viewerConsecFails = (S._viewerConsecFails || 0) + 1;
      }
      if (typeof result === "object") return result;
      return { success: !!result, realFileName: null };
    }

    if (type === "photo" && isCanvas && el?.tagName === "CANVAS" && document.contains(el)) {
      return new Promise((res) => {
        el.toBlob((b) => { if (b) downloadBlob(b, name.replace(/\.[^.]+$/, ".png")); res(true); }, "image/png");
      });
    }
    if (type === "photo") {
      if (src) return downloadUrl(src, name);
      log.w(`Photo without src: ${name}`);
      return false;
    }
    if (type === "gif" || type === "video") {
      if (el?.tagName === "VIDEO" && document.contains(el)) {
        return downloadVideoSmart(el, name, onProgress);
      }
      if (src && !src.startsWith("blob:")) {
        const realName = fileNameFromStreamUrl(src) || name;
        try {
          const result = await downloadViaInjected(src);
          if (result?.blobUrl) {
            const finalName = result.fileName || realName;
            await downloadBlob(await (await fetch(result.blobUrl)).blob(), finalName);
            URL.revokeObjectURL(result.blobUrl);
            return true;
          }
        } catch (e) { log.w(`SW download failed: ${e.message}`); }
      }
      if (src?.startsWith("blob:")) {
        try {
          const blob = await (await fetch(src)).blob();
          if (blob.size > 10000) {
            await downloadBlob(blob, name);
            return true;
          }
        } catch (_) { }
      }
      if (unloaded && !src) {
        // Try API download for unloaded videos (uses message ID)
        if (item._msgId) {
          const peerId = getPeerId();
          if (peerId) {
            try {
              const result = await downloadViaAPI(item._msgId, peerId, true, 180000);
              if (result?.blobUrl) {
                const realName = result.fileName || name;
                const blob = await (await fetch(result.blobUrl)).blob();
                await downloadBlob(blob, realName);
                revokeInjectedUrl(result.blobUrl);
                log.i(`✓ API download (unloaded): ${realName} (${humanSize(blob.size)})`);
                return { success: true, realFileName: realName };
              }
            } catch (e) {
              log.w(`API download failed for unloaded ${name}: ${e.message}`);
            }
          }
        }
        log.w(`Unloaded video: ${name}. Open it in the viewer.`);
        return false;
      }
      if (src) return downloadUrl(src, name);
      return false;
    }
    if (type === "audio") {
      if (src && !src.startsWith("blob:")) {
        const realName = fileNameFromStreamUrl(src) || name;
        try {
          const result = await downloadViaInjected(src);
          if (result?.blobUrl) {
            await downloadBlob(await (await fetch(result.blobUrl)).blob(), result.fileName || realName);
            URL.revokeObjectURL(result.blobUrl);
            return true;
          }
        } catch (_) { }
        return downloadUrl(src, name);
      }
      if (src) return downloadUrl(src, name);
      return false;
    }
    if (type === "doc") {
      if (el && document.contains(el)) {
        const dlBtn = el.querySelector?.('button[class*="download"], .download, [data-type="download"]');
        if (dlBtn) { dlBtn.click(); return true; }
      }
      log.w(`Doc: ${name} — open the chat and download it from there`);
      return false;
    }
    return false;
  }


  // =============================================
  // MEDIA VIEWER HANDLER
  // =============================================
  function watchMediaViewer() {
    const v = detectVersion();

    const observer = new MutationObserver(() => {
      const viewer = document.querySelector(SEL[v].mediaViewer);
      if (!viewer) return;
      if (viewer.querySelector(".tg-grab-viewer-btn")) return;

      log.i("Media Viewer detected, injecting button...");

      // --- K version: also unhide restricted buttons ---
      if (v === "K") {
        const btns = viewer.querySelectorAll(".media-viewer-buttons button.btn-icon.hide");
        btns.forEach((b) => {
          b.classList.remove("hide");
          if (b.textContent === FORWARD_ICON_UNI) b.classList.add("tgico-forward");
          if (b.textContent === DOWNLOAD_ICON_UNI) b.classList.add("tgico-download");
        });
      }

      const mediaArea = viewer.querySelector(SEL[v].mediaViewerMedia);
      if (!mediaArea) return;

      const video = mediaArea.querySelector(SEL[v].mediaViewerVideo);
      const img = mediaArea.querySelector(SEL[v].mediaViewerImg);

      if (!video && !img) return;

      const dlBtn = document.createElement("button");
      dlBtn.className = "tg-grab-viewer-btn";
      dlBtn.innerHTML = `${ICO.dl} Download`;

      dlBtn.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        dlBtn.innerHTML = `${ICO.spin} Downloading...`;
        dlBtn.style.pointerEvents = "none";
        try {
          if (video) {
            const name = extractFileName(video.src || video.currentSrc, video, "video");
            await downloadVideoSmart(video, name, null);
          } else if (img?.src) {
            const name = extractFileName(img.src, img, "photo");
            await downloadUrl(img.src, name);
          }
          dlBtn.innerHTML = `${ICO.ok} Done!`;
          setTimeout(() => { dlBtn.innerHTML = `${ICO.dl} Download`; dlBtn.style.pointerEvents = ""; }, 2500);
        } catch (err) {
          log.e(err.message);
          dlBtn.innerHTML = `${ICO.dl} Download`;
          dlBtn.style.pointerEvents = "";
        }
      });

      viewer.appendChild(dlBtn);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    log.i("Media viewer observer active");
  }

  // =============================================
  // STORIES HANDLER
  // =============================================
  function watchStories() {
    const v = detectVersion();

    const observer = new MutationObserver(() => {
      const container = document.querySelector(SEL[v].stories);
      if (!container || container.querySelector(".tg-grab-viewer-btn")) return;

      const dlBtn = document.createElement("button");
      dlBtn.className = "tg-grab-viewer-btn";
      dlBtn.style.bottom = "70px";
      dlBtn.innerHTML = `${ICO.dl} Download Story`;

      dlBtn.addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        dlBtn.innerHTML = `${ICO.spin} Downloading...`;

        const video = container.querySelector(SEL[v].storyVideo);
        if (video) {
          const vSrc = video.src || video.currentSrc || "";
          await downloadVideoSmart(video, extractFileName(vSrc, video, "video"), null);
        } else {
          const imgs = container.querySelectorAll(SEL[v].storyImg);
          const img = imgs[imgs.length - 1];
          if (img?.src) await downloadUrl(img.src, extractFileName(img.src, img, "photo"));
        }

        dlBtn.innerHTML = `${ICO.ok} Done!`;
        setTimeout(() => { dlBtn.innerHTML = `${ICO.dl} Download Story`; }, 2500);
      });

      container.appendChild(dlBtn);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    log.i("Stories observer active");
  }

  // =============================================
  // RESTRICTED CONTENT BYPASS
  // =============================================
  function bypassRestrictions() {
    if (!S.restrictedEnabled) return;

    // Allow right-click
    document.addEventListener("contextmenu", (e) => e.stopPropagation(), true);
    ["copy", "cut", "selectstart", "dragstart"].forEach((ev) => {
      document.addEventListener(ev, (e) => e.stopPropagation(), true);
    });

    // Remove no-forwards classes on new elements
    new MutationObserver((muts) => {
      muts.forEach((m) => m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        n.classList?.remove("no-forwards");
        n.removeAttribute?.("data-noforwards");
        n.querySelectorAll?.(".no-forwards, [data-noforwards]").forEach((el) => {
          el.classList.remove("no-forwards");
          el.removeAttribute("data-noforwards");
        });
      }));
    }).observe(document.body, { childList: true, subtree: true });

    log.i("Restrictions removed");
  }

  // =============================================
  // AUTO-SCROLL SCANNER
  // =============================================
  // =============================================
  // SHARED MEDIA SCANNER — Uses Telegram's Shared Media sidebar
  // This approach is far more reliable than scrolling chat bubbles because:
  // 1. Telegram already deduplicates items by message ID
  // 2. Each grid item has a stable data-mid attribute
  // 3. No DOM recycling issues — items in the grid are simple thumbnails
  // 4. Covers ALL media in the chat, not just what's loaded in the bubbles
  // =============================================

  async function autoScrollScan(onMedia, onProgress, signal) {
    const v = detectVersion();

    if (v === "K") {
      return sharedMediaScan(onMedia, onProgress, signal);
    }
    // Fallback for version A — simple chat scroll
    return chatScrollScan(onMedia, onProgress, signal);
  }

  // Main scanner: Opens Shared Media sidebar and scrolls media grid
  // DOM structure (Telegram K, confirmed via inspection):
  //   .search-super
  //     .search-super-tabs-scrollable > .scrollable > nav.search-super-tabs.menu-horizontal-div
  //       div.menu-horizontal-div-item (per tab: Chats, Stories, Members, Media, Gifts, etc.)
  //     .search-super-tabs-container.tabs-container
  //       div.search-super-container-media.tabs-tab.active
  //         div.search-super-content-media
  //           div.search-super-month
  //             div.search-super-month-items
  //               div.grid-item.search-super-item[data-mid][data-peer-id]
  //                 span.video-time (if video) | img.media-photo.grid-item-media
  async function sharedMediaScan(onMedia, onProgress, signal) {
    const allMedia = [];
    const seenMids = new Set();

    log.i("Opening Shared Media panel...");
    if (onProgress) onProgress("scanning", 0, 0);

    // Step 1: Open the profile sidebar if not already open
    // We check if it exists AND is visible (offsetParent != null implies display != none)
    let searchSuper = document.querySelector(".search-super");
    if (searchSuper && (searchSuper.offsetParent === null || searchSuper.clientHeight === 0)) {
      searchSuper = null;
    }

    if (!searchSuper) {
      // Try clicking chat header elements to open sidebar
      const clickTargets = [
        ".chat-info .content",
        ".chat-info .person",
        ".top .person",
        ".chat-info .peer-title",
        ".top .peer-title",
        ".chat-info .avatar-element",
        ".chat-utils .search-super-button" // Some versions have a button
      ];
      for (const sel of clickTargets) {
        const el = document.querySelector(sel);
        // Ensure we click a visible element
        if (el && el.offsetParent !== null) {
          log.i(`Trying to open sidebar click in: ${sel}`);
          el.click();
          await sleep(600);
          break;
        }
      }

      // Wait for sidebar & search-super to appear and be visible
      for (let i = 0; i < 25; i++) {
        if (signal?.aborted) return allMedia;

        const el = document.querySelector(".search-super");
        if (el && el.offsetParent !== null && el.clientHeight > 0) {
          searchSuper = el;
          break;
        }

        // Try scrolling profile content down to reveal shared media section
        const profileScroll = document.querySelector("#column-right .scrollable.scrollable-y");
        if (profileScroll && i === 5) {
          profileScroll.scrollTop = profileScroll.scrollHeight;
        }
        await sleep(300);
      }
    }

    if (!searchSuper) {
      log.w("Could not find .search-super. Falling back to chat scroll...");
      return chatScrollScan(onMedia, onProgress, signal);
    }

    log.i("search-super found, looking for tabs...");

    // Step 2: Find and identify tabs (div.menu-horizontal-div-item inside nav)
    const nav = searchSuper.querySelector("nav.search-super-tabs");
    const tabEls = nav ? nav.querySelectorAll(".menu-horizontal-div-item") : [];
    log.i(`Found ${tabEls.length} tabs in nav`);

    // Map tab labels to elements
    const tabMap = {};
    tabEls.forEach((t) => {
      const label = (t.textContent || "").trim().toLowerCase();
      if (label.includes("media") || label.includes("foto") || label.includes("photo")) tabMap.media = t;
      else if (label.includes("file") || label.includes("archivo")) tabMap.files = t;
      else if (label.includes("music") || label.includes("música")) tabMap.music = t;
      else if (label.includes("voice") || label.includes("voz")) tabMap.voice = t;
    });

    log.i(`Mapped tabs: ${Object.keys(tabMap).join(", ")}`);

    // Helper: scan all grid-item.search-super-item elements currently in DOM
    function scanGridItems() {
      let newCount = 0;

      searchSuper.querySelectorAll(".grid-item.search-super-item[data-mid]").forEach((item) => {
        const mid = item.dataset.mid;
        if (!mid || seenMids.has(mid)) return;
        seenMids.add(mid);

        let type = "photo";
        let src = null;
        let thumb = null;
        let name = "";

        // Video detection: has span.video-time child
        const videoTime = item.querySelector("span.video-time");
        if (videoTime) {
          const duration = videoTime.textContent?.trim() || "";
          // GIF detection: short videos or "GIF" badge
          if (duration === "GIF" || item.querySelector(".gif-badge")) {
            type = "gif";
            name = `gif_${mid}.mp4`;
          } else {
            type = "video";
            name = `video_${mid}${duration ? "_" + duration.replace(/:/g, "m") : ""}.mp4`;
          }
        }

        // Thumbnail from img
        const img = item.querySelector("img.media-photo, img.grid-item-media, img");
        if (img?.src) {
          thumb = img.src;
          if (type === "photo") src = img.src;
        }

        // Canvas fallback
        if (!thumb) {
          const canvas = item.querySelector("canvas");
          if (canvas) try { thumb = canvas.toDataURL("image/jpeg", 0.6); } catch (_) { }
        }

        if (type === "photo" && !name) name = `photo_${mid}.jpg`;

        const serialized = {
          type,
          src,
          thumb,
          name,
          isCanvas: false,
          unloaded: type !== "photo", // videos need media viewer to download
          el: item,
          _msgId: mid,
          _fromSharedMedia: true,
        };

        allMedia.push(serialized);
        newCount++;
        if (onMedia) onMedia(serialized, allMedia.length);
      });

      return newCount;
    }

    // Helper: scan document/file items
    function scanFileItems() {
      let newCount = 0;
      const fileContainer = searchSuper.querySelector(".search-super-content-files");
      if (!fileContainer) return 0;

      fileContainer.querySelectorAll("[data-mid]").forEach((item) => {
        const mid = item.dataset.mid;
        if (!mid || seenMids.has(mid)) return;
        seenMids.add(mid);

        const nameEl = item.querySelector(".document-name, .text-bold, .file-title");
        const name = nameEl?.textContent?.trim() || `file_${mid}`;

        allMedia.push({
          type: "doc", src: null, thumb: null, name,
          isCanvas: false, unloaded: true, el: item,
          _msgId: mid, _fromSharedMedia: true,
        });
        newCount++;
        if (onMedia) onMedia(allMedia[allMedia.length - 1], allMedia.length);
      });
      return newCount;
    }

    // Step 3: Scan the Media tab (already active by default)
    // The scrollable is the profile sidebar's main scrollable
    // Find the correct scrollable container
    let scrollContainer = document.querySelector("#column-right .sidebar-content > .scrollable.scrollable-y");

    // Fallback: find closest scrollable parent of searchSuper
    if (!scrollContainer || scrollContainer.clientHeight === 0) {
      let p = searchSuper.parentElement;
      while (p && p !== document.body) {
        const style = window.getComputedStyle(p);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && p.clientHeight > 0) {
          scrollContainer = p;
          break;
        }
        p = p.parentElement;
      }
    }

    if (!scrollContainer) {
      log.w("No scrollable container found");
      scanGridItems();
    } else {
      log.i(`Scroll container found: ${scrollContainer.className} (Height: ${scrollContainer.clientHeight}, ScrollHeight: ${scrollContainer.scrollHeight})`);

      // Scan Media tab
      const mediaTabTypes = ["media"];
      for (const tabType of mediaTabTypes) {
        if (signal?.aborted) break;

        const tab = tabMap[tabType];
        if (!tab) { log.i(`Tab "${tabType}" not found, skip`); continue; }

        if (tab.classList.contains("hide")) { log.i(`Tab "${tabType}" hidden, skip`); continue; }

        log.i(`Clicking tab: ${tabType}...`);
        tab.click();
        await sleep(800);

        const scanFn = (tabType === "files" || tabType === "voice") ? scanFileItems : scanGridItems;
        scanFn();

        let staleRounds = 0;
        const MAX_STALE = 8;
        let scrollAttempts = 0;
        let lastScrollTop = -1;
        let lastScrollHeight = scrollContainer.scrollHeight;

        while (scrollAttempts < 500 && staleRounds < MAX_STALE) {
          if (signal?.aborted) break;

          const prevCount = allMedia.length;

          // Scroll down
          lastScrollTop = scrollContainer.scrollTop;
          scrollContainer.scrollTop += scrollContainer.clientHeight * 0.8;
          await sleep(400);

          // Check if scroll actually moved
          const scrollMoved = Math.abs(scrollContainer.scrollTop - lastScrollTop) >= 2;

          if (!scrollMoved) {
            // Scroll didn't move — we might be at the bottom.
            // Wait for Telegram to load more content (scrollHeight may grow).
            let loaded = false;
            for (let wait = 0; wait < 8; wait++) {
              await sleep(400);
              // Check if a loading spinner is visible (Telegram shows one while fetching)
              const loader = searchSuper.querySelector(".preloader-container:not(.hide), .loader, .lds-ring");
              if (loader) {
                // Still loading, keep waiting
                loaded = false;
                continue;
              }
              // Check if scrollHeight grew (new content appeared)
              if (scrollContainer.scrollHeight > lastScrollHeight + 10) {
                loaded = true;
                break;
              }
              // Check if new items appeared
              if (scanFn() > 0) {
                loaded = true;
                break;
              }
            }
            if (loaded) {
              lastScrollHeight = scrollContainer.scrollHeight;
              staleRounds = 0; // Reset — content is still loading
            } else {
              staleRounds += 3; // Genuine end of content
            }
          } else {
            // Scroll moved — poll for new items to appear in DOM
            for (let poll = 0; poll < 3; poll++) {
              await sleep(300);
              if (scanFn() > 0) break;
            }

            // Track scrollHeight growth (Telegram loads more as you scroll)
            if (scrollContainer.scrollHeight > lastScrollHeight + 10) {
              lastScrollHeight = scrollContainer.scrollHeight;
              staleRounds = Math.max(0, staleRounds - 1); // Content is growing, reduce staleness
            }

            if (allMedia.length === prevCount) {
              staleRounds++;
            } else {
              staleRounds = 0;
            }
          }

          scrollAttempts++;

          // Log every 5 iterations or on first few
          if (scrollAttempts <= 3 || scrollAttempts % 5 === 0) {
            log.i(`[${tabType}] Loop ${scrollAttempts}: ${allMedia.length} items. Scroll: ${Math.round(scrollContainer.scrollTop)}/${scrollContainer.scrollHeight}. Stale: ${staleRounds}`);
          }

          if (onProgress) onProgress("scanning", allMedia.length, scrollAttempts);
        }
        log.i(`[${tabType}] Done. ${allMedia.length} items total (loops: ${scrollAttempts}, stale: ${staleRounds})`);

        if (tabType === "media") {
          scrollContainer.scrollTop = 0;
          await sleep(500);
        }
      }
    }

    // Step 4: Don't close sidebar — items need to stay in DOM for downloadViaMediaViewer
    // The sidebar will be closed when the gallery closes or downloads finish

    if (onProgress) onProgress("done", allMedia.length, 0);
    log.i(`Shared Media scan complete: ${allMedia.length} items (${seenMids.size} unique mids)`);
    return allMedia;
  }

  // Fallback: old chat scroll approach (for Telegram A or if sidebar fails)
  async function chatScrollScan(onMedia, onProgress, signal) {
    const v = detectVersion();

    let scrollEl = null;
    if (v === "K") {
      scrollEl = document.querySelector(".bubbles .scrollable");
      if (!scrollEl) scrollEl = document.querySelector(".bubbles-inner")?.closest(".scrollable");
      if (!scrollEl) scrollEl = document.querySelector(".bubbles");
    } else {
      scrollEl = document.querySelector(".MessageList")?.closest(".scrollable") || document.querySelector(".MessageList");
    }

    if (!scrollEl) { log.w("No se encontró scroll container"); return []; }

    const allMedia = [];
    const seenKeys = new Set();
    const seenMids = new Set();
    const scannedMids = new Set();
    let scrollAttempts = 0;
    const MAX_ATTEMPTS = 600;
    let staleRounds = 0;
    const MAX_STALE = 12;

    function collectMids() {
      const mids = new Set();
      document.querySelectorAll(SEL[v].message).forEach((msg) => {
        const mid = msg.dataset?.mid;
        if (mid) mids.add(mid);
      });
      return mids;
    }

    function scanCurrentView() {
      let newCount = 0;
      document.querySelectorAll(SEL[v].message).forEach((msg) => {
        const mid = msg.dataset?.mid || "";
        if (!mid) return;
        if (scannedMids.has(mid)) return;
        scannedMids.add(mid);

        const items = findMediaInMessage(msg, v);
        const typeCounts = {};
        items.forEach((item) => {
          const t = item.type;
          typeCounts[t] = (typeCounts[t] || 0);
          const key = `${mid}_${t}_${typeCounts[t]}`;
          typeCounts[t]++;
          if (seenKeys.has(key)) return;
          seenKeys.add(key);

          const serialized = {
            type: item.type,
            src: item.src,
            thumb: item.thumb,
            name: item.name,
            isCanvas: item.isCanvas || false,
            unloaded: item.unloaded || false,
            el: item.el,
            _msgId: mid,
          };

          if (item.isCanvas && item.el?.tagName === "CANVAS") {
            try { serialized.thumb = item.el.toDataURL("image/jpeg", 0.6); } catch (_) { }
          }
          if (item.type === "photo" && item.el?.tagName === "IMG" && item.el.src) {
            serialized.thumb = item.el.src;
            serialized.src = item.el.src;
          }

          allMedia.push(serialized);
          newCount++;
          if (onMedia) onMedia(serialized, allMedia.length);
        });
      });
      return newCount;
    }

    scanCurrentView();
    collectMids().forEach(m => seenMids.add(m));
    if (onProgress) onProgress("scanning", allMedia.length, 0);
    log.i(`Scan inicial: ${allMedia.length} media, ${seenMids.size} mensajes`);

    while (scrollAttempts < MAX_ATTEMPTS) {
      if (signal?.aborted) break;

      scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop - scrollEl.clientHeight * 0.8);
      await sleep(300);

      let gotNew = false;
      for (let poll = 0; poll < 8; poll++) {
        await sleep(400);
        const currentMids = collectMids();
        let newMidsFound = 0;
        currentMids.forEach(mid => {
          if (!seenMids.has(mid)) { seenMids.add(mid); newMidsFound++; }
        });
        if (newMidsFound > 0) { gotNew = true; break; }
        if (scrollEl.scrollTop > 10) break;
      }

      const newMediaFound = scanCurrentView();

      if (!gotNew && newMediaFound === 0) {
        staleRounds++;
        if (staleRounds >= MAX_STALE) {
          scrollEl.scrollTop = 0;
          await sleep(2000);
          const lastCheck = collectMids();
          let lastNew = 0;
          lastCheck.forEach(mid => {
            if (!seenMids.has(mid)) { seenMids.add(mid); lastNew++; }
          });
          scanCurrentView();
          if (lastNew === 0) {
            log.i(`Fin del chat (${staleRounds} rondas sin nuevos, ${seenMids.size} msgs total)`);
            break;
          } else {
            staleRounds = 0;
          }
        }
      } else {
        staleRounds = 0;
      }

      scrollAttempts++;
      if (onProgress) onProgress("scanning", allMedia.length, scrollAttempts);

      if (scrollAttempts % 15 === 0) {
        log.i(`Scan: ${allMedia.length} media, ${seenMids.size} msgs, ${scrollAttempts} scrolls, stale=${staleRounds}`);
      }
    }

    scrollEl.scrollTop = scrollEl.scrollHeight;

    allMedia.forEach((item) => {
      if (item.el && !document.contains(item.el)) item.el = null;
    });

    if (onProgress) onProgress("done", allMedia.length, scrollAttempts);
    log.i(`Chat scroll scan completo: ${allMedia.length} media en ${scrollAttempts} scrolls (${seenMids.size} msgs vistos)`);
    return allMedia;
  }


  // =============================================
  // SCAN VISIBLE ONLY (quick)
  // =============================================
  function scanVisible() {
    const v = detectVersion();
    const msgs = document.querySelectorAll(SEL[v].message);
    const counts = { photos: 0, videos: 0, gifs: 0, docs: 0, audios: 0 };
    const all = [];

    msgs.forEach((msg) => {
      findMediaInMessage(msg, v).forEach((item) => {
        all.push(item);
        if (item.type === "photo") counts.photos++;
        else if (item.type === "video") counts.videos++;
        else if (item.type === "gif") counts.gifs++;
        else if (item.type === "doc") counts.docs++;
        else if (item.type === "audio") counts.audios++;
      });
    });

    return { counts, total: all.length, media: all };
  }

  // =============================================
  // GALLERY PREVIEW
  // =============================================
  function openGallery(mediaItems) {
    if (S.galleryOpen) return;
    S.galleryOpen = true;

    // Pre-process thumbnails: convert canvas to dataURL, try to capture blob thumbs
    mediaItems.forEach((item) => {
      // Canvas → data URL
      if (item.isCanvas && item.el?.tagName === "CANVAS") {
        try { item.thumb = item.el.toDataURL("image/jpeg", 0.7); } catch (_) { }
      }
      // For photos/videos without thumb, try to get it from the DOM element
      if (!item.thumb && item.el) {
        // Check for nearby img in the same container
        const nearImg = item.el.tagName === "IMG" ? item.el
          : item.el.querySelector?.("img") || item.el.closest?.(".bubble, .Message")?.querySelector("img.media-photo, img.thumbnail, img");
        if (nearImg?.src && !(/avatar|emoji|sticker|profile/i.test(nearImg.src))) {
          item.thumb = nearImg.src;
        }
      }
      // For video poster
      if (!item.thumb && item.el?.tagName === "VIDEO" && item.el.poster) {
        item.thumb = item.el.poster;
      }
    });

    const overlay = document.createElement("div");
    overlay.className = "tg-gallery-overlay";
    overlay.id = "tg-gallery";

    const selectedSet = new Set();
    let filterType = "all";
    let dlInProgress = false;

    function getFiltered() {
      if (filterType === "all") return mediaItems;
      return mediaItems.filter((m) => m.type === filterType);
    }

    function render() {
      const filtered = getFiltered();
      const selCount = selectedSet.size;
      const totalItems = filtered.length;

      overlay.innerHTML = `
        <div class="tg-gallery-header">
          <div>
            <div class="tg-gallery-title">📸 Galería — ${mediaItems.length} archivos</div>
            <div class="tg-gallery-subtitle">${selCount} seleccionados de ${totalItems} visibles</div>
          </div>
          <div class="tg-gallery-actions">
            <button class="tg-gallery-btn primary" id="tgGalDl" ${selCount === 0 ? "disabled" : ""}>
              ⬇ Descargar ${selCount > 0 ? `(${selCount})` : "seleccionados"}
            </button>
            <button class="tg-gallery-btn close-btn" id="tgGalClose">✕</button>
          </div>
        </div>
        <div class="tg-gallery-filters">
          ${[
          ["all", "Todos", mediaItems.length],
          ["photo", "📸 Fotos", mediaItems.filter((m) => m.type === "photo").length],
          ["video", "🎬 Videos", mediaItems.filter((m) => m.type === "video").length],
          ["gif", "🎭 GIFs", mediaItems.filter((m) => m.type === "gif").length],
          ["audio", "🎵 Audio", mediaItems.filter((m) => m.type === "audio").length],
          ["doc", "📎 Docs", mediaItems.filter((m) => m.type === "doc").length],
        ].filter(([, , c]) => c > 0).map(([t, label, count]) =>
          `<button class="tg-gallery-chip ${filterType === t ? "active" : ""}" data-filter="${t}">${label} (${count})</button>`
        ).join("")}
          <button class="tg-gallery-select-all" id="tgGalSelAll">
            ${selCount === totalItems ? "Deseleccionar todo" : "Seleccionar todo"}
          </button>
        </div>
        <div class="tg-gallery-grid" id="tgGalGrid">
          ${filtered.map((item, i) => {
          const idx = mediaItems.indexOf(item);
          const isSelected = selectedSet.has(idx);
          const safeName = escapeHtml(item.name);
          return `
              <div class="tg-gallery-item ${isSelected ? "selected" : ""}" data-idx="${idx}">
                <div class="tg-gallery-item-check">${isSelected ? "✓" : ""}</div>
                ${item.type === "doc"
              ? `<div class="tg-gallery-item-doc">
                      <div class="tg-gallery-item-doc-icon">📄</div>
                      <div class="tg-gallery-item-doc-name">${safeName}</div>
                    </div>`
              : item.type === "audio"
                ? `<div class="tg-gallery-item-doc">
                        <div class="tg-gallery-item-doc-icon">🎵</div>
                        <div class="tg-gallery-item-doc-name">${safeName}</div>
                      </div>`
                : item.thumb
                  ? `<img src="${item.thumb}" loading="lazy" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                         <div class="tg-gallery-item-doc" style="display:none">
                           <div class="tg-gallery-item-doc-icon">${item.type === "video" ? "🎬" : item.type === "gif" ? "🎭" : "📸"}</div>
                           <div class="tg-gallery-item-doc-name">${safeName}</div>
                         </div>`
                  : `<div class="tg-gallery-item-doc">
                          <div class="tg-gallery-item-doc-icon">${item.type === "video" ? "🎬" : item.type === "gif" ? "🎭" : "📸"}</div>
                          <div class="tg-gallery-item-doc-name">${safeName}</div>
                        </div>`
            }
                <div class="tg-gallery-item-badge">${item.type === "photo" ? "IMG" : item.type === "video" ? "VID" : item.type === "gif" ? "GIF" : item.type === "audio" ? "AUD" : "DOC"
            }</div>
              </div>`;
        }).join("")}
          ${filtered.length === 0 ? '<div class="tg-gallery-empty">No se encontró multimedia de este tipo</div>' : ""}
        </div>
        <div class="tg-gallery-footer">
          <div class="tg-gallery-footer-info" id="tgGalFooterInfo">${selCount} seleccionados</div>
          <div class="tg-gallery-footer-progress" id="tgGalProgress">
            <div class="tg-gallery-footer-progress-fill" id="tgGalProgressFill"></div>
          </div>
        </div>
      `;

      // Event listeners
      overlay.querySelector("#tgGalClose").onclick = closeGallery;

      overlay.querySelectorAll(".tg-gallery-chip").forEach((chip) => {
        chip.onclick = () => { filterType = chip.dataset.filter; render(); };
      });

      overlay.querySelector("#tgGalSelAll").onclick = () => {
        const filtered = getFiltered();
        const allIdxs = filtered.map((m) => mediaItems.indexOf(m));
        const allSelected = allIdxs.every((i) => selectedSet.has(i));
        if (allSelected) {
          allIdxs.forEach((i) => selectedSet.delete(i));
        } else {
          allIdxs.forEach((i) => selectedSet.add(i));
        }
        render();
      };

      overlay.querySelectorAll(".tg-gallery-item").forEach((el) => {
        el.onclick = () => {
          const idx = parseInt(el.dataset.idx);
          if (selectedSet.has(idx)) selectedSet.delete(idx);
          else selectedSet.add(idx);
          render();
        };
      });

      overlay.querySelector("#tgGalDl").onclick = async () => {
        if (dlInProgress || selectedSet.size === 0) return;
        dlInProgress = true;
        const items = [...selectedSet].map((i) => mediaItems[i]);
        const prog = overlay.querySelector("#tgGalProgress");
        const progFill = overlay.querySelector("#tgGalProgressFill");
        const info = overlay.querySelector("#tgGalFooterInfo");
        const dlBtn = overlay.querySelector("#tgGalDl");
        prog.classList.add("active");
        dlBtn.disabled = true;
        dlBtn.textContent = "⏳ Descargando...";
        S.abortController = new AbortController();

        for (let i = 0; i < items.length; i++) {
          if (S.abortController.signal.aborted) break;
          info.textContent = `Descargando ${i + 1} / ${items.length}: ${items[i].name}`;
          progFill.style.width = `${Math.round(((i + 1) / items.length) * 100)}%`;
          try {
            await downloadItem(items[i]);
          } catch (e) { log.e(e.message); }
          // Longer delay for shared media (viewer open/close cycle)
          await sleep(items[i]._fromSharedMedia ? 800 : 200);
        }

        info.textContent = `✅ ${items.length} files downloaded`;
        dlBtn.textContent = "⬇ Done!";
        dlInProgress = false;
        setTimeout(() => {
          prog.classList.remove("active");
          dlBtn.disabled = false;
          dlBtn.textContent = `⬇ Descargar (${selectedSet.size})`;
        }, 3000);
      };
    }

    function closeGallery() {
      overlay.remove();
      S.galleryOpen = false;
      S.abortController?.abort();
    }

    // Close with Escape
    const onKey = (e) => { if (e.key === "Escape") { closeGallery(); document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);

    document.body.appendChild(overlay);
    render();
  }

  // =============================================
  // TOAST
  // =============================================
  let toastEl = null;
  function showToast(title, current, total) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "tg-grab-toast";
      document.body.appendChild(toastEl);
    }
    // Use a content wrapper so appended children (buttons) survive updates
    let contentDiv = toastEl.querySelector(".tg-grab-toast-content");
    if (!contentDiv) {
      contentDiv = document.createElement("div");
      contentDiv.className = "tg-grab-toast-content";
      toastEl.insertBefore(contentDiv, toastEl.firstChild);
    }
    const isScanning = total === 0 || total === null;
    const pct = !isScanning && total > 0 ? Math.round((current / total) * 100) : 0;
    contentDiv.innerHTML = `
      <div class="tg-grab-toast-title"><span>${isScanning ? "🔍" : "⬇"}</span><span>${title}</span></div>
      ${!isScanning ? `<div class="tg-grab-toast-bar"><div class="tg-grab-toast-fill" style="width:${pct}%"></div></div>` : ""}
      <div class="tg-grab-toast-info"><span>${isScanning ? `${current} encontrados` : `${current} / ${total}`}</span><span>${isScanning ? "..." : `${pct}%`}</span></div>
    `;
    toastEl.style.display = "block";
  }
  function hideToast() { if (toastEl) toastEl.style.display = "none"; }

  // Helper: get name key (no extension, lowercase) for duplicate comparison
  function nameKey(filename) {
    return filename.replace(/\.[^.]+$/, "").toLowerCase();
  }

  async function bulkDownload(types, media) {
    if (S.downloading) return;
    S.downloading = true;
    S.abortController = new AbortController();

    const typeMap = { photos: ["photo"], videos: ["video"], gifs: ["gif"], docs: ["doc"], audios: ["audio"] };
    const allowed = types.flatMap((t) => typeMap[t] || []);
    const filtered = (media || scanVisible().media).filter((m) => allowed.includes(m.type));

    if (!filtered.length) {
      showToast("No media found", 0, 0);
      setTimeout(hideToast, 2000);
      S.downloading = false;
      return;
    }

    // Pre-scan: get all existing files to skip duplicates BEFORE downloading
    showToast("Checking for duplicates...", 0, 0);
    let existingFiles = new Set();
    try {
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "getExistingFiles" }, (r) => {
          resolve(r?.files || []);
        });
      });
      existingFiles = new Set(result);
      S._bulkExistingFiles = existingFiles; // Make accessible to downloadFromViewer
      log.i(`Pre-scan: ${existingFiles.size} existing files found`);
    } catch (e) { log.w("Pre-scan failed: " + e.message); }

    // Filter out already-downloaded items (by filename AND by message ID)
    const toDownload = [];
    let skippedCount = 0;
    const chatName = getChatName();
    for (const item of filtered) {
      const key = nameKey(item.name);
      // Check by filename (works for videos with stable names)
      if (existingFiles.has(key)) {
        log.i(`⏭ Pre-skip (name): ${item.name}`);
        skippedCount++;
        continue;
      }
      // Check by message ID (works for photos with changing hash names)
      if (item._msgId && chatName) {
        const midKey = `${chatName}:${item._msgId}`;
        if (S.downloadedMids.has(midKey)) {
          log.i(`⏭ Pre-skip (msgId ${item._msgId}): ${item.name}`);
          skippedCount++;
          continue;
        }
      }
      toDownload.push(item);
    }

    if (!toDownload.length) {
      showToast(`✅ All already downloaded (${skippedCount} duplicates)`, 0, 0);
      setTimeout(hideToast, 3000);
      S.downloading = false;
      return;
    }

    log.i(`Downloading ${toDownload.length} new, ${skippedCount} pre-skipped`);
    showToast(`Downloading... (${skippedCount} skipped)`, 0, toDownload.length);

    for (let i = 0; i < toDownload.length; i++) {
      if (S.abortController.signal.aborted) break;
      try {
        const result = await downloadItem(toDownload[i], (pct) => showToast(`Downloading ${toDownload[i].name}`, i, toDownload.length));
        // Track both the scan name AND the real viewer name as downloaded
        const scanKey = nameKey(toDownload[i].name);
        existingFiles.add(scanKey);
        if (result && typeof result === "object" && result.realFileName) {
          const realKey = nameKey(result.realFileName);
          if (realKey !== scanKey) {
            existingFiles.add(realKey);
            log.i(`Tracking alias: ${toDownload[i].name} → ${result.realFileName}`);
          }
        }
        // Track by message ID for reliable photo dedup
        if (toDownload[i]._msgId && chatName) {
          S.downloadedMids.add(`${chatName}:${toDownload[i]._msgId}`);
        }
        showToast("Downloading...", i + 1, toDownload.length);
      } catch (e) { log.e(e.message); }
      // Send progress to popup
      try {
        chrome.runtime.sendMessage({
          action: "downloadProgress",
          current: i + 1,
          total: toDownload.length,
          fileName: toDownload[i].name,
          skipped: skippedCount
        });
      } catch (_) { }
      // Adaptive delay: short for photos, longer for videos (rate limit protection)
      const isVideo = toDownload[i].type === "video" || toDownload[i].type === "gif";
      const delay = toDownload[i]._fromSharedMedia
        ? (isVideo ? 800 : 300)  // Shared media: videos need viewer cycle, photos are faster
        : (isVideo ? 500 : 200); // Direct: minimal delays
      await sleep(delay);
    }

    showToast(`✅ Done! ${toDownload.length} new, ${skippedCount} skipped`, toDownload.length, toDownload.length);
    setTimeout(hideToast, 3000);
    S.downloading = false;
    S._bulkExistingFiles = null; // Release memory
    _saveMids(); // Persist downloaded message IDs
    // Notify completion
    try {
      chrome.runtime.sendMessage({
        action: "downloadComplete",
        total: toDownload.length + skippedCount,
        skipped: skippedCount
      });
    } catch (_) { }
  }

  // =============================================
  // MESSAGE HANDLER (from popup / background)
  // =============================================
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      try {
        switch (msg.action) {
          case "ping":
            sendResponse({ status: "active", version: detectVersion() });
            break;
          case "scan":
            sendResponse(scanVisible());
            break;
          case "bulkDownload": {
            // Synchronized: open sidebar → scan visible → download batch → scroll → repeat
            if (S.downloading) { sendResponse({ started: false }); break; }
            S.downloading = true;
            const acDl = new AbortController();
            S.abortController = acDl;
            const dlTypes = msg.types || ["photos", "videos", "gifs"];
            const typeMap = { photos: ["photo"], videos: ["video"], gifs: ["gif"], docs: ["doc"], audios: ["audio"] };
            const allowed = dlTypes.flatMap(t => typeMap[t] || []);

            // Progress state (accessible via getDownloadStatus)
            S.dlProgress = { downloaded: 0, skipped: 0, totalFound: 0, active: true, fileName: "" };

            showToast("⬇ Opening media...", 0, 0);
            let skipAc = null; // per-item skip controller
            if (toastEl) {
              const btnRow = document.createElement("div");
              btnRow.style.cssText = "display:flex;gap:6px;margin-top:4px;";

              const skipBtn = document.createElement("button");
              skipBtn.textContent = "⏭ Skip";
              skipBtn.className = "tg-grab-toast-stop";
              skipBtn.style.background = "#e67e22";
              skipBtn.onclick = () => { if (skipAc) skipAc.abort(); };
              btnRow.appendChild(skipBtn);

              const stopBtn = document.createElement("button");
              stopBtn.textContent = "⏹ Stop";
              stopBtn.className = "tg-grab-toast-stop";
              stopBtn.onclick = () => { acDl.abort(); if (skipAc) skipAc.abort(); };
              btnRow.appendChild(stopBtn);

              toastEl.appendChild(btnRow);
            }

            (async () => {
              const P = S.dlProgress;
              const seenMids = new Set();
              const chatName = getChatName();

              // Pre-fetch existing files for duplicate check
              let existingFiles = new Set();
              try {
                const r = await new Promise(resolve => {
                  chrome.runtime.sendMessage({ action: "getExistingFiles" }, res => resolve(res?.files || []));
                });
                existingFiles = new Set(r);
                S._bulkExistingFiles = existingFiles; // Enable metadata pre-check in downloadItem
                S._viewerConsecFails = 0; // Reset consecutive viewer failure counter
                log.i(`Pre-scan: ${existingFiles.size} existing files`);
              } catch (_) { }

              // Step 1: Open sidebar (same logic as sharedMediaScan)
              let searchSuper = document.querySelector(".search-super");
              if (searchSuper && (searchSuper.offsetParent === null || searchSuper.clientHeight === 0)) searchSuper = null;
              if (!searchSuper) {
                const clickTargets = [".chat-info .content", ".chat-info .person", ".top .person",
                  ".chat-info .peer-title", ".top .peer-title", ".chat-info .avatar-element"];
                for (const sel of clickTargets) {
                  const el = document.querySelector(sel);
                  if (el && el.offsetParent !== null) { el.click(); await sleep(600); break; }
                }
                for (let i = 0; i < 25; i++) {
                  if (acDl.signal.aborted) break;
                  const el = document.querySelector(".search-super");
                  if (el && el.offsetParent !== null && el.clientHeight > 0) { searchSuper = el; break; }
                  const ps = document.querySelector("#column-right .scrollable.scrollable-y");
                  if (ps && i === 5) ps.scrollTop = ps.scrollHeight;
                  await sleep(300);
                }
              }
              log.i(`[DL] searchSuper found: ${!!searchSuper}, aborted: ${acDl.signal.aborted}`);
              if (!searchSuper || acDl.signal.aborted) {
                log.w("Could not open sidebar for download");
                showToast("❌ Could not open media sidebar", 0, 0);
                setTimeout(hideToast, 3000);
                S.downloading = false; P.active = false; return;
              }

              // Step 2: Click Media tab
              const nav = searchSuper.querySelector("nav.search-super-tabs");
              const tabEls = nav ? nav.querySelectorAll(".menu-horizontal-div-item") : [];
              let mediaTab = null;
              tabEls.forEach(t => {
                const label = (t.textContent || "").trim().toLowerCase();
                if (label.includes("media") || label.includes("foto") || label.includes("photo")) mediaTab = t;
              });
              log.i(`[DL] Media tab: ${mediaTab ? 'found' : 'NOT FOUND'}, active: ${mediaTab?.classList?.contains('active')}`);
              if (mediaTab && !mediaTab.classList.contains("active")) { mediaTab.click(); await sleep(800); }

              // Step 3: Find scroll container (same strategy as sharedMediaScan)
              let scrollContainer = document.querySelector("#column-right .sidebar-content > .scrollable.scrollable-y");
              if (!scrollContainer || scrollContainer.clientHeight === 0) {
                scrollContainer = null;
                let p = searchSuper.parentElement;
                while (p && p !== document.body) {
                  const style = window.getComputedStyle(p);
                  if ((style.overflowY === "auto" || style.overflowY === "scroll") && p.clientHeight > 0) {
                    scrollContainer = p; break;
                  }
                  p = p.parentElement;
                }
              }
              log.i(`[DL] Scroll container: ${scrollContainer ? scrollContainer.className + ` (H:${scrollContainer.clientHeight} SH:${scrollContainer.scrollHeight})` : "NOT FOUND"}`);

              // Helper: scan visible grid items, return new ones
              function scanNewItems() {
                const items = [];
                searchSuper.querySelectorAll(".grid-item.search-super-item[data-mid]").forEach(el => {
                  const mid = el.dataset.mid;
                  if (!mid || seenMids.has(mid)) return;
                  seenMids.add(mid);
                  let type = "photo", name = "";
                  const vt = el.querySelector("span.video-time");
                  if (vt) {
                    const dur = (vt.textContent || "").trim();
                    if (dur === "GIF" || el.querySelector(".gif-badge")) { type = "gif"; name = `gif_${mid}.mp4`; }
                    else { type = "video"; name = `video_${mid}${dur ? "_" + dur.replace(/:/g, "m") : ""}.mp4`; }
                  }
                  if (type === "photo") name = `photo_${mid}.jpg`;
                  if (allowed.includes(type)) items.push({ type, name, _msgId: mid, _fromSharedMedia: true, el, unloaded: type !== "photo" });
                });
                return items;
              }

              // Peek: check for unseen items WITHOUT consuming them
              function hasNewItems() {
                let count = 0;
                searchSuper.querySelectorAll(".grid-item.search-super-item[data-mid]").forEach(el => {
                  const mid = el.dataset.mid;
                  if (mid && !seenMids.has(mid)) count++;
                });
                return count > 0;
              }

              // Step 4: Scroll to top and start synchronized download loop
              if (scrollContainer) {
                log.i(`[DL] Scrolling to top from ${scrollContainer.scrollTop}`);
                scrollContainer.scrollTop = 0;
                await sleep(600);
                log.i(`[DL] After scroll-to-top: scrollTop=${scrollContainer.scrollTop}`);
              } else {
                log.w(`[DL] No scrollContainer, will scan visible only`);
              }
              let scrollAttempts = 0, staleRounds = 0;
              const MAX_STALE = 10;
              let lastScrollTop = -1, lastScrollHeight = scrollContainer ? scrollContainer.scrollHeight : 0;

              while (scrollAttempts < 500 && staleRounds < MAX_STALE && !acDl.signal.aborted) {
                // Scan visible items
                const batch = scanNewItems();
                P.totalFound += batch.length;
                log.i(`[DL] Iter ${scrollAttempts}: batch=${batch.length}, total=${P.totalFound}, stale=${staleRounds}`);

                // Download each item in this batch BEFORE scrolling
                for (const item of batch) {
                  if (acDl.signal.aborted) break;
                  P.fileName = item.name;
                  const key = nameKey(item.name);

                  if (existingFiles.has(key)) { P.skipped++; log.i(`⏭ Skip: ${item.name}`); continue; }
                  if (item._msgId && chatName && S.downloadedMids.has(`${chatName}:${item._msgId}`)) { P.skipped++; continue; }

                  try {
                    // Create per-item skip controller
                    skipAc = new AbortController();
                    const skipPromise = new Promise((_, reject) => {
                      skipAc.signal.addEventListener("abort", () => reject(new Error("__SKIPPED__")));
                    });
                    showToast(`⬇ ${P.downloaded}/${P.totalFound} — ${item.name}`, P.downloaded + P.skipped, P.totalFound);
                    try { chrome.runtime.sendMessage({ action: "downloadProgress", current: P.downloaded + P.skipped, total: P.totalFound, fileName: item.name }); } catch (_) { }
                    const result = await Promise.race([downloadItem(item), skipPromise]);
                    skipAc = null;
                    P.downloaded++;
                    existingFiles.add(key);
                    if (item._msgId && chatName) S.downloadedMids.add(`${chatName}:${item._msgId}`);
                    // Track real filename from API result too
                    if (result?.realFileName) existingFiles.add(nameKey(result.realFileName));
                  } catch (e) {
                    skipAc = null;
                    if (e.message === "__SKIPPED__") {
                      P.skipped++;
                      log.i(`⏭ User skipped: ${item.name}`);
                      // Cancel any active download (SW/API) in injected.js
                      cancelActiveDownload();
                      // Close any open media viewer from fallback
                      const viewer = document.querySelector(".media-viewer-whole");
                      if (viewer) {
                        const closeBtn = viewer.querySelector(".btn-icon.media-viewer-close");
                        if (closeBtn) closeBtn.click();
                      }
                    } else {
                      log.w(`DL fail: ${item.name}: ${e.message}`);
                    }
                  }

                  showToast(`⬇ ${P.downloaded}/${P.totalFound}${P.skipped ? ` · ${P.skipped} dup` : ""}`, P.downloaded + P.skipped, P.totalFound);
                  try { chrome.runtime.sendMessage({ action: "downloadProgress", current: P.downloaded + P.skipped, total: P.totalFound, fileName: item.name }); } catch (_) { }
                }

                if (!scrollContainer || acDl.signal.aborted) break;

                // Check if sidebar/searchSuper still exists in DOM
                if (!document.contains(searchSuper) || !document.contains(scrollContainer)) {
                  log.w("[DL] Sidebar/searchSuper disappeared from DOM, stopping.");
                  break;
                }

                // NOW scroll for more
                const prevCount = seenMids.size;
                lastScrollTop = scrollContainer.scrollTop;
                scrollContainer.scrollTop += scrollContainer.clientHeight * 0.8;
                await sleep(600);

                const scrollMoved = Math.abs(scrollContainer.scrollTop - lastScrollTop) >= 2;
                if (!scrollMoved) {
                  // Scroll didn't move — wait for lazy loading / preloader
                  let loaded = false;
                  for (let w = 0; w < 15; w++) {
                    await sleep(500);
                    const loader = searchSuper.querySelector(".preloader-container:not(.hide), .loader");
                    if (loader) { staleRounds = Math.max(0, staleRounds - 1); continue; } // still loading, be patient
                    if (scrollContainer.scrollHeight > lastScrollHeight + 10) { loaded = true; break; }
                    if (hasNewItems()) { loaded = true; break; }
                  }
                  if (loaded) { lastScrollHeight = scrollContainer.scrollHeight; staleRounds = 0; }
                  else { staleRounds++; }
                } else {
                  for (let p = 0; p < 5; p++) { await sleep(400); if (hasNewItems()) break; }
                  if (scrollContainer.scrollHeight > lastScrollHeight + 10) { lastScrollHeight = scrollContainer.scrollHeight; staleRounds = Math.max(0, staleRounds - 1); }
                  if (seenMids.size === prevCount) staleRounds++; else staleRounds = 0;
                }
                scrollAttempts++;
                // Early exit: if we've already downloaded items and hit 5+ stale rounds, no point waiting
                if (staleRounds >= 5 && (P.downloaded > 0 || P.skipped > 10)) {
                  log.i(`[DL] Early exit: stale=${staleRounds}, downloaded=${P.downloaded}, skipped=${P.skipped}`);
                  break;
                }
                if (scrollAttempts <= 3 || scrollAttempts % 5 === 0)
                  log.i(`[DL] Loop ${scrollAttempts}: ${seenMids.size} found, ${P.downloaded} dl, ${P.skipped} skip`);
              }

              // Done
              log.i(`[DL] DONE: downloaded=${P.downloaded}, skipped=${P.skipped}, total=${P.totalFound}, loops=${scrollAttempts}`);
              S.downloading = false; P.active = false; S._bulkExistingFiles = null; S._viewerConsecFails = 0;
              hideToast();
              showToast(`✅ Done: ${P.downloaded} downloaded${P.skipped ? `, ${P.skipped} skipped` : ""}`, 0, 0);
              setTimeout(hideToast, 5000);
              try { chrome.runtime.sendMessage({ action: "downloadComplete", total: P.downloaded + P.skipped, skipped: P.skipped }); } catch (_) { }
              _saveMids();
            })();

            sendResponse({ started: true });
            break;
          }
          case "getDownloadStatus": {
            const p = S.dlProgress;
            if (p && p.active) {
              sendResponse({ active: true, downloaded: p.downloaded, skipped: p.skipped, total: p.totalFound, fileName: p.fileName });
            } else {
              sendResponse({ active: false });
            }
            break;
          }
          case "autoScrollScan": {
            const ac = new AbortController();
            S.abortController = ac;
            autoScrollScan(null, (status, count) => {
              try { chrome.runtime.sendMessage({ action: "scanProgress", status, count }); } catch (_) { }
            }, ac.signal).then((media) => {
              S.scannedMedia = media;
              try { chrome.runtime.sendMessage({ action: "scanComplete", count: media.length }); } catch (_) { }
            });
            sendResponse({ started: true });
            break;
          }
          case "stopScan":
            S.abortController?.abort();
            sendResponse({ stopped: true });
            break;
          case "openGallery": {
            const media = S.scannedMedia.length ? S.scannedMedia : scanVisible().media;
            openGallery(media);
            sendResponse({ opened: true });
            break;
          }
          case "autoScrollAndGallery": {
            const ac2 = new AbortController();
            S.abortController = ac2;
            showToast("Scanning chat...", 0, 0);
            if (toastEl) {
              const stopBtn = document.createElement("button");
              stopBtn.textContent = "⏹ Stop";
              stopBtn.className = "tg-grab-toast-stop";
              stopBtn.onclick = () => { ac2.abort(); };
              toastEl.appendChild(stopBtn);
            }
            autoScrollScan(
              (item, count) => showToast(`Scanning... ${count} found`, count, 0),
              null, ac2.signal
            ).then((media) => {
              hideToast();
              S.scannedMedia = media;
              if (media.length > 0) {
                openGallery(media);
              } else {
                showToast("No media found", 0, 0);
                setTimeout(hideToast, 2000);
              }
            });
            sendResponse({ started: true });
            break;
          }
          case "scanAll": {
            const forceRescan = msg.force === true;
            const currentPeerId = getPeerId();

            // Helper to run the actual scan
            function doFullScan() {
              const ac3 = new AbortController();
              S.abortController = ac3;
              showToast("Scanning all media...", 0, 0);
              if (toastEl) {
                const stopBtn = document.createElement("button");
                stopBtn.textContent = "⏹ Stop";
                stopBtn.className = "tg-grab-toast-stop";
                stopBtn.onclick = () => { ac3.abort(); };
                toastEl.appendChild(stopBtn);
              }
              autoScrollScan(
                (item, count) => {
                  showToast(`Scanning... ${count} found`, count, 0);
                  try { chrome.runtime.sendMessage({ action: "scanProgress", count: count }); } catch (_) { }
                },
                null, ac3.signal
              ).then((media) => {
                hideToast();
                S.scannedMedia = media;
                const counts = { photos: 0, videos: 0, gifs: 0, docs: 0, audios: 0 };
                media.forEach(m => {
                  if (m.type === "photo") counts.photos++;
                  else if (m.type === "video") counts.videos++;
                  else if (m.type === "gif") counts.gifs++;
                  else if (m.type === "doc") counts.docs++;
                  else if (m.type === "audio") counts.audios++;
                });
                try { chrome.runtime.sendMessage({ action: "scanComplete", count: media.length, counts: counts }); } catch (_) { }
                updateBadge(media.length);
                showToast(`✅ Scan complete: ${media.length} files`, 0, 0);
                setTimeout(hideToast, 3000);

                // Save scan results to cache (only if same or more items than existing cache)
                if (currentPeerId && media.length > 0) {
                  const cacheKey = `scanCache_${currentPeerId}`;
                  chrome.storage.local.get(cacheKey, (existing) => {
                    const oldCount = existing[cacheKey]?.media?.length || 0;
                    // Don't overwrite a larger cache with a smaller scan (partial scan protection)
                    if (oldCount > 0 && media.length < oldCount * 0.8) {
                      log.i(`Scan NOT cached: ${media.length} items < 80% of existing ${oldCount} items`);
                      return;
                    }
                    const serializable = media.map(m => ({
                      name: m.name, type: m.type, _msgId: m._msgId,
                      _fromSharedMedia: true,
                      thumb: (m.thumb && m.thumb.startsWith("http")) ? m.thumb : null,
                    }));
                    chrome.storage.local.set({ [cacheKey]: { media: serializable, timestamp: Date.now(), peerId: currentPeerId } });
                    log.i(`Scan cached: ${media.length} items for peer ${currentPeerId}`);
                  });
                }
              });
            }

            // Check cache first (unless force re-scan)
            if (!forceRescan && currentPeerId) {
              const cacheKey = `scanCache_${currentPeerId}`;
              chrome.storage.local.get(cacheKey, (data) => {
                const cached = data[cacheKey];
                if (cached && cached.media && cached.media.length > 0) {
                  S.scannedMedia = cached.media.map(m => ({
                    ...m,
                    _fromSharedMedia: true,
                    thumb: (m.thumb && (m.thumb.startsWith("data:") || m.thumb.startsWith("http"))) ? m.thumb : null,
                  }));
                  const counts = { photos: 0, videos: 0, gifs: 0, docs: 0, audios: 0 };
                  S.scannedMedia.forEach(m => {
                    if (m.type === "photo") counts.photos++;
                    else if (m.type === "video") counts.videos++;
                    else if (m.type === "gif") counts.gifs++;
                  });
                  const ago = Math.round((Date.now() - cached.timestamp) / 60000);
                  const agoText = ago < 1 ? "just now" : `${ago}m ago`;
                  try { chrome.runtime.sendMessage({ action: "scanComplete", count: S.scannedMedia.length, counts, fromCache: true }); } catch (_) { }
                  updateBadge(S.scannedMedia.length);
                  showToast(`📦 Restored ${S.scannedMedia.length} items from cache (${agoText})`, 0, 0);
                  log.i(`Scan cache restored: ${S.scannedMedia.length} items for peer ${currentPeerId} (${agoText})`);
                  setTimeout(hideToast, 3000);
                } else {
                  doFullScan();
                }
              });
            } else {
              doFullScan();
            }
            sendResponse({ started: true });
            break;
          }
          case "getCachedScan": {
            const pid = getPeerId();
            if (!pid) { sendResponse({ cached: false }); break; }
            const ck = `scanCache_${pid}`;
            chrome.storage.local.get(ck, (data) => {
              const cached = data[ck];
              if (cached && cached.media && cached.media.length > 0) {
                const ago = Math.round((Date.now() - cached.timestamp) / 60000);
                sendResponse({ cached: true, count: cached.media.length, agoMinutes: ago });
              } else {
                sendResponse({ cached: false });
              }
            });
            return true; // async sendResponse
          }
          case "updateSettings":
            if (msg.buttonsEnabled !== undefined) {
              S.buttonsEnabled = msg.buttonsEnabled;
              if (S.buttonsEnabled) {
                // Clear markers so injectButtons re-processes all messages
                document.querySelectorAll("[data-tg-grab]").forEach(el => delete el.dataset.tgGrab);
                injectButtons();
              } else {
                document.querySelectorAll(".tg-grab-btn").forEach(b => b.remove());
                document.querySelectorAll("[data-tg-grab]").forEach(el => delete el.dataset.tgGrab);
              }
            }
            if (msg.restrictedEnabled !== undefined) S.restrictedEnabled = msg.restrictedEnabled;
            if (msg.folderName) S.folderName = msg.folderName;
            if (msg.maxFileSizeMB !== undefined) S.maxFileSizeMB = msg.maxFileSizeMB;
            if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
              chrome.storage.local.set({
                buttonsEnabled: S.buttonsEnabled,
                restrictedEnabled: S.restrictedEnabled,
                folderName: S.folderName,
                maxFileSizeMB: S.maxFileSizeMB,
              });
            }
            sendResponse({ ok: true });
            break;
          case "getHistory":
            sendResponse({ history: S.downloadHistory || [] });
            break;
          case "clearHistory":
            S.downloadHistory = [];
            S.downloadedMids = new Set();
            _saveHistory();
            _saveMids();
            sendResponse({ ok: true });
            break;
          case "getProgress":
            sendResponse({ downloading: S.downloading });
            break;
          case "command":
            if (msg.command === "download-current") {
              const vv = detectVersion();
              const viewer = document.querySelector(SEL[vv].mediaViewer);
              if (viewer) { const btn = viewer.querySelector(".tg-grab-viewer-btn"); if (btn) btn.click(); }
            }
            if (msg.command === "open-gallery") {
              const media = S.scannedMedia.length ? S.scannedMedia : scanVisible().media;
              openGallery(media);
            }
            break;
          default:
            sendResponse({ error: "Unknown action" });
        }
      } catch (e) {
        log.e("Message handler error: " + e.message);
        sendResponse({ error: e.message });
      }
      return true;
    });
    log.i("Message listener registered");
  } else {
    log.w("chrome.runtime.onMessage not available");
  }

  // =============================================
  // INJECT PER-MESSAGE DOWNLOAD BUTTONS
  // =============================================
  function makeBtn() {
    const b = document.createElement("button");
    b.className = "tg-grab-btn";
    b.innerHTML = ICO.dl;
    b.title = "Descargar";
    // Apply ALL critical styles inline so Telegram CSS can't override them
    Object.assign(b.style, {
      position: "absolute",
      zIndex: "9999",
      top: "6px",
      right: "6px",
      width: "34px",
      height: "34px",
      borderRadius: "50%",
      background: "rgba(0,0,0,0.65)",
      border: "1px solid rgba(255,255,255,0.2)",
      color: "#fff",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      opacity: "0",
      transform: "scale(0.85)",
      transition: "opacity 0.2s, transform 0.2s",
      boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
      backdropFilter: "blur(6px)",
      pointerEvents: "all",
      padding: "0",
      margin: "0",
      outline: "none",
    });
    // Hover handlers — inline since CSS may not reach
    b.addEventListener("mouseenter", () => {
      if (!b.classList.contains("downloading") && !b.classList.contains("done")) {
        b.style.background = "linear-gradient(135deg, #667eea, #764ba2)";
        b.style.transform = "scale(1.1)";
        b.style.borderColor = "transparent";
      }
    });
    b.addEventListener("mouseleave", () => {
      if (!b.classList.contains("downloading") && !b.classList.contains("done")) {
        b.style.background = "rgba(0,0,0,0.65)";
        b.style.transform = "scale(1)";
        b.style.borderColor = "rgba(255,255,255,0.2)";
      }
    });
    return b;
  }

  function injectButtons() {
    if (!S.buttonsEnabled) return;
    const v = detectVersion();
    const msgs = document.querySelectorAll(SEL[v].message);

    let injectedCount = 0;
    msgs.forEach((msg) => {
      if (msg.dataset.tgGrab === "1") return;
      msg.dataset.tgGrab = "1";

      const items = findMediaInMessage(msg, v);
      if (!items.length) return;

      // Attach message ID to each item for API downloads
      // Only set parent msgId as fallback — grouped/album items already have per-item _msgId from findMediaInMessage
      const msgId = msg.dataset?.mid;
      if (msgId) {
        items.forEach(it => { if (!it._msgId) it._msgId = msgId; });
      }

      // Place button on .bubble-content (the visible message box) not .bubble (full width)
      // For K version, .bubble-content is the visible area; for A, it's the message itself
      const bubbleEl = (v === "K")
        ? (msg.querySelector(".bubble-content") || msg)
        : msg;
      if (bubbleEl.querySelector(".tg-grab-btn")) return;

      // Ensure container has position context + overflow visible for the button
      const pos = getComputedStyle(bubbleEl).position;
      if (pos === "static" || pos === "") {
        bubbleEl.style.position = "relative";
      }
      bubbleEl.style.overflow = "visible";

      // For albums/multi-media, we place individual buttons per media item
      if (items.length === 1) {
        const btn = makeBtn();
        const item = items[0];

        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          if (btn.classList.contains("downloading")) return;
          btn.classList.add("downloading");
          btn.innerHTML = ICO.spin;
          btn.style.opacity = "1";
          btn.style.background = "rgba(255,170,51,0.9)";

          try {
            S._forceDownload = true;
            await downloadItem(item);
            S._forceDownload = false;
            btn.classList.remove("downloading");
            btn.classList.add("done");
            btn.innerHTML = ICO.ok;
            btn.style.background = "#3fb950";
            setTimeout(() => {
              btn.classList.remove("done");
              btn.innerHTML = ICO.dl;
              btn.style.background = "rgba(0,0,0,0.65)";
              btn.style.opacity = "0";
            }, 2500);
          } catch (err) {
            S._forceDownload = false;
            log.e(err.message);
            btn.classList.remove("downloading");
            btn.innerHTML = ICO.dl;
            btn.style.background = "rgba(0,0,0,0.65)";
          }
        });

        bubbleEl.appendChild(btn);
        injectedCount++;

        // Show/hide on bubble hover (inline event handlers)
        bubbleEl.addEventListener("mouseenter", () => {
          const b = bubbleEl.querySelector(".tg-grab-btn");
          if (b && !b.classList.contains("downloading") && !b.classList.contains("done")) {
            b.style.opacity = "1";
            b.style.transform = "scale(1)";
          }
        });
        bubbleEl.addEventListener("mouseleave", () => {
          const b = bubbleEl.querySelector(".tg-grab-btn");
          if (b && !b.classList.contains("downloading") && !b.classList.contains("done")) {
            b.style.opacity = "0";
            b.style.transform = "scale(0.85)";
          }
        });
      } else {
        // Multiple media items — still one button on bubble, downloads ALL items
        const btn = makeBtn();

        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          if (btn.classList.contains("downloading")) return;
          btn.classList.add("downloading");
          btn.innerHTML = ICO.spin;
          btn.style.opacity = "1";
          btn.style.background = "rgba(255,170,51,0.9)";

          try {
            S._forceDownload = true;
            for (const item of items) {
              await downloadItem(item);
            }
            S._forceDownload = false;
            btn.classList.remove("downloading");
            btn.classList.add("done");
            btn.innerHTML = ICO.ok;
            btn.style.background = "#3fb950";
            setTimeout(() => {
              btn.classList.remove("done");
              btn.innerHTML = ICO.dl;
              btn.style.background = "rgba(0,0,0,0.65)";
              btn.style.opacity = "0";
            }, 2500);
          } catch (err) {
            S._forceDownload = false;
            log.e(err.message);
            btn.classList.remove("downloading");
            btn.innerHTML = ICO.dl;
            btn.style.background = "rgba(0,0,0,0.65)";
          }
        });

        bubbleEl.appendChild(btn);
        injectedCount++;

        bubbleEl.addEventListener("mouseenter", () => {
          const b = bubbleEl.querySelector(".tg-grab-btn");
          if (b && !b.classList.contains("downloading") && !b.classList.contains("done")) {
            b.style.opacity = "1";
            b.style.transform = "scale(1)";
          }
        });
        bubbleEl.addEventListener("mouseleave", () => {
          const b = bubbleEl.querySelector(".tg-grab-btn");
          if (b && !b.classList.contains("downloading") && !b.classList.contains("done")) {
            b.style.opacity = "0";
            b.style.transform = "scale(0.85)";
          }
        });
      }
    });
    if (injectedCount > 0) log.i(`Buttons injected: ${injectedCount}`);
  }

  // =============================================
  // OBSERVER — watch for new messages
  // =============================================
  function startObserver() {
    if (S.observerActive) return;
    const v = detectVersion();
    const container = document.querySelector(SEL[v].chatContainer);
    if (!container) { setTimeout(startObserver, 2000); return; }

    new MutationObserver(debounce(() => injectButtons(), 400)).observe(container, { childList: true, subtree: true });
    S.observerActive = true;
    log.i("Chat observer active");
    injectButtons();
  }

  // =============================================
  // INIT
  // =============================================
  function init() {
    const v = detectVersion();
    log.i(`Initializing v2 — Version ${v}`);

    function startAll() {
      injectInterceptor();
      bypassRestrictions();
      watchMediaViewer();
      // watchStories(); // Disabled — Story download button removed

      const wait = setInterval(() => {
        const chat = document.querySelector(SEL[v].chatContainer);
        if (chat) {
          clearInterval(wait);
          startObserver();
          // Auto-restore scan cache for current chat
          const pid = getPeerId();
          if (pid) {
            const ck = `scanCache_${pid}`;
            chrome.storage.local.get(ck, (data) => {
              const cached = data[ck];
              if (cached && cached.media && cached.media.length > 0 && S.scannedMedia.length === 0) {
                S.scannedMedia = cached.media.map(m => ({
                  ...m,
                  _fromSharedMedia: true,
                  // Strip invalid thumbs (blob: URLs die after reload, only keep data: or http:)
                  thumb: (m.thumb && (m.thumb.startsWith("data:") || m.thumb.startsWith("http"))) ? m.thumb : null,
                }));
                updateBadge(S.scannedMedia.length);
                const ago = Math.round((Date.now() - cached.timestamp) / 60000);
                log.i(`Auto-restored scan cache: ${S.scannedMedia.length} items (${ago}m ago)`);
              }
            });
          }
        }
      }, 1000);

      log.i("TG Media Grabber Pro ready");
    }

    // Protect against chrome API not being available
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["buttonsEnabled", "restrictedEnabled", "folderName", "maxFileSizeMB", "downloadHistory", "downloadedMids"], (data) => {
        if (chrome.runtime.lastError) { log.w("Storage read error, using defaults"); }
        else {
          if (data.buttonsEnabled === false) S.buttonsEnabled = false;
          if (data.restrictedEnabled === false) S.restrictedEnabled = false;
          if (data.folderName) S.folderName = data.folderName;
          if (data.maxFileSizeMB !== undefined) S.maxFileSizeMB = data.maxFileSizeMB;
          if (Array.isArray(data.downloadHistory)) S.downloadHistory = data.downloadHistory;
          if (Array.isArray(data.downloadedMids)) S.downloadedMids = new Set(data.downloadedMids);
        }
        log.i(`Settings loaded: buttons=${S.buttonsEnabled}, restricted=${S.restrictedEnabled}`);
        startAll();
      });
    } else {
      log.w("chrome.storage no disponible, usando defaults");
      startAll();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
