# Mblackman TiddlyWiki5 Plugin Library (`tw5-plugin-library`)

Centralized, self-updating [TiddlyWiki5](https://github.com/TiddlyWiki/TiddlyWiki5) plugin library for `@mblackman` plugins, hosted on GitHub Pages at:

- **Interactive Showcase & Library Landing Page**: `https://mblackman.github.io/tw5-plugin-library/`
- **Plugin Library Endpoint (`$:/tags/PluginLibrary`)**: `https://mblackman.github.io/tw5-plugin-library/recipes/library/index.html`

## Included Plugin Repositories

Configured in [`plugins.json`](./plugins.json):

- [`mblackman/tiddlywiki-slipstream`](https://github.com/mblackman/tiddlywiki-slipstream)
- [`mblackman/tiddlywiki-timelord`](https://github.com/mblackman/tiddlywiki-timelord)
- [`mblackman/tiddlywiki-revision-history`](https://github.com/mblackman/tiddlywiki-revision-history)
- [`mblackman/tiddlywiki-media-importer`](https://github.com/mblackman/tiddlywiki-media-importer)
- [`mblackman/tiddlywiki-coffee-tracker`](https://github.com/mblackman/tiddlywiki-coffee-tracker)
- [`mblackman/tiddlywiki-journal`](https://github.com/mblackman/tiddlywiki-journal)
- [`mblackman/tiddlywiki-dayjs-plugin`](https://github.com/mblackman/tiddlywiki-dayjs-plugin)

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
