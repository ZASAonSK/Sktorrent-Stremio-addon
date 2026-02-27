// SKTorrent Addon v1.3.0 + TORBOX
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const bencode = require("bncode");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const SKT_UID = process.env.SKT_UID || "";
const SKT_PASS = process.env.SKT_PASS || "";
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const TORBOX_API_KEY = process.env.TORBOX_API_KEY || ""; 

// NOVÉ VECI PRE RENDER:
const PORT = process.env.PORT || 7000; // Render si nastaví vlastný port
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`; // Pre cloud nastavíme v Renderi, inak použije lokál

const BASE_URL = "https://sktorrent.eu"; // Pre lokálny HTTP prepíš na "http://..."
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

// ===================================================================
// OPTIMALIZÁCIA: Rýchly sieťový klient (Keep-Alive) pre lokál
// ===================================================================
const agentOptions = { keepAlive: true, maxSockets: 50 };
const fastAxios = axios.create({
    timeout: 5000, 
    httpAgent: new http.Agent(agentOptions),
    httpsAgent: new https.Agent(agentOptions),
    headers: {
        "User-Agent": "Mozilla/5.0",
        "Cookie": `uid=${SKT_UID}; pass=${SKT_PASS}`,
        "Referer": BASE_URL,
        "Connection": "keep-alive"
    }
});

// ===================================================================
// CACHE a CONCURRENCY SYSTÉM
// ===================================================================
const cache = new Map();
async function withCache(key, ttlMs, fetcher) {
    const cached = cache.get(key);
    if (cached && Date.now() < cached.expires) return cached.data;
    
    const data = await fetcher();
    if (data && (!Array.isArray(data) || data.length > 0) && Object.keys(data).length !== 0) {
        cache.set(key, { data, expires: Date.now() + ttlMs });
    }
    return data;
}

function pLimit(limit) {
    let active = 0; const q = [];
    const next = () => {
        if (active >= limit || q.length === 0) return;
        active++;
        const { fn, resolve, reject } = q.shift();
        fn().then(resolve, reject).finally(() => { active--; next(); });
    };
    return (fn) => new Promise((resolve, reject) => { q.push({ fn, resolve, reject }); next(); });
}

// ===================================================================
// STREMIO ADDON DEFINÍCIA
// ===================================================================
const builder = addonBuilder({
    id: "org.stremio.sktorrent.local.torbox",
    version: "1.3.0",
    name: "SKTorrent + TorBox",
    description: "SKTorrent s TorBox",
    types: ["movie", "series"],
    catalogs: [
        { type: "movie", id: "skt-movie", name: "SKT Filmy" },
        { type: "series", id: "skt-series", name: "SKT Seriály" }
    ],
    resources: ["stream"],
    idPrefixes: ["tt"]
});

const langToFlag = {
    CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸",
    DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
    RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵"
};

function odstranDiakritiku(str) { return str.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function skratNazov(title, pocetSlov = 3) { return title.split(/\s+/).slice(0, pocetSlov).join(" "); }

// ===================================================================
// TORBOX: OVERENIE CACHE (Hromadne)
// ===================================================================
async function overitTorboxCache(infoHashes) {
    if (!TORBOX_API_KEY || infoHashes.length === 0) return {};
    
    const unikatneHashe = [...new Set(infoHashes)].map(h => h.toLowerCase());
    const hashString = unikatneHashe.sort().join(",");
    
    return withCache(`torbox:${hashString}`, 600000, async () => { // Cache na 10 min
        console.log(`[INFO] ⚡ Overujem cache na TorBoxe pre ${unikatneHashe.length} hashov...`);
        try {
            const res = await axios.get(`https://api.torbox.app/v1/api/torrents/checkcached`, {
                params: {
                    hash: unikatneHashe.join(","),
                    format: "list"
                },
                headers: {
                    "Authorization": `Bearer ${TORBOX_API_KEY}`
                },
                timeout: 5000
            });
            
            const cacheMap = {};
            // TorBox vráti dáta v res.data.data
            if (res.data && res.data.success && res.data.data) {
                const poleDat = Array.isArray(res.data.data) ? res.data.data : [res.data.data];
                poleDat.forEach(item => {
                    if (item.hash) {
                        cacheMap[item.hash.toLowerCase()] = true; 
                    }
                });
            }
            return cacheMap;
        } catch (error) {
            console.error("[ERROR] TorBox API zlyhalo:", error.message);
            return {};
        }
    });
}

