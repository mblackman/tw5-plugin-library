#!/usr/bin/env node
/**
 * sync-and-build.js
 * Self-contained release fetcher and TiddlyWiki5 Plugin Library builder
 * for https://github.com/mblackman/tw5-plugin-library
 *
 * Fetches the latest GitHub Release .json plugin assets from each repository
 * listed in plugins.json, updates plugins-lock.json, generates the static
 * TiddlyWiki5 Plugin Library endpoints (dist/recipes/library/*), and builds
 * the interactive showcase wiki (dist/index.html) via TiddlyWiki5 CLI.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT_DIR = process.cwd();
const MANIFEST_PATH = path.join(ROOT_DIR, "plugins.json");
const LOCKFILE_PATH = path.join(ROOT_DIR, "plugins-lock.json");
const TIDDLERS_DIR = path.join(ROOT_DIR, "tiddlers");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const LIBRARY_DIR = path.join(DIST_DIR, "recipes", "library");
const LIBRARY_TIDDLERS_DIR = path.join(LIBRARY_DIR, "tiddlers");

let GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
if (!GITHUB_TOKEN) {
  try {
    GITHUB_TOKEN = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Fall back to unauthenticated requests if gh CLI is unavailable
  }
}
const FORCE_BUILD = process.argv.includes("--force");
const CHECK_ONLY = process.argv.includes("--check-only");

/**
 * Fetch JSON from GitHub REST API using built-in fetch (Node 18+).
 */
async function githubFetchJson(url) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "mblackman-tw5-plugin-library-builder",
  };
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error (${res.status}) for ${url}: ${body}`);
  }
  return res.json();
}

/**
 * Download a raw release asset JSON file via the GitHub Release Asset API URL
 * with automatic fallback to browser_download_url.
 */
async function downloadAssetText(asset) {
  const headers = {
    Accept: "application/octet-stream",
    "User-Agent": "mblackman-tw5-plugin-library-builder",
  };
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }
  const res = await fetch(asset.url, { headers, redirect: "follow" });
  if (res.ok) {
    return res.text();
  }
  // Fallback to browser_download_url without Authorization header
  const fallbackRes = await fetch(asset.browserDownloadUrl, {
    headers: { "User-Agent": "mblackman-tw5-plugin-library-builder" },
    redirect: "follow",
  });
  if (!fallbackRes.ok) {
    throw new Error(
      `Asset download error (${fallbackRes.status}) for ${asset.browserDownloadUrl}`
    );
  }
  return fallbackRes.text();
}

/**
 * Extract valid TiddlyWiki plugin tiddler objects from a parsed JSON file.
 * Supports both single-tiddler JSON objects and exported arrays of tiddlers
 * produced by either standard `tiddlywiki --build` or Modern.TiddlyDev.
 */
function extractPluginTiddlers(parsedJson, sourceRepo) {
  const candidates = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
  const plugins = [];

  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const isPluginTitle =
      typeof item.title === "string" &&
      (item.title.startsWith("$:/plugins/") ||
        item.title.startsWith("$:/themes/") ||
        item.title.startsWith("$:/languages/"));
    const hasPluginType = Boolean(item["plugin-type"]);

    if (isPluginTitle || hasPluginType) {
      plugins.push({
        ...item,
        "plugin-type": item["plugin-type"] || "plugin",
        _sourceRepo: sourceRepo,
      });
    }
  }
  return plugins;
}

/**
 * Extract the embedded readme text from a packed plugin's internal sub-tiddlers
 * so the TiddlyWiki Control Panel plugin browser displays the full README.
 */
function extractPluginReadme(pluginTiddler, options = {}) {
  const { includeNotice = true } = options;
  let readme = "";
  if (typeof pluginTiddler.readme === "string" && pluginTiddler.readme.trim()) {
    readme = pluginTiddler.readme;
  } else {
    try {
      const payload = JSON.parse(pluginTiddler.text || "{}");
      const subTiddlers = payload.tiddlers || {};
      for (const [subTitle, subTiddler] of Object.entries(subTiddlers)) {
        if (subTitle.toLowerCase().endsWith("/readme") && subTiddler?.text) {
          readme = subTiddler.text;
          break;
        }
      }
    } catch {
      // Ignore malformed inner plugin text
    }
  }
  if (!readme) {
    readme = pluginTiddler.description || "";
  }

  if (includeNotice) {
    if (pluginTiddler.title === "$:/plugins/mblackman/tiddlypwa") {
      const notice = `//''⚠️ Requirements'': This plugin requires running a companion [[TiddlyPWA sync backend server|https://github.com/mblackman/tiddlypwa#quick-start-with-docker]] (Docker / Deno 2 + SQLite) and installing the companion [[$:/plugins/mblackman/web-app-manifest]] prerequisite plugin.//\n\n`;
      if (!readme.includes("TiddlyPWA sync backend server")) {
        readme = notice + readme;
      }
    } else if (pluginTiddler.title === "$:/plugins/mblackman/web-app-manifest") {
      const notice = `//''ℹ️ TiddlyPWA Prerequisite'': This plugin is a required dependency for [[$:/plugins/mblackman/tiddlypwa]] to properly initialize Progressive Web App features and browser manifest registration.//\n\n`;
      if (!readme.includes("TiddlyPWA Prerequisite")) {
        readme = notice + readme;
      }
    } else if (pluginTiddler["server-dependent"] === "yes") {
      const notice = `//''⚠️ Backend Server Required'': This plugin requires running a companion backend server.//\n\n`;
      if (!readme.includes("Backend Server Required")) {
        readme = notice + readme;
      }
    }
  }

  return readme;
}

