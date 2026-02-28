import axios from "axios";
import cron from "node-cron";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const STORAGE_FILE = "./storage.json";

const ALL_COUNTRIES = [
"ae","ag","ai","al","am","ao","ar","at","au","az",
"ba","bb","be","bf","bg","bh","bj","bm","bn","bo","br","bs","bt","bw","by","bz",
"ca","cd","cg","ch","ci","cl","cm","cn","co","cr","cv","cy","cz",
"de","dk","dm","do","dz",
"ec","ee","eg","es","fi","fj","fr",
"ga","gb","gd","ge","gh","gm","gr","gt","gw",
"hk","hn","hr","hu",
"id","ie","il","in","is","it","jm","jo","jp",
"ke","kg","kh","kn","kr","kw","ky","kz",
"la","lb","lc","lk","lr","lt","lu","lv",
"ma","md","me","mg","mk","ml","mn","mo","mr","ms","mt","mu","mv","mw","mx","my","mz",
"na","ne","ng","ni","nl","no","np","nz",
"om",
"pa","pe","pg","ph","pk","pl","pt","py",
"qa",
"ro","rs","ru","rw",
"sa","sb","sc","se","sg","si","sk","sl","sn","sr","st","sv","sz",
"tc","td","th","tj","tm","tn","tr","tt","tw","tz",
"ua","ug","us","uy","uz",
"vc","ve","vg","vn",
"ye","za","zm","zw"
];

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function loadStorage(){
  if(!fs.existsSync(STORAGE_FILE)) return { items: {}, bot: { offset: 0 }, config: { target: null } };
  try{
    const parsed = JSON.parse(fs.readFileSync(STORAGE_FILE, "utf8"));
    parsed.items ??= {};
    parsed.bot ??= { offset: 0 };
    parsed.config ??= { target: null };
    return parsed;
  }catch{
    return { items: {}, bot: { offset: 0 }, config: { target: null } };
  }
}

function saveStorage(data){
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
}

function getTopLimit(){
  const n = Number(process.env.TOP_LIMIT || 50);
  if(!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), 100);
}