// ===================================================================
// FILTRE PRE SERIÁLY (Opravené na Balíky/Packy)
// ===================================================================
function torrentSedisSeriou(nazovTorrentu, seria) {
    if (/S\d{1,2}\s*[-–]\s*S?\d{1,2}/i.test(nazovTorrentu) || /Seasons?\s*\d{1,2}\s*[-–]\s*\d{1,2}/i.test(nazovTorrentu)) return true; 
    const serieMatch = nazovTorrentu.match(/\b(\d+)\.Serie\b/i);
    if (serieMatch && parseInt(serieMatch[1]) !== seria) return false;
    const seasonMatch = nazovTorrentu.match(/\bSeason\s+(\d+)\b/i);
    if (seasonMatch && parseInt(seasonMatch[1]) !== seria) return false;
    const sMatch = nazovTorrentu.match(/\bS(\d{2})(?!E)/i);
    if (sMatch && parseInt(sMatch[1]) !== seria) return false;
    return true;
}

function torrentSediSEpizodou(nazov, seria, epizoda) {
    const seriaStr = String(seria).padStart(2, "0");
    const epStr = String(epizoda).padStart(2, "0");

    // =========================================================
    // 1. ZABIJAK NESPRÁVNYCH EPIZÓD (Najdôležitejší krok)
    // =========================================================
    // Ak je v názve explicitne iná epizóda, okamžite to zahodíme, aj keby to bol balík.
    
    // Extrahujeme všetky "E" čísla pre danú sériu (napr. z "S01E05" vyberie "05")
    const najdeneE = nazov.match(new RegExp(`S${seriaStr}[._-]?E(\\d{1,3})`, "i"));
    const najdeneX = nazov.match(new RegExp(`${seria}x(\\d{1,3})`, "i"));
    
    let toMaZluEpizodu = false;
    
    if (najdeneE && parseInt(najdeneE[1]) !== parseInt(epizoda)) {
        toMaZluEpizodu = true; // Zistil, že tam je napr. E05, a my hľadáme E02
    }
    if (najdeneX && parseInt(najdeneX[1]) !== parseInt(epizoda)) {
        toMaZluEpizodu = true; // Zistil, že tam je napr. 1x05, a my hľadáme 1x02
    }

    // Ochrana pred tým, ak by náhodou niekto zapísal rozsah ako "S01E01-E05" alebo "S01E01-05"
    // Nesmieme to zabiť, ak sa naša epizóda nachádza vnútri tohto rozsahu.
    const jeToRozsahE = nazov.match(/E(\d{1,3})[._-]?E?(\d{1,3})/i);
    if (jeToRozsahE) {
        const zaciatokE = parseInt(jeToRozsahE[1]);
        const koniecE = parseInt(jeToRozsahE[2]);
        if (epizoda >= zaciatokE && epizoda <= koniecE) {
            toMaZluEpizodu = false; // Je to rozsah a sme v ňom, ZACHRÁNIME TO!
        }
    }

    // Ak to má fakt len jednu ZLÚ epizódu (napr. S01E05), odstrelíme to okamžite tu.
    if (toMaZluEpizodu) {
        return false; 
    }



    // =========================================================
    // 2. KONTROLY, KTORÉ TO MÔŽU PUSTIŤ
    // =========================================================

    // A) Priama zhoda: Presne tá epizóda, ktorú hľadáme (S01E02)
    if (new RegExp(`S${seriaStr}[._-]?E${epStr}\\b`, "i").test(nazov)) return true;
    if (new RegExp(`\\b${seria}x${epStr}\\b`, "i").test(nazov)) return true;

    // B) Rozsah epizód: Sme vnútri rozsahu? (napr. hľadáme E02 v balíku E01-E05)
    const rozsahEpizod = nazov.match(/E(\d{1,3})[._-]?E?(\d{1,3})/i) || nazov.match(/(?:Dily?|Parts?|Epizody?|Eps?|Ep)?[._\s]*(\d{1,3})\s*[-–]\s*(\d{1,3})/i);
    if (rozsahEpizod) {
        const zaciatok = parseInt(rozsahEpizod[1] || rozsahEpizod[2]);
        const koniec = parseInt(rozsahEpizod[2] || rozsahEpizod[3]);
        if (epizoda >= zaciatok && epizoda <= koniec) return true;
    }

    // C) Obrovské balíky viacerých sérií (Napr. "S01-S08" alebo "1.-8. série")
    const rozsahSerii = nazov.match(/S(\d{1,2})\s*[-–]\s*S?(\d{1,2})/i) || 
                        nazov.match(/(?:Season|S[eé]rie)\s*(\d{1,2})\s*[-–]\s*(\d{1,2})/i) ||
                        nazov.match(/(\d{1,2})\.\s*[-–]\s*(\d{1,2})\.\s*s[eé]rie/i);
    if (rozsahSerii) {
        const zaciatokSer = parseInt(rozsahSerii[1]);
        const koniecSer = parseInt(rozsahSerii[2]);
        if (seria >= zaciatokSer && seria <= koniecSer) return true;
    }

    // D) Obyčajný balík pre jednu sériu (Nemá žiadne čísla epizód, len S01 alebo "1. série")
    const jeToCelaSeria = new RegExp(`\\b${seria}\\.\\s*s[eé]rie\\b`, "i").test(nazov) || 
                          new RegExp(`\\bSeason\\s*${seria}\\b`, "i").test(nazov) || 
                          new RegExp(`\\bS${seriaStr}\\b`, "i").test(nazov) ||
                          /\b(Pack|Komplet|Complete|Vol|Volume)\b/i.test(nazov);
                          
    if (jeToCelaSeria) {
        return true; 
    }

    // Ak nič z toho neplatí, letí to do koša
    return false;
}



