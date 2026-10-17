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

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
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
function extractPluginReadme(pluginTiddler) {
  if (typeof pluginTiddler.readme === "string" && pluginTiddler.readme.trim()) {
    return pluginTiddler.readme;
  }
  try {
    const payload = JSON.parse(pluginTiddler.text || "{}");
    const subTiddlers = payload.tiddlers || {};
    for (const [subTitle, subTiddler] of Object.entries(subTiddlers)) {
      if (subTitle.toLowerCase().endsWith("/readme") && subTiddler?.text) {
        return subTiddler.text;
      }
    }
  } catch {
    // Ignore malformed inner plugin text
  }
  return pluginTiddler.description || "";
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

  // 2. Write each packed plugin tiddler AND a searchable non-system showcase tiddler
  const rows = [];

  for (const entry of collectedPlugins) {
    const { plugin, releaseTag, publishedAt, repo, htmlUrl } = entry;
    const safeFile = plugin.title.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
    const cleanTiddler = {
      ...plugin,
      "source-library": manifest.libraryBaseUrl,
      "source-repo": `https://github.com/${repo}`,
      "library-release-tag": releaseTag,
    };
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

    // Find embedded readme sub-tiddler title inside the plugin
    let readmeSubTitle = `${plugin.title}/readme`;
    try {
      const parsedPayload = JSON.parse(plugin.text || "{}");
      for (const k of Object.keys(parsedPayload.tiddlers || {})) {
        if (k.toLowerCase().endsWith("/readme")) {
          readmeSubTitle = k;
          break;
        }
      }
    } catch {
      // Ignore
    }

    // Create a non-system documentation tiddler so the plugin appears in standard search and TableOfContents
    const docTiddler = {
      title: docTiddlerTitle,
      tags: `[[${homeTitle}]] Plugins`,
      caption: shortName,
      "plugin-tiddler": plugin.title,
      version: ver,
      repository: `https://github.com/${repo}`,
      type: "text/vnd.tiddlywiki",
      text: `|!Plugin Title |\`${plugin.title}\` |
|!Install Badge |<$draggable tiddler="${plugin.title}"><span class="tc-tag-label" style="cursor:grab; background-color:#2b6cb0; color:#ffffff; padding:0.2em 0.6em; border-radius:1em;">📦 Drag ${shortName} v${ver} to your wiki</span></$draggable> |
|!Version |\`${ver}\` ([[Release ${releaseTag}|${htmlUrl || `https://github.com/${repo}/releases`}]]) |
|!Updated |${dateStr} |
|!Repository |[[${repo}|https://github.com/${repo}]] |

---

<$transclude tiddler="${readmeSubTitle}" mode="block">
//No embedded readme tiddler found in \`${plugin.title}\`.//
</$transclude>
`,
    };

    await fs.writeFile(
      path.join(TIDDLERS_DIR, `Doc_${safeFile}`),
      JSON.stringify([docTiddler], null, 2),
      "utf8"
    );

    rows.push(
      `|[[${shortName}|${docTiddlerTitle}]] |<$draggable tiddler="${plugin.title}"><span class="tc-tag-label" style="cursor:grab;">📦 \`${plugin.title}\`</span></$draggable> |\`${ver}\` |${desc} |${dateStr} |[[${repo}|https://github.com/${repo}]] |`
    );
  }

  // 3. Write the main landing page tiddler
  const catalogWikitext = `title: ${homeTitle}
tags: TableOfContents
type: text/vnd.tiddlywiki

Welcome to ''${manifest.libraryName}''. This library automatically aggregates the latest GitHub Releases across [[@${manifest.authorHandle}|https://github.com/${manifest.authorHandle}]]'s TiddlyWiki5 plugin repositories.

!! 1. Add the Plugin Library (Recommended for 1-Click Updates)

Drag and drop the following library configuration badge into your own TiddlyWiki, click ''Import'', and then open ''Control Panel -> Plugins -> Get more plugins'':

* <$draggable tiddler="${configTitle}"><span class="tc-tag-label" style="cursor:grab; background-color:#2b6cb0; color:#ffffff; padding:0.25em 0.7em; border-radius:1em;">📦 ${manifest.libraryName} (Drag to your TiddlyWiki)</span></$draggable> — or drag the tiddler link directly: [[${configTitle}]]
* ''Library Endpoint URL'': \`${libraryConfigTiddler.url}\`

!! 2. Available Plugins (${collectedPlugins.length})

Click any plugin name below to read its documentation, or drag its pill directly into your wiki:

|!Plugin & Docs |!Drag to Install |!Version |!Description |!Updated |!Source Repository |
${rows.join("\n") || "|//No plugins published yet// | | | | | |"}
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

  for (const { plugin, releaseTag, repo } of collectedPlugins) {
    const cleanPlugin = {
      ...plugin,
      "source-library": manifest.libraryBaseUrl,
      "source-repo": `https://github.com/${repo}`,
      "library-release-tag": releaseTag,
    };
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
