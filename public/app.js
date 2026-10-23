require("dns").setDefaultResultOrder("ipv4first");

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const pornhub = require("@justalk/pornhub-api");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");

const UA =
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36";

app.use(express.json({ limit: "32kb" }));
app.use(express.static(PUBLIC_DIR));

const TERMS = [
    "amateur", "asian", "latina", "lesbian", "mature",
    "compilation", "massage", "couples", "pov", "blonde",
    "brunette", "redhead", "ebony", "homemade", "outdoor",
    "threesome", "solo", "creampie", "big tits", "blowjob"
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rand = n => Math.floor(Math.random() * n);

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = rand(i + 1);
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function decode(s) {
    return String(s || "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

/* ---------- Native search ---------- */

async function nativeSearch(query, page) {
    const url =
        "https://www.pornhub.com/video/search?search=" +
        encodeURIComponent(query) +
        (page > 1 ? "&page=" + page : "");

    const response = await fetch(url, {
        headers: {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
            "Cookie": "accessAgeDisclaimerPH=1; accessAgeDisclaimerUK=1; platform=pc"
        },
        signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
        throw new Error("HTTP " + response.status);
    }

    const html = await response.text();
    const videos = [];
    const seen = new Set();

    for (const part of html.split('data-video-vkey="').slice(1)) {
        const key = part.slice(0, part.indexOf('"'));

        if (!/^[a-z0-9]{6,30}$/i.test(key) || seen.has(key)) {
            continue;
        }

        seen.add(key);
        const chunk = part.slice(0, 5000);

        const title = (
            chunk.match(/viewkey=[^"]+"[^>]*\btitle="([^"]+)"/) ||
            chunk.match(/\btitle="([^"]+)"[^>]*href="[^"]*viewkey/) ||
            chunk.match(/data-title="([^"]+)"/) ||
            chunk.match(/<img[^>]*\balt="([^"]{2,300})"/) ||
            []
        )[1];

        const thumbRaw = (
            chunk.match(/data-mediumthumb="([^"]+)"/) ||
            chunk.match(/data-thumb_url="([^"]+)"/) ||
            chunk.match(/data-src="([^"]+)"/) ||
            []
        )[1];

        let thumb = decode(thumbRaw);

        if (thumb.startsWith("//")) {
            thumb = "https:" + thumb;
        }

        thumb =
            /^https:\/\/[^/]*phncdn\.com\//i.test(thumb)
                ? "/api/img?u=" + encodeURIComponent(thumb)
                : "";

        const durationText =
            (chunk.match(/class="duration"[^>]*>\s*([\d:]+)/) || [])[1];

        let duration = 0;

        if (durationText) {
            duration = durationText
                .split(":")
                .map(Number)
                .reduce((a, b) => a * 60 + b, 0) || 0;
        }

        const author = (
            chunk.match(/usernameWrap[\s\S]{0,300}?<a[^>]*>\s*([^<]+?)\s*</) ||
            []
        )[1];

        videos.push({
            title: decode(title) || "Untitled",
            url: "https://www.pornhub.com/view_video.php?viewkey=" + key,
            thumb,
            duration,
            hd: /hd-thumbnail/.test(chunk),
            author: decode(author)
        });
    }

    return videos;
}

async function libSearch(query, page) {
    try {
        const response = await pornhub.search(
            query,
            ["title", "link", "hd", "premium"],
            { page, search: "video" }
        );

        const list = Array.isArray(response)
            ? response
            : response && response.results;

        if (!Array.isArray(list)) {
            return [];
        }

        return list
            .filter(v =>
                typeof v.link === "string" &&
                /^https:\/\/www\.pornhub\.com\/view_video\.php\?viewkey=/i.test(v.link)
            )
            .map(v => ({
                title: v.title || "Untitled",
                url: v.link,
                thumb: "",
                duration: 0,
                hd: Boolean(v.hd),
                author: v.author || ""
            }));
    } catch (error) {
        console.error("Library search failed:", error.message);
        return [];
    }
}

async function fetchVideos(query, page) {
    try {
        const videos = await nativeSearch(query, page);

        if (videos.length) {
            console.log(
                `Native search "${query}" page ${page}: ${videos.length} results`
            );
            return videos;
        }

        console.error("Native search returned no results; trying fallback.");
    } catch (error) {
        console.error(
            "Native search failed:",
            error.message,
            "- trying fallback"
        );
    }

    return libSearch(query, page);
}

/* ---------- Search cache ---------- */

const SEARCH_FILE = path.join(__dirname, "search-cache.json");
const searchCache = new Map();
const poolKeys = new Set();