/**
 * Escape `<` inside inline JSON script payloads so `</script>` inside a plugin
 * never prematurely closes the HTML `<script>` tag.
 */
function safeJsonForInlineScript(data) {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * Generate the official TiddlyWiki5 postMessage library server HTML
 * (`dist/recipes/library/index.html`) compatible with $:/tags/PluginLibrary.
 */
function generateLibraryServerHtml(libraryTitle, metadataArray, fullPluginMap) {
  const assetListJson = safeJsonForInlineScript(metadataArray);
  const pluginStoreJson = safeJsonForInlineScript(fullPluginMap);

  return `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Type" content="text/html;charset=utf-8" />
<meta name="application-name" content="TiddlyWiki Plugin Library" />
<title>${libraryTitle}</title>
<script>
var assetList = ${assetListJson};
var pluginStore = ${pluginStoreJson};

var httpGet = function(url, callback) {
  var http = new XMLHttpRequest();
  http.open("GET", url, true);
  http.onreadystatechange = function() {
    if (http.readyState === 4 && http.status === 200) {
      callback(http.responseText);
    }
  };
  http.send();
};

window.addEventListener("message", function(event) {
  if (!event.data) return;
  if (event.data.verb === "GET") {
    if (event.data.url === "recipes/library/tiddlers.json") {
      event.source.postMessage({
        verb: "GET-RESPONSE",
        status: "200",
        cookies: event.data.cookies,
        url: event.data.url,
        type: "application/json",
        body: JSON.stringify(assetList, null, 2)
      }, "*");
    } else if (event.data.url.indexOf("recipes/library/tiddlers/") === 0) {
      var encodedSuffix = event.data.url.slice("recipes/library/tiddlers/".length);
      var rawTitle = decodeURIComponent(encodedSuffix.replace(/\\.json$/i, ""));
      if (pluginStore[rawTitle]) {
        event.source.postMessage({
          verb: "GET-RESPONSE",
          status: "200",
          cookies: event.data.cookies,
          url: event.data.url,
          type: "application/json",
          body: JSON.stringify(pluginStore[rawTitle], null, 2)
        }, "*");
        return;
      }
      var url = "tiddlers/" + encodeURIComponent(encodedSuffix);
      httpGet(url, function(body) {
        event.source.postMessage({
          verb: "GET-RESPONSE",
          status: "200",
          cookies: event.data.cookies,
          url: event.data.url,
          type: "application/json",
          body: body
        }, "*");
      });
    } else {
      event.source.postMessage({
        verb: "GET-RESPONSE",
        status: "404",
        cookies: event.data.cookies,
        url: event.data.url,
        body: ""
      }, "*");
    }
  }
}, false);
</script>
</head>
<body>
<h1>${libraryTitle}</h1>
<p>This is a TiddlyWiki5 plugin library endpoint. To install plugins, open the main library wiki at <a href="../../index.html">../../index.html</a> and drag the plugin library configuration tiddler into your TiddlyWiki.</p>
</body>
</html>
`;
}

/**
 * Generate the landing page catalog tiddlers, individual searchable plugin
 * showcase tiddlers, and read-only UI polish tiddlers in `tiddlers/`.
 */
async function writeWikiTiddlers(manifest, collectedPlugins) {
  await fs.mkdir(TIDDLERS_DIR, { recursive: true });

  const configTitle = `$:/config/${manifest.authorHandle}/PluginLibrary`;
  const homeTitle = "Mblackman TiddlyWiki Plugin Library";

  // 1. Write the draggable $:/tags/PluginLibrary configuration tiddler
  const libraryConfigTiddler = {
    title: configTitle,
    tags: "$:/tags/PluginLibrary",
    url: `${manifest.libraryBaseUrl.replace(/\/$/, "")}/recipes/library/index.html`,
    caption: manifest.libraryName,
    text: manifest.libraryDescription,
  };
  await fs.writeFile(
    path.join(TIDDLERS_DIR, "PluginLibraryConfig.json"),
    JSON.stringify([libraryConfigTiddler], null, 2),
    "utf8"
  );

  // 2. Partition plugins into standard and server-dependent collections
  const standardPlugins = [];
  const serverDependentPlugins = [];

  for (const entry of collectedPlugins) {
    if (entry.serverDependent) {
      serverDependentPlugins.push(entry);
    } else {
      standardPlugins.push(entry);
    }
  }

  serverDependentPlugins.sort((a, b) => {
    // web-app-manifest first as prerequisite, then tiddlypwa
    if (a.plugin.title === "$:/plugins/mblackman/web-app-manifest") return -1;
    if (b.plugin.title === "$:/plugins/mblackman/web-app-manifest") return 1;
    return 0;
  });

  // 3. Write each packed plugin tiddler AND a searchable non-system showcase tiddler
  for (const entry of collectedPlugins) {
    const { plugin, releaseTag, publishedAt, repo, htmlUrl, serverDependent } = entry;
    const isTiddlyPwaSync = plugin.title === "$:/plugins/mblackman/tiddlypwa";
    const isManifest = plugin.title === "$:/plugins/mblackman/web-app-manifest";
    const isServerCore = isTiddlyPwaSync || (serverDependent && !isManifest);

    const safeFile = plugin.title.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
    const cleanTiddler = {
      ...plugin,
      "source-library": manifest.libraryBaseUrl,
      "source-repo": `https://github.com/${repo}`,
      "library-release-tag": releaseTag,
    };
    if (isServerCore) {
      cleanTiddler["server-dependent"] = "yes";
    }
    if (isTiddlyPwaSync) {
      cleanTiddler["dependents"] = "$:/plugins/mblackman/web-app-manifest";
    }
    delete cleanTiddler._sourceRepo;

    await fs.writeFile(
      path.join(TIDDLERS_DIR, safeFile),
      JSON.stringify([cleanTiddler], null, 2),
      "utf8"
    );

    const shortName = plugin.name || plugin.title.split("/").pop();
    const docTiddlerTitle = `Plugin: ${shortName}`;
    const desc = (plugin.description || "")
      .replace(/\|/g, "&#124;")
      .replace(/\r?\n/g, " ");
    const ver = plugin.version || releaseTag;
    const dateStr = publishedAt ? publishedAt.slice(0, 10) : "";

    let serverNoticeWikitext = "";
    let serverTableRows = "";
    let suiteRoleRow = "";

    if (isTiddlyPwaSync) {
      serverNoticeWikitext = `
<div style="background-color: #fff8e6; border: 1px solid #ffd591; border-left: 5px solid #d46b08; padding: 14px 18px; margin: 1.2em 0; border-radius: 4px; color: #873800;">
<h3 style="margin-top:0; color:#d46b08;">⚠️ Companion Backend Server & Manifest Plugin Required</h3>
<p style="margin-bottom:0.6em;">''${shortName}'' is part of an <strong>offline-first synchronized architecture</strong> requiring a running companion backend server and the web app manifest prerequisite plugin.</p>
<ul style="margin-bottom:0.6em; padding-left:1.5em;">
<li><strong>Required Prerequisite</strong>: Install the companion <$draggable tiddler="$:/plugins/mblackman/web-app-manifest"><span class="tc-tag-label" style="cursor:grab; background-color:#2b6cb0; color:#ffffff; padding:0.15em 0.5em; border-radius:1em;">📦 [[web-app-manifest|Plugin: Web App Manifest]]</span></$draggable> plugin. TiddlyPWA requires this plugin to generate the web app manifest and register PWA installation with the browser.</li>
<li><strong>Zero-Knowledge Encryption</strong>: All tiddlers are encrypted locally on your device (AES-GCM / Argon2id) before transmission; the sync server only stores ciphertext and never sees your plaintext content or encryption keys.</li>
<li><strong>Multi-Device Real-Time Sync</strong>: Streams updates across all open devices in real time via Server-Sent Events (SSE) and WebSocket/JSON-RPC.</li>
<li><strong>Conflict Resolution</strong>: Optimistic Concurrency Control (OCC) detects concurrent edits across multiple devices and provides non-destructive resolution workflows.</li>
</ul>
<p style="margin-bottom:0;">👉 View setup instructions in the [[TiddlyPWA Repository|https://github.com/${repo}]] and the [[Docker Quick Start Guide|https://github.com/${repo}#quick-start-with-docker]].</p>
</div>
`;
      serverTableRows = `
|!Prerequisite Plugin |<$draggable tiddler="$:/plugins/mblackman/web-app-manifest"><span class="tc-tag-label" style="cursor:grab; background-color:#2b6cb0; color:#ffffff; padding:0.2em 0.6em; border-radius:1em;">📦 Drag web-app-manifest</span></$draggable> &bull; [[Plugin: Web App Manifest]] (''Required'' for proper operation) |
|!Server Requirement |<span style="color:#d46b08; font-weight:bold;">⚠️ Companion Backend Server Required</span> (Deno 2 + SQLite) |
|!Backend Deployment |[[Docker Quick Start|https://github.com/${repo}#quick-start-with-docker]] &bull; [[Architecture Specs|https://github.com/${repo}/tree/trunk/docs]] |`;
      suiteRoleRow = `\n|!Suite Role |<span style="color:#d46b08; font-weight:bold;">⚡ Core Sync Adaptor</span> (Requires backend + manifest) |`;
    } else if (isManifest) {
      serverNoticeWikitext = `
<div style="background-color: #e6f7ff; border: 1px solid #91d5ff; border-left: 5px solid #1890ff; padding: 14px 18px; margin: 1.2em 0; border-radius: 4px; color: #003a8c;">
<h3 style="margin-top:0; color:#096dd9;">ℹ️ Required Prerequisite for TiddlyPWA</h3>
<p style="margin-bottom:0.6em;">This plugin dynamically generates and registers the browser Web App Manifest (<code>manifest.json</code>) and is a <strong>required dependency for [[TiddlyPWA|Plugin: TiddlyPWA]]</strong> to function properly as an installable Progressive Web App.</p>
<p style="margin-bottom:0;">When installing TiddlyPWA, make sure to drag both this manifest plugin and the core syncadaptor: <$draggable tiddler="$:/plugins/mblackman/tiddlypwa"><span class="tc-tag-label" style="cursor:grab; background-color:#d46b08; color:#ffffff; padding:0.15em 0.5em; border-radius:1em;">⚡ Drag TiddlyPWA</span></$draggable>.</p>
</div>
`;
      serverTableRows = `
|!Companion Core Plugin |<$draggable tiddler="$:/plugins/mblackman/tiddlypwa"><span class="tc-tag-label" style="cursor:grab; background-color:#d46b08; color:#ffffff; padding:0.2em 0.6em; border-radius:1em;">⚡ Drag TiddlyPWA</span></$draggable> &bull; [[Plugin: TiddlyPWA]] |`;
      suiteRoleRow = `\n|!Suite Role |<span style="color:#096dd9; font-weight:bold;">📦 Required Prerequisite</span> for [[Plugin: TiddlyPWA]] |`;
    } else if (serverDependent) {
      serverNoticeWikitext = `
<div style="background-color: #fff8e6; border: 1px solid #ffd591; border-left: 5px solid #d46b08; padding: 14px 18px; margin: 1.2em 0; border-radius: 4px; color: #873800;">
<h3 style="margin-top:0; color:#d46b08;">⚠️ Companion Backend Server Required</h3>
<p style="margin-bottom:0.6em;">Unlike standard client-only TiddlyWiki plugins that execute solely within the browser, ''${shortName}'' requires a running companion backend server.</p>
</div>
`;
      serverTableRows = `
|!Requirement |<span style="color:#d46b08; font-weight:bold;">⚠️ Companion Backend Server Required</span> |`;
    }

    const rawReadme = extractPluginReadme(cleanTiddler, { includeNotice: false });

    // Create a non-system documentation tiddler so the plugin appears in standard search and TableOfContents
    const docTiddler = {
      title: docTiddlerTitle,
      tags: `[[${homeTitle}]] Plugins${serverDependent ? " [[Server-Dependent Plugins]]" : ""}${isTiddlyPwaSync || isManifest ? " [[TiddlyPWA Suite]]" : ""}`,
      caption: shortName,
      "plugin-tiddler": plugin.title,
      version: ver,
      repository: `https://github.com/${repo}`,
      "server-dependent": isServerCore ? "yes" : "no",
      type: "text/vnd.tiddlywiki",
      text: `${serverNoticeWikitext}|!Plugin Title |\`${plugin.title}\` |
|!Install Badge |<$draggable tiddler="${plugin.title}"><span class="tc-tag-label" style="cursor:grab; background-color:${isServerCore ? "#d46b08" : "#2b6cb0"}; color:#ffffff; padding:0.2em 0.6em; border-radius:1em;">📦 Drag ${shortName} v${ver} to your wiki</span></$draggable> |
|!Version |\`${ver}\` ([[Release ${releaseTag}|${htmlUrl || `https://github.com/${repo}/releases`}]]) |${suiteRoleRow}
|!Architecture |${isServerCore ? "⚠️ ''Server-Dependent'' (Requires TiddlyPWA Sync Server)" : isManifest ? "PWA Manifest Generator (Client-side prerequisite)" : "Standard Client Plugin (No Server Required)"} |
|!Updated |${dateStr} |
|!Repository |[[${repo}|https://github.com/${repo}]] |${serverTableRows}

---

${rawReadme || `//No readme found in \`${plugin.title}\`.//`}
`,
    };

    await fs.writeFile(
      path.join(TIDDLERS_DIR, `Doc_${safeFile}`),
      JSON.stringify([docTiddler], null, 2),
      "utf8"
    );
  }

  const standardRows = standardPlugins.map((entry) => {
    const { plugin, releaseTag, publishedAt, repo } = entry;
    const shortName = plugin.name || plugin.title.split("/").pop();
    const docTiddlerTitle = `Plugin: ${shortName}`;
    const desc = (plugin.description || "")
      .replace(/\|/g, "&#124;")
      .replace(/\r?\n/g, " ");
    const ver = plugin.version || releaseTag;
    const dateStr = publishedAt ? publishedAt.slice(0, 10) : "";
    return `|[[${shortName}|${docTiddlerTitle}]] |<$draggable tiddler="${plugin.title}"><span class="tc-tag-label" style="cursor:grab;">📦 \`${plugin.title}\`</span></$draggable> |\`${ver}\` |${desc} |${dateStr} |[[${repo}|https://github.com/${repo}]] |`;
  });

  const serverRows = serverDependentPlugins.map((entry) => {
    const { plugin, releaseTag, publishedAt, repo } = entry;
    const shortName = plugin.name || plugin.title.split("/").pop();
    const docTiddlerTitle = `Plugin: ${shortName}`;
    const desc = (plugin.description || "")
      .replace(/\|/g, "&#124;")
      .replace(/\r?\n/g, " ");
    const ver = plugin.version || releaseTag;
    const dateStr = publishedAt ? publishedAt.slice(0, 10) : "";

    let requirementCol = `<span style="color:#d46b08; font-weight:bold;">⚠️ Server Required</span>`;
    let badgeColor = "#d46b08";
    let icon = "⚡";

    if (plugin.title === "$:/plugins/mblackman/web-app-manifest") {
      requirementCol = `<span style="color:#096dd9; font-weight:bold;">📦 Required Prerequisite</span><br/><span style="font-size:0.85em; color:#4a5568;">Must be installed for TiddlyPWA</span>`;
      badgeColor = "#2b6cb0";
      icon = "📦";
    } else if (plugin.title === "$:/plugins/mblackman/tiddlypwa") {
      requirementCol = `<span style="color:#d46b08; font-weight:bold;">⚡ Core Sync Adaptor</span><br/><span style="font-size:0.85em; color:#d46b08;">⚠️ Server + web-app-manifest required</span>`;
    }

    return `|[[${shortName}|${docTiddlerTitle}]] |<$draggable tiddler="${plugin.title}"><span class="tc-tag-label" style="cursor:grab; background-color:${badgeColor}; color:#ffffff;">${icon} \`${plugin.title}\`</span></$draggable> |\`${ver}\` |${requirementCol} |${desc} |${dateStr} |[[${repo}|https://github.com/${repo}]] |`;
  });

  // 4. Write the main landing page tiddler with separated sections
  const catalogWikitext = `title: ${homeTitle}
tags: TableOfContents
type: text/vnd.tiddlywiki

Welcome to ''${manifest.libraryName}''. This library automatically aggregates the latest GitHub Releases across [[@${manifest.authorHandle}|https://github.com/${manifest.authorHandle}]]'s TiddlyWiki5 plugin repositories.

!! Add the Plugin Library (1-Click Updates)

Drag and drop the following library configuration badge into your own TiddlyWiki, click ''Import'', and then open ''Control Panel -> Plugins -> Get more plugins'':

* <$draggable tiddler="${configTitle}"><span class="tc-tag-label" style="cursor:grab; background-color:#2b6cb0; color:#ffffff; padding:0.25em 0.7em; border-radius:1em;">📦 ${manifest.libraryName} (Drag to your TiddlyWiki)</span></$draggable> — or drag the tiddler link directly: [[${configTitle}]]
* ''Library Endpoint URL'': \`${libraryConfigTiddler.url}\`

!! Standard Client Plugins (${standardPlugins.length})

These plugins run entirely within your browser or standard TiddlyWiki instance without requiring any server infrastructure or external services. Click any plugin name below to read its documentation, or drag its badge directly into your wiki:

|!Plugin & Docs |!Drag to Install |!Version |!Description |!Updated |!Source Repository |
${standardRows.join("\n") || "|//No standard plugins published yet// | | | | | |"}

!! TiddlyPWA Progressive Web App Suite (${serverDependentPlugins.length} Plugins)

<div style="background-color: #fafafa; border: 1px solid #e2e8f0; border-left: 5px solid #d46b08; border-radius: 6px; padding: 18px 22px; margin: 1.5em 0;">

<div style="font-size: 1.15em; font-weight: bold; color: #d46b08; margin-bottom: 8px;">
💡 Understanding TiddlyPWA & The Sync Server Architecture
</div>

<p style="margin-top: 0; color: #4a5568; line-height: 1.5;">
Unlike traditional plugins that run purely inside a single-file wiki, <strong>TiddlyPWA</strong> turns TiddlyWiki into a full <strong>Progressive Web App (PWA)</strong> with encrypted real-time synchronization across your devices.
</p>

<div style="background:#fffbe6; border:1px solid #ffe58f; padding:12px 16px; border-radius:5px; color:#ad6800; font-size:0.95em; line-height:1.55; margin:14px 0;">
<strong>⚠️ Installation Requirement:</strong> The TiddlyPWA suite consists of two complementary plugins. <strong>Both must be installed together</strong> in your TiddlyWiki for TiddlyPWA to operate properly:
<div style="margin-top:8px; display:flex; flex-direction:column; gap:6px;">
<div><strong>1. Prerequisite:</strong> <$draggable tiddler="$:/plugins/mblackman/web-app-manifest"><span class="tc-tag-label" style="cursor:grab; background-color:#2b6cb0; color:#ffffff; padding:0.2em 0.6em; border-radius:1em;">📦 Drag web-app-manifest</span></$draggable> — Generates the browser Web App Manifest (required for PWA initialization).</div>
<div><strong>2. Core Sync Adaptor:</strong> <$draggable tiddler="$:/plugins/mblackman/tiddlypwa"><span class="tc-tag-label" style="cursor:grab; background-color:#d46b08; color:#ffffff; padding:0.2em 0.6em; border-radius:1em;">⚡ Drag tiddlypwa</span></$draggable> — Provides offline-first zero-knowledge encrypted multi-device sync with the backend.</div>
</div>
</div>

<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin: 16px 0;">

<div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px 16px;">
<div style="font-weight: bold; color: #2d3748; margin-bottom: 6px;">🔐 Zero-Knowledge Encryption</div>
<div style="font-size: 0.9em; color: #4a5568; line-height: 1.45;">
All tiddlers are encrypted locally (AES-GCM / Argon2id) before leaving your browser. The server only stores ciphertext blobs—it never sees your keys or plaintext notes.
</div>
</div>

<div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px 16px;">
<div style="font-weight: bold; color: #2d3748; margin-bottom: 6px;">🔄 Why a Backend Server is Needed</div>
<div style="font-size: 0.9em; color: #4a5568; line-height: 1.45;">
A companion server (Deno 2 + SQLite) coordinates real-time updates via Server-Sent Events (SSE) and handles Optimistic Concurrency Control (OCC) to prevent conflicting edits.
</div>
</div>

<div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px 16px;">
<div style="font-weight: bold; color: #2d3748; margin-bottom: 6px;">🚀 Lightweight Self-Hosting</div>
<div style="font-size: 0.9em; color: #4a5568; line-height: 1.45;">
The sync backend runs with a minimal CPU/RAM footprint. Deploy via Docker:<br/>
<code style="display:inline-block; margin-top:4px; font-size:0.85em; background:#f7fafc; padding:2px 6px; border:1px solid #edf2f7; border-radius:3px;">docker run -d -p 8080:8000 ghcr.io/mblackman/tiddlypwa:latest</code>
</div>
</div>

</div>

<p style="margin-bottom: 0; font-size: 0.92em;">
📖 Setup Guide: <a href="https://github.com/mblackman/tiddlypwa#quick-start-with-docker" target="_blank" rel="noopener">Docker Quick Start</a> &bull; <a href="https://github.com/mblackman/tiddlypwa/tree/trunk/docs" target="_blank" rel="noopener">Architecture Documentation Suite</a> &bull; <a href="https://github.com/mblackman/tiddlypwa" target="_blank" rel="noopener">GitHub Repository</a>
</p>

</div>

|!Plugin & Docs |!Drag to Install |!Version |!Requirement / Role |!Description |!Updated |!Source Repository |
${serverRows.join("\n") || "|//No server-dependent plugins published yet// | | | | | | |"}
`;

  await fs.writeFile(path.join(TIDDLERS_DIR, "PluginLibraryCatalog.tid"), catalogWikitext, "utf8");

  // 4. Write UI polish & read-only showcase configuration tiddlers
  const uiConfigTiddlers = [
    {
      title: "$:/SiteTitle",
      text: manifest.libraryName,
    },
    {
      title: "$:/SiteSubtitle",
      text: manifest.libraryDescription,
    },
    {
      title: "$:/DefaultTiddlers",
      text: `[[${homeTitle}]]`,
    },
    // Prevent "Leave site? Unsaved changes" browser prompt when visitors click around the demo site
    {
      title: "$:/config/SaverFilter",
      text: "",
    },
    // Show Home and Close All buttons in page controls; hide Save Wiki and New Tiddler buttons
    {
      title: "$:/config/PageControlButtons/Visibility/$:/core/ui/Buttons/home",
      text: "show",
    },
    {
      title: "$:/config/PageControlButtons/Visibility/$:/core/ui/Buttons/close-all",
      text: "show",
    },
    {
      title: "$:/config/PageControlButtons/Visibility/$:/core/ui/Buttons/new-tiddler",
      text: "hide",
    },
    {
      title: "$:/config/PageControlButtons/Visibility/$:/core/ui/Buttons/save-wiki",
      text: "hide",
    },
    // Add a "Plugins" Table of Contents tab in the right sidebar made default
    {
      title: "$:/config/PluginLibrary/ContentsTab",
      tags: "$:/tags/SideBar",
      caption: "Plugins",
      "list-before": "$:/core/ui/SideBar/Open",
      type: "text/vnd.tiddlywiki",
      text: `<div class="tc-table-of-contents"><<toc-selective-expandable "${homeTitle}" "sort[title]">></div>`,
    },
    {
      title: "$:/config/DefaultSidebarTab",
      text: "$:/config/PluginLibrary/ContentsTab",
    },
  ];

  // Disable all hosted plugins within the showcase wiki itself
  // This prevents hosted plugins (such as TiddlyPWA syncadaptor, login dialogs, or custom UI overrides)
  // from executing on the library site, while preserving them in the store for drag-and-drop installation.
  for (const { plugin } of collectedPlugins) {
    uiConfigTiddlers.push({
      title: `$:/config/Plugins/Disabled/${plugin.title}`,
      text: "yes",
    });
  }

  await fs.writeFile(
    path.join(TIDDLERS_DIR, "UIConfigTiddlers.json"),
    JSON.stringify(uiConfigTiddlers, null, 2),
    "utf8"
  );
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
  let lock = { updatedAt: null, repositories: {} };
  try {
    lock = JSON.parse(await fs.readFile(LOCKFILE_PATH, "utf8"));
  } catch {
    // Initialize fresh lockfile if missing
  }

  let hasUpdates = false;
  const latestMetaByRepo = {};

  console.log(`Checking ${manifest.repositories.length} plugin repositories...`);

  for (const repoEntry of manifest.repositories) {
    const repo = typeof repoEntry === "string" ? repoEntry : repoEntry.repo;
    const isServerDependent = Boolean(
      typeof repoEntry === "object" &&
        (repoEntry.serverDependent || repoEntry.category === "server-dependent")
    );
    const serverDescription =
      typeof repoEntry === "object" ? repoEntry.serverDescription : "";
    const assetPattern =
      typeof repoEntry === "object" && repoEntry.assetRegex
        ? new RegExp(repoEntry.assetRegex)
        : /\.json$/i;

    const releaseUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    const release = await githubFetchJson(releaseUrl);

    if (!release) {
      console.warn(`[SKIP] No published GitHub Release found for ${repo}`);
      continue;
    }

    const jsonAssets = (release.assets || []).filter(
      (a) =>
        assetPattern.test(a.name) &&
        !a.name.endsWith("package.json") &&
        !a.name.endsWith("tsconfig.json")
    );

    if (jsonAssets.length === 0) {
      console.warn(
        `[SKIP] Release ${release.tag_name} in ${repo} has no matching .json plugin assets`
      );
      continue;
    }

    const fingerprint = `${release.tag_name}:${jsonAssets.map((a) => `${a.id}-${a.updated_at}`).join(",")}`;
    const prevFingerprint = lock.repositories?.[repo]?.fingerprint;

    if (fingerprint !== prevFingerprint) {
      console.log(`[UPDATE DETECTED] ${repo} -> ${release.tag_name}`);
      hasUpdates = true;
    } else {
      console.log(`[UP TO DATE] ${repo} (${release.tag_name})`);
    }

    latestMetaByRepo[repo] = {
      repo,
      releaseTag: release.tag_name,
      publishedAt: release.published_at,
      htmlUrl: release.html_url,
      serverDependent: isServerDependent,
      serverDescription,
      fingerprint,
      assets: jsonAssets.map((a) => ({
        id: a.id,
        name: a.name,
        url: a.url,
        browserDownloadUrl: a.browser_download_url,
        updatedAt: a.updated_at,
      })),
    };
  }

  if (CHECK_ONLY) {
    console.log(`Check complete. Updates available: ${hasUpdates}`);
    process.exit(0);
  }

  if (!hasUpdates && !FORCE_BUILD) {
    console.log("No new plugin releases detected. Pass --force to rebuild anyway.");
    return;
  }

  // Download all current plugin JSON assets and deduplicate by plugin title
  // (latest publishedAt wins if a renamed repo like revision-history -> timelord shares a title)
  const pluginsByTitle = new Map();

  for (const [repo, meta] of Object.entries(latestMetaByRepo)) {
    for (const asset of meta.assets) {
      console.log(`Downloading ${asset.name} from ${repo}@${meta.releaseTag}...`);
      try {
        const rawText = await downloadAssetText(asset);
        const parsed = JSON.parse(rawText);
        const plugins = extractPluginTiddlers(parsed, repo);
        for (const plugin of plugins) {
          const isPluginServerDependent = Boolean(
            meta.serverDependent ||
            plugin.title === "$:/plugins/mblackman/tiddlypwa" ||
            plugin.title === "$:/plugins/mblackman/web-app-manifest" ||
            plugin["server-dependent"] === "yes"
          );

          const existing = pluginsByTitle.get(plugin.title);
          if (
            !existing ||
            new Date(meta.publishedAt || 0) >= new Date(existing.publishedAt || 0)
          ) {
            pluginsByTitle.set(plugin.title, {
              plugin,
              repo,
              releaseTag: meta.releaseTag,
              publishedAt: meta.publishedAt,
              htmlUrl: meta.htmlUrl,
              serverDependent: isPluginServerDependent,
              serverDescription: isPluginServerDependent ? meta.serverDescription : "",
            });
          }
        }
      } catch (err) {
        console.warn(`[WARN] Skipping asset ${asset.name} from ${repo}: ${err.message}`);
      }
    }
  }

  const collectedPlugins = Array.from(pluginsByTitle.values());
  console.log(`Prepared ${collectedPlugins.length} unique TiddlyWiki plugins for library build.`);

  // 1. Populate tiddlers/ directory for the landing page wiki
  await writeWikiTiddlers(manifest, collectedPlugins);

  // 2. Build the static recipes/library/ endpoints
  await fs.mkdir(LIBRARY_TIDDLERS_DIR, { recursive: true });
  const libraryManifestArray = [];
  const fullPluginMap = {};

  for (const { plugin, releaseTag, repo, serverDependent } of collectedPlugins) {
    const cleanPlugin = {
      ...plugin,
      "source-library": manifest.libraryBaseUrl,
      "source-repo": `https://github.com/${repo}`,
      "library-release-tag": releaseTag,
    };
    if (serverDependent) {
      cleanPlugin["server-dependent"] = "yes";
    }
    delete cleanPlugin._sourceRepo;

    fullPluginMap[cleanPlugin.title] = cleanPlugin;

    const singleEncoded = `${encodeURIComponent(cleanPlugin.title)}.json`;
    const doubleEncoded = `${encodeURIComponent(encodeURIComponent(cleanPlugin.title))}.json`;
    const serializedPlugin = JSON.stringify(cleanPlugin, null, 2);

    // Write both single-encoded and double-encoded filenames for static host compatibility
    await fs.writeFile(path.join(LIBRARY_TIDDLERS_DIR, singleEncoded), serializedPlugin, "utf8");
    if (doubleEncoded !== singleEncoded) {
      await fs.writeFile(path.join(LIBRARY_TIDDLERS_DIR, doubleEncoded), serializedPlugin, "utf8");
    }

    const metadataOnly = {
      ...cleanPlugin,
      readme: extractPluginReadme(cleanPlugin),
    };
    delete metadataOnly.text;
    libraryManifestArray.push(metadataOnly);
  }

  const tiddlersJsonText = JSON.stringify(libraryManifestArray, null, 2);
  await fs.writeFile(path.join(LIBRARY_DIR, "tiddlers.json"), tiddlersJsonText, "utf8");
  await fs.writeFile(
    path.join(LIBRARY_DIR, "index.html"),
    generateLibraryServerHtml(manifest.libraryName, libraryManifestArray, fullPluginMap),
    "utf8"
  );

  // 3. Build dist/index.html via TiddlyWiki5 CLI
  console.log("Building landing page wiki (dist/index.html) via TiddlyWiki CLI...");
  execFileSync(
    "npx",
    [
      "tiddlywiki",
      ".",
      "--output",
      DIST_DIR,
      "--render",
      "$:/core/save/all",
      "index.html",
      "text/plain",
    ],
    { stdio: "inherit" }
  );

  // 4. Update lockfile
  const updatedLock = {
    updatedAt: new Date().toISOString(),
    repositories: Object.fromEntries(
      Object.entries(latestMetaByRepo).map(([repo, meta]) => [
        repo,
        {
          releaseTag: meta.releaseTag,
          publishedAt: meta.publishedAt,
          fingerprint: meta.fingerprint,
        },
      ])
    ),
  };
  await fs.writeFile(LOCKFILE_PATH, JSON.stringify(updatedLock, null, 2) + "\n", "utf8");
  console.log("Library build complete -> dist/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
