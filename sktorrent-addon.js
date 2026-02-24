// SKTorrent Stremio addon v1.1.6 - Podpora pre Multi-Season packy (S01-S03)
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
    version: "1.1.6",
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

const delay = ms => new Promise(res => setTimeout(res, ms));

function removeDiacritics(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function shortenTitle(title, wordCount = 3) {
    return title.split(/\s+/).slice(0, wordCount).join(" ");
}

// ===================================================================
// FILTER 1: Kontrola Série (Rýchly filter)
// ===================================================================
function torrentMatchesSeason(torrentName, season) {
    // 1. BEZPEČNOSTNÁ VÝNIMKA: Ak je to rozsah (S01-S03), tento filter to IGNORUJE a pustí ďalej.
    // O presnosť sa postará až druhý filter (torrentNameMatchesEpisode).
    if (/S\d{1,2}\s*[-–]\s*S?\d{1,2}/i.test(torrentName) || /Seasons?\s*\d{1,2}\s*[-–]\s*\d{1,2}/i.test(torrentName)) {
        return true; 
    }

    // Klasická kontrola (ak to NIE JE rozsah)
    const serieMatch = torrentName.match(/\b(\d+)\.Serie\b/i);
    if (serieMatch && parseInt(serieMatch[1]) !== season) return false;
    const seasonMatch = torrentName.match(/\bSeason\s+(\d+)\b/i);
    if (seasonMatch && parseInt(seasonMatch[1]) !== season) return false;
    const sMatch = torrentName.match(/\bS(\d{2})(?!E)/i);
    if (sMatch && parseInt(sMatch[1]) !== season) return false;
    
    return true;
}

// ===================================================================
// FILTER 2: Kontrola Epizódy a Rozsahov (Detailný filter)
// ===================================================================
function torrentNameMatchesEpisode(name, season, episode) {
    const seasonPadded = String(season).padStart(2, "0");
    const epPadded = String(episode).padStart(2, "0");

    // A) KONTROLA ROZSAHU SÉRIÍ (Novinka pre S01-S03)
    const seasonRangeMatch = name.match(/S(\d{1,2})[-–]S?(\d{1,2})/i) || 
                             name.match(/Seasons?\s*(\d{1,2})[-–](\d{1,2})/i);
    
    if (seasonRangeMatch) {
        const startSeason = parseInt(seasonRangeMatch[1]);
        const endSeason = parseInt(seasonRangeMatch[2]);
        // Ak je naša séria v tomto rozsahu, PUSTÍME TO (return true)
        // Ak nie, necháme to padnúť nižšie (kde to pravdepodobne zlyhá, čo je správne)
        if (season >= startSeason && season <= endSeason) {
            return true; 
        }
    }

    // B) KLASICKÁ KONTROLA EPIZÓD
    // Ak v názve nie je žiadne info o epizóde (napr. "S36 Complete"), pustime to ďalej
    const hasAnyEpisode = new RegExp(`S${seasonPadded}E\\d+`, "i").test(name);
    if (!hasAnyEpisode) return true;

    // Priama zhoda: S36E01
    const directMatch = new RegExp(`S${seasonPadded}[._-]?E${epPadded}\\b`, "i");
    if (directMatch.test(name)) return true;

    // Rozsah epizód: S36E03-E07 alebo S36E03-07
    const rangeMatch = name.match(new RegExp(`S${seasonPadded}E(\\d+)[._-]E?(\\d+)`, "i"));
    if (rangeMatch) {
        const startEp = parseInt(rangeMatch[1]);
        const endEp = parseInt(rangeMatch[2]);
        return episode >= startEp && episode <= endEp;
    }

    return false;
}

// ===================================================================
// Získanie názvov (TMDB + Cinemeta)
// ===================================================================
async function getTitlesFromTMDB(imdbId, type) {
    if (!TMDB_API_KEY) return [];
    try {
        const tmdbType = type === "series" ? "tv" : "movie";
        const findRes = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
            params: { api_key: TMDB_API_KEY, external_source: "imdb_id" }, timeout: 7000
        });

        let tmdbId = null, baseTitle = null, originalTitle = null;

        if (type === "series" && findRes.data.tv_results?.length > 0) {
            const r = findRes.data.tv_results[0];
            tmdbId = r.id; baseTitle = r.name; originalTitle = r.original_name;
        } else if (type === "movie" && findRes.data.movie_results?.length > 0) {
            const r = findRes.data.movie_results[0];
            tmdbId = r.id; baseTitle = r.title; originalTitle = r.original_title;
        }

        const titles = new Set();
        if (baseTitle) titles.add(baseTitle);
        if (originalTitle) titles.add(originalTitle);
        if (!tmdbId) return [...titles];

        const transRes = await axios.get(`https://api.themoviedb.org/3/${tmdbType}/${tmdbId}/translations`, {
            params: { api_key: TMDB_API_KEY }, timeout: 7000
        });

        if (transRes.data?.translations) {
            transRes.data.translations.forEach(tr => {
                const name = (tr.data || {}).title || (tr.data || {}).name;
                if (name && ["cs", "sk", "en"].includes(tr.iso_639_1)) titles.add(name);
            });
        }
        const result = [...titles].filter(Boolean);
        console.log(`[DEBUG] 🌝 Názvy z TMDB: ${result.join(" | ")}`);
        return result;
    } catch (err) {
        console.error("[ERROR] TMDB chyba:", err.message);
        return [];
    }
}

