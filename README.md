# Mblackman TiddlyWiki5 Plugin Library (`tw5-plugin-library`)

Centralized, self-updating [TiddlyWiki5](https://github.com/TiddlyWiki/TiddlyWiki5) plugin library for `@mblackman` plugins, hosted on GitHub Pages at:

- **Interactive Showcase & Library Site**: [https://mblackman.github.io/tw5-plugin-library/](https://mblackman.github.io/tw5-plugin-library/)
- **Starter Empty Notebook (`empty.html`)**: [https://mblackman.github.io/tw5-plugin-library/empty.html](https://mblackman.github.io/tw5-plugin-library/empty.html)
- **Plugin Library Endpoint (`$:/tags/PluginLibrary`)**: [https://mblackman.github.io/tw5-plugin-library/recipes/library/index.html](https://mblackman.github.io/tw5-plugin-library/recipes/library/index.html)


## Included Plugin Repositories

Configured in [`plugins.json`](./plugins.json):

### Standard Client Plugins (No Server Required)
These plugins run client-side in any standard TiddlyWiki single-file or node environment:
- [`mblackman/tiddlywiki-slipstream`](https://github.com/mblackman/tiddlywiki-slipstream) — Sleek 3-column desktop and mobile Zoomin reading layout theme
- [`mblackman/tiddlywiki-timelord`](https://github.com/mblackman/tiddlywiki-timelord) — Timeline navigation, visual diff viewer, and revision history
- [`mblackman/tiddlywiki-media-importer`](https://github.com/mblackman/tiddlywiki-media-importer) — Media consumption and asset tracking within TiddlyWiki
- [`mblackman/tiddlywiki-coffee-tracker`](https://github.com/mblackman/tiddlywiki-coffee-tracker) — Daily coffee and espresso brewing tracker
- [`mblackman/tiddlywiki-journal`](https://github.com/mblackman/tiddlywiki-journal) — Structured daily, weekly, monthly, and yearly journaling and habit tracking (with built-in Day.js support)
- [`mblackman/Projectify`](https://github.com/mblackman/Projectify) — GTD-inspired project and task management with Kanban boards, sub-tasks, and smart capture (for TiddlyWiki v5.4.0+)

### TiddlyPWA Progressive Web App Suite (Offline-First Sync Architecture)
- [`mblackman/tiddlypwa`](https://github.com/mblackman/tiddlypwa) — **Offline-First Storage & Zero-Knowledge Sync Solution**
  - **Required Complementary Plugins** (both must be installed together for TiddlyPWA to operate properly):
    1. **`$:/plugins/mblackman/web-app-manifest`** (*Required Prerequisite*): Dynamically generates and registers the browser Web App Manifest (`manifest.json`), necessary for PWA installation ("Add to Home Screen"), theme/background color integration, and icon handling.
    2. **`$:/plugins/mblackman/tiddlypwa`** (*Core Sync Adaptor*): Offline-first IndexedDB encrypted cache and syncadaptor connecting to the companion sync backend.
  - *Backend Server Requirement*: Requires running the companion TiddlyPWA backend server (Deno 2 + SQLite / Docker).
  - *Zero-Knowledge Privacy*: All tiddlers are encrypted locally on the device (AES-GCM / Argon2id) before syncing over the network; the sync server only stores ciphertext blobs and never sees plaintext content or keys.
  - *Features*: Offline PWA caching with Service Worker, real-time sync via Server-Sent Events (SSE), multi-device optimistic concurrency conflict resolution, and multi-tenant notebook scoping.
  - *Deployment*: Docker image available at `ghcr.io/mblackman/tiddlypwa:latest`. See [Docker Quick Start Guide](https://github.com/mblackman/tiddlypwa#quick-start-with-docker) and [Architecture Specifications](https://github.com/mblackman/tiddlypwa/tree/trunk/docs).

### Familiar (Self-Hosted AI Gateway)
- [`mblackman/tiddly-familiar`](https://github.com/mblackman/tiddly-familiar) — **An AI Familiar for Your Wiki**
  - **Plugin (`$:/plugins/mblackman/familiar`)**: Adds streaming AI chat, semantic search, note summaries, tag/task suggestions, and related-note discovery to any TiddlyWiki.
  - *Backend Server Requirement*: Requires running the companion Familiar gateway server (FastAPI + Gemini or local Ollama via Docker Compose).
  - *Client-Supplied Content*: The wiki sends its own note content with each request (minimized via a content-addressed SHA-256 cache), so it works against any TiddlyWiki without per-wiki server credentials or configuration.
  - *Deployment*: See the [Gateway Setup Guide](https://github.com/mblackman/tiddly-familiar#gateway) for Docker Compose setup instructions.


## Start a New Notebook Immediately

To quickly start a new notebook with all standard client plugins already installed (without needing to install them individually):

1. **Download the Starter Wiki**: Download [`empty.html`](https://mblackman.github.io/tw5-plugin-library/empty.html) directly or via the [Plugin Library Site](https://mblackman.github.io/tw5-plugin-library/).
2. **Open in Browser**: Open the downloaded `empty.html` file in your browser.
3. **Write & Save**: Configure your wiki title, choose your preferred saving mechanism (e.g. TiddlyDesktop, Timimi, WebDAV, or local download), and start writing notes right away.
4. **1-Click Updates**: The starter notebook includes the plugin library endpoint pre-installed, so you can receive 1-click updates anytime in **Control Panel -> Plugins -> Get more plugins**.

## Quick Start (Repository Setup & Development)

1. **Initialize and push to GitHub**:
   ```bash
   git init -b main
   git add .
   git commit -m "feat: initial TiddlyWiki5 plugin library setup"
   git remote add origin git@github.com:mblackman/tw5-plugin-library.git
   git push -u origin main
   ```
2. **Configure GitHub Pages**:
   In `mblackman/tw5-plugin-library` on GitHub, navigate to **Settings -> Pages** and set **Build and deployment -> Source** to **GitHub Actions**.
3. **Local Build / Testing**:
   ```bash
   npm install
   npm run build:force
   ```
4. **Syndicate to TiddlyWiki-CPL (Optional)**:
   Add `https://mblackman.github.io/tw5-plugin-library/recipes/library/index.html` to [TiddlyWiki-CPL's `libraries.json`](https://github.com/tiddly-gittly/TiddlyWiki-CPL/blob/master/libraries.json).