// ===================================================================
// Získanie názvov (Súbežne TMDB + Cinemeta)
// ===================================================================
async function ziskatVsetkyNazvy(imdbId, vlastnyTyp) {
    return withCache(`names:${imdbId}`, 21600000, async () => { 
        const nazvy = new Set();
        const tmdbTyp = vlastnyTyp === "series" ? "tv" : "movie";
        
        const promises = [
            axios.get(`https://v3-cinemeta.strem.io/meta/${vlastnyTyp}/${imdbId}.json`, { timeout: 4000 }).catch(() => null)
        ];

        if (TMDB_API_KEY) {
            promises.push(
                axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, { params: { api_key: TMDB_API_KEY, external_source: "imdb_id" }, timeout: 4000 }).catch(() => null)
            );
        }

        const [cineRes, tmdbRes] = await Promise.all(promises);

        if (cineRes && cineRes.data?.meta) {
            const m = cineRes.data.meta;
            if (m.name) nazvy.add(decode(m.name).trim());
            if (m.original_name) nazvy.add(decode(m.original_name).trim());
            if (m.aliases) m.aliases.forEach(a => nazvy.add(decode(a).trim()));
        }

        if (tmdbRes && tmdbRes.data) {
            let tmdbId = null;
            if (vlastnyTyp === "series" && tmdbRes.data.tv_results?.length > 0) {
                tmdbId = tmdbRes.data.tv_results[0].id;
                nazvy.add(tmdbRes.data.tv_results[0].name);
            } else if (vlastnyTyp === "movie" && tmdbRes.data.movie_results?.length > 0) {
                tmdbId = tmdbRes.data.movie_results[0].id;
                nazvy.add(tmdbRes.data.movie_results[0].title);
            }

            if (tmdbId) {
                try {
                    const trans = await axios.get(`https://api.themoviedb.org/3/${tmdbTyp}/${tmdbId}/translations`, { params: { api_key: TMDB_API_KEY }, timeout: 4000 });
                    if (trans.data?.translations) {
                        trans.data.translations.forEach(tr => {
                            const m = (tr.data || {}).title || (tr.data || {}).name;
                            if (m && ["cs", "sk", "en"].includes(tr.iso_639_1)) nazvy.add(m);
                        });
                    }
                } catch (e) { /* ignore */ }
            }
        }

        if (imdbId === "tt27543632") { nazvy.add("Pomocnice"); nazvy.add("Pomocníčka"); }
        if (imdbId === "tt0903747")  { nazvy.add("Perníkový táta"); nazvy.add("Pernikovy tata"); }
        if (imdbId === "tt27497448") { nazvy.add("Rytíř sedmi království"); nazvy.add("Rytier siedmich kráľovstiev"); }

        const finalne = [...nazvy].filter(Boolean).filter(t => !t.toLowerCase().startsWith("výsledky"));
        return finalne;
    });
}