async function getTitlesFromCinemeta(imdbId, type) {
    try {
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, { timeout: 5000 });
        if (!res.data?.meta) return [];
        const meta = res.data.meta;
        const titles = new Set();
        if (meta.name) titles.add(decode(meta.name).trim());
        if (meta.original_name) titles.add(decode(meta.original_name).trim());
        if (meta.aliases) meta.aliases.forEach(a => titles.add(decode(a).trim()));
        const result = [...titles].filter(Boolean);
        console.log(`[DEBUG] 🌍 Názvy z Cinemeta: ${result.join(" | ")}`);
        return result;
    } catch { return []; }
}

async function getAllTitles(imdbId, type) {
    const tmdbTitles = await getTitlesFromTMDB(imdbId, type);
    const cineTitles = await getTitlesFromCinemeta(imdbId, type);
    const titles = new Set([...tmdbTitles, ...cineTitles]);

    if (imdbId === "tt27543632") { titles.add("Pomocnice"); titles.add("Pomocníčka"); }
    if (imdbId === "tt0903747")  { titles.add("Perníkový táta"); titles.add("Pernikovy tata"); }
    if (imdbId === "tt27497448") { titles.add("Rytíř sedmi království"); titles.add("Rytier siedmich kráľovstiev"); }

    const final = [...titles].filter(Boolean).filter(t => !t.toLowerCase().startsWith("výsledky"));
    console.log(`[DEBUG] ✅ Finálne názvy na vyhľadávanie: ${final.join(" | ")}`);
    return final;
}

// ===================================================================
// SKTorrent vyhľadávanie
// ===================================================================
async function searchTorrents(query) {
    if (!query || query.trim().length < 2) return [];
    console.log(`[INFO] 🔎 Hľadám '${query}' na SKTorrent...`);
    try {
        const res = await axios.get(SEARCH_URL, {
            params: { search: query, category: 0 },
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                "Cookie": `uid=${SKT_UID}; pass=${SKT_PASS}`,
                "Referer": BASE_URL,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "sk-SK,sk;q=0.9,cs;q=0.8,en-US;q=0.7"
            },
            timeout: 10000
        });

        const $ = cheerio.load(res.data);
        const results = [];

        $('a[href^="details.php"] img').each((i, img) => {
            const parent = $(img).closest("a");
            const outerTd = parent.closest("td");
            const fullBlock = outerTd.text().replace(/\s+/g, " ").trim();
            const href = parent.attr("href") || "";
            const tooltip = parent.attr("title") || "";
            const torrentId = href.split("id=").pop();
            const category = outerTd.find("b").first().text().trim();
            const sizeMatch = fullBlock.match(/Velkost\s([^|]+)/i);
            const seedMatch = fullBlock.match(/Odosielaju\s*:\s*(\d+)/i);

            if (!category.toLowerCase().includes("film") && !category.toLowerCase().includes("seri")) return;

            results.push({
                name: tooltip,
                id: torrentId,
                size: sizeMatch ? sizeMatch[1].trim() : "?",
                seeds: seedMatch ? seedMatch[1] : "0",
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
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                "Cookie": `uid=${SKT_UID}; pass=${SKT_PASS}`,
                "Referer": `${BASE_URL}/torrent/torrents_v2.php`,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "sk-SK,sk;q=0.9,cs;q=0.8",
                "Connection": "keep-alive",
                "Upgrade-Insecure-Requests": "1"
            },
            timeout: 10000
        });

        const bufferString = res.data.toString("utf8", 0, 50);
        if (bufferString.includes("<html") || bufferString.includes("<!DOC")) {
            console.error(`[ERROR] SKTorrent nevrátil .torrent súbor (neplatné prihlasovacie údaje?)`);
            return null;
        }

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
        console.error(`[ERROR] ⛔️ Chyba pri .torrent:`, err.message);
        return null;
    }
}

