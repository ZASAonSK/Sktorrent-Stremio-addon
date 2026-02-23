// SKTorrent Stremio addon s TMDB (CZ/SK názvy) a pokročilým fallbackom
require("dotenv").config();
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const bencode = require("bncode");
const crypto = require("crypto");

const SKT_UID = process.env.SKT_UID || "";
const SKT_PASS = process.env.SKT_PASS || "";
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";

const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

const builder = addonBuilder({
    id: "org.stremio.sktorrent",
    version: "1.1.0",
    name: "SKTorrent",
    description: "Streamuj torrenty z SKTorrent.eu (CZ/SK názvy cez TMDB)",
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "sktorrent-movie", name: "SKTorrent Filmy" },
        { type: "series", id: "sktorrent-series", name: "SKTorrent Seriály" }
    ],
    resources: ["stream"],
    idPrefixes: ["tt"]
});

const langToFlag = {
    CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸",
    DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
    RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵",
    KR: "🇰🇷", CN: "🇨🇳"
};

function removeDiacritics(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function shortenTitle(title, wordCount = 3) {
    return title.split(/\s+/).slice(0, wordCount).join(" ");
}

function torrentMatchesSeason(torrentName, season) {
    const serieMatch = torrentName.match(/\b(\d+)\.Serie\b/i);
    if (serieMatch && parseInt(serieMatch[1]) !== season) return false;

    const seasonMatch = torrentName.match(/\bSeason\s+(\d+)\b/i);
    if (seasonMatch && parseInt(seasonMatch[1]) !== season) return false;

    const sMatch = torrentName.match(/\bS(\d{2})(?!E)/i);
    if (sMatch && parseInt(sMatch[1]) !== season) return false;

    return true;
}

// ===================================================================
// TMDB: nájdi TMDB ID podľa IMDb ID + vytiahni preklady (EN + CZ + SK)
// ===================================================================
async function getTitlesFromTMDB(imdbId, type) {
    if (!TMDB_API_KEY) {
        console.error("[ERROR] TMDB_API_KEY nie je nastavený v .env!");
        return [];
    }

    try {
        const tmdbType = type === "series" ? "tv" : "movie";

        // 1) nájdeme TMDB objekt podľa IMDb ID
        const findUrl = `https://api.themoviedb.org/3/find/${imdbId}`;
        const findRes = await axios.get(findUrl, {
            params: {
                api_key: TMDB_API_KEY,
                external_source: "imdb_id"
            },
            timeout: 7000
        });

        let tmdbId = null;
        let baseTitle = null;
        let originalTitle = null;

        if (type === "series" && findRes.data.tv_results && findRes.data.tv_results.length > 0) {
            const r = findRes.data.tv_results[0];
            tmdbId = r.id;
            baseTitle = r.name;
            originalTitle = r.original_name;
        } else if (type === "movie" && findRes.data.movie_results && findRes.data.movie_results.length > 0) {
            const r = findRes.data.movie_results[0];
            tmdbId = r.id;
            baseTitle = r.title;
            originalTitle = r.original_title;
        }

        const titles = new Set();
        if (baseTitle) titles.add(baseTitle);
        if (originalTitle) titles.add(originalTitle);

        if (!tmdbId) {
            console.log(`[DEBUG] TMDB nenašiel ${type} pre IMDb ${imdbId}`);
            return [...titles];
        }

        // 2) preklady pre tento TMDB ID (vrátane CZ/SK)
        const translationsUrl = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}/translations`;
        const transRes = await axios.get(translationsUrl, {
            params: { api_key: TMDB_API_KEY },
            timeout: 7000
        });

        if (transRes.data && Array.isArray(transRes.data.translations)) {
            transRes.data.translations.forEach(tr => {
                const lang = tr.iso_639_1;
                const data = tr.data || {};
                const name = data.title || data.name;
                if (name && (lang === "cs" || lang === "sk" || lang === "en")) {
                    titles.add(name);
                }
            });
        }

        const final = [...titles].filter(Boolean);
        console.log(`[DEBUG] 🌝 Názvy z TMDB: ${final.join(" | ")}`);
        return final;
    } catch (err) {
        console.error("[ERROR] TMDB chyba:", err.message);
        return [];
    }
}

// fallback: Cinemeta (ak TMDB vráti málo)
async function getTitlesFromCinemeta(imdbId, type) {
    try {
        const res = await axios.get(
            `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
            { timeout: 5000 }
        );
        if (!res.data || !res.data.meta) return [];

        const meta = res.data.meta;
        const titles = new Set();

        if (meta.name) titles.add(decode(meta.name).trim());
        if (meta.original_name) titles.add(decode(meta.original_name).trim());
        if (meta.aliases && meta.aliases.length > 0) {
            meta.aliases.forEach(a => titles.add(decode(a).trim()));
        }

        const arr = [...titles].filter(Boolean);
        console.log(`[DEBUG] 🌍 Názvy z Cinemeta: ${arr.join(" | ")}`);
        return arr;
    } catch {
        return [];
    }
}

