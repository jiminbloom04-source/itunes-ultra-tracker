import axios from "axios";
import fs from "fs";

const STORAGE_FILE = "./storage.json";

const ALL_COUNTRIES = [
"ae","ag","ai","al","am","ao","ar","at","au","az","ba","bb","be","bf","bg","bh","bj","bm","bn","bo","br","bs","bt","bw","by","bz",
"ca","cd","cg","ch","ci","cl","cm","cn","co","cr","cv","cy","cz","de","dk","dm","do","dz","ec","ee","eg","es","fi","fj","fr",
"ga","gb","gd","ge","gh","gm","gr","gt","gw","hk","hn","hr","hu","id","ie","il","in","is","it","jm","jo","jp","ke","kg","kh","kn",
"kr","kw","ky","kz","la","lb","lc","lk","lr","lt","lu","lv","ma","md","me","mg","mk","ml","mn","mo","mr","ms","mt","mu","mv","mw",
"mx","my","mz","na","ne","ng","ni","nl","no","np","nz","om","pa","pe","pg","ph","pk","pl","pt","py","qa","ro","rs","ru","rw","sa",
"sb","sc","se","sg","si","sk","sl","sn","sr","st","sv","sz","tc","td","th","tj","tm","tn","tr","tt","tw","tz","ua","ug","us","uy",
"uz","vc","ve","vg","vn","ye","za","zm","zw"
];

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function loadStorage(){
  if(!fs.existsSync(STORAGE_FILE)) return { items:{}, bot:{offset:0}, config:{target:null} };
  try{
    const s = JSON.parse(fs.readFileSync(STORAGE_FILE,"utf8"));
    s.items ??= {};
    s.bot ??= { offset: 0 };
    s.config ??= { target: null };
    return s;
  }catch{
    return { items:{}, bot:{offset:0}, config:{target:null} };
  }
}

function saveStorage(store){
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(store,null,2));
}

function chunkMessage(msg, maxLen=3800){
  msg = String(msg);
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
  if(buf.trim()) out.push(buf.trimEnd());
  return out;
}

async function sendTelegram(text){
  const token = process.env.TELEGRAM_TOKEN;
  const chat = process.env.TELEGRAM_CHAT;
  if(!token || !chat) return;

  for(const part of chunkMessage(text)){
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chat,
      text: part
    });
  }
}

function getTopLimit(){
  const n = Number(process.env.TOP_LIMIT || 50);
  if(!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), 100);
}

function getCountries(){
  const raw = String(process.env.COUNTRIES || "ALL").trim();
  if(raw.toUpperCase() === "ALL") return ALL_COUNTRIES;
  return raw.split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
}

function getTarget(){
  const t = String(process.env.TARGET || "BOTH").toUpperCase();
  return ["JIMIN","BTS","BOTH"].includes(t) ? t : "BOTH";
}

function matchBTS(a){
  return a.includes("bts") || a.includes("bangtan") || a.includes("방탄") || a.includes("방탄소년단");
}
function matchJimin(a){
  return a.includes("jimin");
}

function isArtistAllowed(artist, target){
  const a = String(artist||"").toLowerCase();
  const hasJimin = matchJimin(a);
  const hasBTS = matchBTS(a);

  if(target === "JIMIN") return hasJimin && !hasBTS;
  if(target === "BTS") return hasBTS;
  return hasJimin || hasBTS; // BOTH
}

function normName(s){
  return String(s||"")
    .toLowerCase()
    .replace(/\(.*?\)/g," ")
    .replace(/[^a-z0-9]+/g," ")
    .replace(/\s+/g," ")
    .trim();
}

async function fetchChart(country, type, target){
  const url = `https://rss.marketingtools.apple.com/api/v2/${country}/music/most-played/100/${type}.json`;
  const { data } = await axios.get(url, { timeout: 30000 });
  const topLimit = getTopLimit();

  return (data?.feed?.results || [])
    .map((item, idx)=>({
      id: item.id,
      name: item.name,
      artist: item.artistName,
      rank: idx+1,
      kind: type
    }))
    .filter(x=>x.rank <= topLimit)
    .filter(x=>isArtistAllowed(x.artist, target));
}

