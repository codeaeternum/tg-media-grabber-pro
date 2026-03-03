/**
 * TG Media Grabber Pro — Page Context Injected Script
 * Runs in MAIN WORLD to access Telegram's internal APIs.
 *
 * STRATEGY 1 (primary): appDownloadManager.downloadMedia()
 *   → Uses Telegram's own download manager via mtproto
 *   → No chunking needed, no LIMIT_INVALID errors
 *   → Handles rate limits internally
 *
 * STRATEGY 2 (fallback): Service Worker fetch with Range headers
 *   → Used when API isn't available or for restricted content
 *   → 512KB chunks with adaptive throttling and retry
 */
(function () {
  "use strict";

  const LOG = "[TG Grabber]";
  let apiReady = false;
  let rootScopeReady = false;

  // ─── API Readiness Detection ───────────────────────────────────
  function checkApiReady() {
    try {
      if (window.appDownloadManager && window.mtprotoMessagePort?.mirrors?.messages) {
        if (!apiReady) {
          apiReady = true;
          console.log(`${LOG} ✓ Telegram API detected (appDownloadManager + mtproto)`);
        }
        return true;
      }
    } catch (_) { }
    return false;
  }

  // Poll for API readiness with backoff (500ms → 1s → 2s) to reduce CPU on slow loads
  const API_POLL_MAX_MS = 30000;
  function pollApiReady(elapsedMs) {
    if (checkApiReady()) return;
    if (elapsedMs >= API_POLL_MAX_MS) return;
    const delay = elapsedMs < 5000 ? 500 : elapsedMs < 20000 ? 1000 : 2000;
    setTimeout(() => pollApiReady(elapsedMs + delay), delay);
  }
  setTimeout(() => pollApiReady(0), 500);

  // ─── rootScope Progress Events ─────────────────────────────────
  function setupProgressListener() {
    const ROOT_POLL_MAX_MS = 30000;
    function pollRootScope(elapsedMs) {
      if (window.rootScope) {
        rootScopeReady = true;
        window.rootScope.addEventListener("download_progress", (ev) => {
          if (ev.fileName) {
            const done = ev.done || 0;
            const total = ev.total || 0;
            if (total > 0) {
              window.postMessage({
                type: "TG_GRABBER_API_PROGRESS",
                fileName: ev.fileName,
                progress: Math.round((done / total) * 100),
                done, total,
              }, "*");
            }
          }
        });
        console.log(`${LOG} ✓ rootScope progress listener active`);
        return;
      }
      if (elapsedMs >= ROOT_POLL_MAX_MS) return;
      const delay = elapsedMs < 5000 ? 500 : elapsedMs < 20000 ? 1000 : 2000;
      setTimeout(() => pollRootScope(elapsedMs + delay), delay);
    }
    setTimeout(() => pollRootScope(0), 500);
  }
  setupProgressListener();

  // ─── STRATEGY 1: Download via Telegram API ─────────────────────
  async function downloadViaAPI(msgId, peerId, includeVideo = false) {
    if (!checkApiReady()) throw new Error("API not ready");

    const mirrors = window.mtprotoMessagePort.mirrors.messages;
    const historyKey = peerId + "_history";
    const msgData = mirrors?.[historyKey]?.[msgId];
    if (!msgData?.media) throw new Error(`Media not found for msg ${msgId}`);

    const media = msgData.media;
    let target, mediaType, fileName;

    if (includeVideo) {
      // Prefer document (video file) first, then photo
      target = media.document;
      mediaType = "video";
      if (!target) {
        target = media.photo;
        mediaType = "image";
      }
    } else {
      target = media.photo;
      mediaType = "image";
      if (!target) {
        target = media.document;
        mediaType = "video";
      }
    }

    if (!target) throw new Error("No downloadable media found");

    // Check alt_documents for better quality video (mp4 preferred)
    if (Array.isArray(media.alt_documents) && mediaType === "video") {
      for (const alt of media.alt_documents) {
        if (alt.mime_type === "video/mp4") {
          fileName = alt.file_name;
          break;
        }
      }
    }

    // Build download request
    const downloadReq = { media: target };
    if (mediaType === "image") {
      // For photos, use highest quality size
      if (!downloadReq.thumb) {
        downloadReq.thumb = target?.sizes?.slice().pop() || null;
      }
    }

    // Track progress for videos
    const trackId = "document_" + target.id;

    console.log(`${LOG} API Download: msgId=${msgId}, type=${mediaType}, id=${target.id}`);

    const blob = await window.appDownloadManager.downloadMedia(downloadReq);
    const blobUrl = URL.createObjectURL(blob);

    // Extract filename from metadata if we don't have one
    if (!fileName && target.file_name) fileName = target.file_name;
    if (!fileName && target.attributes) {
      for (const attr of target.attributes) {
        if (attr.file_name) { fileName = attr.file_name; break; }
      }
    }

    return {
      blobUrl,
      fileName: fileName || "",
      mediaType,
      size: blob.size,
      mimeType: blob.type || (mediaType === "image" ? "image/jpeg" : "video/mp4"),
    };
  }

  // ─── Get metadata without downloading ──────────────────────────
  function getMediaMetadata(msgId, peerId) {
    if (!checkApiReady()) return null;
    try {
      const mirrors = window.mtprotoMessagePort.mirrors.messages;
      const msgData = mirrors?.[peerId + "_history"]?.[msgId];
      if (!msgData?.media) return null;

      const media = msgData.media;
      const doc = media.document;
      const photo = media.photo;

      const result = {
        hasMedia: true,
        hasPhoto: !!photo,
        hasDocument: !!doc,
        fileName: null,
        mimeType: null,
        size: null,
      };

      if (doc) {
        result.fileName = doc.file_name || null;
        result.mimeType = doc.mime_type || null;
        result.size = doc.size || null;
        // Check attributes for filename
        if (!result.fileName && doc.attributes) {
          for (const attr of doc.attributes) {
            if (attr.file_name) { result.fileName = attr.file_name; break; }
          }
        }
      }

      return result;
    } catch (_) {
      return null;
    }
  }

  // ─── STRATEGY 2: Download via Service Worker ───────────────────
  function parseStreamUrl(url) {
    try {
      const decoded = decodeURIComponent(url);
      const streamIdx = decoded.indexOf("/stream/");
      if (streamIdx !== -1) {
        const json = decoded.substring(streamIdx + 8);
        const meta = JSON.parse(json);
        return {
          fileName: meta.fileName || null,
          size: meta.size || null,
          mimeType: meta.mimeType || null,
        };
      }
      const progIdx = decoded.indexOf("/progressive/");
      if (progIdx !== -1) return { fileName: null, size: null, mimeType: null };
    } catch (_) { }
    return null;
  }

  // Track active downloads for cancellation
  const _activeDownloads = new Map();

  async function downloadViaSW(streamUrl, onProgress, signal) {
    const meta = parseStreamUrl(streamUrl);
    const fileName = meta?.fileName || "video.mp4";
    const mimeType = meta?.mimeType || "video/mp4";
    let totalSize = meta?.size || null;

    console.log(`${LOG} SW Download: ${fileName} (${totalSize ? (totalSize / 1048576).toFixed(1) + " MB" : "?"})`);

    if (!totalSize) {
      try {
        const probe = await fetch(streamUrl, { headers: { Range: "bytes=0-0" } });
        const cr = probe.headers.get("Content-Range");
        if (cr) { const m = cr.match(/\/(\d+)/); if (m) totalSize = parseInt(m[1]); }
        if (!totalSize) { const cl = probe.headers.get("Content-Length"); if (cl) totalSize = parseInt(cl); }
      } catch (_) { }
    }

    if (totalSize && totalSize > 0) {
      const CHUNK = 512 * 1024;
      const blobs = [];
      let offset = 0, failures = 0;
      const MAX_RETRIES = totalSize > 50 * 1048576 ? 15 : 10;
      const chunkDelay = totalSize > 50 * 1048576 ? 150 : totalSize > 5 * 1048576 ? 50 : 0;

      while (offset < totalSize) {
        if (signal?.aborted) throw new Error("__CANCELLED__");
        const end = Math.min(offset + CHUNK - 1, totalSize - 1);
        try {
          const resp = await fetch(streamUrl, { headers: { Range: `bytes=${offset}-${end}` }, signal });
          if (!resp.ok && resp.status !== 206) {
            failures++;
            if (failures > MAX_RETRIES) throw new Error(`HTTP ${resp.status} after ${failures} retries`);
            const backoff = Math.min(2000 * Math.pow(2, failures - 1), 30000);
            await new Promise(r => setTimeout(r, backoff));
            continue;
          }
          blobs.push(await resp.blob());
          offset = end + 1;
          failures = 0;
          if (onProgress) onProgress(Math.round((offset / totalSize) * 100), offset, totalSize);
          if (chunkDelay > 0 && offset < totalSize) await new Promise(r => setTimeout(r, chunkDelay));
        } catch (e) {
          if (signal?.aborted) throw new Error("__CANCELLED__");
          failures++;
          if (failures > MAX_RETRIES) throw e;
          const backoff = Math.min(3000 * Math.pow(2, failures - 1), 60000);
          await new Promise(r => setTimeout(r, backoff));
        }
      }

      const finalBlob = new Blob(blobs, { type: mimeType });
      return { blobUrl: URL.createObjectURL(finalBlob), size: finalBlob.size, fileName, mimeType };
    }

    // Single full fetch (small files / unknown size)
    const resp = await fetch(streamUrl, { signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    if (blob.size < 100) throw new Error("Empty response");
    return { blobUrl: URL.createObjectURL(blob), size: blob.size, fileName, mimeType: blob.type || mimeType };
  }

  // ─── Message Handler ──────────────────────────────────────────
  const ALLOWED_ORIGIN = location.origin;
  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== ALLOWED_ORIGIN) return;
    const { data } = event;

    // API-based download (primary strategy)
    if (data?.type === "TG_GRABBER_API_DOWNLOAD") {
      const { msgId, peerId, requestId, includeVideo } = data;
      try {
        const result = await downloadViaAPI(msgId, peerId, includeVideo);
        window.postMessage({
          type: "TG_GRABBER_API_DOWNLOAD_COMPLETE",
          requestId, ...result,
        }, "*");
      } catch (e) {
        console.warn(`${LOG} API download failed, will need SW fallback:`, e.message);
        window.postMessage({
          type: "TG_GRABBER_API_DOWNLOAD_ERROR",
          requestId, error: e.message,
        }, "*");
      }
    }

    // Get metadata only
    if (data?.type === "TG_GRABBER_GET_METADATA") {
      const { msgId, peerId, requestId } = data;
      const meta = getMediaMetadata(msgId, peerId);
      window.postMessage({
        type: "TG_GRABBER_METADATA_RESULT",
        requestId, metadata: meta,
      }, "*");
    }

    // SW-based download (fallback strategy)
    if (data?.type === "TG_GRABBER_DOWNLOAD_REQUEST") {
      const { streamUrl, requestId } = data;
      const ac = new AbortController();
      _activeDownloads.set(requestId, ac);
      try {
        const result = await downloadViaSW(streamUrl, (pct, received, total) => {
          window.postMessage({
            type: "TG_GRABBER_DOWNLOAD_PROGRESS",
            requestId, pct, received, total,
          }, "*");
        }, ac.signal);
        window.postMessage({
          type: "TG_GRABBER_DOWNLOAD_COMPLETE",
          requestId, ...result,
        }, "*");
      } catch (e) {
        if (e.message !== "__CANCELLED__") console.error(`${LOG} SW Download error:`, e);
        window.postMessage({
          type: e.message === "__CANCELLED__" ? "TG_GRABBER_DOWNLOAD_CANCELLED" : "TG_GRABBER_DOWNLOAD_ERROR",
          requestId, error: e.message,
        }, "*");
      } finally {
        _activeDownloads.delete(requestId);
      }
    }

    // Cancel an in-progress download
    if (data?.type === "TG_GRABBER_CANCEL_DOWNLOAD") {
      const { requestId } = data;
      const ac = _activeDownloads.get(requestId);
      if (ac) { ac.abort(); _activeDownloads.delete(requestId); }
    }

    // Check API status
    if (data?.type === "TG_GRABBER_CHECK_API") {
      window.postMessage({
        type: "TG_GRABBER_API_STATUS",
        apiReady: checkApiReady(),
        rootScopeReady,
      }, "*");
    }

    // Revoke blob URL to free memory
    if (data?.type === "TG_GRABBER_REVOKE_URL") {
      try { URL.revokeObjectURL(data.url); } catch (_) { }
    }
  });

  console.log(`${LOG} Interceptor ready`);
})();