try {
    const saved = JSON.parse(fs.readFileSync(SEARCH_FILE, "utf8"));

    for (const [key, value] of Object.entries(saved.cache || {})) {
        searchCache.set(key, value);
    }

    (saved.pool || []).forEach(key => poolKeys.add(key));
} catch {}

let searchSaveTimer;

function saveSearch() {
    clearTimeout(searchSaveTimer);

    searchSaveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(
                SEARCH_FILE,
                JSON.stringify({
                    cache: Object.fromEntries(searchCache),
                    pool: [...poolKeys]
                })
            );
        } catch (error) {
            console.error("Could not save search cache:", error.message);
        }
    }, 2000);
}

const pendingSearches = new Map();

function refreshSearch(key, query, page) {
    if (pendingSearches.has(key)) {
        return pendingSearches.get(key);
    }

    const promise = fetchVideos(query, page)
        .then(videos => {
            if (videos.length) {
                searchCache.set(key, {
                    t: Date.now(),
                    videos
                });

                while (searchCache.size > 200) {
                    searchCache.delete(searchCache.keys().next().value);
                }

                saveSearch();
            }

            return videos;
        })
        .finally(() => pendingSearches.delete(key));

    pendingSearches.set(key, promise);
    return promise;
}

async function getVideos(query, page) {
    const key = query.toLowerCase() + "|" + page;
    const cached = searchCache.get(key);

    if (cached) {
        if (Date.now() - cached.t > 30 * 60 * 1000) {
            refreshSearch(key, query, page).catch(() => {});
        }

        return cached.videos;
    }

    return refreshSearch(key, query, page);
}

function newCombo() {
    const query = TERMS[rand(TERMS.length)];
    const page = 1 + rand(5);

    return {
        query,
        page,
        key: query + "|" + page
    };
}

function pickCombo() {
    const pool = [...poolKeys].filter(key => searchCache.has(key));

    if (pool.length >= 4 && Math.random() < 0.85) {
        const key = pool[rand(pool.length)];
        const index = key.lastIndexOf("|");

        return {
            query: key.slice(0, index),
            page: Number(key.slice(index + 1)),
            key
        };
    }

    return newCombo();
}

let warming = false;

async function warmOne() {
    if (warming) return;

    warming = true;

    try {
        const combo = newCombo();
        const videos = await getVideos(combo.query, combo.page);

        if (videos.length) {
            poolKeys.add(combo.key);
            saveSearch();
        }
    } finally {
        warming = false;
    }
}

/* ---------- Original video URL validation ---------- */

function validVideoUrl(raw) {
    try {
        const url = new URL(String(raw || ""));

        if (
            url.protocol === "https:" &&
            /(^|\.)pornhub\.com$/i.test(url.hostname) &&
            url.pathname.includes("view_video.php")
        ) {
            return url;
        }
    } catch {}

    return null;
}

/* ---------- Original API endpoints ---------- */

app.get("/api/health", (req, res) => {
    res.json({ status: "online" });
});

app.get("/api/home", async (req, res) => {
    try {
        const a = pickCombo();
        let b = pickCombo();

        for (let i = 0; i < 6 && b.key === a.key; i++) {
            b = pickCombo();
        }

        const lists = await Promise.all([a, b].map(async combo => {
            const videos = await getVideos(combo.query, combo.page);

            if (videos.length) {
                poolKeys.add(combo.key);
            }

            return videos;
        }));

        const seen = new Set();

        const videos = shuffle(lists.flat()).filter(video => {
            if (seen.has(video.url)) return false;
            seen.add(video.url);
            return true;
        });

        if (!videos.length) {
            return res.status(502).json({
                success: false,
                error: "Could not load videos. Check the server logs."
            });
        }

        warmOne().catch(() => {});

        res.json({
            success: true,
            videos: videos.slice(0, 24)
        });
    } catch (error) {
        console.error("Home error:", error.message);

        res.status(502).json({
            success: false,
            error: "Could not load videos."
        });
    }
});

app.get("/api/search", async (req, res) => {
    try {
        const query = String(req.query.q || "popular").slice(0, 150);
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const videos = await getVideos(query, page);

        res.json({
            success: true,
            count: videos.length,
            videos
        });
    } catch (error) {
        console.error("Search error:", error.message);

        res.status(502).json({
            success: false,
            error: "Search failed."
        });
    }
});

/* ---------- Server-generated share links ----------

   A short ID maps to a video record stored on this server.
   Public links look like /watch/SHORT_ID.
   They never expose the provider URL in the shared link.
*/

const SHARE_FILE = path.join(__dirname, "share-links.json");
const shareLinks = new Map();

