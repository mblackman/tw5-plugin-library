# Mblackman TiddlyWiki5 Plugin Library (`tw5-plugin-library`)

Centralized, self-updating [TiddlyWiki5](https://github.com/TiddlyWiki/TiddlyWiki5) plugin library for `@mblackman` plugins, hosted on GitHub Pages at:

- **Interactive Showcase & Library Landing Page**: `https://mblackman.github.io/tw5-plugin-library/`
- **Plugin Library Endpoint (`$:/tags/PluginLibrary`)**: `https://mblackman.github.io/tw5-plugin-library/recipes/library/index.html`

## Included Plugin Repositories

Configured in [`plugins.json`](./plugins.json):

### Standard Client Plugins (No Server Required)
These plugins run client-side in any standard TiddlyWiki single-file or node environment:
- [`mblackman/tiddlywiki-slipstream`](https://github.com/mblackman/tiddlywiki-slipstream) — Sleek 3-column desktop and mobile Zoomin reading layout theme
- [`mblackman/tiddlywiki-timelord`](https://github.com/mblackman/tiddlywiki-timelord) — Timeline navigation and temporal tiddler browsing
- [`mblackman/tiddlywiki-revision-history`](https://github.com/mblackman/tiddlywiki-revision-history) — Visual diff viewer and revision history
- [`mblackman/tiddlywiki-media-importer`](https://github.com/mblackman/tiddlywiki-media-importer) — Media consumption and asset tracking within TiddlyWiki
- [`mblackman/tiddlywiki-coffee-tracker`](https://github.com/mblackman/tiddlywiki-coffee-tracker) — Daily coffee and espresso brewing tracker
- [`mblackman/tiddlywiki-journal`](https://github.com/mblackman/tiddlywiki-journal) — Journal structure and styling enhancements
- [`mblackman/tiddlywiki-dayjs-plugin`](https://github.com/mblackman/tiddlywiki-dayjs-plugin) — Day.js date parsing and formatting library

### Server-Dependent Plugins (Offline-First Sync Architecture)
- [`mblackman/tiddlypwa`](https://github.com/mblackman/tiddlypwa) — **TiddlyPWA: Offline-First Storage & Zero-Knowledge Sync Solution**
  - *Architecture Requirement*: Requires self-hosting the lightweight companion TiddlyPWA backend server (Deno 2 + SQLite / Docker).
  - *Zero-Knowledge Privacy*: All tiddlers are encrypted locally on the device (AES-GCM / Argon2id) before syncing over the network; the sync server only stores ciphertext blobs and never sees plaintext content or keys.
  - *Features*: Offline PWA caching with Service Worker, real-time sync via Server-Sent Events (SSE), multi-device optimistic concurrency conflict resolution, and multi-tenant notebook scoping.
  - *Deployment*: Docker image available at `ghcr.io/mblackman/tiddlypwa:latest`. See [Docker Quick Start Guide](https://github.com/mblackman/tiddlypwa#quick-start-with-docker) and [Architecture Specifications](https://github.com/mblackman/tiddlypwa/tree/trunk/docs).


## Quick Start

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