// finálne: spoj TMDB + Cinemeta, plus hardcode pre tvoje konkrétne prípady
async function getAllTitles(imdbId, type) {
    const tmdbTitles = await getTitlesFromTMDB(imdbId, type);
    const cineTitles = await getTitlesFromCinemeta(imdbId, type);

    const titles = new Set([...tmdbTitles, ...cineTitles]);

    // hardcode pomocníkov, ak by TMDB/Cinemeta chýbalo
    if (imdbId === "tt27543632") {
        titles.add("Pomocnice");
        titles.add("Pomocníčka");
    }
    if (imdbId === "tt0903747") {
        titles.add("Perníkový táta");
        titles.add("Pernikovy tata");
    }
    if (imdbId === "tt27497448") {
        titles.add("Rytíř sedmi království");
        titles.add("Rytier siedmich kráľovstiev");
    }

    const final = [...titles]
        .filter(Boolean)
        .filter(t => !t.toLowerCase().startsWith("výsledky vyhledávání"));

    console.log(`[DEBUG] ✅ Finálne názvy na vyhľadávanie: ${final.join(" | ")}`);
    return final;
}

// =================== SKTorrent vyhľadávanie ===================
async function searchTorrents(query) {
    if (!query || query.trim().length < 2) return [];

    console.log(`[INFO] 🔎 Hľadám '${query}' na SKTorrent...`);
    try {
        const session = axios.create({
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
                "Cookie": `uid=${SKT_UID}; pass=${SKT_PASS}`,
                "Referer": BASE_URL
            },
            timeout: 10000
        });

        const res = await session.get(SEARCH_URL, { params: { search: query, category: 0 } });
        const $ = cheerio.load(res.data);
        const posters = $('a[href^="details.php"] img');
        const results = [];

        posters.each((i, img) => {
            const parent = $(img).closest("a");
            const outerTd = parent.closest("td");
            const fullBlock = outerTd.text().replace(/\s+/g, " ").trim();
            const href = parent.attr("href") || "";
            const tooltip = parent.attr("title") || "";
            const torrentId = href.split("id=").pop();
            const category = outerTd.find("b").first().text().trim();
            const sizeMatch = fullBlock.match(/Velkost\s([^|]+)/i);
            const seedMatch = fullBlock.match(/Odosielaju\s*:\s*(\d+)/i);
            const size = sizeMatch ? sizeMatch[1].trim() : "?";
            const seeds = seedMatch ? seedMatch[1] : "0";

            if (!category.toLowerCase().includes("film") && !category.toLowerCase().includes("seri")) return;

            results.push({
                name: tooltip,
                id: torrentId,
                size,
                seeds,
                category,
                downloadUrl: `${BASE_URL}/torrent/download.php?id=${torrentId}`
            });
        });

        console.log(`[INFO] 📦 Nájdených torrentov: ${results.length}`);
        return results;
    } catch (err) {
        console.error("[ERROR] Vyhľadávanie zlyhalo:", err.message);
        return [];
    }
}

async function getTorrentData(url) {
    try {
        const res = await axios.get(url, {
            responseType: "arraybuffer",
            headers: { "Cookie": `uid=${SKT_UID}; pass=${SKT_PASS}` },
            timeout: 10000
        });

        const bufferString = res.data.toString("utf8", 0, 50);
        if (bufferString.includes("<html") || bufferString.includes("<!DOC")) return null;

        const torrent = bencode.decode(res.data);
        const info = bencode.encode(torrent.info);
        const infoHash = crypto.createHash("sha1").update(info).digest("hex");

        let files = [];
        if (torrent.info.files) {
            files = torrent.info.files.map((file, index) => {
                const filePath = (file["path.utf-8"] || file.path || []).map(p => p.toString()).join("/");
                return { path: filePath, index };
            });
        } else {
            const name = (torrent.info["name.utf-8"] || torrent.info.name || "").toString();
            files = [{ path: name, index: 0 }];
        }

        return { infoHash, files };
    } catch (err) {
        console.error("[ERROR] ⛔️ Chyba pri .torrent:", err.message);
        return null;
    }
}

