// SKTorrent Stremio addon v1.2.0 - IGNORUJE NUVIO TYPE BUG
// Automaticky deteguje Movie/Series podľa formátu IMDb ID
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

// V definícii addon-u stále nechávame typy, aby ho Stremio rozpoznalo pre oba
const builder = addonBuilder({
    id: "org.stremio.sktorrent",
    version: "1.2.0",
    name: "SKTorrent",
    description: "Streamuj torrenty z SKTorrent.eu (CZ/SK názvy)",
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

function odstranDiakritiku(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function skratNazov(title, pocetSlov = 3) {
    return title.split(/\s+/).slice(0, pocetSlov).join(" ");
}

// ===================================================================
// FILTER 1: Kontrola Série (Rýchly filter názvu)
// ===================================================================
function torrentSedisSeriou(nazovTorrentu, seria) {
    if (/S\d{1,2}\s*[-–]\s*S?\d{1,2}/i.test(nazovTorrentu) || /Seasons?\s*\d{1,2}\s*[-–]\s*\d{1,2}/i.test(nazovTorrentu)) {
        return true; 
    }
    const serieMatch = nazovTorrentu.match(/\b(\d+)\.Serie\b/i);
    if (serieMatch && parseInt(serieMatch[1]) !== seria) return false;
    
    const seasonMatch = nazovTorrentu.match(/\bSeason\s+(\d+)\b/i);
    if (seasonMatch && parseInt(seasonMatch[1]) !== seria) return false;
    
    const sMatch = nazovTorrentu.match(/\bS(\d{2})(?!E)/i);
    if (sMatch && parseInt(sMatch[1]) !== seria) return false;
    
    return true;
}

// ===================================================================
// FILTER 2: Kontrola Epizódy a Rozsahov (Detailný filter)
// ===================================================================
function torrentSediSEpizodou(nazov, seria, epizoda) {
    const seriaStr = String(seria).padStart(2, "0");
    const epStr = String(epizoda).padStart(2, "0");

    const rozsahSerii = nazov.match(/S(\d{1,2})[-–]S?(\d{1,2})/i) || 
                        nazov.match(/Seasons?\s*(\d{1,2})[-–](\d{1,2})/i);
    if (rozsahSerii) {
        const startSeria = parseInt(rozsahSerii[1]);
        const endSeria = parseInt(rozsahSerii[2]);
        if (seria >= startSeria && seria <= endSeria) return true; 
    }

    const maEpizoduTag = new RegExp(`S${seriaStr}E\\d+`, "i").test(nazov);
    if (!maEpizoduTag) return true;

    const priamaZhoda = new RegExp(`S${seriaStr}[._-]?E${epStr}\\b`, "i");
    if (priamaZhoda.test(nazov)) return true;

    const rozsahEpizod = nazov.match(new RegExp(`S${seriaStr}E(\\d+)[._-]E?(\\d+)`, "i"));
    if (rozsahEpizod) {
        const startEp = parseInt(rozsahEpizod[1]);
        const endEp = parseInt(rozsahEpizod[2]);
        return epizoda >= startEp && epizoda <= endEp;
    }

    return false;
}

// ===================================================================
// Získanie názvov (TMDB + Cinemeta)
// ===================================================================
// POZOR: Prijíma už "vlastnyTyp", ktorý si určíme sami z ID
async function ziskatNazvyZTMDB(imdbId, vlastnyTyp) {
    if (!TMDB_API_KEY) return [];
    try {
        const tmdbTyp = vlastnyTyp === "series" ? "tv" : "movie";
        const hladanie = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
            params: { api_key: TMDB_API_KEY, external_source: "imdb_id" }, timeout: 7000
        });

        let tmdbId = null, baseTitle = null, originalTitle = null;

        if (vlastnyTyp === "series" && hladanie.data.tv_results?.length > 0) {
            const r = hladanie.data.tv_results[0];
            tmdbId = r.id; baseTitle = r.name; originalTitle = r.original_name;
        } else if (vlastnyTyp === "movie" && hladanie.data.movie_results?.length > 0) {
            const r = hladanie.data.movie_results[0];
            tmdbId = r.id; baseTitle = r.title; originalTitle = r.original_title;
        }

        const nazvy = new Set();
        if (baseTitle) nazvy.add(baseTitle);
        if (originalTitle) nazvy.add(originalTitle);
        if (!tmdbId) return [...nazvy];

        const preklady = await axios.get(`https://api.themoviedb.org/3/${tmdbTyp}/${tmdbId}/translations`, {
            params: { api_key: TMDB_API_KEY }, timeout: 7000
        });

        if (preklady.data?.translations) {
            preklady.data.translations.forEach(tr => {
                const meno = (tr.data || {}).title || (tr.data || {}).name;
                if (meno && ["cs", "sk", "en"].includes(tr.iso_639_1)) nazvy.add(meno);
            });
        }
        const vysledok = [...nazvy].filter(Boolean);
        console.log(`[DEBUG] 🌝 Názvy z TMDB: ${vysledok.join(" | ")}`);
        return vysledok;
    } catch (chyba) {
        console.error("[ERROR] TMDB chyba:", chyba.message);
        return [];
    }
}

async function ziskatNazvyZCinemeta(imdbId, vlastnyTyp) {
    try {
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${vlastnyTyp}/${imdbId}.json`, { timeout: 5000 });
        if (!res.data?.meta) return [];
        const meta = res.data.meta;
        const nazvy = new Set();
        if (meta.name) nazvy.add(decode(meta.name).trim());
        if (meta.original_name) nazvy.add(decode(meta.original_name).trim());
        if (meta.aliases) meta.aliases.forEach(a => nazvy.add(decode(a).trim()));
        const vysledok = [...nazvy].filter(Boolean);
        console.log(`[DEBUG] 🌍 Názvy z Cinemeta: ${vysledok.join(" | ")}`);
        return vysledok;
    } catch { return []; }
}

async function ziskatVsetkyNazvy(imdbId, vlastnyTyp) {
    const tmdbNazvy = await ziskatNazvyZTMDB(imdbId, vlastnyTyp);
    const cineNazvy = await ziskatNazvyZCinemeta(imdbId, vlastnyTyp);
    const nazvy = new Set([...tmdbNazvy, ...cineNazvy]);

    if (imdbId === "tt27543632") { nazvy.add("Pomocnice"); nazvy.add("Pomocníčka"); }
    if (imdbId === "tt0903747")  { nazvy.add("Perníkový táta"); nazvy.add("Pernikovy tata"); }
    if (imdbId === "tt27497448") { nazvy.add("Rytíř sedmi království"); nazvy.add("Rytier siedmich kráľovstiev"); }

    const finalne = [...nazvy].filter(Boolean).filter(t => !t.toLowerCase().startsWith("výsledky"));
    console.log(`[DEBUG] ✅ Finálne názvy na vyhľadávanie: ${finalne.join(" | ")}`);
    return finalne;
}

// ===================================================================
// SKTorrent vyhľadávanie
// ===================================================================
async function hladatTorrenty(dotaz) {
    if (!dotaz || dotaz.trim().length < 2) return [];
    console.log(`[INFO] 🔎 Hľadám '${dotaz}' na SKTorrent...`);
    try {
        const res = await axios.get(SEARCH_URL, {
            params: { search: dotaz, category: 0 },
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
        const vysledky = [];

        $('a[href^="details.php"] img').each((i, img) => {
            const rodic = $(img).closest("a");
            const bunka = rodic.closest("td");
            const text = bunka.text().replace(/\s+/g, " ").trim();
            const odkaz = rodic.attr("href") || "";
            const nazov = rodic.attr("title") || "";
            const torrentId = odkaz.split("id=").pop();
            const kategoria = bunka.find("b").first().text().trim();
            const velkostMatch = text.match(/Velkost\s([^|]+)/i);
            const seedMatch = text.match(/Odosielaju\s*:\s*(\d+)/i);

            if (!kategoria.toLowerCase().includes("film") && !kategoria.toLowerCase().includes("seri")) return;

            vysledky.push({
                name: nazov,
                id: torrentId,
                size: velkostMatch ? velkostMatch[1].trim() : "?",
                seeds: seedMatch ? seedMatch[1] : "0",
                category: kategoria,
                downloadUrl: `${BASE_URL}/torrent/download.php?id=${torrentId}`
            });
        });

        console.log(`[INFO] 📦 Nájdených torrentov: ${vysledky.length}`);
        return vysledky;
    } catch (chyba) {
        console.error("[ERROR] Vyhľadávanie zlyhalo:", chyba.message);
        return [];
    }
}

async function stiahnutTorrentData(url) {
    try {
        const res = await axios.get(url, {
            responseType: "arraybuffer",
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Cookie": `uid=${SKT_UID}; pass=${SKT_PASS}`,
                "Referer": `${BASE_URL}/torrent/torrents_v2.php`,
                "Connection": "keep-alive"
            },
            timeout: 10000
        });

        const bufferString = res.data.toString("utf8", 0, 50);
        if (bufferString.includes("<html") || bufferString.includes("<!DOC")) {
            return null;
        }

        const torrent = bencode.decode(res.data);
        const info = bencode.encode(torrent.info);
        const infoHash = crypto.createHash("sha1").update(info).digest("hex");

        let subory = [];
        if (torrent.info.files) {
            subory = torrent.info.files.map((file, index) => {
                const cesta = (file["path.utf-8"] || file.path || []).map(p => p.toString()).join("/");
                return { path: cesta, index };
            });
        } else {
            const nazov = (torrent.info["name.utf-8"] || torrent.info.name || "").toString();
            subory = [{ path: nazov, index: 0 }];
        }

        return { infoHash, files: subory };
    } catch (chyba) {
        return null;
    }
}

async function vytvoritStream(t, seria, epizoda) {
    const langZhody = t.name.match(/\b([A-Z]{2})\b/g) || [];
    const vlajky = langZhody.map(kod => langToFlag[kod.toUpperCase()]).filter(Boolean);
    const vlajkyText = vlajky.length ? `\n${vlajky.join(" / ")}` : "";

    let cistyNazov = t.name.replace(/^Stiahni si\s*/i, "").trim();
    if (cistyNazov.toLowerCase().startsWith(t.category.trim().toLowerCase())) {
        cistyNazov = cistyNazov.slice(t.category.length).trim();
    }

    const torrentData = await stiahnutTorrentData(t.downloadUrl);
    if (!torrentData) return null;

    let streamObj = {
        title: `${cistyNazov}\n👤 ${t.seeds}  📀 ${t.size}  🌐 sktorrent.eu${vlajkyText}`,
        name: `SKTorrent\n${t.category}`,
        behaviorHints: { bingeGroup: cistyNazov },
        infoHash: torrentData.infoHash
    };

    if (seria !== undefined && epizoda !== undefined) {
        const videoSubory = torrentData.files
            .filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.path))
            .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));

        let najdenyIndex = -1;
        if (videoSubory.length === 0) return null;

        if (videoSubory.length === 1) {
            najdenyIndex = videoSubory[0].index;
        } else {
            const epCislo = parseInt(epizoda);
            const epStr = String(epCislo).padStart(2, "0");
            const seriaStr = String(seria).padStart(2, "0");

            const epRegexy = [
                new RegExp(`\\b${seria}x${epStr}\\b`, "i"),
                new RegExp(`\\b${seriaStr}x${epStr}\\b`, "i"),
                new RegExp(`S${seriaStr}[._-]?E${epStr}(?![0-9])`, "i"),
                new RegExp(`Ep(?:isode)?[._\\s]*0*${epCislo}\\b`, "i"),
                new RegExp(`\\b0*${epCislo}\\.(?:mp4|mkv|avi|m4v)$`, "i")
            ];

            for (const reg of epRegexy) {
                const zhoda = videoSubory.find(f => reg.test(f.path));
                if (zhoda) { najdenyIndex = zhoda.index; break; }
            }

            if (najdenyIndex === -1) {
                const volneRegexy = [
                    new RegExp(`\\b${seria}x0*${epCislo}\\b`, "i"),
                    new RegExp(`(^|/)[\\s._-]*0*${epCislo}[\\s._-]+.*\\.(?:mp4|mkv|avi|m4v)$`, "i")
                ];
                for (const volnyReg of volneRegexy) {
                    const zhodaVolna = videoSubory.find(f => volnyReg.test(f.path));
                    if (zhodaVolna) { najdenyIndex = zhodaVolna.index; break; }
                }
            }
        }

        if (najdenyIndex === -1) return null;
        streamObj.fileIdx = najdenyIndex;
    }

    return streamObj;
}

// ===================================================================
// Hlavný handler
// ===================================================================
builder.defineStreamHandler(async ({ type: aplikaciaTyp, id }) => {
    console.log(`\n====== 🎮 RAW Požiadavka: type z aplikacie='${aplikaciaTyp}', id='${id}' ======`);
    
    // TENTO KROK JE KLÚČOVÝ PRE NUVIO BUG:
    // Ak id obsahuje dvojbodky (napr. tt123456:1:2), JE TO SERIÁL.
    // Ignorujeme to, čo nám hovorí aplikácia (Nuvio) v type, a urobíme si vlastný.
    const jeToSerialPodlaId = id.includes(":");
    const [imdbId, sRaw, eRaw] = id.split(":");
    
    const seria = (jeToSerialPodlaId && sRaw) ? parseInt(sRaw) : undefined;
    const epizoda = (jeToSerialPodlaId && eRaw) ? parseInt(eRaw) : undefined;
    
    // Náš vlastný spoľahlivý typ
    const vlastnyTyp = jeToSerialPodlaId ? "series" : "movie";
    console.log(`[INFO] 🕵️ Zistený reálny typ z ID: ${vlastnyTyp} (Aplikácia hlásila: ${aplikaciaTyp})`);

    // Pošleme náš vlastný zistený typ do funkcií na hľadanie názvu z TMDB/Cinemeta
    const suroveNazvy = await ziskatVsetkyNazvy(imdbId, vlastnyTyp);
    if (!suroveNazvy.length) return { streams: [] };

    const zakladneNazvy = [];
    suroveNazvy.forEach(t => {
        let cistyT = t.replace(/\\(.*?\\)/g, "").replace(/TV (Mini )?Series/gi, "").trim();
        zakladneNazvy.push(cistyT);
        if (cistyT.includes(":")) zakladneNazvy.push(cistyT.split(":")[0].trim());
    });
    const unikatneNazvy = [...new Set(zakladneNazvy)];

    const dotazy = new Set();
    unikatneNazvy.forEach(zaklad => {
        const bezDia = odstranDiakritiku(zaklad);
        const kratky = skratNazov(bezDia);

        if (vlastnyTyp === "series" && seria && epizoda) {
            const epTag  = ` S${String(seria).padStart(2, "0")}E${String(epizoda).padStart(2, "0")}`;
            const epTag2 = ` ${seria}x${String(epizoda).padStart(2, "0")}`;
            const sTag1  = ` S${String(seria).padStart(2, "0")}`;
            const sTag2  = ` ${seria}.Serie`;

            [zaklad, bezDia, kratky].forEach(b => {
                if (!b.trim()) return;
                dotazy.add(b + epTag);
                dotazy.add(b + epTag2);
                dotazy.add((b + epTag).replace(/\s+/g, "."));
                dotazy.add(b + sTag1);
                dotazy.add(b + sTag2);
            });
        } else {
            [zaklad, bezDia, kratky].forEach(b => {
                if (!b.trim()) return;
                dotazy.add(b);
                dotazy.add(b.replace(/[':]/g, ""));
            });
        }
    });

    let torrenty = [];
    let pokus = 1;
    const videnieTorrentIds = new Set();

    for (const d of dotazy) { 
        console.log(`[DEBUG] 🔍 Pokus ${pokus++}: Hľadám '${d}'`);
        const najdene = await hladatTorrenty(d);
        for (const t of najdene) {
            if (!videnieTorrentIds.has(t.id)) {
                torrenty.push(t);
                videnieTorrentIds.add(t.id);
            }
        }
        if (torrenty.length >= (vlastnyTyp === "movie" ? 5 : 3)) break;
        if (pokus > 10) break;
    }

    if (seria !== undefined) {
        torrenty = torrenty.filter(t => torrentSedisSeriou(t.name, seria));
        torrenty = torrenty.filter(t => torrentSediSEpizodou(t.name, seria, epizoda));
    }

    const streamy = [];
    for (const t of torrenty) {
        await delay(300);
        const stream = await vytvoritStream(t, seria, epizoda);
        if (stream) streamy.push(stream);
    }

    console.log(`[INFO] ✅ Odosielam ${streamy.length} streamov do Stremio`);
    return { streams: streamy };
});

builder.defineCatalogHandler(() => ({ metas: [] }));

serveHTTP(builder.getInterface(), { port: 7000 });
console.log("🚀 SKTorrent addon beží na http://localhost:7000/manifest.json");
