/**
 * TG Media Grabber Pro — Popup Script
 */
document.addEventListener("DOMContentLoaded", () => {
  const $ = (s) => document.querySelector(s);

  function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  const dot = $("#dot");
  const statusTxt = $("#statusTxt");
  const btnGallery = $("#btnGallery");
  const btnBulk = $("#btnBulk");
  const btnScan = $("#btnScan");
  const btnRescan = $("#btnRescan");
  const btnSettingsToggle = $("#btnSettingsToggle");
  const settingsPanel = $("#settingsPanel");
  const prog = $("#prog");
  const progFill = $("#progFill");
  const progTxt = $("#progTxt");
  const progPct = $("#progPct");
  const progSpeed = $("#progSpeed");
  const progFile = $("#progFile");
  const folder = $("#folder");
  const togRestrict = $("#togRestrict");
  const togButtons = $("#togButtons");
  const selMaxSize = $("#selMaxSize");
  const historyPanel = $("#historyPanel");
  const historyList = $("#historyList");
  const historyCount = $("#historyCount");

  const selectedTypes = new Set(["photos", "videos", "gifs"]);
  let dlStartTime = 0;
  let lastDlCurrent = 0;
  const PING_TIMEOUT_MS = 2500;

  // ── Card selection (persisted) ──
  function applySelectedTypesToUI() {
    document.querySelectorAll(".type-card").forEach((c) => {
      const t = c.dataset.type;
      if (selectedTypes.has(t)) c.classList.add("sel");
      else c.classList.remove("sel");
    });
  }
  function saveSelectedTypes() {
    save({ selectedTypes: [...selectedTypes] });
  }
  document.querySelectorAll(".type-card").forEach((c) => {
    const t = c.dataset.type;
    if (selectedTypes.has(t)) c.classList.add("sel");
    c.addEventListener("click", () => {
      if (selectedTypes.has(t)) { selectedTypes.delete(t); c.classList.remove("sel"); }
      else { selectedTypes.add(t); c.classList.add("sel"); }
      saveSelectedTypes();
    });
  });

  // ── Toggles ──
  function updateToggleAria(el) {
    el.setAttribute("aria-checked", el.classList.contains("on") ? "true" : "false");
  }
  togRestrict.addEventListener("click", () => {
    togRestrict.classList.toggle("on");
    updateToggleAria(togRestrict);
    const v = togRestrict.classList.contains("on");
    save({ restrictedEnabled: v });
    send({ action: "updateSettings", restrictedEnabled: v });
  });
  togButtons.addEventListener("click", () => {
    togButtons.classList.toggle("on");
    updateToggleAria(togButtons);
    const v = togButtons.classList.contains("on");
    save({ buttonsEnabled: v });
    send({ action: "updateSettings", buttonsEnabled: v });
  });

  // ── Settings Toggle ──
  btnSettingsToggle.addEventListener("click", () => {
    settingsPanel.classList.toggle("open");
    btnSettingsToggle.classList.toggle("active");
  });

  // ── Folder ──
  folder.addEventListener("change", () => {
    let v = folder.value.trim();
    v = v.replace(/[<>:"/\\|?*]/g, "").replace(/^\.+/, "").trim();
    if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i.test(v)) v = v + "_folder";
    v = v.substring(0, 100);
    if (!v) v = "TG_Media";
    folder.value = v;
    save({ folderName: v });
    send({ action: "updateSettings", folderName: v });
  });

  // ── Max File Size ──
  selMaxSize.addEventListener("change", () => {
    const v = parseInt(selMaxSize.value) || 0;
    save({ maxFileSizeMB: v });
    send({ action: "updateSettings", maxFileSizeMB: v });
  });

  // ── History Toggle ──
  $("#btnHistoryToggle").addEventListener("click", () => {
    historyPanel.classList.toggle("open");
    if (historyPanel.classList.contains("open")) loadHistory();
  });

  // ── Clear History ──
  $("#btnClearHistory").addEventListener("click", () => {
    send({ action: "clearHistory" }, () => {
      historyList.innerHTML = '<div class="history-empty">No recent downloads</div>';
      historyCount.textContent = "0";
    });
  });

  // ── Load History ──
  function loadHistory() {
    send({ action: "getHistory" }, (r) => {
      const history = r?.history || [];
      historyCount.textContent = String(history.length);
      if (!history.length) {
        historyList.innerHTML = '<div class="history-empty">No recent downloads</div>';
        return;
      }
      const reversed = [...history].reverse().slice(0, 50);
      historyList.innerHTML = reversed.map(item => {
        const icon = item.type === "photo" ? "📸" : item.type === "video" ? "🎬" :
          item.type === "gif" ? "🎭" : item.type === "audio" ? "🎵" : "📄";
        const time = new Date(item.time).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
        const chat = escapeHtml(item.chat || "");
        const name = escapeHtml(item.name || "");
        return `<div class="history-item">
          <span class="history-icon">${icon}</span>
          <div class="history-info">
            <div class="history-name" title="${name}">${name}</div>
            <div class="history-meta">${chat} · ${time}</div>
          </div>
        </div>`;
      }).join("");
    });
  }

  // ── Ping (with timeout) ──
  function setDisconnected(msg) {
    dot.classList.remove("on");
    statusTxt.textContent = msg || "Open web.telegram.org first";
    btnGallery.disabled = true;
    btnBulk.disabled = true;
    btnBulk.title = "Open web.telegram.org first";
    btnScan.disabled = true;
    btnRescan.disabled = true;
  }
  function setConnected(r) {
    dot.classList.add("on");
    statusTxt.textContent = `Connected — Telegram Web ${r.version}`;
    btnGallery.disabled = false;
    btnBulk.disabled = false;
    btnBulk.title = "Download all selected media";
    btnScan.disabled = false;
    btnRescan.disabled = false;
    send({ action: "getCachedScan" }, (cr) => {
      if (cr?.cached) {
        const ago = cr.agoMinutes < 1 ? "just now" : `${cr.agoMinutes}m ago`;
        statusTxt.textContent = `📦 ${cr.count} items cached (${ago})`;
      }
    });
    send({ action: "getDownloadStatus" }, (ds) => {
      if (ds?.active) {
        setLoading(btnBulk, true);
        statusTxt.textContent = `⬇ ${ds.downloaded}/${ds.total}${ds.skipped ? ` · ${ds.skipped} dup` : ""}`;
        btnBulk.querySelector("span").textContent = `Downloading...`;
      }
    });
  }
  function ping() {
    let answered = false;
    const timeoutId = setTimeout(() => {
      if (answered) return;
      answered = true;
      setDisconnected("Open web.telegram.org first");
    }, PING_TIMEOUT_MS);
    send({ action: "ping" }, (r) => {
      if (answered) return;
      answered = true;
      clearTimeout(timeoutId);
      if (r?.status === "ok" || r?.status === "active") {
        setConnected(r);
      } else {
        setDisconnected(chrome.runtime?.lastError ? "Could not reach tab" : "Open web.telegram.org first");
      }
    });
  }

  // ── Scan (uses cache if available) ──
  btnScan.addEventListener("click", () => {
    setLoading(btnScan, true);
    statusTxt.textContent = "🔍 Scanning chat...";
    send({ action: "scanAll" });
  });

  // ── Re-scan (always fresh) ──
  btnRescan.addEventListener("click", () => {
    setLoading(btnRescan, true);
    statusTxt.textContent = "🔄 Re-scanning chat...";
    send({ action: "scanAll", force: true });
  });

  // ── Gallery ──
  btnGallery.addEventListener("click", () => {
    setLoading(btnGallery, true);
    statusTxt.textContent = "🖼 Opening gallery...";
    send({ action: "openGallery" }, () => {
      setTimeout(() => setLoading(btnGallery, false), 1000);
    });
  });

  // ── Bulk download ──
  btnBulk.addEventListener("click", async () => {
    if (!selectedTypes.size) { statusTxt.textContent = "⚠ Select at least one type"; return; }
    setLoading(btnBulk, true);
    prog.classList.add("on");
    progFill.style.width = "0%";
    progTxt.textContent = "Starting download...";
    progPct.textContent = "0%";
    const progBar = document.getElementById("progBar");
    if (progBar) progBar.setAttribute("aria-valuenow", "0");
    progSpeed.textContent = "";
    progFile.textContent = "";
    dlStartTime = Date.now();
    lastDlCurrent = 0;
    send({ action: "bulkDownload", types: [...selectedTypes] });
  });

  // ── Listen for messages ──
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "scanProgress") {
      statusTxt.textContent = `🔍 ${msg.count} found...`;
    }
    if (msg.action === "scanComplete") {
      setLoading(btnScan, false);
      setLoading(btnRescan, false);
      const cacheLabel = msg.fromCache ? "📦" : "✅";
      statusTxt.textContent = `${cacheLabel} ${msg.count} files found`;
      if (msg.count > 0) {
        btnBulk.querySelector("span").textContent = `Download All`;
      }
      if (msg.counts) {
        $("#cPhotos").textContent = msg.counts.photos || 0;
        $("#cVideos").textContent = msg.counts.videos || 0;
        $("#cGifs").textContent = msg.counts.gifs || 0;
      }
    }
    if (msg.action === "downloadProgress") {
      const pct = Math.round((msg.current / msg.total) * 100);
      progFill.style.width = `${pct}%`;
      progPct.textContent = `${pct}%`;
      const progBar = document.getElementById("progBar");
      if (progBar) progBar.setAttribute("aria-valuenow", String(pct));
      const name = msg.fileName || "";
      const shortName = name.length > 28 ? name.substring(0, 25) + "..." : name;
      progTxt.textContent = `${msg.current}/${msg.total}`;
      progFile.textContent = shortName;

      // Calculate speed
      if (msg.current > lastDlCurrent) {
        const elapsed = (Date.now() - dlStartTime) / 1000;
        if (elapsed > 0) {
          const filesPerSec = msg.current / elapsed;
          const remaining = msg.total - msg.current;
          const eta = Math.round(remaining / filesPerSec);
          if (eta > 60) {
            progSpeed.textContent = `~${Math.round(eta / 60)}min remaining`;
          } else if (eta > 0) {
            progSpeed.textContent = `~${eta}s remaining`;
          }
        }
        lastDlCurrent = msg.current;
      }
    }
    if (msg.action === "downloadComplete") {
      setLoading(btnBulk, false);
      progFill.style.width = "100%";
      progTxt.textContent = `✅ ${msg.total} files downloaded`;
      progPct.textContent = "100%";
      progSpeed.textContent = "";
      progFile.textContent = "";
      statusTxt.textContent = `✅ ${msg.total} files downloaded`;
      setTimeout(() => prog.classList.remove("on"), 5000);
      if (historyPanel.classList.contains("open")) loadHistory();
    }
  });

  // ── Helpers ──
  function setLoading(btn, loading) {
    if (loading) { btn.classList.add("loading"); btn.disabled = true; }
    else { btn.classList.remove("loading"); btn.disabled = false; }
  }
  function send(msg, cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, msg, (r) => {
          if (chrome.runtime.lastError) { if (cb) cb(null); }
          else { if (cb) cb(r); }
        });
      } else { if (cb) cb(null); }
    });
  }
  function save(d) { chrome.storage.local.set(d); }
  function load() {
    chrome.storage.local.get(["buttonsEnabled", "restrictedEnabled", "folderName", "maxFileSizeMB", "selectedTypes"], (d) => {
      if (d.buttonsEnabled === false) { togButtons.classList.remove("on"); togButtons.setAttribute("aria-checked", "false"); }
      if (d.restrictedEnabled === false) { togRestrict.classList.remove("on"); togRestrict.setAttribute("aria-checked", "false"); }
      if (d.folderName) folder.value = d.folderName;
      if (d.maxFileSizeMB !== undefined) selMaxSize.value = String(d.maxFileSizeMB);
      if (Array.isArray(d.selectedTypes) && d.selectedTypes.length) {
        selectedTypes.clear();
        d.selectedTypes.forEach((t) => selectedTypes.add(t));
        applySelectedTypesToUI();
      }
    });
  }

  load();
  ping();

  // ── Feedback Modal ──
  const fbOverlay = $("#feedbackOverlay");
  const fbMessage = $("#fbMessage");
  const fbSubmit = $("#fbSubmit");
  const fbSuccess = $("#fbSuccess");
  const fbBody = fbOverlay.querySelector(".fb-body");
  let fbType = "Bug";

  // Open / Close
  $("#btnFeedback").addEventListener("click", (e) => {
    e.preventDefault();
    fbOverlay.classList.add("open");
    fbOverlay.setAttribute("aria-hidden", "false");
    fbBody.style.display = "";
    fbSuccess.style.display = "none";
    fbMessage.value = "";
    fbSubmit.disabled = false;
    fbSubmit.querySelector("span").textContent = "Send";
    setTimeout(() => fbMessage.focus(), 50);
  });

  function closeFbModal() {
    fbOverlay.classList.remove("open");
    fbOverlay.setAttribute("aria-hidden", "true");
  }
  $("#fbClose").addEventListener("click", closeFbModal);
  fbOverlay.addEventListener("click", (e) => { if (e.target === fbOverlay) closeFbModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && fbOverlay.classList.contains("open")) closeFbModal();
  });

  // Type selector
  fbOverlay.querySelectorAll(".fb-type-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      fbOverlay.querySelectorAll(".fb-type-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      fbType = btn.dataset.type;
    });
  });

  // Feedback form — replace with your own Google Form URL and field entry IDs for production
  const FEEDBACK_CONFIG = {
    url: "https://docs.google.com/forms/d/e/1FAIpQLSe9wih_kZ9xHyid3T0-hELgm9blkkASsG-h6FDWnvfKIUBXNw/formResponse",
    entryType: "entry.675272766",
    entryMessage: "entry.292794743",
  };

  fbSubmit.addEventListener("click", async () => {
    const msg = fbMessage.value.trim();
    if (!msg) { fbMessage.focus(); return; }

    fbSubmit.disabled = true;
    fbSubmit.querySelector("span").textContent = "Sending...";

    try {
      const formData = new URLSearchParams();
      formData.append(FEEDBACK_CONFIG.entryType, fbType);
      formData.append(FEEDBACK_CONFIG.entryMessage, msg);

      await fetch(FEEDBACK_CONFIG.url, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formData.toString()
      });

      // no-cors always succeeds from client side
      fbBody.style.display = "none";
      fbSuccess.style.display = "";
      setTimeout(closeFbModal, 2000);
    } catch (err) {
      fbSubmit.querySelector("span").textContent = "Error — try again";
      fbSubmit.disabled = false;
    }
  });
});