// ===================================================================
// Vyhľadávanie na Lokálnom trackeri
// ===================================================================
async function hladatTorrenty(dotaz) {
    if (!dotaz || dotaz.trim().length < 2) return [];
    
    return withCache(`search:${dotaz}`, 600000, async () => {
        try {
            const res = await fastAxios.get(SEARCH_URL, { params: { search: dotaz, category: 0 } });
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

                if (!kategoria.toLowerCase().includes("film") && !kategoria.toLowerCase().includes("seri") &&
                    !kategoria.toLowerCase().includes("dokum") && !kategoria.toLowerCase().includes("tv")) return;

                vysledky.push({
                    name: nazov, id: torrentId,
                    size: velkostMatch ? velkostMatch[1].trim() : "?",
                    seeds: seedMatch ? parseInt(seedMatch[1]) : 0,
                    category: kategoria,
                    downloadUrl: `${BASE_URL}/torrent/download.php?id=${torrentId}`
                });
            });

            return vysledky.sort((a, b) => b.seeds - a.seeds); 
        } catch (chyba) {
            return [];
        }
    });
}

// ===================================================================
// Sťahovanie a spracovanie .torrent obsahu
// ===================================================================
async function stiahnutTorrentData(url) {
    return withCache(`torrent:${url}`, 86400000, async () => { 
        try {
            const res = await fastAxios.get(url, { responseType: "arraybuffer" });
            const bufferString = res.data.toString("utf8", 0, 50);
            if (bufferString.includes("<html") || bufferString.includes("<!DOC")) return null;

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
    });
}

async function vytvoritStream(t, seria, epizoda) {
    const torrentData = await stiahnutTorrentData(t.downloadUrl);
    if (!torrentData) return null;

    const langZhody = t.name.match(/\b([A-Z]{2})\b/g) || [];
    const vlajky = langZhody.map(kod => langToFlag[kod.toUpperCase()]).filter(Boolean);
    const vlajkyText = vlajky.length ? `\n${vlajky.join(" / ")}` : "";

    let cistyNazov = t.name.replace(/^Stiahni si\s*/i, "").trim();
    if (cistyNazov.toLowerCase().startsWith(t.category.trim().toLowerCase())) {
        cistyNazov = cistyNazov.slice(t.category.length).trim();
    }

    let streamObj = {
        title: `${cistyNazov}\n👤 ${t.seeds}  📀 ${t.size}  🌐 SKTorrent${vlajkyText}`,
        // Zatiaľ nedávame do Name žiadny prefix, urobíme to až po kontrole s TorBoxom
        name: `SKT\n${t.category.toUpperCase()}`, 
        behaviorHints: { bingeGroup: cistyNazov },
        infoHash: torrentData.infoHash
    };

    if (seria !== undefined && epizoda !== undefined) {
        const videoSubory = torrentData.files
            .filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.path))
            .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));

        if (videoSubory.length === 0) return null;
        let najdenyIndex = -1;

        const epCislo = parseInt(epizoda);
        const epStr = String(epCislo).padStart(2, "0");
        const seriaStr = String(seria).padStart(2, "0");

        const epRegexy = [
            new RegExp(`\\b${seria}x${epStr}\\b`, "i"),
            new RegExp(`\\b${seriaStr}x${epStr}\\b`, "i"),
            new RegExp(`S${seriaStr}[._-]?E${epStr}(?![0-9])`, "i"),
            new RegExp(`Ep(?:isode)?[._\\s]*0*${epCislo}\\b`, "i"),
            new RegExp(`\\b0*${epCislo}\\.(?:mp4|mkv|avi|m4v)$`, "i"),
            new RegExp(`\\b${seria}x0*${epCislo}\\b`, "i"),
            new RegExp(`(^|/)[\\s._-]*0*${epCislo}[\\s._-]+.*\\.(?:mp4|mkv|avi|m4v)$`, "i")
        ];

        if (videoSubory.length === 1) {
            const nazovSuboru = videoSubory[0].path;
            
            // Extrahujeme reálne číslo epizódy zo samotného súboru vo vnútri torrentu
            const najdeneESubor = nazovSuboru.match(new RegExp(`S${seriaStr}[._-]?E(\\d{1,3})`, "i")) || 
                                  nazovSuboru.match(new RegExp(`\\b${seria}x(\\d{1,3})`, "i")) ||
                                  nazovSuboru.match(new RegExp(`Ep(?:isode)?[._\\s]*(\\d{1,3})\\b`, "i"));
            
            // Ak vo vnútri nájde, že to je napr. E05, ale my chceme E02, ZAHODÍ TO
            if (najdeneESubor && parseInt(najdeneESubor[1]) !== epCislo) {
                return null;
            }
            
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
                new RegExp(`\\b0*${epCislo}\\.(?:mp4|mkv|avi|m4v)$`, "i"),
                new RegExp(`\\b${seria}x0*${epCislo}\\b`, "i"),
                new RegExp(`(^|/)[\\s._-]*0*${epCislo}[\\s._-]+.*\\.(?:mp4|mkv|avi|m4v)$`, "i")
            ];

            for (const reg of epRegexy) {
                const zhoda = videoSubory.find(f => reg.test(f.path));
                if (zhoda) { najdenyIndex = zhoda.index; break; }
            }
        }

        if (najdenyIndex === -1) return null;
        streamObj.fileIdx = najdenyIndex;
    }

    return streamObj;
}