async function runScan(){
  const store = loadStorage();
  const items = store.items;

  const target = getTarget();
  const topLimit = getTopLimit();
  const countries = getCountries();
  const throttle = Number(process.env.THROTTLE_MS || 0);

  const touched = new Set();

  for(const country of countries){
    if(throttle>0) await sleep(throttle);

    let songs=[], albums=[];
    try{
      songs = await fetchChart(country,"songs",target);
      albums = await fetchChart(country,"albums",target);
    }catch{
      continue;
    }

    const all = [...songs,...albums];
    if(!all.length) continue; // hanya negara yg ada entry TOP_LIMIT

    for(const entry of all){
      const key = `${country}_${entry.kind}_${entry.id}`;
      const old = items[key];
      const label = entry.kind === "songs" ? "SONG" : "ALBUM";

      touched.add(key);

      if(!old){
        await sendTelegram(`🚨 NEW ${label} (TOP ${topLimit}) (${country.toUpperCase()}): ${entry.name} (#${entry.rank})`);
        items[key] = {
          rank: entry.rank,
          top50Alerted: entry.rank <= 50,
          top10Alerted: entry.rank <= 10,
          onChart: true
        };

        if(entry.rank <= 50) await sendTelegram(`🔥 FIRST TIME TOP 50 ${label} (${country.toUpperCase()}): ${entry.name} (#${entry.rank})`);
        if(entry.rank <= 10) await sendTelegram(`🚀 FIRST TIME TOP 10 ${label} (${country.toUpperCase()}): ${entry.name} (#${entry.rank})`);
      }else{
        if(old.onChart === false){
          await sendTelegram(`🔄 RE-ENTRY ${label} (TOP ${topLimit}) (${country.toUpperCase()}): ${entry.name} (#${entry.rank})`);
        }

        const diff = old.rank - entry.rank;
        if(diff>0) await sendTelegram(`📈 ${country.toUpperCase()} ${entry.name} naik ${diff} (#${entry.rank})`);
        else if(diff<0) await sendTelegram(`📉 ${country.toUpperCase()} ${entry.name} turun ${Math.abs(diff)} (#${entry.rank})`);

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
      }
    }
  }

  // kalau item sebelumnya tidak ketemu di scan ini => off chart (out of TOP_LIMIT)
  for(const [key, val] of Object.entries(items)){
    if(!touched.has(key)){
      val.onChart = false;
    }
  }

  store.items = items;
  saveStorage(store);
}

async function runDailySummary(){
  const target = getTarget();
  const topLimit = getTopLimit();
  const countries = getCountries();
  const throttle = Number(process.env.THROTTLE_MS || 0);

  const currentByCountry = {};
  const activeCountries = [];

  for(const country of countries){
    if(throttle>0) await sleep(throttle);
    try{
      const songs = await fetchChart(country,"songs",target);
      const albums = await fetchChart(country,"albums",target);
      const combined = [...songs,...albums];
      if(combined.length){
        currentByCountry[country] = combined;
        activeCountries.push(country);
      }
    }catch{}
  }

  const dateStr = new Date().toLocaleDateString();

  // summary per negara (hanya yg aktif)
  for(const country of activeCountries){
    const list = currentByCountry[country].slice().sort((a,b)=>(a.kind.localeCompare(b.kind)||a.rank-b.rank));
    let msg = `📊 iTunes Summary (TARGET=${target}, TOP ${topLimit}) (${country.toUpperCase()}) — ${dateStr}\n`;

    msg += "\n🎵 Songs:\n";
    const songs = list.filter(x=>x.kind==="songs");
    if(!songs.length) msg += "• (none)\n";
    else songs.forEach(s=> msg += `• ${s.name} (#${s.rank})\n`);

    msg += "\n💿 Albums:\n";
    const albums = list.filter(x=>x.kind==="albums");
    if(!albums.length) msg += "• (none)\n";
    else albums.forEach(a=> msg += `• ${a.name} (#${a.rank})\n`);

    await sendTelegram(msg.trimEnd());
  }

  // global ranking agregasi (hanya negara aktif)
  const agg = new Map();
  for(const country of activeCountries){
    for(const it of currentByCountry[country]){
      const key = `${it.kind}::${normName(it.name)}`;
      if(!agg.has(key)){
        agg.set(key, { name: it.name, kind: it.kind, countries:new Set([country]), bestRank:it.rank, bestCountry:country, sumRank:it.rank, count:1 });
      }else{
        const a = agg.get(key);
        a.countries.add(country);
        a.sumRank += it.rank;
        a.count += 1;
        if(it.rank < a.bestRank){
          a.bestRank = it.rank;
          a.bestCountry = country;
        }
      }
    }
  }

  if(!agg.size){
    await sendTelegram(`🌍 iTunes Global Ranking — ${dateStr}\nNo entries found for TARGET=${target} in TOP ${topLimit}.`);
    return;
  }

  const rows = Array.from(agg.values()).map(r=>({
    ...r,
    countryCount: r.countries.size,
    avgRank: r.sumRank / r.count
  })).sort((a,b)=>(b.countryCount-a.countryCount)||(a.bestRank-b.bestRank)||(a.avgRank-b.avgRank));

  let gmsg = `🌍 iTunes Global Ranking (TARGET=${target}, TOP ${topLimit}) — ${dateStr}\n(active countries only)\n\n`;
  for(const r of rows){
    const kindLabel = r.kind==="songs" ? "Song" : "Album";
    gmsg += `• ${kindLabel}: ${r.name}\n`;
    gmsg += `  - Countries: ${r.countryCount} (${Array.from(r.countries).map(c=>c.toUpperCase()).join(", ")})\n`;
    gmsg += `  - Best rank: #${r.bestRank} (${r.bestCountry.toUpperCase()})\n`;
    gmsg += `  - Avg rank: #${r.avgRank.toFixed(1)}\n`;
  }
  await sendTelegram(gmsg.trimEnd());
}

const mode = (process.argv[2] || "scan").toLowerCase();
if(mode === "summary") await runDailySummary();
else await runScan();
