/**
 * TG Media Grabber Pro — Background Service Worker
 * (version from manifest.json)
 */

// Strip extension and lowercase for comparison
function nameKey(filename) {
  return filename.replace(/\.[^.]+$/, "").toLowerCase();
}

// Handle downloads and other messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "download") {
    const targetFile = msg.fileName || "TG_Media/file";
    const basename = targetFile.split("/").pop();

    // If force flag is set (individual button downloads), skip duplicate check
    if (msg.force) {
      chrome.downloads.download({
        url: msg.url,
        filename: targetFile,
        conflictAction: "uniquify",
        saveAs: false,
      }, (id) => {
        if (chrome.runtime.lastError) {
          console.error("[TG Grabber BG]", chrome.runtime.lastError.message);
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ downloadId: id });
        }
      });
      return true;
    }

    // Bulk downloads: check Chrome's download history for duplicates
    const key = nameKey(basename);
    const stem = basename.replace(/\.[^.]+$/, "");

    chrome.downloads.search({
      query: [stem],
      state: "complete",
      limit: 20
    }, (results) => {
      const exists = results?.some(item => {
        if (!item.filename) return false;
        if (item.exists === false) return false;
        const itemName = item.filename.replace(/\\/g, "/").split("/").pop();
        return nameKey(itemName) === key;
      });

      if (exists) {
        console.log("[TG Grabber BG] Duplicate skipped (file exists):", basename);
        sendResponse({ skipped: true });
        return;
      }

      chrome.downloads.download({
        url: msg.url,
        filename: targetFile,
        conflictAction: "uniquify",
        saveAs: false,
      }, (id) => {
        if (chrome.runtime.lastError) {
          console.error("[TG Grabber BG]", chrome.runtime.lastError.message);
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ downloadId: id });
        }
      });
    });

    return true;
  }

  // Pre-scan: get all existing files in the configured folder for bulk duplicate check
  if (msg.action === "getExistingFiles") {
    const folder = (msg.folderName && String(msg.folderName).trim()) || "TG_Media";
    chrome.downloads.search({
      query: [folder],
      state: "complete",
      limit: 5000
    }, (results) => {
      const files = new Set();
      results?.forEach(r => {
        if (r.exists !== false && r.filename) {
          const name = r.filename.replace(/\\/g, "/").split("/").pop();
          if (name) {
            const key = nameKey(name);
            files.add(key);
            // For video_MSGID_duration.mp4 also add video_MSGID so grid items named video_MSGID.mp4 match
            const videoStem = name.match(/^video_(\d+)/i);
            if (videoStem) files.add("video_" + videoStem[1]);
          }
        }
      });
      sendResponse({ files: [...files] });
    });
    return true;
  }

  // Badge update
  if (msg.action === "updateBadge") {
    const count = msg.count || 0;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#7c4dff" });
    return;
  }

  // Download complete — show notification
  if (msg.action === "downloadComplete") {
    const total = msg.total || 0;
    const skipped = msg.skipped || 0;
    const downloaded = total - skipped;
    chrome.notifications.create("dl-complete-" + Date.now(), {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "TG Media Grabber Pro",
      message: `✅ Download complete: ${downloaded} file${downloaded !== 1 ? "s" : ""}${skipped > 0 ? `, ${skipped} skipped` : ""}`,
      priority: 1
    });
    chrome.action.setBadgeText({ text: "" });
  }

  // Relay progress/scan messages to popup
  if (msg.action === "scanProgress" || msg.action === "scanComplete" ||
    msg.action === "downloadProgress") {
    chrome.runtime.sendMessage(msg).catch(() => { });
  }
});

// Keyboard shortcuts
chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { action: "command", command });
    }
  });
});

// Clear badge when switching tabs
chrome.tabs.onActivated.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
});

// Install defaults
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.storage.local.set({
      buttonsEnabled: true,
      restrictedEnabled: true,
      folderName: "TG_Media",
      maxFileSizeMB: 2048,
      downloadedFiles: [],
    });
    console.log("[TG Grabber BG] Defaults set");
  }
});