async function toStream(t, season, episode) {
    const langMatches = t.name.match(/\b([A-Z]{2})\b/g) || [];
    const flags = langMatches.map(code => langToFlag[code.toUpperCase()]).filter(Boolean);
    const flagsText = flags.length ? `\n${flags.join(" / ")}` : "";

    let cleanedTitle = t.name.replace(/^Stiahni si\s*/i, "").trim();
    if (cleanedTitle.toLowerCase().startsWith(t.category.trim().toLowerCase())) {
        cleanedTitle = cleanedTitle.slice(t.category.length).trim();
    }

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

        if (videoFiles.length === 0) return null;

        if (videoFiles.length === 1) {
            // SINGLE-FILE: Pre-filter v hlavnom handleri už overil názov torrentu.
            // Vnútorný názov súboru ignorujeme (rieši Rytiera 7 kráľovstiev).
            foundIdx = videoFiles[0].index;
        } else {
            // MULTI-FILE: Hľadáme správny súbor regexom
            const epNum = parseInt(episode);
            const strEpPadded = String(epNum).padStart(2, "0");
            const seasonPadded = String(season).padStart(2, "0");

            const epRegexes = [
                new RegExp(`\\b${season}x${strEpPadded}\\b`, "i"),
                new RegExp(`\\b${seasonPadded}x${strEpPadded}\\b`, "i"),
                new RegExp(`S${seasonPadded}[._-]?E${strEpPadded}(?![0-9])`, "i"),
                new RegExp(`Ep(?:isode)?[._\\s]*0*${epNum}\\b`, "i"),
                new RegExp(`\\b0*${epNum}\\.(?:mp4|mkv|avi|m4v)$`, "i")
            ];

            // 1. Kolo: Prísne regexy
            for (const reg of epRegexes) {
                const match = videoFiles.find(f => reg.test(f.path));
                if (match) { foundIdx = match.index; break; }
            }

            // 2. Kolo: Voľné "Anime" regexy (ak prísne zlyhali)
            if (foundIdx === -1) {
                const looseRegexes = [
                    new RegExp(`\\b${season}x0*${epNum}\\b`, "i"), // "1x71"
                    new RegExp(`(^|/)[\\s._-]*0*${epNum}[\\s._-]+.*\\.(?:mp4|mkv|avi|m4v)$`, "i") // "071 Pokemon.mkv"
                ];
                for (const looseReg of looseRegexes) {
                    const matchLoose = videoFiles.find(f => looseReg.test(f.path));
                    if (matchLoose) {
                        foundIdx = matchLoose.index;
                        console.log(`[DEBUG] 🎯 Epizóda ${episode} nájdená cez voľný (anime) regex.`);
                        break;
                    }
                }
            }
        }

        if (foundIdx === -1) {
            console.log(`[DEBUG] ❌ '${t.name}' - nenašiel sa súbor pre epizódu ${episode}. Zahadzujem.`);
            return null;
        }

        streamObj.fileIdx = foundIdx;
    }

    return streamObj;
}

// ===================================================================
// Hlavný handler
// ===================================================================
builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`\n====== 🎮 RAW Požiadavka: type='${type}', id='${id}' ======`);
    const [imdbId, sRaw, eRaw] = id.split(":");
    const season = sRaw ? parseInt(sRaw) : undefined;
    const episode = eRaw ? parseInt(eRaw) : undefined;

    const titlesRaw = await getAllTitles(imdbId, type);
    if (!titlesRaw.length) return { streams: [] };

    const baseTitles = [];
    titlesRaw.forEach(t => {
        let cleanT = t.replace(/\(.*?\)/g, "").replace(/TV (Mini )?Series/gi, "").trim();
        baseTitles.push(cleanT);
        if (cleanT.includes(":")) baseTitles.push(cleanT.split(":")[0].trim());
    });
    const uniqueBaseTitles = [...new Set(baseTitles)];

    const queries = new Set();
    uniqueBaseTitles.forEach(base => {
        const noDia = removeDiacritics(base);
        const short = shortenTitle(noDia);

        if (type === "series" && season && episode) {
            const epTag  = ` S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
            const epTag2 = ` ${season}x${String(episode).padStart(2, "0")}`;
            const sTag1  = ` S${String(season).padStart(2, "0")}`;
            const sTag2  = ` ${season}.Serie`;

            [base, noDia, short].forEach(b => {
                if (!b.trim()) return;
                queries.add(b + epTag);
                queries.add(b + epTag2);
                queries.add((b + epTag).replace(/\s+/g, "."));
                queries.add(b + sTag1);
                queries.add(b + sTag2);
            });
        } else {
            [base, noDia, short].forEach(b => {
                if (!b.trim()) return;
                queries.add(b);
                queries.add(b.replace(/[':]/g, ""));
            });
        }
    });

    let torrents = [];
    let attempt = 1;
    const seenTorrentIds = new Set();

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
        if (attempt > 10) break;
    }

    if (season !== undefined) {
        // Filter 1: Rýchly (meno), s výnimkou pre S01-S03
        torrents = torrents.filter(t => torrentMatchesSeason(t.name, season));
        
        // Filter 2: Detailný (epizódy + rozsahy)
        const before = torrents.length;
        torrents = torrents.filter(t => torrentNameMatchesEpisode(t.name, season, episode));
        const after = torrents.length;
        if (before !== after) {
            console.log(`[DEBUG] ⚡ Pre-filter: z ${before} torrentov ostalo ${after} relevantných`);
        }
    }

    const streams = [];
    for (const t of torrents) {
        await delay(300);
        const stream = await toStream(t, season, episode);
        if (stream) streams.push(stream);
    }

    console.log(`[INFO] ✅ Odosielam ${streams.length} streamov do Stremio`);
    return { streams };
});

builder.defineCatalogHandler(() => ({ metas: [] }));

serveHTTP(builder.getInterface(), { port: 7000 });
console.log("🚀 SKTorrent addon beží na http://localhost:7000/manifest.json");