try {
    const saved = JSON.parse(fs.readFileSync(SHARE_FILE, "utf8"));

    for (const [id, value] of Object.entries(saved)) {
        if (value && validVideoUrl(value.url)) {
            shareLinks.set(id, value);
        }
    }
} catch {}

let shareSaveTimer;

function saveShareLinks() {
    clearTimeout(shareSaveTimer);

    shareSaveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(
                SHARE_FILE,
                JSON.stringify(Object.fromEntries(shareLinks), null, 2)
            );
        } catch (error) {
            console.error("Could not save share links:", error.message);
        }
    }, 200);
}

function cleanVideo(video) {
    const original = validVideoUrl(video && video.url);

    if (!original) {
        return null;
    }

    return {
        title: String(video.title || "Video").slice(0, 300),
        author: String(video.author || "").slice(0, 150),
        thumb: String(video.thumb || "").slice(0, 2000),
        duration: Math.max(0, Number(video.duration) || 0),
        hd: Boolean(video.hd),
        url: original.href
    };
}

app.post("/api/share", (req, res) => {
    const video = cleanVideo(req.body && req.body.video);

    if (!video) {
        return res.status(400).json({
            success: false,
            error: "Invalid video."
        });
    }

    // Reuse the existing ID for the same provider URL.
    let id = null;

    for (const [existingId, record] of shareLinks) {
        if (record.url === video.url) {
            id = existingId;
            break;
        }
    }

    if (!id) {
        id = crypto.randomBytes(9).toString("base64url");

        shareLinks.set(id, {
            ...video,
            createdAt: Date.now()
        });

        saveShareLinks();
    }

    res.json({
        success: true,
        id,
        url: `${req.protocol}://${req.get("host")}/watch/${id}`,
        video: {
            title: video.title,
            author: video.author,
            thumb: video.thumb
        }
    });
});

app.get("/api/share/:id", (req, res) => {
    const id = String(req.params.id || "");

    if (!/^[a-zA-Z0-9_-]{8,30}$/.test(id)) {
        return res.status(400).json({
            success: false,
            error: "Invalid share link."
        });
    }

    const video = shareLinks.get(id);

    if (!video) {
        return res.status(404).json({
            success: false,
            error: "This shared video could not be found."
        });
    }

    // Return the source URL only to the player on your own website.
    res.set("Cache-Control", "no-store");

    res.json({
        success: true,
        video: {
            ...video,
            shareId: id
        }
    });
});

/* Serve the app shell for shareable watch URLs.
   The browser reads the ID and retrieves the saved video. */

app.get("/watch/:id", (req, res, next) => {
    const id = String(req.params.id || "");

    if (!/^[a-zA-Z0-9_-]{8,30}$/.test(id)) {
        return res.status(404).send("Shared video not found.");
    }

    res.sendFile(path.join(PUBLIC_DIR, "index.html"), error => {
        if (error && !res.headersSent) next(error);
    });
});

/* ---------- Video stream endpoint ---------- */

app.get("/api/stream", (req, res) => {
    const url = validVideoUrl(req.query.url);

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "Invalid video page URL."
        });
    }

    execFile(
        "python",
        [
            "-m", "yt_dlp",
            "--no-update",
            "--impersonate", "chrome",
            "--no-warnings",
            "-g",
            "--no-playlist",
            "-f", "best[height<=720]/best",
            url.href
        ],
        { timeout: 45000 },
        (error, stdout, stderr) => {
            if (error) {
                console.error("yt-dlp error:", stderr || error.message);

                return res.status(502).json({
                    success: false,
                    error: "Could not get a stream."
                });
            }

            const link = stdout.trim().split("\n")[0];

            if (!link) {
                return res.status(502).json({
                    success: false,
                    error: "No stream URL was returned."
                });
            }

            res.json({
                success: true,
                url: "/api/hls?u=" + encodeURIComponent(link),
                hls: link.includes(".m3u8")
            });
        }
    );
});

/* ---------- HLS proxy ---------- */

app.get("/api/hls", async (req, res) => {
    try {
        const target = new URL(String(req.query.u || ""));

        if (
            target.protocol !== "https:" ||
            !/(^|\.)phncdn\.com$/i.test(target.hostname)
        ) {
            return res.status(400).send("Blocked");
        }

        const upstream = await fetch(target.href, {
            headers: {
                "User-Agent": UA,
                "Referer": "https://www.pornhub.com/"
            },
            signal: AbortSignal.timeout(30000)
        });

        if (!upstream.ok) {
            return res.status(upstream.status).send("Upstream error");
        }

        const proxy = value =>
            "/api/hls?u=" + encodeURIComponent(new URL(value, target).href);

        if (target.pathname.endsWith(".m3u8")) {
            const text = await upstream.text();

            const output = text.split("\n").map(line => {
                const trimmed = line.trim();

                if (!trimmed) return line;

                if (trimmed.startsWith("#")) {
                    return line.replace(
                        /URI="([^"]+)"/g,
                        (match, uri) => 'URI="' + proxy(uri) + '"'
                    );
                }

                return proxy(trimmed);
            }).join("\n");

            res.set("Content-Type", "application/vnd.apple.mpegurl");
            res.set("Cache-Control", "no-store");

            return res.send(output);
        }

        res.set(
            "Content-Type",
            upstream.headers.get("content-type") || "application/octet-stream"
        );

        res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
        console.error("HLS proxy error:", error.message);
        res.status(502).send("Proxy error");
    }
});