// ===================================================================
// HLAVNÝ HANDLER
// ===================================================================
builder.defineStreamHandler(async ({ type: aplikaciaTyp, id }) => {
    console.log(`\n====== 🎮 RAW Požiadavka: type='${aplikaciaTyp}', id='${id}' ======`);
    
    const jeToSerialPodlaId = id.includes(":");
    const [imdbId, sRaw, eRaw] = id.split(":");
    const seria = (jeToSerialPodlaId && sRaw) ? parseInt(sRaw) : undefined;
    const epizoda = (jeToSerialPodlaId && eRaw) ? parseInt(eRaw) : undefined;
    const vlastnyTyp = jeToSerialPodlaId ? "series" : "movie";

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
        const kratky = skratNazov(bezDia, 3); // Kratší názov pre väčšiu šancu na úspech

        if (vlastnyTyp === "series" && seria !== undefined && epizoda !== undefined) {
            const epTag  = ` S${String(seria).padStart(2, "0")}E${String(epizoda).padStart(2, "0")}`; // S01E03
            const epTag2 = ` ${seria}x${String(epizoda).padStart(2, "0")}`; // 1x03
            const sTag1  = ` S${String(seria).padStart(2, "0")}`; // S01
            const sTag2  = ` ${seria}.série`; // Bez medzery: "1.série"
            const sTag3  = ` ${seria}. série`; // S medzerou: "1. série"

            // 1. Hľadanie presnej epizódy (napr. S01E03)
            dotazy.add(bezDia + epTag);
            dotazy.add(zaklad + epTag);
            
            // 2. Hľadanie Špecifických CZ/SK Balíkov (napr. "1. série")
            dotazy.add(bezDia + sTag3); 
            dotazy.add(kratky + sTag3); 
            dotazy.add(bezDia + sTag2); 
            dotazy.add(kratky + sTag2); 
            
            // 3. Hľadanie štandardných balíkov (napr. "S01")
            dotazy.add(bezDia + sTag1); 
            dotazy.add(kratky + sTag1); 
            
            // 4. Hľadanie iných formátov epizódy (napr. 1x03)
            dotazy.add(bezDia + epTag2);
            dotazy.add(kratky + epTag2);

            // 5. NAJDÔLEŽITEJŠIE PRE VEĽKÉ BALÍKY (ako S01-S08):
            // Nakoniec prikážeme hľadať LEN samotný názov seriálu (napr. "Zachranari L.A.").
            // Vďaka tomu nám SKTorrent vráti tie obrovské torrenty a tvoj nový filter si v nich už nájde epizódu.
            dotazy.add(bezDia);
            dotazy.add(kratky);

        } else {
            // Toto platí pre Filmy
            [zaklad, bezDia, kratky].forEach(b => {
                if (!b.trim()) return;
                dotazy.add(b);
            });
        }
    });




    let torrenty = [];
    let pokus = 1;
    const videnieTorrentIds = new Set();

    // Hľadanie na lokálnom trackeri
    for (const d of dotazy) { 
        console.log(`[DEBUG] 🔍 Pokus ${pokus++}: Hľadám '${d}'`);
        const najdene = await hladatTorrenty(d);
        for (const t of najdene) {
            if (!videnieTorrentIds.has(t.id)) {
                torrenty.push(t);
                videnieTorrentIds.add(t.id);
            }
        }
        // !!! ZVÝŠENÝ LIMIT ABY NEPRESTALO HĽADAŤ PREDČASNE !!!
        if (torrenty.length >= 8) break; 
        if (pokus > 8) break; 
    }


    if (seria !== undefined) {
        torrenty = torrenty.filter(t => torrentSedisSeriou(t.name, seria) && torrentSediSEpizodou(t.name, seria, epizoda));
    }

    // 1. Získanie infoHash a videí (Paralelne, max 5 naraz)
    const execLimit = pLimit(5);
    let streamy = (await Promise.all(
        torrenty.map(t => execLimit(() => vytvoritStream(t, seria, epizoda)))
    )).filter(Boolean);

    // 2. TORBOX INTEGRÁCIA: Ak máme TorBox kľúč a našli sme streamy
    if (TORBOX_API_KEY && streamy.length > 0) {
        const hasheKONTROLA = streamy.map(s => s.infoHash).filter(Boolean); // Extrahujeme infoHashe
        
        // --- TENTO RIADOK TI CHÝBAL ---
        // Tu zistíme, čo reálne TorBox má alebo nemá v cache (vráti napr. { "hash1": true })
        const torboxCache = await overitTorboxCache(hasheKONTROLA);

        // Prejdeme vytvorené streamy a modifikujeme ich na HTTP/Proxy verzie
        streamy = streamy.map(stream => {
            const hash = stream.infoHash.toLowerCase();
            const indexSuboru = stream.fileIdx || 0; // Index videa v torrente
            
            // Overíme proti výsledku z TorBox API
            const jeCached = torboxCache[hash] === true;
            
            const staraKategoria = stream.name.split("\n")[1] || "";

            if (jeCached) {
                stream.name = `[TB ⚡] SKT\n${staraKategoria}`;
                const proxySeria = seria || "1";
                const proxyEpizoda = epizoda || "1";
                // ZMENA LOKALHOSTU NA PREMENNÚ
                stream.url = `${PUBLIC_URL}/play/${hash}/${proxySeria}/${proxyEpizoda}`;
                delete stream.infoHash;
                delete stream.fileIdx;
            } else {
                stream.name = `[TB ⏳] SKT\n${staraKategoria}`;
                // ZMENA LOKALHOSTU NA PREMENNÚ
                stream.url = `${PUBLIC_URL}/download/${hash}`;
                delete stream.infoHash;
                delete stream.fileIdx;
            }

            return stream;
        });

        // 3. ZORADENIE: Cached streamy chceme vidieť v Stremio prvé
        streamy.sort((a, b) => {
            const aCached = a.name.includes("⚡") ? 1 : 0;
            const bCached = b.name.includes("⚡") ? 1 : 0;
            return bCached - aCached;
        });
    }

    console.log(`[INFO] ✅ Odosielam ${streamy.length} streamov do Stremio`);
    return { streams: streamy };
});


