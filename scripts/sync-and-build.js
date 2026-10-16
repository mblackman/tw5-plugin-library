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
 * Generate the official TiddlyWiki5 postMessage library server HTML
 * (`dist/recipes/library/index.html`) compatible with $:/tags/PluginLibrary.
 */
function generateLibraryServerHtml(libraryTitle, assetListJson) {
  return `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Type" content="text/html;charset=utf-8" />
<meta name="application-name" content="TiddlyWiki Plugin Library" />
<title>${libraryTitle}</title>
<script>
var assetList = ${assetListJson};

// Ensure each asset only exposes metadata fields in the initial listing
for (var i = 0; i < assetList.length; i++) {
  delete assetList[i].text;
}

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
      var filename = event.data.url.slice("recipes/library/tiddlers/".length);
      var url = "tiddlers/" + encodeURIComponent(decodeURIComponent(filename));
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
 * Generate the landing page catalog tiddlers in `tiddlers/` before invoking `tiddlywiki --build`.
 */
async function writeWikiTiddlers(manifest, collectedPlugins) {
  await fs.mkdir(TIDDLERS_DIR, { recursive: true });

  // 1. Write the draggable $:/tags/PluginLibrary configuration tiddler
  const libraryConfigTiddler = {
    title: `$:/config/${manifest.authorHandle}/PluginLibrary`,
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

  // 2. Write each packed plugin tiddler into tiddlers/ so the landing wiki includes them
  for (const entry of collectedPlugins) {
    const safeFile = entry.plugin.title.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
    const cleanTiddler = { ...entry.plugin };
    delete cleanTiddler._sourceRepo;
    await fs.writeFile(
      path.join(TIDDLERS_DIR, safeFile),
      JSON.stringify([cleanTiddler], null, 2),
      "utf8"
    );
  }

  // 3. Write SiteTitle, SiteSubtitle, DefaultTiddlers, and the PluginLibraryCatalog overview tiddler
  const rows = collectedPlugins
    .map(({ plugin, releaseTag, publishedAt, repo }) => {
      const desc = plugin.description || "";
      const ver = plugin.version || releaseTag;
      const dateStr = publishedAt ? publishedAt.slice(0, 10) : "";
      return `|[[${plugin.title}]] |\`${ver}\` |${desc} |${dateStr} |[[${repo}|https://github.com/${repo}]] |`;
    })
    .join("\n");

  const catalogWikitext = `title: Matt Blackman's TiddlyWiki Plugin Library
tags: TableOfContents
type: text/vnd.tiddlywiki

Welcome to **${manifest.libraryName}**. This library automatically aggregates the latest GitHub Releases across [[@${manifest.authorHandle}|https://github.com/${manifest.authorHandle}]]'s TiddlyWiki5 plugin repositories.

!! 1. Add the Plugin Library (Recommended for 1-Click Updates)

Drag and drop the following library configuration pill into your own TiddlyWiki, then open ''Control Panel -> Plugins -> Get more plugins'':

* <$MacroCall $name="tag-pill" tag="$:/config/${manifest.authorHandle}/PluginLibrary"/> — ''${manifest.libraryName}'' (\`${libraryConfigTiddler.url}\`)

!! 2. Available Plugins in This Library

|!Plugin Tiddler |!Version |!Description |!Updated |!Source Repository |
${rows || "|//No plugins published yet// | | | | |"}
`;

  await fs.writeFile(path.join(TIDDLERS_DIR, "PluginLibraryCatalog.tid"), catalogWikitext, "utf8");
  await fs.writeFile(
    path.join(TIDDLERS_DIR, "SiteTitle.tid"),
    `title: $:/SiteTitle\n\n${manifest.libraryName}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(TIDDLERS_DIR, "SiteSubtitle.tid"),
    `title: $:/SiteSubtitle\n\n${manifest.libraryDescription}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(TIDDLERS_DIR, "DefaultTiddlers.tid"),
    `title: $:/DefaultTiddlers\n\n[[Matt Blackman's TiddlyWiki Plugin Library]]\n`,
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

  for (const { plugin } of collectedPlugins) {
    const cleanPlugin = { ...plugin };
    delete cleanPlugin._sourceRepo;

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
    generateLibraryServerHtml(manifest.libraryName, tiddlersJsonText),
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
