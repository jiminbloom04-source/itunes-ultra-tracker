import axios from "axios";
import fs from "fs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getStorageFile() {
  return String(process.env.STORAGE_FILE || "./storage.json");
}

function loadStorage() {
  const file = getStorageFile();
  if (!fs.existsSync(file)) return { items: {} };
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    s.items ??= {};
    return s;
  } catch {
    return { items: {} };
  }
}

function saveStorage(store) {
  const file = getStorageFile();
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
}

function chunkMessage(msg, maxLen = 3800) {
  msg = String(msg);
  if (msg.length <= maxLen) return [msg];
  const lines = msg.split("\n");
  const out = [];
  let buf = "";
  for (const line of lines) {
    if ((buf + line + "\n").length > maxLen) {
      out.push(buf.trimEnd());
      buf = "";
    }
    buf += line + "\n";
  }
  if (buf.trim()) out.push(buf.trimEnd());
  return out;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_TOKEN;
  const chat = process.env.TELEGRAM_CHAT;
  if (!token || !chat) return;
  for (const part of chunkMessage(text)) {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chat,
      text: part,
    });
  }
}

function getTopLimit() {
  const n = Number(process.env.TOP_LIMIT || 100);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(Math.floor(n), 100);
}

function getCountries() {
  const raw = String(process.env.COUNTRIES || "").trim();
  if (!raw) throw new Error("COUNTRIES env is required.");
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function getTarget() {
  const t = String(process.env.TARGET || "JIMIN").toUpperCase();
  return ["JIMIN", "BTS", "BOTH"].includes(t) ? t : "JIMIN";
}

function matchBTS(a) {
  return (
    a.includes("bts") ||
    a.includes("bangtan") ||
    a.includes("방탄") ||
    a.includes("방탄소년단")
  );
}
function matchJimin(a) {
  return a.includes("jimin");
}

// JIMIN = solo only (exclude BTS)
function isArtistAllowed(artist, target) {
  const a = String(artist || "").toLowerCase();
  const hasJimin = matchJimin(a);
  const hasBTS = matchBTS(a);

  if (target === "JIMIN") return hasJimin && !hasBTS;
  if (target === "BTS") return hasBTS;
  return hasJimin || hasBTS;
}

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function entryLabel(topLimit) {
  return topLimit === 1 ? "#1" : `TOP ${topLimit}`;
}

function ccToFlagEmoji(cc) {
  cc = String(cc || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return "🏳️";
  const A = 0x1f1e6;
  const first = cc.charCodeAt(0) - 65;
  const second = cc.charCodeAt(1) - 65;
  return String.fromCodePoint(A + first, A + second);
}

async function fetchChart(country, type, target) {
  const url = `https://rss.marketingtools.apple.com/api/v2/${country}/music/most-played/100/${type}.json`;
  const { data } = await axios.get(url, { timeout: 30000 });
  const topLimit = getTopLimit();

  return (data?.feed?.results || [])
    .map((item, idx) => ({
      id: item.id,
      name: item.name,
      artist: item.artistName,
      rank: idx + 1,
      kind: type, // songs | albums
    }))
    .filter((x) => x.rank <= topLimit)
    .filter((x) => isArtistAllowed(x.artist, target));
}

function pushLine(bucketByCountry, country, line) {
  const cc = String(country || "").toUpperCase();
  if (!bucketByCountry[cc]) bucketByCountry[cc] = [];
  bucketByCountry[cc].push(line);
}

async function runScanCombinedMessage() {
  const store = loadStorage();
  const items = store.items;

  const target = getTarget();
  const topLimit = getTopLimit();
  const countries = getCountries();
  const throttle = Number(process.env.THROTTLE_MS || 0);

  const touched = new Set();
  const label = entryLabel(topLimit);

  const bucket = {};
  let totalEvents = 0;

  for (const country of countries) {
    if (throttle > 0) await sleep(throttle);

    let songs = [],
      albums = [];
    try {
      songs = await fetchChart(country, "songs", target);
      albums = await fetchChart(country, "albums", target);
    } catch {
      continue;
    }

    const all = [...songs, ...albums];
    if (!all.length) continue;

    for (const entry of all) {
      const key = `${country}_${entry.kind}_${entry.id}`;
      const old = items[key];
      const typeLabel = entry.kind === "songs" ? "SONG" : "ALBUM";

      touched.add(key);

      if (!old) {
        // NEW
        if (topLimit === 1) {
          pushLine(bucket, country, `🏆 NEW #1 ${typeLabel}: ${entry.name} (#1)`);
          pushLine(bucket, country, `🏆 FIRST TIME #1 ${typeLabel}: ${entry.name} (#1)`);
          totalEvents += 2;
        } else {
          pushLine(bucket, country, `🚨 NEW ${typeLabel} (${label}): ${entry.name} (#${entry.rank})`);
          totalEvents += 1;

          if (entry.rank <= 50) {
            pushLine(bucket, country, `🔥 FIRST TIME TOP 50 ${typeLabel}: ${entry.name} (#${entry.rank})`);
            totalEvents += 1;
          }
          if (entry.rank <= 10) {
            pushLine(bucket, country, `🚀 FIRST TIME TOP 10 ${typeLabel}: ${entry.name} (#${entry.rank})`);
            totalEvents += 1;
          }
        }

        items[key] = {
          rank: entry.rank,
          onChart: true,
          top50Alerted: entry.rank <= 50,
          top10Alerted: entry.rank <= 10,
        };
      } else {
        // RE-ENTRY / BACK
        if (old.onChart === false) {
          if (topLimit === 1) {
            pushLine(bucket, country, `🔁 BACK TO #1 ${typeLabel}: ${entry.name} (#1)`);
          } else {
            pushLine(bucket, country, `🔄 RE-ENTRY ${typeLabel} (${label}): ${entry.name} (#${entry.rank})`);
          }
          totalEvents += 1;
        }

        // MOVEMENT only if TOP_LIMIT > 1
        if (topLimit > 1) {
          const diff = old.rank - entry.rank;
          if (diff > 0) {
            pushLine(bucket, country, `📈 ${entry.name} UP ${diff} (now #${entry.rank})`);
            totalEvents += 1;
          } else if (diff < 0) {
            pushLine(bucket, country, `📉 ${entry.name} DOWN ${Math.abs(diff)} (now #${entry.rank})`);
            totalEvents += 1;
          }

          if (entry.rank <= 50 && !old.top50Alerted) {
            pushLine(bucket, country, `🔥 FIRST TIME TOP 50 ${typeLabel}: ${entry.name} (#${entry.rank})`);
            old.top50Alerted = true;
            totalEvents += 1;
          }
          if (entry.rank <= 10 && !old.top10Alerted) {
            pushLine(bucket, country, `🚀 FIRST TIME TOP 10 ${typeLabel}: ${entry.name} (#${entry.rank})`);
            old.top10Alerted = true;
            totalEvents += 1;
          }
        }

        old.rank = entry.rank;
        old.onChart = true;
      }
    }
  }

  // Mark off-chart if missing this run
  for (const [key, val] of Object.entries(items)) {
    if (!touched.has(key)) val.onChart = false;
  }

  store.items = items;
  saveStorage(store);

  // One combined message (only if events exist)
  if (totalEvents > 0) {
    const now = new Date();
    const stamp = now.toISOString().replace("T", " ").slice(0, 16) + " UTC";

    let msg = `🧾 iTunes Update (Hourly)\nTARGET=${target} | ${label}\n${stamp}\n`;
    msg += `Updates detected: ${totalEvents}\n`;

    const countriesSorted = Object.keys(bucket).sort();
    for (const cc of countriesSorted) {
      msg += `\n${ccToFlagEmoji(cc)} ${cc}\n`;
      for (const line of bucket[cc]) msg += `• ${line}\n`;
    }

    await sendTelegram(msg.trimEnd());
  }
}

async function runDailySummary() {
  const target = getTarget();
  const topLimit = getTopLimit();
  const countries = getCountries();
  const throttle = Number(process.env.THROTTLE_MS || 0);

  const currentByCountry = {};
  const activeCountries = [];

  for (const country of countries) {
    if (throttle > 0) await sleep(throttle);
    try {
      const songs = await fetchChart(country, "songs", target);
      const albums = await fetchChart(country, "albums", target);
      const combined = [...songs, ...albums];
      if (combined.length) {
        currentByCountry[country] = combined;
        activeCountries.push(country);
      }
    } catch {}
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const label = entryLabel(topLimit);

  // Country summary
  for (const country of activeCountries) {
    const list = currentByCountry[country]
      .slice()
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.rank - b.rank);

    let msg = `📊 iTunes Daily Summary\nTARGET=${target} | ${label}\n${ccToFlagEmoji(country)} ${country.toUpperCase()} | ${dateStr}\n`;

    msg += `\n🎵 Songs:\n`;
    const songs = list.filter((x) => x.kind === "songs");
    if (!songs.length) msg += `• (none)\n`;
    else songs.forEach((s) => (msg += `• ${s.name} (#${s.rank})\n`));

    msg += `\n💿 Albums:\n`;
    const albums = list.filter((x) => x.kind === "albums");
    if (!albums.length) msg += `• (none)\n`;
    else albums.forEach((a) => (msg += `• ${a.name} (#${a.rank})\n`));

    await sendTelegram(msg.trimEnd());
  }

  // Global aggregation
  const agg = new Map();
  for (const country of activeCountries) {
    for (const it of currentByCountry[country]) {
      const key = `${it.kind}::${normName(it.name)}`;
      if (!agg.has(key)) {
        agg.set(key, {
          name: it.name,
          kind: it.kind,
          countries: new Set([country]),
          bestRank: it.rank,
          bestCountry: country,
          sumRank: it.rank,
          count: 1,
        });
      } else {
        const a = agg.get(key);
        a.countries.add(country);
        a.sumRank += it.rank;
        a.count += 1;
        if (it.rank < a.bestRank) {
          a.bestRank = it.rank;
          a.bestCountry = country;
        }
      }
    }
  }

  if (!agg.size) {
    await sendTelegram(`🌍 Global Summary\nNo entries found for TARGET=${target} (${label}) on ${dateStr}.`);
    return;
  }

  const rows = Array.from(agg.values())
    .map((r) => ({
      ...r,
      countryCount: r.countries.size,
      avgRank: r.sumRank / r.count,
    }))
    .sort(
      (a, b) =>
        b.countryCount - a.countryCount ||
        a.bestRank - b.bestRank ||
        a.avgRank - b.avgRank
    );

  let gmsg = `🌍 iTunes Global Summary\nTARGET=${target} | ${label}\nDate: ${dateStr}\n(active countries only)\n\n`;

  for (const r of rows) {
    const kindLabel = r.kind === "songs" ? "Song" : "Album";
    gmsg += `• ${kindLabel}: ${r.name}\n`;
    gmsg += `  - Countries: ${r.countryCount} (${Array.from(r.countries)
      .map((c) => `${ccToFlagEmoji(c)} ${c.toUpperCase()}`)
      .join(", ")})\n`;
    gmsg += `  - Best rank: #${r.bestRank} (${ccToFlagEmoji(r.bestCountry)} ${r.bestCountry.toUpperCase()})\n`;
    gmsg += `  - Avg rank: #${r.avgRank.toFixed(1)}\n\n`;
  }

  await sendTelegram(gmsg.trimEnd());
}

const mode = (process.argv[2] || "scan").toLowerCase();
if (mode === "summary") await runDailySummary();
else await runScanCombinedMessage();