builder.defineCatalogHandler(() => ({ metas: [] }));
// ===================================================================
// TORBOX PROXY ROUTER: Presmerovanie Stremio na TorBox HTTP Stream
// ===================================================================
const express = require("express");
const FormData = require("form-data"); // Potrebujeme na správne odoslanie do TorBoxu
const app = express();

// --- 1. Endpoint pre Cached streamy (⚡) ---
app.get("/play/:hash/:seria/:epizoda", async (req, res) => {
    const { hash, seria, epizoda } = req.params;
    
    try {
        console.log(`\n▶️ [PROXY] Stremio žiada prehratie - Hash: ${hash} | Séria: ${seria} | Epizóda: ${epizoda}`);

        // 1. Zistíme, či ho už máme na účte
        const tbTorrentsRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
            headers: { "Authorization": `Bearer ${TORBOX_API_KEY}` }
        });
        
        let torrentId = null;
        let najdenyTorrentObj = null;

        if (tbTorrentsRes.data && tbTorrentsRes.data.data) {
            const zoznam = Array.isArray(tbTorrentsRes.data.data) ? tbTorrentsRes.data.data : [tbTorrentsRes.data.data];
            najdenyTorrentObj = zoznam.find(t => t.hash && t.hash.toLowerCase() === hash.toLowerCase());
            if (najdenyTorrentObj) {
                torrentId = najdenyTorrentObj.id;
            }
        }

        // 2. Ak ho tam nemáme, pridáme ho
        if (!torrentId) {
            console.log(`[PROXY] Pridávam Cached torrent do TorBoxu...`);
            const formData = new FormData();
            formData.append("magnet", `magnet:?xt=urn:btih:${hash}`);

            const addRes = await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", formData, {
                headers: { "Authorization": `Bearer ${TORBOX_API_KEY}`, ...formData.getHeaders() }
            });
            torrentId = addRes.data?.data?.torrent_id;
            await new Promise(r => setTimeout(r, 3000));
            
            const tbRefreshRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
                headers: { "Authorization": `Bearer ${TORBOX_API_KEY}` }
            });
            if (tbRefreshRes.data && tbRefreshRes.data.data) {
                const zoznamRefresh = Array.isArray(tbRefreshRes.data.data) ? tbRefreshRes.data.data : [tbRefreshRes.data.data];
                najdenyTorrentObj = zoznamRefresh.find(t => t.id === torrentId);
            }
        }

        // 3. INTELIGENTNÉ HĽADANIE SPRÁVNEHO SÚBORU PODĽA SÉRIE A EPIZÓDY
        let spravneFileId = null;
        
        if (najdenyTorrentObj && najdenyTorrentObj.files && seria && epizoda) {
            const epCislo = parseInt(epizoda);
            const epStr = String(epCislo).padStart(2, "0");
            const seriaStr = String(seria).padStart(2, "0");

            // Rôzne spôsoby, akými môže byť súbor pomenovaný
            const epRegexy = [
                new RegExp(`\\b${seria}x${epStr}\\b`, "i"), // napr. 1x21
                new RegExp(`\\b${seriaStr}x${epStr}\\b`, "i"), // napr. 01x21
                new RegExp(`S${seriaStr}[._-]?E${epStr}(?![0-9])`, "i"), // napr. S01E21
                new RegExp(`Ep(?:isode)?[._\\s]*0*${epCislo}\\b`, "i"), // napr. Ep21
                new RegExp(`\\b0*${epCislo}\\.(?:mp4|mkv|avi|m4v)$`, "i") // napr. 21.mp4
            ];

            // Nájdeme len video súbory
            const videoSúbory = najdenyTorrentObj.files.filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.name));

            for (const reg of epRegexy) {
                const zhoda = videoSúbory.find(f => reg.test(f.name));
                if (zhoda) { 
                    spravneFileId = zhoda.id; 
                    console.log(`👉 [PROXY MATCH] Našiel som súbor! ID: ${spravneFileId} | Názov: ${zhoda.name}`);
                    break; 
                }
            }
            
            // Ak nenájde konkrétnu zhodu, zoberie najväčší súbor (najmä pre filmy to pomáha)
            if (spravneFileId === null && videoSúbory.length > 0) {
                videoSúbory.sort((a, b) => b.size - a.size);
                spravneFileId = videoSúbory[0].id;
                console.log(`⚠️ [PROXY MATCH] Nenašiel som zhodu pre S${seriaStr}E${epStr}. Vyberám najväčší súbor: ${videoSúbory[0].name}`);
            }
        }

        // Ak to z nejakého dôvodu stále nemá ID, fallback na "0"
        if (spravneFileId === null) spravneFileId = 0;

        // 4. Požiadame TorBox o linku pre správny súbor
        const downloadRes = await axios.get("https://api.torbox.app/v1/api/torrents/requestdl", {
            params: {
                token: TORBOX_API_KEY,
                torrent_id: torrentId,
                file_id: spravneFileId, // TU ODOVZDÁVAME TORBOXOVÉ ID
                zip_link: false
            },
            headers: { "Authorization": `Bearer ${TORBOX_API_KEY}` }
        });

        const directLink = downloadRes.data?.data;
        
        if (directLink) {
            res.redirect(302, directLink);
        } else {
            res.status(404).send("Torbox nevrátil URL.");
        }
    } catch (err) {
        console.error("[ERROR] Play zlyhalo:", err.response?.data || err.message);
        res.status(500).send("Chyba proxy servera.");
    }
});