function getCountries(){
  const raw = String(process.env.COUNTRIES || "ALL").trim();
  if(raw.toUpperCase() === "ALL") return ALL_COUNTRIES;
  return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function getTarget(store){
  // Priority: runtime (Telegram commands) -> env TARGET -> default BOTH
  const runtime = store?.config?.target;
  if(runtime && ["JIMIN","BTS","BOTH"].includes(runtime)) return runtime;
  const envT = String(process.env.TARGET || "BOTH").toUpperCase();
  if(["JIMIN","BTS","BOTH"].includes(envT)) return envT;
  return "BOTH";
}

function matchJimin(artistLower){
  // "Jimin" solo; if artist string includes BTS keywords, it's treated as BTS context
  return artistLower.includes("jimin");
}

function matchBTS(artistLower){
  return (
    artistLower.includes("bts") ||
    artistLower.includes("bangtan") ||
    artistLower.includes("방탄") ||
    artistLower.includes("방탄소년단")
  );
}

function isArtistAllowed(artist, target){
  const a = String(artist || "").toLowerCase();
  const hasJimin = matchJimin(a);
  const hasBTS = matchBTS(a);

  if(target === "JIMIN"){
    // Strict Jimin: include Jimin but exclude BTS
    return hasJimin && !hasBTS;
  }
  if(target === "BTS"){
    // Strict BTS: include BTS; exclude solo Jimin entries unless explicitly BTS
    return hasBTS;
  }
  // BOTH
  return hasJimin || hasBTS;
}

/** Telegram sending (chunked) */
async function sendTelegram(text){
  if(!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT) return;
  const parts = chunkMessage(String(text), 3800);
  for(const part of parts){
    try{
      await axios.post(
        `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
        { chat_id: process.env.TELEGRAM_CHAT, text: part }
      );
    }catch(e){
      console.log("Telegram send error:", e?.response?.data?.description || e.message);
      break;
    }
  }
}

function chunkMessage(msg, maxLen){
  if(msg.length <= maxLen) return [msg];
  const lines = msg.split("\n");
  const out = [];
  let buf = "";
  for(const line of lines){
    if((buf + line + "\n").length > maxLen){
      out.push(buf.trimEnd());
      buf = "";
    }
    buf += line + "\n";
  }
  if(buf.trim().length) out.push(buf.trimEnd());
  return out;
}

/** Telegram command polling */
async function pollTelegramCommands(){
  if(!process.env.TELEGRAM_TOKEN) return;

  const store = loadStorage();
  const offset = Number(store?.bot?.offset || 0);

  try{
    const { data } = await axios.get(
      `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getUpdates`,
      { params: { offset: offset ? offset + 1 : 0, timeout: 0 }, timeout: 30000 }
    );

    const updates = data?.result || [];
    if(!updates.length) return;

    for(const upd of updates){
      store.bot.offset = upd.update_id;

      const msg = upd.message || upd.edited_message;
      const chatId = msg?.chat?.id;
      const text = (msg?.text || "").trim();

      // Only accept commands from your configured chat (if set)
      if(process.env.TELEGRAM_CHAT && String(chatId) !== String(process.env.TELEGRAM_CHAT)) continue;
      if(!text.startsWith("/")) continue;

      const cmd = text.split(/\s+/)[0].toLowerCase();

      if(cmd === "/jimin"){
        store.config.target = "JIMIN";
        await sendTelegram("✅ Mode set: JIMIN only (exclude BTS).");
      } else if(cmd === "/bts"){
        store.config.target = "BTS";
        await sendTelegram("✅ Mode set: BTS only.");
      } else if(cmd === "/both" || cmd === "/all"){
        store.config.target = "BOTH";
        await sendTelegram("✅ Mode set: BOTH (Jimin + BTS).");
      } else if(cmd === "/status"){
        const t = getTarget(store);
        await sendTelegram(`📌 Status\n- TARGET: ${t}\n- COUNTRIES: ${process.env.COUNTRIES || "ALL"}\n- TOP_LIMIT: ${process.env.TOP_LIMIT || "50"}\n- THROTTLE_MS: ${process.env.THROTTLE_MS || "0"}`);
      } else if(cmd === "/help" || cmd === "/start"){
        await sendTelegram(
`🤖 Commands:
/jimin  -> track Jimin solo only
/bts    -> track BTS only
/both   -> track Jimin + BTS
/status -> show current settings
`
        );
      }
    }

    saveStorage(store);
  }catch(e){
    console.log("Telegram poll error:", e?.response?.data?.description || e.message);
  }
}

/** iTunes RSS fetch (Top 100), then filter to TOP_LIMIT and target */
async function fetchChart(country, type, target){
  const url = `https://rss.marketingtools.apple.com/api/v2/${country}/music/most-played/100/${type}.json`;
  const { data } = await axios.get(url, { timeout: 30000 });

  const topLimit = getTopLimit();

  return (data?.feed?.results || [])
    .map((item, index) => ({
      id: item.id,
      name: item.name,
      artist: item.artistName,
      rank: index + 1,
      kind: type // songs | albums
    }))
    .filter(item => item.rank <= topLimit)
    .filter(item => isArtistAllowed(item.artist, target));
}

function nowISO(){ return new Date().toISOString(); }
function todayLabel(){ return new Date().toLocaleDateString(); }

function normName(s){
  return String(s||"")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Core scan (Top N only, active countries only) */
async function runCheck(){
  try{
    const store = loadStorage();
    const target = getTarget(store);
    const topLimit = getTopLimit();

    console.log("=================================");
    console.log(`Scanning v2.6 (TARGET=${target}, TOP ${topLimit}):`, new Date().toLocaleString());

    const items = store.items;
    const countries = getCountries();
    const throttle = Number(process.env.THROTTLE_MS || 0);

    const touchedThisScan = new Set();

    for(const country of countries){
      if(throttle > 0) await sleep(throttle);

      let songs = [];
      let albums = [];
      try{
        songs = await fetchChart(country, "songs", target);
        albums = await fetchChart(country, "albums", target);
      }catch(e){
        continue;
      }

      const all = [...songs, ...albums];
      if(!all.length) continue; // active only

      for(const entry of all){
        const key = `${country}_${entry.kind}_${entry.id}`;
        const old = items[key];
        const label = entry.kind === "songs" ? "SONG" : "ALBUM";

        touchedThisScan.add(key);

        if(!old){
          await sendTelegram(`🚨 NEW ${label} (TOP ${topLimit}) (${country.toUpperCase()}): ${entry.name} (#${entry.rank})`);
          items[key] = {
            rank: entry.rank,
            firstSeen: nowISO(),
            top50Alerted: entry.rank <= 50,
            top10Alerted: entry.rank <= 10,
            onChart: true,
            lastSeen: nowISO()
          };

          if(entry.rank <= 50) await sendTelegram(`🔥 FIRST TIME TOP 50 ${label} (${country.toUpperCase()}): ${entry.name} (#${entry.rank})`);
          if(entry.rank <= 10) await sendTelegram(`🚀 FIRST TIME TOP 10 ${label} (${country.toUpperCase()}): ${entry.name} (#${entry.rank})`);
        }else{
          if(old.onChart === false){
            await sendTelegram(`🔄 RE-ENTRY ${label} (TOP ${topLimit}) (${country.toUpperCase()}): ${entry.name} (#${entry.rank})`);
          }

          const diff = old.rank - entry.rank;
          if(diff > 0) await sendTelegram(`📈 ${country.toUpperCase()} ${entry.name} naik ${diff} (#${entry.rank})`);
          else if(diff < 0) await sendTelegram(`📉 ${country.toUpperCase()} ${entry.name} turun ${Math.abs(diff)} (#${entry.rank})`);

          if(entry.rank <= 50 && !old.top50Alerted){
            await sendTelegram(`🔥 FIRST TIME TOP 50 ${label} (${country.toUpperCase()}): ${entry.name} (#${entry.rank})`);
            old.top50Alerted = true;
          }
          if(entry.rank <= 10 && !old.top10Alerted){
            await sendTelegram(`🚀 FIRST TIME TOP 10 ${label} (${country.toUpperCase()}): ${entry.name} (#${entry.rank})`);
            old.top10Alerted = true;
          }

          old.rank = entry.rank;
          old.onChart = true;
          old.lastSeen = nowISO();
        }
      }
    }

    // mark off-chart for tracked items not seen in this scan
    for(const [key, val] of Object.entries(items)){
      if(!touchedThisScan.has(key)){
        // only for keys that belong to currently scanned countries
        const isTrackedCountry = countries.some(c => key.startsWith(c + "_"));
        if(isTrackedCountry) val.onChart = false;
      }
    }

    saveStorage(store);

    console.log("Scan done.");
    console.log("=================================\n");
  }catch(e){
    console.log("runCheck error:", e?.response?.data?.error?.message || e.message);
  }
}

/** Daily summaries + global ranking (active countries only) */
async function sendDailySummaries(){
  try{
    const store = loadStorage();
    const target = getTarget(store);
    const topLimit = getTopLimit();

    const countries = getCountries();
    const throttle = Number(process.env.THROTTLE_MS || 0);

    const currentByCountry = {};
    const activeCountries = [];

    for(const country of countries){
      if(throttle > 0) await sleep(throttle);
      try{
        const songs = await fetchChart(country, "songs", target);
        const albums = await fetchChart(country, "albums", target);
        const combined = [...songs, ...albums];
        if(combined.length){
          currentByCountry[country] = combined;
          activeCountries.push(country);
        }
      }catch{
        continue;
      }
    }

    const dateStr = todayLabel();

    // per-country
    for(const country of activeCountries){
      const list = currentByCountry[country] || [];
      list.sort((a,b) => (a.kind.localeCompare(b.kind) || a.rank - b.rank));

      let msg = `📊 iTunes Summary (TARGET=${target}, TOP ${topLimit}) (${country.toUpperCase()}) — ${dateStr}\n`;
      msg += "\n🎵 Songs:\n";
      const songs = list.filter(x => x.kind === "songs");
      if(!songs.length) msg += "• (none)\n"; else songs.forEach(s => msg += `• ${s.name} (#${s.rank})\n`);

      msg += "\n💿 Albums:\n";
      const albums = list.filter(x => x.kind === "albums");
      if(!albums.length) msg += "• (none)\n"; else albums.forEach(a => msg += `• ${a.name} (#${a.rank})\n`);

      await sendTelegram(msg.trimEnd());
    }

    // global ranking
    const agg = new Map();
    for(const country of activeCountries){
      for(const it of (currentByCountry[country] || [])){
        const key = `${it.kind}::${normName(it.name)}`;
        if(!agg.has(key)){
          agg.set(key, {
            name: it.name,
            kind: it.kind,
            countries: new Set(),
            bestRank: it.rank,
            bestCountry: country,
            sumRank: it.rank,
            count: 1
          });
        }else{
          const a = agg.get(key);
          a.sumRank += it.rank;
          a.count += 1;
          if(it.rank < a.bestRank){
            a.bestRank = it.rank;
            a.bestCountry = country;
          }
        }
        agg.get(key).countries.add(country);
      }
    }

    if(agg.size){
      const rows = Array.from(agg.values()).map(r => ({
        ...r,
        countryCount: r.countries.size,
        avgRank: r.sumRank / r.count
      })).sort((a,b) =>
        (b.countryCount - a.countryCount) ||
        (a.bestRank - b.bestRank) ||
        (a.avgRank - b.avgRank)
      );

      let gmsg = `🌍 iTunes Global Ranking (TARGET=${target}, TOP ${topLimit}) — ${dateStr}\n`;
      gmsg += "(active countries only)\n\n";
      for(const r of rows){
        const kindLabel = r.kind === "songs" ? "Song" : "Album";
        gmsg += `• ${kindLabel}: ${r.name}\n`;
        gmsg += `  - Countries: ${r.countryCount} (${Array.from(r.countries).map(c=>c.toUpperCase()).join(", ")})\n`;
        gmsg += `  - Best rank: #${r.bestRank} (${r.bestCountry.toUpperCase()})\n`;
        gmsg += `  - Avg rank: #${r.avgRank.toFixed(1)}\n`;
      }
      await sendTelegram(gmsg.trimEnd());
    }else{
      await sendTelegram(`🌍 iTunes Global Ranking — ${dateStr}\nNo entries found for TARGET=${target} in TOP ${topLimit}.`);
    }
  }catch(e){
    console.log("daily summary error:", e?.response?.data?.error?.message || e.message);
  }
}

/** Cron */
cron.schedule("0 * * * *", async () => { await runCheck(); });
cron.schedule("59 23 * * *", async () => { await sendDailySummaries(); });

// Poll telegram commands every minute
cron.schedule("* * * * *", async () => { await pollTelegramCommands(); });

console.log("ITUNES ULTRA TRACKER v2.6 STARTED");
console.log("Send /help to your bot for commands.");
runCheck();