/* ---------- Image proxy ---------- */

const imageCache = new Map();

app.get("/api/img", async (req, res) => {
    try {
        const target = new URL(String(req.query.u || ""));

        if (
            target.protocol !== "https:" ||
            !/(^|\.)phncdn\.com$/i.test(target.hostname)
        ) {
            return res.status(400).end();
        }

        let cached = imageCache.get(target.href);

        if (!cached) {
            const upstream = await fetch(target.href, {
                headers: {
                    "User-Agent": UA,
                    "Referer": "https://www.pornhub.com/"
                },
                signal: AbortSignal.timeout(15000)
            });

            if (!upstream.ok) {
                return res.status(upstream.status).end();
            }

            cached = {
                type: upstream.headers.get("content-type") || "image/jpeg",
                buffer: Buffer.from(await upstream.arrayBuffer())
            };

            imageCache.set(target.href, cached);

            if (imageCache.size > 500) {
                imageCache.delete(imageCache.keys().next().value);
            }
        }

        res.set("Content-Type", cached.type);
        res.set("Cache-Control", "public, max-age=86400");
        res.send(cached.buffer);
    } catch {
        res.status(502).end();
    }
});

/* ---------- Metadata cache ---------- */

const META_FILE = path.join(__dirname, "meta-cache.json");
const metaCache = new Map();

try {
    for (
        const [key, value] of
        Object.entries(JSON.parse(fs.readFileSync(META_FILE, "utf8")))
    ) {
        metaCache.set(key, value);
    }
} catch {}

let metaSaveTimer;

function saveMeta() {
    clearTimeout(metaSaveTimer);

    metaSaveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(
                META_FILE,
                JSON.stringify(Object.fromEntries(metaCache))
            );
        } catch {}
    }, 2000);
}

const metaInflight = new Map();
const metaWaiting = [];
let metaRunning = 0;

function metaPump() {
    while (metaRunning < 2 && metaWaiting.length) {
        const job = metaWaiting.shift();
        metaRunning++;

        execFile(
            "python",
            [
                "-m", "yt_dlp",
                "--no-update",
                "--impersonate", "chrome",
                "--skip-download",
                "--no-playlist",
                "--no-warnings",
                "--print", "%(thumbnail)s\t%(duration)s",
                job.href
            ],
            { timeout: 45000 },
            (error, stdout) => {
                metaRunning--;

                let output = { success: false };

                if (!error) {
                    const [thumb, duration] =
                        stdout.trim().split("\n")[0].split("\t");

                    output = {
                        success: true,
                        thumb: thumb && thumb.startsWith("https://")
                            ? "/api/img?u=" + encodeURIComponent(thumb)
                            : "",
                        duration: Number(duration) || 0
                    };

                    metaCache.set(job.href, output);
                    saveMeta();
                }

                job.resolve(output);
                metaPump();
            }
        );
    }
}

function getMeta(href) {
    if (metaCache.has(href)) {
        return Promise.resolve(metaCache.get(href));
    }

    if (metaInflight.has(href)) {
        return metaInflight.get(href);
    }

    const promise = new Promise(resolve => {
        metaWaiting.push({ href, resolve });
        metaPump();
    });

    metaInflight.set(href, promise);
    promise.finally(() => metaInflight.delete(href));

    return promise;
}

app.get("/api/meta", async (req, res) => {
    const url = validVideoUrl(req.query.url);

    if (!url) {
        return res.status(400).json({ success: false });
    }

    res.json(await getMeta(url.href));
});

/* ---------- Start ---------- */

app.listen(PORT, HOST, () => {
    console.log(`VideoHub running at http://${HOST}:${PORT}`);
    console.log("Share links are saved in share-links.json");

    (async () => {
        for (let i = 0; i < 5; i++) {
            try {
                await warmOne();
            } catch (error) {
                console.error("Cache warm-up failed:", error.message);
            }

            await sleep(1500);
        }
    })();
});