// --- 2. Endpoint pre Uncached streamy (⌛) ---
app.get("/download/:hash", async (req, res) => {
    const { hash } = req.params;
    
    try {
        console.log(`[INFO] Sťahujem Uncached torrent do TorBoxu (Hash: ${hash})`);
        
        const formData = new FormData();
        formData.append("magnet", `magnet:?xt=urn:btih:${hash}`);

        await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", formData, {
            headers: { 
                "Authorization": `Bearer ${TORBOX_API_KEY}`,
                ...formData.getHeaders()
            }
        });

        console.log(`[INFO] TorBox úspešne začal sťahovanie!`);

        // ZNEPLATNENIE LOKÁLNEJ CACHE!
        // Akonáhle začne sťahovanie, prejdeme celú našu cache pamäť
        for (const [key, value] of cache.entries()) {
            // Ak ide o TorBox cache a obsahuje hash, ktorý práve sťahujeme
            if (key.startsWith("torbox:") && key.includes(hash.toLowerCase())) {
                cache.delete(key); // Vymažeme ho
                console.log(`[INFO] 🧹 Zmazal som starú TorBox cache pre tento hash. Pri ďalšom načítaní sa skontroluje naostro!`);
            }
        }

        // Presmerujeme Stremio na server
        res.redirect(302, `${PUBLIC_URL}/info-video`);
        
    } catch (err) {
        console.error("[ERROR] Zlyhalo stahovanie do TorBoxu:", err.response?.data || err.message);
        res.status(500).send("Chyba API.");
    }
});

// --- NOVÝ ENDPOINT PRE LOKÁLNE VIDEO ---
const path = require("path");

app.get("/info-video", (req, res) => {
    // Pošle Stremio klientovi súbor "stahuje-sa.mp4", ktorý máš uložený vedľa addonu
    res.sendFile(path.join(__dirname, "stahuje-sa.mp4")); 
});


// Prepojíme tvoj Stremio builder s našim Express proxy serverom
const { getRouter } = require("stremio-addon-sdk");
app.use("/", getRouter(builder.getInterface()));

app.listen(PORT, () => {
    console.log(`🚀 SKTorrent + TorBox PROXY beží na ${PUBLIC_URL}/manifest.json`);
});




