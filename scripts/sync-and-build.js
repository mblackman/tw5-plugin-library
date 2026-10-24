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
 * Parse a TiddlyWiki `.tid` file string into a tiddler object.
 */
function parseTidFile(rawText) {
  const normalized = rawText.replace(/\r\n/g, "\n");
  const splitIdx = normalized.indexOf("\n\n");
  if (splitIdx === -1) return null;

  const headerPart = normalized.slice(0, splitIdx);
  const bodyPart = normalized.slice(splitIdx + 2);
  const tiddler = {};

  for (const line of headerPart.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key) {
      tiddler[key] = val;
    }
  }
  tiddler.text = bodyPart;
  return tiddler;
}

/**
 * Parse raw release asset text (supports `.json` and `.tid` formats).
 */
function parseAssetContent(rawText, assetName) {
  if (/\.tid$/i.test(assetName)) {
    return parseTidFile(rawText);
  }
  return JSON.parse(rawText);
}

/**
 * Extract valid TiddlyWiki plugin tiddler objects from a parsed JSON/tid object.
 * Supports both single-tiddler objects and exported arrays of tiddlers
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
      const notice = `//''Heads up'': This plugin needs a running [[TiddlyPWA sync server|https://github.com/mblackman/tiddlypwa#quick-start-with-docker]] and the [[$:/plugins/mblackman/web-app-manifest]] plugin.//\n\n`;
      if (!readme.includes("TiddlyPWA sync")) {
        readme = notice + readme;
      }
    } else if (pluginTiddler.title === "$:/plugins/mblackman/web-app-manifest") {
      const notice = `//''Note'': Needed if you're using [[$:/plugins/mblackman/tiddlypwa]], or if you just want your wiki to be installable as a web app.//\n\n`;
      if (!readme.includes("installable as a web app")) {
        readme = notice + readme;
      }
    } else if (pluginTiddler.title === "$:/plugins/mblackman/familiar") {
      const notice = `//''Heads up'': This plugin needs a running [[Familiar gateway server|https://github.com/mblackman/tiddly-familiar#gateway]].//\n\n`;
      if (!readme.includes("Familiar gateway server")) {
        readme = notice + readme;
      }
    } else if (pluginTiddler["server-dependent"] === "yes") {
      const notice = `//''Heads up'': This plugin requires a companion backend server.//\n\n`;
      if (!readme.includes("companion backend server")) {
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
<p>This is a TiddlyWiki5 plugin library endpoint. To browse and install plugins, head over to <a href="../../index.html">the main library page</a> and drag the library badge into your wiki.</p>
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
  const homeTitle = manifest.libraryName || "Matt Blackman's TiddlyWiki Plugin Library";

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
  const tiddlyPwaPlugins = [];
  const familiarPlugins = [];

  for (const entry of collectedPlugins) {
    if (entry.plugin.title === "$:/plugins/mblackman/familiar") {
      familiarPlugins.push(entry);
    } else if (entry.serverDependent) {
      tiddlyPwaPlugins.push(entry);
    } else {
      standardPlugins.push(entry);
    }
  }

  tiddlyPwaPlugins.sort((a, b) => {
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
    const isFamiliar = plugin.title === "$:/plugins/mblackman/familiar";
    const isServerCore = isTiddlyPwaSync || isFamiliar || (serverDependent && !isManifest);

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
    const ver = plugin.version || releaseTag;
    const dateStr = publishedAt ? publishedAt.slice(0, 10) : "";

    let serverNoticeWikitext = "";
    let extraTableRows = "";

    if (isTiddlyPwaSync) {
      serverNoticeWikitext = `
<div style="background-color: #fff8e6; border: 1px solid #ffd591; border-left: 4px solid #d46b08; padding: 12px 16px; margin: 1em 0; border-radius: 4px; color: #873800;">
<strong>Heads up — requires a sync server & companion plugin</strong>
<p style="margin: 0.4em 0 0 0;">To use TiddlyPWA, you'll also need to install <$draggable tiddler="$:/plugins/mblackman/web-app-manifest"><span class="tc-tag-label" style="cursor:grab; background-color:#2b6cb0; color:#ffffff; padding:0.15em 0.5em; border-radius:1em;">📦 [[web-app-manifest|Plugin: Web App Manifest]]</span></$draggable> and run the companion sync server. Check out the [[Docker Quick Start|https://github.com/${repo}#quick-start-with-docker]] to get the server running.</p>
</div>
`;
      extraTableRows = `\n|!Requires |<$draggable tiddler="$:/plugins/mblackman/web-app-manifest"><span class="tc-tag-label" style="cursor:grab; background-color:#2b6cb0; color:#ffffff; padding:0.15em 0.5em; border-radius:1em;">📦 web-app-manifest</span></$draggable> + [[TiddlyPWA Sync Server|https://github.com/${repo}#quick-start-with-docker]] |`;
    } else if (isManifest) {
      serverNoticeWikitext = `
<div style="background-color: #e6f7ff; border: 1px solid #91d5ff; border-left: 4px solid #1890ff; padding: 12px 16px; margin: 1em 0; border-radius: 4px; color: #003a8c;">
<strong>Part of the TiddlyPWA setup</strong>
<p style="margin: 0.4em 0 0 0;">This generates the browser <code>manifest.json</code> so your wiki can be installed as an app. It's required if you're using [[TiddlyPWA|Plugin: TiddlyPWA]], though it works fine on its own too.</p>
</div>
`;
      extraTableRows = `\n|!Companion Plugin |[[Plugin: TiddlyPWA]] |`;
    } else if (isFamiliar) {
      serverNoticeWikitext = `
<div style="background-color: #fff8e6; border: 1px solid #ffd591; border-left: 4px solid #d46b08; padding: 12px 16px; margin: 1em 0; border-radius: 4px; color: #873800;">
<strong>Heads up — requires the Familiar gateway server</strong>
<p style="margin: 0.4em 0 0 0;">To use Familiar, you'll also need to run the companion gateway server (FastAPI + Gemini or local Ollama). Check out the [[Gateway setup guide|https://github.com/${repo}#gateway]] to get the server running with Docker.</p>
</div>
`;
      extraTableRows = `\n|!Requires |[[Familiar Gateway Server|https://github.com/${repo}#gateway]] |`;
    } else if (serverDependent) {
      serverNoticeWikitext = `
<div style="background-color: #fff8e6; border: 1px solid #ffd591; border-left: 4px solid #d46b08; padding: 12px 16px; margin: 1em 0; border-radius: 4px; color: #873800;">
<strong>Heads up:</strong> Unlike regular client-only plugins, ''${shortName}'' needs a companion backend server to work.
</div>
`;
    }

    const rawReadme = extractPluginReadme(cleanTiddler, { includeNotice: false });
    const suiteTag = isFamiliar
      ? " [[Familiar]]"
      : serverDependent
        ? " [[TiddlyPWA]]"
        : "";

    // Create a non-system documentation tiddler so the plugin appears in standard search and TableOfContents
    const docTiddler = {
      title: docTiddlerTitle,
      tags: `[[${homeTitle}]] Plugins${suiteTag}`,
      caption: shortName,
      "plugin-tiddler": plugin.title,
      version: ver,
      repository: `https://github.com/${repo}`,
      "server-dependent": isServerCore ? "yes" : "no",
      type: "text/vnd.tiddlywiki",
      text: `${serverNoticeWikitext}|!Install |<$draggable tiddler="${plugin.title}"><span class="tc-tag-label" style="cursor:grab; background-color:${isServerCore ? "#d46b08" : "#2b6cb0"}; color:#ffffff; padding:0.2em 0.6em; border-radius:1em;">📦 Drag ${shortName} v${ver} to your wiki</span></$draggable> |
|!Version |\`${ver}\` (${dateStr ? `updated ${dateStr} · ` : ""}[[Release notes|${htmlUrl || `https://github.com/${repo}/releases`}]]) |
|!Source |[[${repo}|https://github.com/${repo}]] (\`${plugin.title}\`) |${extraTableRows}

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

  // Clean up small typos from upstream plugin descriptions on the overview table
  const formatDesc = (raw) =>
    (raw || "")
      .replace(/Manage you media/i, "Manage your media")
      .replace(/\|/g, "&#124;")
      .replace(/\r?\n/g, " ");

  const standardRows = standardPlugins.map((entry) => {
    const { plugin, releaseTag, repo } = entry;
    const shortName = plugin.name || plugin.title.split("/").pop();
    const docTiddlerTitle = `Plugin: ${shortName}`;
    const desc = formatDesc(plugin.description);
    const ver = plugin.version || releaseTag;
    return `|[[${shortName}|${docTiddlerTitle}]] |${desc} |\`${ver}\` |<$draggable tiddler="${plugin.title}"><span class="tc-tag-label" style="cursor:grab; background-color:#2b6cb0; color:#ffffff; padding:0.15em 0.55em; border-radius:1em;">📦 Drag to wiki</span></$draggable> |[[GitHub|https://github.com/${repo}]] |`;
  });

  const formatServerRow = (entry) => {
    const { plugin, releaseTag, repo } = entry;
    const shortName = plugin.name || plugin.title.split("/").pop();
    const docTiddlerTitle = `Plugin: ${shortName}`;
    const desc = formatDesc(plugin.description);
    const ver = plugin.version || releaseTag;

    let noteCol = "Needs backend server";
    let badgeColor = "#d46b08";
    let icon = "⚡";

    if (plugin.title === "$:/plugins/mblackman/web-app-manifest") {
      noteCol = "Required by TiddlyPWA";
      badgeColor = "#2b6cb0";
      icon = "📦";
    } else if (plugin.title === "$:/plugins/mblackman/tiddlypwa") {
      noteCol = "Needs server + manifest plugin";
    } else if (plugin.title === "$:/plugins/mblackman/familiar") {
      noteCol = "Needs gateway server";
    }

    return `|[[${shortName}|${docTiddlerTitle}]] |${desc} |${noteCol} |\`${ver}\` |<$draggable tiddler="${plugin.title}"><span class="tc-tag-label" style="cursor:grab; background-color:${badgeColor}; color:#ffffff; padding:0.15em 0.55em; border-radius:1em;">${icon} Drag to wiki</span></$draggable> |[[GitHub|https://github.com/${repo}]] |`;
  };

  const tiddlyPwaRows = tiddlyPwaPlugins.map(formatServerRow);
  const familiarRows = familiarPlugins.map(formatServerRow);

  // 4. Write dedicated server-backed suite tiddlers & starter notebook tiddler
  const tiddlyPwaTiddlerTitle = "TiddlyPWA";
  const tiddlyPwaSuiteTiddler = {
    title: tiddlyPwaTiddlerTitle,
    tags: `[[${homeTitle}]] TableOfContents`,
    caption: tiddlyPwaTiddlerTitle,
    type: "text/vnd.tiddlywiki",
    text: `[[TiddlyPWA|Plugin: TiddlyPWA]] turns TiddlyWiki into an installable offline-first web app that syncs across your devices in real time. Your tiddlers are encrypted locally in your browser before they ever touch the server, so the server only sees encrypted blobs.

Because it syncs across devices, it needs a little more setup than a regular plugin:
* ''Both plugins below'' need to be installed in your wiki (the manifest generator + the sync adaptor).
* ''A lightweight sync server'' (Deno + SQLite) needs to be running somewhere you control. It's easy to spin up with Docker — check the [[Quick Start guide|https://github.com/mblackman/tiddlypwa#quick-start-with-docker]] for details.

|!Plugin |!What it does |!Notes |!Version |!Install |!Code |
${tiddlyPwaRows.join("\n") || "|//No server plugins published yet// | | | | | |"}
`,
  };
  await fs.writeFile(
    path.join(TIDDLERS_DIR, "Doc_TiddlyPWA.json"),
    JSON.stringify([tiddlyPwaSuiteTiddler], null, 2),
    "utf8"
  );

  const familiarTiddlerTitle = "Familiar";
  const familiarSuiteTiddler = {
    title: familiarTiddlerTitle,
    tags: `[[${homeTitle}]] TableOfContents`,
    caption: familiarTiddlerTitle,
    type: "text/vnd.tiddlywiki",
    text: `[[familiar|Plugin: familiar]] adds streaming AI chat, semantic search, note summaries, tag & task suggestions, and related-note discovery to any TiddlyWiki. Your wiki sends its own note content with each request (minimized through a content-addressed cache), so it works with any TiddlyWiki without per-wiki server config while keeping your notes on your own infrastructure.

Because retrieval and LLM calls run through a backend service, it needs a little more setup than a regular plugin:
* ''A lightweight gateway server'' (FastAPI + Gemini or local Ollama) needs to be running somewhere you control. It's easy to spin up with Docker — check the [[Gateway setup guide|https://github.com/mblackman/tiddly-familiar#gateway]] for details.
* Once it's running, point the plugin at your gateway URL in ''Control Panel → Settings → Familiar''.

|!Plugin |!What it does |!Notes |!Version |!Install |!Code |
${familiarRows.join("\n") || "|//No server plugins published yet// | | | | | |"}
`,
  };
  await fs.writeFile(
    path.join(TIDDLERS_DIR, "Doc_Familiar.json"),
    JSON.stringify([familiarSuiteTiddler], null, 2),
    "utf8"
  );

  const starterTiddlerTitle = "Starter Notebook";
  const starterTiddler = {
    title: starterTiddlerTitle,
    tags: `[[${homeTitle}]] TableOfContents`,
    caption: starterTiddlerTitle,
    type: "text/vnd.tiddlywiki",
    text: `If you're starting a brand new wiki and want all of my regular plugins ready to go out of the box, grab this starter file.

It's just the standard TiddlyWiki \`empty.html\` with my client-side plugins and this plugin library already installed.

<div style="margin: 1.2em 0; display:flex; gap:14px; align-items:center; flex-wrap:wrap;">
<a href="empty.html" download="empty.html" style="background-color:#16a34a; color:#ffffff; padding:0.5em 1.1em; border-radius:4px; text-decoration:none; font-weight:bold; display:inline-flex; align-items:center; gap:6px;">
⬇️ Download empty.html
</a>
<a href="empty.html" target="_blank" rel="noopener" style="color:#15803d; font-weight:600; text-decoration:underline;">
Preview in a new tab &rarr;
</a>
</div>

!! What's inside

|!Plugin |!Version |!What it does |
${standardPlugins.map((e) => `|[[${e.plugin.name || e.plugin.title.split("/").pop()}|Plugin: ${e.plugin.name || e.plugin.title.split("/").pop()}]] |\`${e.plugin.version || e.releaseTag}\` |${formatDesc(e.plugin.description)} |`).join("\n")}

The [[plugin library|$:/config/${manifest.authorHandle}/PluginLibrary]] is also pre-configured, so whenever I push a new release you can update straight from ''Control Panel → Plugins → Get more plugins''.
`,
  };
  await fs.writeFile(
    path.join(TIDDLERS_DIR, "Doc_Starter_Notebook.json"),
    JSON.stringify([starterTiddler], null, 2),
    "utf8"
  );

  // 5. Write the main landing page tiddler
  const catalogWikitext = `title: ${homeTitle}
tags: TableOfContents
list: [[${tiddlyPwaTiddlerTitle}]] [[${familiarTiddlerTitle}]] [[${starterTiddlerTitle}]]
type: text/vnd.tiddlywiki

Hi! This is where I keep the TiddlyWiki plugins I've built. Whenever I cut a new release on [[GitHub|https://github.com/${manifest.authorHandle}]], this page updates automatically.

!! How to install

The easiest way to install and update these plugins is to add my library to your wiki:

# Drag this badge into your TiddlyWiki window: <$draggable tiddler="${configTitle}"><span class="tc-tag-label" style="cursor:grab; background-color:#2b6cb0; color:#ffffff; padding:0.25em 0.7em; border-radius:1em;">📦 ${manifest.libraryName}</span></$draggable> and click ''Import''.
# Open ''Control Panel → Plugins → Get more plugins'' to browse, install, or grab updates with one click.

//Just want to try one out?// You can also drag any individual plugin's ''📦 Drag to wiki'' button from the tables below straight into your wiki.

//Starting fresh?// Grab the [[${starterTiddlerTitle}]] — a blank TiddlyWiki with all of the regular plugins below pre-installed.

!! Plugins

These run right in your browser like normal TiddlyWiki plugins — no server or extra setup needed. Click a plugin's name to see its README and usage notes.

|!Plugin |!What it does |!Version |!Install |!Code |
${standardRows.join("\n") || "|//No plugins published yet// | | | | |"}
`;

  await fs.writeFile(path.join(TIDDLERS_DIR, "PluginLibraryCatalog.tid"), catalogWikitext, "utf8");

  // 6. Write UI polish & read-only showcase configuration tiddlers
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
      text: `[[${homeTitle}]] [[${tiddlyPwaTiddlerTitle}]] [[${familiarTiddlerTitle}]] [[${starterTiddlerTitle}]]`,
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
        : /\.(json|tid)$/i;

    const releaseUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    const release = await githubFetchJson(releaseUrl);

    if (!release) {
      console.warn(`[SKIP] No published GitHub Release found for ${repo}`);
      continue;
    }

    const allCandidateAssets = (release.assets || []).filter(
      (a) =>
        assetPattern.test(a.name) &&
        !a.name.endsWith("package.json") &&
        !a.name.endsWith("tsconfig.json")
    );
    const jsonOnlyAssets = allCandidateAssets.filter((a) => /\.json$/i.test(a.name));
    const jsonAssets = jsonOnlyAssets.length > 0 ? jsonOnlyAssets : allCandidateAssets;

    if (jsonAssets.length === 0) {
      console.warn(
        `[SKIP] Release ${release.tag_name} in ${repo} has no matching .json/.tid plugin assets`
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

  // Download all current plugin JSON/tid assets and deduplicate by plugin title
  // (latest publishedAt wins if a renamed repo like revision-history -> timelord shares a title)
  const pluginsByTitle = new Map();

  for (const [repo, meta] of Object.entries(latestMetaByRepo)) {
    for (const asset of meta.assets) {
      console.log(`Downloading ${asset.name} from ${repo}@${meta.releaseTag}...`);
      try {
        const rawText = await downloadAssetText(asset);
        const parsed = parseAssetContent(rawText, asset.name);
        const plugins = extractPluginTiddlers(parsed, repo);
        for (const plugin of plugins) {
          const isPluginServerDependent = Boolean(
            meta.serverDependent ||
            plugin.title === "$:/plugins/mblackman/tiddlypwa" ||
            plugin.title === "$:/plugins/mblackman/web-app-manifest" ||
            plugin.title === "$:/plugins/mblackman/familiar" ||
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

  // 4. Build starter notebook wiki (dist/empty.html & dist/Empty.html) via TiddlyWiki CLI
  console.log("Building starter notebook wiki (dist/empty.html) via TiddlyWiki CLI...");
  const emptyStagingDir = path.join(ROOT_DIR, ".empty-staging");
  await fs.mkdir(emptyStagingDir, { recursive: true });

  try {
    const standardPlugins = collectedPlugins.filter((p) => !p.serverDependent);

    // Stage standard (client-only) plugins without disabling them
    for (const { plugin, releaseTag, repo } of standardPlugins) {
      const cleanPlugin = {
        ...plugin,
        "source-library": manifest.libraryBaseUrl,
        "source-repo": `https://github.com/${repo}`,
        "library-release-tag": releaseTag,
      };
      delete cleanPlugin._sourceRepo;
      delete cleanPlugin["server-dependent"];

      const safeFile = plugin.title.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
      await fs.writeFile(
        path.join(emptyStagingDir, safeFile),
        JSON.stringify([cleanPlugin], null, 2),
        "utf8"
      );
    }

    // Stage Plugin Library configuration so the new wiki can receive updates
    const libraryConfigTiddler = {
      title: `$:/config/${manifest.authorHandle}/PluginLibrary`,
      tags: "$:/tags/PluginLibrary",
      url: `${manifest.libraryBaseUrl.replace(/\/$/, "")}/recipes/library/index.html`,
      caption: manifest.libraryName,
      text: manifest.libraryDescription,
    };
    await fs.writeFile(
      path.join(emptyStagingDir, "PluginLibraryConfig.json"),
      JSON.stringify([libraryConfigTiddler], null, 2),
      "utf8"
    );

    // Resolve path to official TiddlyWiki editions/empty so all official components & themes
    // ($:/themes/tiddlywiki/vanilla, $:/themes/tiddlywiki/snowwhite, $:/core, $:/StoryList) are loaded
    const twPackagePath = require.resolve("tiddlywiki/package.json");
    const emptyEditionPath = path.join(path.dirname(twPackagePath), "editions", "empty");

    // Render empty.html using the official TiddlyWiki editions/empty base
    execFileSync(
      "npx",
      [
        "tiddlywiki",
        emptyEditionPath,
        "--load",
        emptyStagingDir,
        "--output",
        DIST_DIR,
        "--render",
        "$:/core/save/all",
        "empty.html",
        "text/plain",
      ],
      { stdio: "inherit" }
    );

    // Ensure case-insensitive access on static web hosts (empty.html and Empty.html)
    await fs.copyFile(
      path.join(DIST_DIR, "empty.html"),
      path.join(DIST_DIR, "Empty.html")
    );
    console.log("Starter notebook generated -> dist/empty.html & dist/Empty.html");
  } finally {
    await fs.rm(emptyStagingDir, { recursive: true, force: true });
  }

  // 5. Update lockfile
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