async function toStream(t, season, episode) {
    const langMatches = t.name.match(/\b([A-Z]{2})\b/g) || [];
    const flags = langMatches.map(code => langToFlag[code.toUpperCase()]).filter(Boolean);
    const flagsText = flags.length ? `\n${flags.join(" / ")}` : "";

    let cleanedTitle = t.name.replace(/^Stiahni si\s*/i, "").trim();
    const categoryPrefix = t.category.trim().toLowerCase();
    if (cleanedTitle.toLowerCase().startsWith(categoryPrefix)) cleanedTitle = cleanedTitle.slice(t.category.length).trim();

    const torrentData = await getTorrentData(t.downloadUrl);
    if (!torrentData) return null;

    let streamObj = {
        title: `${cleanedTitle}\n👤 ${t.seeds}  📀 ${t.size}  🌐 sktorrent.eu${flagsText}`,
        name: `SKTorrent\n${t.category}`,
        behaviorHints: { bingeGroup: cleanedTitle },
        infoHash: torrentData.infoHash
    };

    if (season !== undefined && episode !== undefined) {
        const videoFiles = torrentData.files
            .filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.path))
            .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));

        let foundIdx = -1;

        if (videoFiles.length === 1) {
            foundIdx = videoFiles[0].index;
        } else if (videoFiles.length > 1) {
            const epNum = parseInt(episode);
            const strEpPadded = String(epNum).padStart(2, "0");
            const seasonPadded = String(season).padStart(2, "0");

            const epRegexes = [
                new RegExp(`\\b${season}x${strEpPadded}\\b`, "i"),
                new RegExp(`\\b${seasonPadded}x${strEpPadded}\\b`, "i"),
                new RegExp(`S${seasonPadded}[._-]?E${strEpPadded}\\b`, "i"),
                new RegExp(`Ep(?:isode)?[._\\s]*0*${epNum}\\b`, "i"),
                new RegExp(`\\b0*${epNum}\\.(?:mp4|mkv|avi|m4v)$`, "i")
            ];

            for (const reg of epRegexes) {
                const match = videoFiles.find(f => reg.test(f.path));
                if (match) {
                    foundIdx = match.index;
                    break;
                }
            }

            if (foundIdx === -1) {
                const isLaterPart = /Part\s*[2-9]/i.test(t.name) || /Cast\s*[2-9]/i.test(t.name);
                if (!isLaterPart && episode <= videoFiles.length) {
                    foundIdx = videoFiles[episode - 1].index;
                }
            }
        }

        if (foundIdx !== -1) {
            streamObj.fileIdx = foundIdx;
        } else {
            return null;
        }
    }

    return streamObj;
}

builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`\n====== 🎮 RAW Požiadavka: type='${type}', id='${id}' ======`);
    const [imdbId, sRaw, eRaw] = id.split(":");
    const season = sRaw ? parseInt(sRaw) : undefined;
    const episode = eRaw ? parseInt(eRaw) : undefined;

    const titlesRaw = await getAllTitles(imdbId, type);
    if (!titlesRaw.length) return { streams: [] };

    const baseTitles = [];
    titlesRaw.forEach(t => {
        let cleanT = t.replace(/\\(.*?\\)/g, "").replace(/TV (Mini )?Series/gi, "").trim();
        baseTitles.push(cleanT);
        if (cleanT.includes(":")) baseTitles.push(cleanT.split(":")[0].trim());
    });
    const uniqueBaseTitles = [...new Set(baseTitles)];

    const queries = new Set();

    uniqueBaseTitles.forEach(base => {
        const noDia = removeDiacritics(base);
        const short = shortenTitle(noDia);

        if (type === "series" && season && episode) {
            const epTag = ` S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
            const epTag2 = ` ${season}x${String(episode).padStart(2, "0")}`;
            const seasonTag1 = ` S${String(season).padStart(2, "0")}`;
            const seasonTag2 = ` ${season}.Serie`;
            const seasonTag3 = ` Season ${season}`;

            [base, noDia, short].forEach(b => {
                if (!b.trim()) return;
                queries.add(b + epTag);
                queries.add(b + epTag2);
                queries.add((b + epTag).replace(/\s+/g, "."));
                queries.add(b + seasonTag1);
                queries.add(b + seasonTag2);
                queries.add(b + seasonTag3);
            });
        } else {
            [base, noDia, short].forEach(b => {
                if (!b.trim()) return;
                queries.add(b);
                queries.add(b.replace(/[':]/g, ""));
                queries.add(b.replace(/[':]/g, "").replace(/\s+/g, "."));
            });
        }
    });

    let torrents = [];
    let attempt = 1;
    let seenTorrentIds = new Set();

    for (const q of queries) {
        console.log(`[DEBUG] 🔍 Pokus ${attempt++}: Hľadám '${q}'`);
        const found = await searchTorrents(q);
        for (const t of found) {
            if (!seenTorrentIds.has(t.id)) {
                torrents.push(t);
                seenTorrentIds.add(t.id);
            }
        }
        if (torrents.length >= (type === "movie" ? 5 : 3)) break;
        if (attempt > 12) break;
    }

    if (season !== undefined) {
        torrents = torrents.filter(t => torrentMatchesSeason(t.name, season));
    }

    const streams = (await Promise.all(torrents.map(t => toStream(t, season, episode)))).filter(Boolean);
    console.log(`[INFO] ✅ Odosielam ${streams.length} streamov do Stremio`);
    return { streams };
});

builder.defineCatalogHandler(() => ({ metas: [] }));

serveHTTP(builder.getInterface(), { port: 7000 });
console.log("🚀 SKTorrent addon beží na http://localhost:7000/manifest.json");
