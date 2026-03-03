# TG Media Grabber Pro

![Version](https://img.shields.io/badge/version-4.3-blue) ![License](https://img.shields.io/badge/license-MIT-green)

**The ultimate tool for downloading media from Telegram Web (K & A versions).**

TG Media Grabber Pro allows you to easily download photos, videos, GIFs, and documents from any Telegram chat. It supports both the "K" and "A" versions of Telegram Web and includes advanced features like bulk downloading and restricted content bypass.

## Features

- **⚡ Universal Support**: Works on both `web.telegram.org/k/` and `/a/`.
- **🔓 Restricted Content Bypass**: Download media even from channels that restrict saving/forwarding.
- **🖼 Gallery View**: Scan the entire chat and view all media in a clean grid.
- **📥 One-Click Download**: Buttons added directly to messages for quick saving.
- **🚀 Bulk Download**: Download all media from a chat in one go.
- **⏩ Auto-Scroll**: Automatically scroll through history to find old media.
- **📁 Organized Downloads**: Files saved to `TG_Media/{ChatName}/`.
- **⌨️ Keyboard Shortcuts**: `Ctrl+Shift+D` — download current media; `Ctrl+Shift+G` — open gallery.
- **🎯 Smart Duplicate Detection**: Skips files already on disk.
- **📏 Configurable Max File Size**: Auto-skip videos above your chosen limit (500 MB – 4 GB).
- **🛡️ Resilient Downloads**: Graceful error recovery — never gets stuck on failures.

## Installation

### From Chrome Web Store
[Get it on Chrome Web Store](https://chrome.google.com/webstore/detail/tg-media-grabber-pro/)

### Manual Installation (Developer Mode)
1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **"Developer mode"** in the top right.
4. Click **"Load unpacked"**.
5. Select the folder containing this project.

## Usage

1. Open [Telegram Web](https://web.telegram.org/).
2. Navigate to a chat or channel.
3. Click the **TG Media Grabber** icon in your browser toolbar.
4. **Scan**: Click "Scan" to see count of visible media (Photos, Videos, GIFs).
5. **Download**:
   - Use the floating buttons on messages in the chat.
   - Or select types and click "Download All" in the popup.
   - Check **History** in the popup for recent downloads; use **Send Feedback** to report bugs or suggest features.

## Privacy

This extension runs entirely locally on your machine.
- No user data is sent to external servers.
- Media is downloaded directly from telegram.org servers to your device.
- Full privacy policy: [codeaeternum.com/privacy.html](https://codeaeternum.com/privacy.html)

## Support

- 🌐 Website: [codeaeternum.com](https://codeaeternum.com)
- 𝕏 Twitter: [@CodeAeternum](https://x.com/CodeAeternum)
- ☕ Support development: [ko-fi.com/codeaeternum](https://ko-fi.com/codeaeternum)

## For developers

- **Context & conventions**: See [GEMINI.md](GEMINI.md) for project structure, data flow, and decisions.
- **Audit & improvements**: See [AUDIT_REPORT.md](AUDIT_REPORT.md) for the full audit and checklist.
- **Release history**: See [CHANGELOG.md](CHANGELOG.md) for version history and changes.

## Disclaimer

This tool is for educational purposes and personal use only. Respect copyright and Telegram's Terms of Service.
