import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import pg from "pg";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const app = express();
const PORT = process.env.PORT || 3001;

const onlineUsers = new Map();

const FLAP_GQL = "https://bnb.taxed.fun";
const IPFS_GATEWAY = "https://flap.mypinata.cloud/ipfs/";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let cachedTokens = [];
let lastFetchTime = 0;
const CACHE_TTL = 10000;

let cachedNewTokens = [];
let cachedBondingTokens = [];

// Persistent accumulator: address -> token object for ALL graduated tokens ever seen
// across any boardV2 section. Survives individual API polling gaps.
const graduatedCache = new Map();

const knownNewlyCreated = new Set();
const newlyDetectedTimestamps = new Map();
let isFirstFetch = true;

// Tracks tokens seen in the "graduating" section so we can later check if they
// disappeared because they graduated (as opposed to just falling out of the list).
// address -> { coin raw data, firstSeenAt ms }
const graduationWatchList = new Map();

// Every address ever seen from any Flap.sh boardV2 section.
// Used to directly check DexScreener for graduation status on known tokens.
const allKnownFlapAddresses = new Map(); // address -> raw coin data (last seen)

let bnbPrice = 600;
let lastPriceFetch = 0;

// BSC on-chain graduation detection via PancakeSwap V2 factory PairCreated events
const BSC_RPC = 'https://bsc.publicnode.com';
const PANCAKE_V2_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const PAIR_CREATED_TOPIC = '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';
const BSC_BLOCKS_PER_DAY = 28800; // ~3 sec/block
let lastCheckedBlock = 0; // 0 = not initialized yet

// Flap.sh uses a factory pattern where all token addresses end in 7777 or 8888
const isFlapAddress = addr => addr.endsWith('7777') || addr.endsWith('8888');

const dexCache = new Map();
const DEX_CACHE_TTL = 120000;
const dexPaidDetectedAtMap = new Map();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  const runSafe = async (label, fn) => {
    try { await fn(); } catch (e) {
      if (e.message && e.message.includes('must be owner')) return;
      console.error(`DB init (${label}):`, e.message);
    }
  };
  await runSafe('site_settings', () => pool.query(`
    CREATE TABLE IF NOT EXISTS site_settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `));
  await runSafe('seed settings', () => pool.query(`
    INSERT INTO site_settings (key, value) VALUES 
      ('ca_address', '0x000000000000000000000000'),
      ('telegram', 'https://t.me/BubbleFlap'),
      ('twitter', 'https://x.com/BubbleFlapFun'),
      ('github', 'https://github.com/bubbleflap'),
      ('email', 'dev@bubbleflap.fun'),
      ('bflap_link', 'https://flap.sh/bnb/0x'),
      ('flapsh_link', 'https://flap.sh/bnb/board')
    ON CONFLICT (key) DO NOTHING
  `));
  await runSafe('site_visitors', () => pool.query(`
    CREATE TABLE IF NOT EXISTS site_visitors (
      id SERIAL PRIMARY KEY,
      visitor_id VARCHAR(100) NOT NULL,
      ip_hash VARCHAR(100) NOT NULL,
      page VARCHAR(200) NOT NULL DEFAULT '/',
      user_agent TEXT,
      referrer TEXT,
      country VARCHAR(10) DEFAULT NULL,
      last_seen TIMESTAMP NOT NULL DEFAULT now(),
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `));
  await runSafe('idx visitor_id', () => pool.query(`CREATE INDEX IF NOT EXISTS idx_site_visitors_visitor_id ON site_visitors (visitor_id)`));
  await runSafe('idx ip_hash', () => pool.query(`CREATE INDEX IF NOT EXISTS idx_site_visitors_ip_hash ON site_visitors (ip_hash)`));
  await runSafe('idx last_seen', () => pool.query(`CREATE INDEX IF NOT EXISTS idx_site_visitors_last_seen ON site_visitors (last_seen)`));
  await runSafe('idx created_at', () => pool.query(`CREATE INDEX IF NOT EXISTS idx_site_visitors_created_at ON site_visitors (created_at)`));
  await runSafe('idx country', () => pool.query(`CREATE INDEX IF NOT EXISTS idx_site_visitors_country ON site_visitors (country)`));
}
initDb();

function hashIp(ip) {
  return crypto.createHash("sha256").update(ip + "bubbleflap-salt").digest("hex").substring(0, 16);
}

async function getCountryFromIp(ip) {
  try {
    if (ip === "127.0.0.1" || ip === "::1" || ip.startsWith("192.168.") || ip.startsWith("10.")) return null;
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode`);
    if (res.ok) {
      const data = await res.json();
      return data.countryCode || null;
    }
  } catch {}
  return null;
}

async function fetchBnbPrice() {
  const now = Date.now();
  if (now - lastPriceFetch < 60000) return bnbPrice;
  try {
    const res = await fetch("https://api.binance.com/api/v3/avgPrice?symbol=BNBUSDT");
    if (res.ok) {
      const data = await res.json();
      bnbPrice = parseFloat(data.price) || 600;
      lastPriceFetch = now;
    }
  } catch (err) {
    console.error("BNB price fetch error:", err.message);
  }
  return bnbPrice;
}

function resolveImage(img) {
  if (!img) return null;
  if (img.startsWith("http")) return img;
  if (img.startsWith("/")) return img;
  return IPFS_GATEWAY + img + "?img-width=200&img-height=200&img-fit=cover";
}

const COIN_FIELDS = `
  name address symbol listed createdAt
  r(round: 3) h(round: 3) k(round: 3)
  dexThreshSupply
  marketcap(round: 18) reserve(round: 18) supply(round: 18)
  quoteToken
  tax(round: 4)
  beneficiary
  creator
  nHolders
  author { name pfp }
  holders { holder amount }
  metadata { description image website twitter telegram }
`;

const BOARD_QUERY = `{
  boardV2 {
    verified(limit: 25) { coins { ${COIN_FIELDS} } }
    newlyCreated(limit: 35) { coins { ${COIN_FIELDS} } }
    graduating(limit: 25) { coins { ${COIN_FIELDS} } }
    listed(limit: 50) { coins { ${COIN_FIELDS} } }
  }
}`;

const RECENT_BONDING_QUERY = `{
  boardV2 {
    verified(limit: 50) { coins { ${COIN_FIELDS} } }
    newlyCreated(limit: 50) { coins { ${COIN_FIELDS} } }
    graduating(limit: 50) { coins { ${COIN_FIELDS} } }
    listed(limit: 50) { coins { ${COIN_FIELDS} } }
  }
}`;

async function queryFlap(query, variables = {}) {
  const body = variables && Object.keys(variables).length > 0
    ? JSON.stringify({ query, variables })
    : JSON.stringify({ query });

  const res = await fetch(FLAP_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": BROWSER_UA,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GraphQL error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors).slice(0, 200)}`);
  }
  return data.data;
}

async function checkDexScreener(addresses) {
  const now = Date.now();
  const toCheck = addresses.filter((a) => {
    const cached = dexCache.get(a);
    return !cached || now - cached.time > DEX_CACHE_TTL;
  });

  if (toCheck.length > 0) {
    const batches = [];
    for (let i = 0; i < toCheck.length; i += 30) {
      batches.push(toCheck.slice(i, i + 30));
    }

    for (const batch of batches) {
      try {
        const joined = batch.join(",");
        const res = await fetch(
          `https://api.dexscreener.com/tokens/v1/bsc/${joined}`,
          { headers: { "User-Agent": BROWSER_UA } }
        );
        if (res.ok) {
          const pairs = await res.json();
          const pairsByToken = new Map();
          if (Array.isArray(pairs)) {
            for (const pair of pairs) {
              const addr = pair.baseToken?.address?.toLowerCase();
              if (addr) {
                if (!pairsByToken.has(addr)) pairsByToken.set(addr, []);
                pairsByToken.get(addr).push(pair);
              }
            }
          }
          for (const addr of batch) {
            const tokenPairs = pairsByToken.get(addr.toLowerCase()) || [];
            const hasPaid = tokenPairs.some(
              (p) =>
                p.boosts?.active > 0 ||
                (p.info?.header) ||
                (p.info?.openGraph)
            );
            if (hasPaid && !dexPaidDetectedAtMap.has(addr.toLowerCase())) {
              dexPaidDetectedAtMap.set(addr.toLowerCase(), now);
            }
            const bestPair = tokenPairs[0];
            const txns24h = bestPair?.txns?.h24 || {};
            dexCache.set(addr.toLowerCase(), {
              time: now,
              paid: hasPaid,
              pairCount: tokenPairs.length,
              priceUsd: bestPair?.priceUsd || null,
              volume24h: bestPair?.volume?.h24 || 0,
              liquidity: bestPair?.liquidity?.usd || 0,
              priceChange24h: bestPair?.priceChange?.h24 || 0,
              buys24h: txns24h.buys || 0,
              sells24h: txns24h.sells || 0,
              dexUrl: bestPair?.url || null,
              pairCreatedAt: bestPair?.pairCreatedAt || null,
            });
          }
        }
      } catch (err) {
        console.error("DexScreener batch error:", err.message);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const result = {};
  for (const addr of addresses) {
    const cached = dexCache.get(addr.toLowerCase());
    result[addr.toLowerCase()] = cached || { paid: false, pairCount: 0, priceUsd: null, volume24h: 0, liquidity: 0, priceChange24h: 0, buys24h: 0, sells24h: 0, dexUrl: null };
  }
  return result;
}


const BURN_ADDRESS = "0x000000000000000000000000000000000000dead";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TOTAL_SUPPLY = 1_000_000_000;

function getBurnedAmount(coin) {
  if (!coin.holders || !Array.isArray(coin.holders)) return 0;
  let burned = 0;
  for (const h of coin.holders) {
    const addr = h.holder?.toLowerCase();
    if (addr === BURN_ADDRESS || addr === ZERO_ADDRESS) {
      burned += parseFloat(h.amount) || 0;
    }
  }
  return burned;
}

function calcBurnPercent(coin) {
  const burned = getBurnedAmount(coin);
  if (burned <= 0) return 0;
  return (burned / TOTAL_SUPPLY) * 100;
}

function calcPrice(coin, bnb) {
  const mcapBnb = parseFloat(coin.marketcap) || 0;
  if (mcapBnb <= 0) return 0;
  const burned = getBurnedAmount(coin);
  const circulating = TOTAL_SUPPLY - burned;
  if (circulating <= 0) return 0;
  return (mcapBnb * bnb) / circulating;
}

function calcDevHold(coin) {
  if (!coin.holders || !Array.isArray(coin.holders) || coin.holders.length === 0) return 0;
  const creator = coin.creator?.toLowerCase();
  if (!creator) return 0;
  const devHolder = coin.holders.find((h) => h.holder?.toLowerCase() === creator);
  if (!devHolder) return 0;
  const devAmount = parseFloat(devHolder.amount) || 0;
  return (devAmount / TOTAL_SUPPLY) * 100;
}

function mapCoin(coin, price, section) {
  const mcapBnb = parseFloat(coin.marketcap) || 0;
  const mcapUsd = mcapBnb * price;
  const tokenPrice = calcPrice(coin, price);
  const taxRateRaw = parseFloat(coin.tax) || 0;
  const taxRatePercent = taxRateRaw * 100;
  const holdersCount = typeof coin.nHolders === 'number' ? coin.nHolders : (Array.isArray(coin.holders) ? coin.holders.length : 0);
  const devHold = calcDevHold(coin);
  const burnPercent = calcBurnPercent(coin);
  const reserveBnb = parseFloat(coin.reserve) || 0;
  const BOND_TARGET_BNB = 16;
  const bondProgress = Math.min((reserveBnb / BOND_TARGET_BNB) * 100, 100);
  const isBonding = !coin.listed && reserveBnb >= 1;
  const isGraduated = coin.listed || bondProgress >= 100;

  return {
    address: coin.address,
    name: coin.name || "Unknown",
    ticker: coin.symbol || "???",
    mcap: mcapUsd,
    mcapBnb: mcapBnb,
    price: tokenPrice,
    holders: holdersCount,
    change24h: 0,
    image: resolveImage(coin.metadata?.image) || null,
    createdAt: coin.createdAt
      ? new Date(coin.createdAt * 1000).toISOString()
      : new Date().toISOString(),
    devHoldPercent: devHold,
    burnPercent: burnPercent,
    devWallet: coin.creator || null,
    sniperHoldPercent: 0,
    website: coin.metadata?.website || null,
    twitter: coin.metadata?.twitter || null,
    telegram: coin.metadata?.telegram || null,
    bondingCurve: isBonding,
    bondProgress: bondProgress,
    reserveBnb: reserveBnb,
    graduated: isGraduated,
    listed: coin.listed || false,
    taxRate: taxRatePercent,
    taxEarned: 0,
    beneficiary: coin.beneficiary || null,
    description: coin.metadata?.description || null,
    section: section,
    dexPaid: false,
    dexPairCount: 0,
    volume24h: 0,
    liquidity: 0,
    buys24h: 0,
    sells24h: 0,
    dexUrl: null,
  };
}

async function fetchFlapTokens() {
  const now = Date.now();
  if (cachedTokens.length > 0 && now - lastFetchTime < CACHE_TTL) {
    return cachedTokens;
  }

  try {
    const [data, price] = await Promise.all([
      queryFlap(BOARD_QUERY),
      fetchBnbPrice(),
    ]);

    const board = data.boardV2;
    const allCoins = [];
    const seen = new Set();

    const sections = [
      { data: board.verified, name: "verified" },
      { data: board.newlyCreated, name: "newlyCreated" },
      { data: board.graduating, name: "graduating" },
      { data: board.listed, name: "listed" },
    ];

    for (const section of sections) {
      if (!section.data?.coins) continue;
      for (const coin of section.data.coins) {
        if (!seen.has(coin.address)) {
          seen.add(coin.address);
          allCoins.push({ coin, section: section.name });
        }
      }
    }

    const mapped = allCoins.map(({ coin, section }) => mapCoin(coin, price, section));

    const currentNewlyCreated = new Set();
    for (const { coin, section: sec } of allCoins) {
      if (sec === "newlyCreated") {
        currentNewlyCreated.add(coin.address);
      }
    }

    const now2 = Date.now();
    if (isFirstFetch) {
      for (const addr of currentNewlyCreated) {
        knownNewlyCreated.add(addr);
      }
      isFirstFetch = false;
      console.log(`[INIT] Seeded ${currentNewlyCreated.size} known newlyCreated tokens (no NEW flags on first load)`);
    } else {
      for (const addr of currentNewlyCreated) {
        if (!knownNewlyCreated.has(addr)) {
          newlyDetectedTimestamps.set(addr, now2);
          console.log(`[NEW TOKEN DETECTED] ${addr}`);
        }
      }
      knownNewlyCreated.clear();
      for (const addr of currentNewlyCreated) {
        knownNewlyCreated.add(addr);
      }
    }

    for (const [addr, ts] of newlyDetectedTimestamps) {
      if (now2 - ts > 60000) {
        newlyDetectedTimestamps.delete(addr);
      }
    }

    for (const token of mapped) {
      const detectedAt = newlyDetectedTimestamps.get(token.address);
      if (detectedAt) {
        token.newlyDetectedAt = detectedAt;
      }
    }

    const addresses = mapped.map((t) => t.address);
    try {
      const dexResults = await checkDexScreener(addresses);
      for (const token of mapped) {
        const dex = dexResults[token.address.toLowerCase()];
        if (dex) {
          token.dexPaid = dex.paid || false;
          token.dexPairCount = dex.pairCount || 0;
          token.volume24h = dex.volume24h || 0;
          token.liquidity = dex.liquidity || 0;
          token.change24h = dex.priceChange24h || 0;
          token.buys24h = dex.buys24h || 0;
          token.sells24h = dex.sells24h || 0;
          token.dexUrl = dex.dexUrl || null;
        }
      }
    } catch (err) {
      console.error("DexScreener enrichment error:", err.message);
    }

    cachedTokens = mapped;
    lastFetchTime = now;

    cachedNewTokens = mapped.filter((t) => !t.listed && t.mcap < 500000);
    cachedBondingTokens = mapped.filter((t) => t.listed);

    console.log(
      `Fetched ${cachedTokens.length} Flap.sh tokens (BNB: $${price.toFixed(2)}, ` +
      `new: ${cachedNewTokens.length}, bonding: ${cachedBondingTokens.length})`
    );
    return cachedTokens;
  } catch (err) {
    console.error("Flap.sh fetch error:", err.message);
    return cachedTokens;
  }
}

app.use(express.json());

app.get("/api/settings", async (req, res) => {
  try {
    const result = await pool.query("SELECT key, value FROM site_settings");
    const settings = {};
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    res.json(settings);
  } catch (err) {
    console.error("Settings fetch error:", err.message);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Wrong password" });
  }
});

app.post("/api/track", async (req, res) => {
  try {
    const { visitor_id, page, referrer } = req.body;
    if (!visitor_id) return res.status(400).json({ error: "Missing visitor_id" });
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const ipH = hashIp(ip);
    const ua = req.headers["user-agent"] || "";
    const pg = (page || "/").substring(0, 200);
    const ref = (referrer || "").substring(0, 500);

    onlineUsers.set(visitor_id, { visitor_id, ip_hash: ipH, page: pg, user_agent: ua, last_seen: new Date(), country: null });

    let country = null;
    getCountryFromIp(ip).then(async (c) => {
      country = c;
      if (onlineUsers.has(visitor_id)) {
        onlineUsers.get(visitor_id).country = country;
      }
      try {
        await pool.query(
          `INSERT INTO site_visitors (visitor_id, ip_hash, page, user_agent, referrer, country, last_seen, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
          [visitor_id, ipH, pg, ua, ref, country]
        );
      } catch (e) { console.error("Track insert error:", e.message); }
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Track error:", err.message);
    res.status(500).json({ error: "Track failed" });
  }
});

app.post("/api/heartbeat", (req, res) => {
  const { visitor_id, page } = req.body;
  if (!visitor_id) return res.status(400).json({ error: "Missing visitor_id" });
  if (onlineUsers.has(visitor_id)) {
    const u = onlineUsers.get(visitor_id);
    u.last_seen = new Date();
    if (page) u.page = page;
  }
  res.json({ ok: true });
});

setInterval(() => {
  const now = Date.now();
  for (const [vid, u] of onlineUsers) {
    if (now - u.last_seen.getTime() > 5 * 60 * 1000) {
      onlineUsers.delete(vid);
    }
  }
}, 30000);

function requireAdminPassword(req, res, next) {
  const { password } = req.query;
  if (password === process.env.ADMIN_PASSWORD) return next();
  const authHeader = req.headers.authorization;
  if (authHeader === process.env.ADMIN_PASSWORD) return next();
  res.status(401).json({ error: "Unauthorized" });
}

app.get("/api/dev88/visitors", requireAdminPassword, async (req, res) => {
  try {
    const onlineCount = onlineUsers.size;

    const todayResult = await pool.query(
      `SELECT COUNT(DISTINCT ip_hash) as cnt FROM site_visitors WHERE created_at >= CURRENT_DATE`
    );
    const todayVisitors = parseInt(todayResult.rows[0]?.cnt || "0");

    const weekResult = await pool.query(
      `SELECT COUNT(DISTINCT ip_hash) as cnt FROM site_visitors WHERE created_at >= NOW() - INTERVAL '7 days'`
    );
    const weekVisitors = parseInt(weekResult.rows[0]?.cnt || "0");

    const totalResult = await pool.query(
      `SELECT COUNT(DISTINCT ip_hash) as cnt FROM site_visitors`
    );
    const totalVisitors = parseInt(totalResult.rows[0]?.cnt || "0");

    const dailyResult = await pool.query(
      `SELECT DATE(created_at) as date, COUNT(DISTINCT ip_hash) as visitors, COUNT(*) as page_views
       FROM site_visitors WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(created_at) ORDER BY date DESC`
    );

    const topPagesResult = await pool.query(
      `SELECT page, COUNT(*) as views, COUNT(DISTINCT ip_hash) as unique_visitors
       FROM site_visitors WHERE created_at >= NOW() - INTERVAL '30 days'
       GROUP BY page ORDER BY views DESC LIMIT 20`
    );

    const countryResult = await pool.query(
      `SELECT country, COUNT(DISTINCT ip_hash) as visitors
       FROM site_visitors WHERE country IS NOT NULL AND country != ''
       AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY country ORDER BY visitors DESC LIMIT 30`
    );

    const recentResult = await pool.query(
      `SELECT ip_hash, country, page, created_at
       FROM site_visitors ORDER BY created_at DESC LIMIT 50`
    );

    res.json({
      online_now: onlineCount,
      today_visitors: todayVisitors,
      week_visitors: weekVisitors,
      total_visitors: totalVisitors,
      daily_stats: dailyResult.rows.map(r => ({ date: r.date, visitors: parseInt(r.visitors), page_views: parseInt(r.page_views) })),
      top_pages: topPagesResult.rows.map(r => ({ page: r.page, views: parseInt(r.views), unique_visitors: parseInt(r.unique_visitors) })),
      country_stats: countryResult.rows.map(r => ({ country: r.country, visitors: r.visitors.toString() })),
      recent_visitors: recentResult.rows.map(r => ({ ip_hash: r.ip_hash, country: r.country, page: r.page, wallet_address: null, created_at: r.created_at })),
    });
  } catch (err) {
    console.error("Visitors API error:", err.message);
    res.status(500).json({ error: "Failed to fetch visitor stats" });
  }
});

app.get("/api/dev88/online", requireAdminPassword, async (req, res) => {
  const users = [];
  const now = Date.now();
  for (const [, u] of onlineUsers) {
    users.push({
      visitor_id: u.visitor_id,
      ip_hash: u.ip_hash,
      page: u.page,
      wallet: null,
      country: u.country || "Unknown",
      last_seen: u.last_seen,
      idle_seconds: Math.floor((now - u.last_seen.getTime()) / 1000),
    });
  }
  users.sort((a, b) => a.idle_seconds - b.idle_seconds);
  res.json({ users });
});

app.post("/api/settings", async (req, res) => {
  const { password, ...updates } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const validKeys = ["ca_address", "telegram", "twitter", "github", "email", "bflap_link", "flapsh_link"];
    for (const [key, value] of Object.entries(updates)) {
      if (validKeys.includes(key) && typeof value === "string") {
        await pool.query(
          "INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()",
          [key, value]
        );
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Settings update error:", err.message);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

app.get("/api/flapsh-tokens", async (req, res) => {
  const tokens = await fetchFlapTokens();
  const bubbleTokens = tokens.filter((t) => !t.listed && t.mcap < 500000);
  res.json({ tokens: bubbleTokens });
});

app.get("/api/tokens", async (req, res) => {
  const tokens = await fetchFlapTokens();
  res.json({ tokens });
});

app.get("/api/new-tokens", async (req, res) => {
  await fetchFlapTokens();
  res.json({ tokens: cachedNewTokens });
});

app.get("/api/bonding-tokens", async (req, res) => {
  await fetchFlapTokens();
  res.json({ tokens: cachedBondingTokens });
});

app.get("/api/bonded-tokens", async (req, res) => {
  const tokens = await fetchFlapTokens();
  const bondedOnly = tokens.filter((t) => t.listed);
  res.json({ tokens: bondedOnly });
});

app.get("/api/recent-bonding", (req, res) => {
  res.json({ tokens: recentBondingTokens });
});

app.get("/api/highcap-tokens", async (req, res) => {
  const tokens = await fetchFlapTokens();
  const highcap = tokens.filter((t) => !t.listed && t.mcap >= 500000);
  res.json({ tokens: highcap });
});

let dexPaidCache = [];
let dexPaidLastFetch = 0;
const DEX_PAID_TTL = 30000;

async function fetchDexPaidTokens() {
  const now = Date.now();
  if (dexPaidCache.length > 0 && now - dexPaidLastFetch < DEX_PAID_TTL) {
    return dexPaidCache;
  }

  try {
    const flapTokens = await fetchFlapTokens();
    const dexPaidTokens = flapTokens.filter((t) => t.dexPaid);

    if (dexPaidTokens.length === 0) {
      dexPaidCache = [];
      dexPaidLastFetch = now;
      return dexPaidCache;
    }

    const addresses = dexPaidTokens.map((t) => t.address);
    const pairBatches = [];
    for (let i = 0; i < addresses.length; i += 30) {
      pairBatches.push(addresses.slice(i, i + 30));
    }

    const pairData = new Map();
    for (const batch of pairBatches) {
      try {
        const joined = batch.join(",");
        const pRes = await fetch(
          `https://api.dexscreener.com/tokens/v1/bsc/${joined}`,
          { headers: { "User-Agent": BROWSER_UA } }
        );
        if (pRes.ok) {
          const pairs = await pRes.json();
          if (Array.isArray(pairs)) {
            for (const pair of pairs) {
              const addr = pair.baseToken?.address?.toLowerCase();
              if (addr && !pairData.has(addr)) {
                pairData.set(addr, pair);
              }
            }
          }
        }
      } catch (err) {
        console.error("DexPaid pair fetch error:", err.message);
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    const results = dexPaidTokens.map((token) => {
      const pair = pairData.get(token.address.toLowerCase());
      const pairCreatedAt = pair?.pairCreatedAt || null;
      return {
        address: token.address,
        name: token.name,
        ticker: token.ticker,
        icon: pair?.info?.imageUrl || token.image || null,
        header: pair?.info?.header || null,
        description: token.description || null,
        mcap: pair?.marketCap || pair?.fdv || token.mcap || 0,
        priceUsd: pair?.priceUsd || String(token.price) || null,
        volume24h: pair?.volume?.h24 || 0,
        priceChange24h: pair?.priceChange?.h24 || 0,
        liquidity: pair?.liquidity?.usd || 0,
        pairAddress: pair?.pairAddress || null,
        dexUrl: pair?.url || `https://dexscreener.com/bsc/${token.address}`,
        boostAmount: pair?.boosts?.active || 0,
        website: pair?.info?.websites?.[0]?.url || token.website || null,
        twitter: pair?.info?.socials?.find((s) => s.type === "twitter")?.url || token.twitter || null,
        telegram: pair?.info?.socials?.find((s) => s.type === "telegram")?.url || token.telegram || null,
        discord: pair?.info?.socials?.find((s) => s.type === "discord")?.url || null,
        createdAt: token.createdAt || null,
        holders: token.holders || 0,
        taxRate: token.taxRate || 0,
        pairCreatedAt: pairCreatedAt,
        dexPaidDetectedAt: dexPaidDetectedAtMap.get(token.address.toLowerCase()) || now,
      };
    });

    results.sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0));
    dexPaidCache = results;
    dexPaidLastFetch = now;
    console.log(`DexPaid: Found ${dexPaidTokens.length} dex-paid Flap.sh tokens, returning top ${dexPaidCache.length}`);
    return dexPaidCache;
  } catch (err) {
    console.error("DexPaid fetch error:", err.message);
    return dexPaidCache;
  }
}

app.get("/api/dexpaid-tokens", async (req, res) => {
  const tokens = await fetchDexPaidTokens();
  res.json({ tokens });
});

app.get("/api/token-lookup/:address", async (req, res) => {
  const addr = req.params.address.toLowerCase();
  const tokens = await fetchFlapTokens();
  const found = tokens.find((t) => t.address.toLowerCase() === addr);
  if (found) {
    return res.json({ token: found, source: "cache" });
  }

  try {
    const COIN_QUERY = `query($address: String!) {
      coin(address: $address) {
        ${COIN_FIELDS}
      }
    }`;
    const data = await queryFlap(COIN_QUERY, { address: req.params.address });
    if (data.coin) {
      const price = await fetchBnbPrice();
      const mapped = mapCoin(data.coin, price, "lookup");
      return res.json({ token: mapped, source: "live" });
    }
    res.json({ token: null });
  } catch (err) {
    console.error("Token lookup error:", err.message);
    res.json({ token: null, error: err.message });
  }
});

const FAQ_RESPONSES = {
  bonding: {
    patterns: [/how\s+does\s+bonding\s+work/i, /what\s+is\s+bonding/i, /bonding\s+curve/i, /bonding\s+on\s+flap/i, /how\s+bonding/i, /explain\s+bonding/i],
    reply: `Bonding on Flap.sh is a unique token launch mechanism that creates a fair and gradual price discovery process! Here's how it works:

🔗 **Bonding Curve Mechanism:**
- Tokens start at a very low price and increase algorithmically as more are bought
- The more tokens purchased, the higher the price goes
- Creates natural price appreciation based on demand

📈 **Graduation System:**
- Tokens "graduate" from bonding when they reach a certain market cap threshold
- Once graduated, they get listed on DEXs with liquidity
- This prevents rug pulls since liquidity is locked automatically

💧 **Liquidity Protection:**
- During bonding, there's no traditional liquidity pool that can be pulled
- Liquidity is only created upon graduation
- This makes launches much safer for investors

⚡ **Benefits:**
- Fair launch - no presales or insider advantages
- Anti-rug mechanism built-in
- Gradual price discovery
- Community-driven growth

The bonding percentage shows how close a token is to graduating. Once it hits 100%, it automatically graduates to full DEX trading with locked liquidity!

Want to see how a specific token is doing in its bonding phase? Just paste its contract address! 🚀`
  },
  flap: {
    patterns: [/what\s+is\s+flap/i, /what'?s\s+flap/i, /about\s+flap/i, /tell\s+me\s+about\s+flap/i, /explain\s+flap/i, /flap\.sh\s*\?/i],
    reply: `Flap.sh is a decentralized launchpad on the BNB Smart Chain (BSC) that allows users to create and trade tokens through a bonding curve mechanism.

Here's how it works:

🚀 **Token Creation:** Anyone can launch a token with just a few clicks
📈 **Bonding Curve:** Tokens start with a bonding curve pricing model where price increases as more tokens are bought
🎓 **Graduation:** When a token reaches a certain market cap threshold, it "graduates" and gets listed on PancakeSwap with liquidity
💧 **Liquidity:** Graduated tokens have their liquidity burned, making them safer investments
🔍 **Transparency:** All token data is on-chain and visible, including holder distribution and dev allocations

**Key Features:**
- Fair launch mechanism
- Anti-rug protection through bonding curves
- Automatic PancakeSwap listing for successful projects
- Built-in token explorer and analytics
- Social features and community building tools

The platform is designed to make token creation accessible while providing safety mechanisms to protect investors from common crypto scams like rug pulls.

Want to explore a specific token? Just paste its contract address and I'll show you all the details! 🫧`
  },
  graduation: {
    patterns: [/what\s+is\s+graduat/i, /how\s+does\s+graduat/i, /when\s+does?\s+.*graduat/i, /explain\s+graduat/i],
    reply: `**Graduation** is when a token on Flap.sh reaches its bonding target and "levels up" to full DEX trading!

📊 **How it works:**
- Each token starts with a bonding curve on Flap.sh
- As people buy, the reserve grows toward the **16 BNB target**
- The bonding percentage shows progress (e.g., "73%" means 73% of the way)
- At **100%**, the token automatically graduates!

🎓 **What happens at graduation:**
- Liquidity is automatically created on PancakeSwap
- The liquidity is **burned** (locked forever) — no rug pull possible
- Token becomes freely tradable on DEXs
- Price discovery moves to the open market

✅ **Why it matters:**
- Graduated tokens are generally safer — they have real liquidity
- The bonding phase acts as a filter for genuine community interest
- No team can pull liquidity after graduation

On Bubble Flap, graduated tokens appear on the **Bonding** page with a "Graduated" badge! 🏆`
  },
  help: {
    patterns: [/^help$/i, /what\s+can\s+you\s+do/i, /how\s+to\s+use/i, /^commands$/i],
    reply: `I'm **Bot Bubble Flap** 🫧 — your AI assistant for exploring BSC tokens on Flap.sh!

Here's what I can do:

🔍 **Token Analysis** — Paste any BSC contract address (0x...) and I'll show you detailed info including market cap, price, holders, dev hold %, tax, bonding status, and more

❓ **FAQ Answers** — Ask me about:
- "What is Flap.sh?"
- "How does bonding work?"
- "What is graduation?"

💬 **General Crypto Chat** — Ask me anything about DeFi, BSC, token mechanics, or trading concepts

**Quick tip:** Just paste a contract address like \`0x...\` to get started!`
  }
};

function matchFAQ(text) {
  for (const [, faq] of Object.entries(FAQ_RESPONSES)) {
    for (const pattern of faq.patterns) {
      if (pattern.test(text)) return faq.reply;
    }
  }
  return null;
}

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }

  const lastMsg = messages[messages.length - 1]?.content || "";

  const faqReply = matchFAQ(lastMsg.trim());
  if (faqReply && !lastMsg.match(/0x[a-fA-F0-9]{40}/)) {
    return res.json({ reply: faqReply, model: "faq-cache", tokenData: null });
  }

  const caMatch = lastMsg.match(/0x[a-fA-F0-9]{40}/);
  let found = null;

  if (caMatch) {
    const addr = caMatch[0].toLowerCase();
    const tokens = await fetchFlapTokens();
    found = tokens.find((t) => t.address.toLowerCase() === addr);

    if (!found) {
      // Check graduated cache (covers listed/bonded tokens from Recent Bonding)
      found = graduatedCache.get(addr) || null;
    }

    if (!found) {
      try {
        const COIN_QUERY = `query($address: String!) {
          coin(address: $address) {
            ${COIN_FIELDS}
          }
        }`;
        const data = await queryFlap(COIN_QUERY, { address: caMatch[0] });
        if (data.coin) {
          const price = await fetchBnbPrice();
          found = mapCoin(data.coin, price, "lookup");
        }
      } catch (err) {
        console.error("Chat token lookup error:", err.message);
      }
    }
  }

  const wantsAnalysis = /analy[zs]/i.test(lastMsg);
  const isJustCA = caMatch && lastMsg.trim().replace(/0x[a-fA-F0-9]{40}/, '').trim().length < 5;

  if (caMatch && found && !wantsAnalysis && isJustCA) {
    const tokenData = {
      address: found.address, name: found.name, ticker: found.ticker,
      mcap: found.mcap, price: found.price, holders: found.holders,
      devHoldPercent: found.devHoldPercent, burnPercent: found.burnPercent,
      sniperHoldPercent: found.sniperHoldPercent,
      taxRate: found.taxRate, beneficiary: found.beneficiary,
      bondingCurve: found.bondingCurve, bondProgress: found.bondProgress,
      reserveBnb: found.reserveBnb, graduated: found.graduated, listed: found.listed,
      image: found.image, website: found.website, twitter: found.twitter,
      telegram: found.telegram, createdAt: found.createdAt,
      description: found.description, dexPaid: found.dexPaid,
    };
    const status = found.listed ? "Graduated" : found.bondingCurve ? `Bonding ${Math.round(found.bondProgress)}%` : "New";
    const reply = `**${found.name}** $${found.ticker}\n${status}${found.taxRate > 0 ? ` | ${found.taxRate}% Tax` : ""}`;
    return res.json({ reply, model: "direct-lookup", tokenData });
  }

  if (caMatch && !found) {
    return res.json({ reply: `Token not found for address \`${caMatch[0]}\`. It may not be on Flap.sh/BSC.`, model: "direct-lookup", tokenData: null });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "OpenRouter API key not configured" });
  }

  let tokenContext = "";
  if (found) {
    tokenContext = `\n\nTOKEN DATA FOUND for ${caMatch[0]}:\n` +
      JSON.stringify({
        name: found.name, ticker: found.ticker, address: found.address,
        mcap: found.mcap, price: found.price, holders: found.holders,
        devHoldPercent: found.devHoldPercent, burnPercent: found.burnPercent,
        sniperHoldPercent: found.sniperHoldPercent,
        taxRate: found.taxRate, beneficiary: found.beneficiary,
        bondingCurve: found.bondingCurve, bondProgress: found.bondProgress,
        reserveBnb: found.reserveBnb, graduated: found.graduated, listed: found.listed,
        image: found.image, website: found.website, twitter: found.twitter,
        telegram: found.telegram, createdAt: found.createdAt,
        description: found.description, dexPaid: found.dexPaid,
      }, null, 2) +
      `\nBuy link: https://flap.sh/bnb/${found.address}`;
  }

  const systemPrompt = `You are Bot Bubble Flap, an AI assistant for the Bubble Flap token visualizer on the BSC/BNB blockchain (Flap.sh launchpad).

Your job is to help users understand tokens on the Flap.sh platform.

When a user pastes a contract address (CA), you will receive token data. Present it in this EXACT format using this template:

**[TOKEN_NAME]** $[TICKER]
[BONDING_STATUS] | [TAX_INFO]

| Field | Value |
|-------|-------|
| MCap | $XX.XK |
| Price | $0.0000XXXX |
| Holders | XXX |
| Age | XXd/XXh/XXm ago |
| Dev Hold | X.X% |
| Sniper | X.X% |
| Tax | X% |

**CA:** \`0x...full address\`
**Buy:** [Buy on Flap.sh](https://flap.sh/bnb/CONTRACT_ADDRESS)

[Show social links if available: Web, Twitter, TG]

Rules:
- Always show the buy link to flap.sh
- For bonding status: show "Bonding XX%" if bonding, "Graduated" if graduated/listed, "New" if neither
- Show tax rate and beneficiary if tax > 0
- Format mcap: use K for thousands, M for millions
- Format price with appropriate decimals
- Calculate age from createdAt timestamp
- If dev hold > 20%, warn the user
- If sniper hold > 15%, warn the user
- Be friendly, concise, and helpful
- You can answer general crypto/DeFi questions too
- Always respond in the same language the user uses${tokenContext}`;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://bubbleflap.com",
        "X-Title": "Bubble Flap Bot",
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4",
        messages: [
          { role: "system", content: systemPrompt },
          ...messages.slice(-10),
        ],
        max_tokens: 1024,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("OpenRouter error:", response.status, errText.slice(0, 300));
      return res.status(502).json({ error: "AI service error" });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Sorry, I couldn't process that.";
    const tokenData = (caMatch && found) ? {
      address: found.address,
      name: found.name,
      ticker: found.ticker,
      mcap: found.mcap,
      price: found.price,
      holders: found.holders,
      devHoldPercent: found.devHoldPercent,
      burnPercent: found.burnPercent,
      sniperHoldPercent: found.sniperHoldPercent,
      taxRate: found.taxRate,
      beneficiary: found.beneficiary,
      bondingCurve: found.bondingCurve,
      bondProgress: found.bondProgress,
      reserveBnb: found.reserveBnb,
      graduated: found.graduated,
      listed: found.listed,
      image: found.image,
      website: found.website,
      twitter: found.twitter,
      telegram: found.telegram,
      createdAt: found.createdAt,
      description: found.description,
      dexPaid: found.dexPaid,
    } : null;
    res.json({ reply, model: data.model, tokenData });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: "Failed to get AI response" });
  }
});

const FLAP_PORTAL_BSC = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0";
const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const PANCAKE_V3_ROUTER = "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4";
const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

const BSC_CURVE_R = 6.14;
const BSC_CURVE_H = 107036752;
const BSC_CURVE_K = 6797205657.28;
const BILLION = 1e9;

function flapQuoteBuy(inputBnb, reserveBnb, circulatingSupply) {
  const x = BILLION + BSC_CURVE_H - circulatingSupply;
  const y = reserveBnb;
  const k = BSC_CURVE_K;
  const r = BSC_CURVE_R;
  const newY = y + inputBnb;
  const newX = k / (newY + r);
  const tokensOut = x - newX;
  return Math.max(0, tokensOut);
}

function flapQuoteSell(tokenAmount, reserveBnb, circulatingSupply) {
  const x = BILLION + BSC_CURVE_H - circulatingSupply;
  const y = reserveBnb;
  const k = BSC_CURVE_K;
  const r = BSC_CURVE_R;
  const newX = x + tokenAmount;
  const newY = k / (newX) - r;
  const bnbOut = y - newY;
  return Math.max(0, bnbOut);
}

function flapGetPrice(reserveBnb, circulatingSupply) {
  const x = BILLION + BSC_CURVE_H - circulatingSupply;
  const r = BSC_CURVE_R;
  const k = BSC_CURVE_K;
  return k / ((x) * (x)) * (1);
}

app.get("/api/swap/quote", async (req, res) => {
  try {
    const { tokenAddress, inputAmount, direction } = req.query;
    if (!tokenAddress || !inputAmount || !direction) {
      return res.status(400).json({ error: "Missing tokenAddress, inputAmount, or direction (buy/sell)" });
    }

    const amount = parseFloat(inputAmount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid inputAmount" });
    }

    await fetchBnbPrice();

    const allTokens = [...cachedNewTokens, ...cachedBondingTokens];
    const token = allTokens.find(t => t.address?.toLowerCase() === tokenAddress.toLowerCase());

    if (!token) {
      try {
        const WBNB_ADDR = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
        const PANCAKE_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
        const RPC_URL = "https://bsc-dataseed.binance.org/";

        const amountWei = BigInt(Math.floor(amount * 1e18));
        const path = direction === "buy"
          ? [WBNB_ADDR, tokenAddress]
          : [tokenAddress, WBNB_ADDR];

        const pathEncoded = path.map(a => a.replace("0x", "").padStart(64, "0")).join("");
        const callData = "0xd06ca61f" +
          amountWei.toString(16).padStart(64, "0") +
          "0000000000000000000000000000000000000000000000000000000000000040" +
          "0000000000000000000000000000000000000000000000000000000000000002" +
          pathEncoded;

        const rpcResp = await fetch(RPC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "eth_call",
            params: [{ to: PANCAKE_ROUTER, data: callData }, "latest"]
          }),
        });
        const rpcData = await rpcResp.json();

        if (rpcData.result && rpcData.result !== "0x") {
          const hex = rpcData.result.slice(2);
          const outputHex = hex.slice(192, 256);
          const outputWei = BigInt("0x" + outputHex);
          const outputAmount = Number(outputWei) / 1e18;

          const currentPrice = direction === "buy"
            ? amount * bnbPrice / outputAmount
            : outputAmount * bnbPrice / amount;

          return res.json({
            router: "pancakeswap",
            routerName: "PancakeSwap V2",
            routerAddress: PANCAKE_ROUTER,
            tokenAddress,
            tokenName: tokenAddress,
            tokenTicker: "",
            tokenImage: "",
            direction,
            inputAmount: amount,
            outputAmount,
            currentPrice,
            currentPriceUsd: currentPrice,
            priceImpact: 0.5,
            fee: "0.25%",
            taxRate: "0%",
            bondProgress: 100,
            graduated: true,
            bnbPrice,
            mcap: 0,
          });
        }
      } catch (e) {
        console.error("PancakeSwap quote error:", e.message);
      }

      return res.json({
        router: "unknown",
        error: "Token not found. Try refreshing.",
        tokenAddress,
      });
    }

    const isGraduated = token.graduated || token.listed;
    const taxRate = token.taxRate || 0;

    if (!isGraduated) {
      const reserveBnb = token.reserveBnb || 0;
      const totalSupply = BILLION;
      const circulatingSupply = token.bondProgress ? (token.bondProgress / 100) * 800000000 : 0;

      let outputAmount, priceImpact, currentPrice;
      currentPrice = flapGetPrice(reserveBnb, circulatingSupply);

      if (direction === "buy") {
        const feeAmount = amount * 0.01;
        const netInput = amount - feeAmount;
        outputAmount = flapQuoteBuy(netInput, reserveBnb, circulatingSupply);
        const avgPrice = amount / outputAmount;
        priceImpact = Math.abs((avgPrice - currentPrice) / currentPrice) * 100;
      } else {
        outputAmount = flapQuoteSell(amount, reserveBnb, circulatingSupply);
        const feeAmount = outputAmount * 0.01;
        outputAmount = outputAmount - feeAmount;
        if (taxRate > 0) {
          outputAmount = outputAmount * (1 - taxRate / 10000);
        }
        const avgPrice = outputAmount / amount;
        priceImpact = Math.abs((currentPrice - avgPrice) / currentPrice) * 100;
      }

      return res.json({
        router: "flap",
        routerName: "Flap.sh Bonding Curve",
        routerAddress: FLAP_PORTAL_BSC,
        tokenAddress,
        tokenName: token.name || token.ticker,
        tokenTicker: token.ticker,
        tokenImage: token.image,
        direction,
        inputAmount: amount,
        outputAmount: Math.max(0, outputAmount),
        currentPrice,
        currentPriceUsd: currentPrice * bnbPrice,
        priceImpact: Math.min(priceImpact, 100),
        fee: "1%",
        taxRate: taxRate > 0 ? `${taxRate / 100}%` : "0%",
        bondProgress: token.bondProgress || 0,
        reserveBnb,
        graduated: false,
        bnbPrice,
        mcap: token.mcap,
      });
    } else {
      const WBNB_ADDR = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
      const PANCAKE_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
      const RPC_URL = "https://bsc-dataseed.binance.org/";

      let outputAmount;
      let routerUsed = taxRate > 0 ? "pancakeswap_v2" : "pancakeswap_v3";
      let routerAddress = taxRate > 0 ? PANCAKE_V2_ROUTER : PANCAKE_V3_ROUTER;
      let routerName = taxRate > 0 ? "PancakeSwap V2" : "PancakeSwap V3";

      try {
        const amountWei = BigInt(Math.floor(amount * 1e18));
        const path = direction === "buy"
          ? [WBNB_ADDR, tokenAddress]
          : [tokenAddress, WBNB_ADDR];
        const pathEncoded = path.map(a => a.replace("0x", "").padStart(64, "0")).join("");
        const callData = "0xd06ca61f" +
          amountWei.toString(16).padStart(64, "0") +
          "0000000000000000000000000000000000000000000000000000000000000040" +
          "0000000000000000000000000000000000000000000000000000000000000002" +
          pathEncoded;

        const rpcResp = await fetch(RPC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "eth_call",
            params: [{ to: PANCAKE_ROUTER, data: callData }, "latest"]
          }),
        });
        const rpcData = await rpcResp.json();

        if (rpcData.result && rpcData.result !== "0x") {
          const hex = rpcData.result.slice(2);
          const outputHex = hex.slice(192, 256);
          const outputWei = BigInt("0x" + outputHex);
          outputAmount = Number(outputWei) / 1e18;
          routerUsed = "pancakeswap";
          routerAddress = PANCAKE_ROUTER;
          routerName = "PancakeSwap V2";
        }
      } catch (e) {
        console.error("PancakeSwap on-chain quote error:", e.message);
      }

      if (!outputAmount) {
        const tokenPrice = token.price || 0;
        if (direction === "buy") {
          outputAmount = tokenPrice > 0 ? (amount * bnbPrice) / tokenPrice : 0;
        } else {
          outputAmount = tokenPrice > 0 ? (amount * tokenPrice) / bnbPrice : 0;
        }
      }

      const tokenPrice = token.price || 0;

      return res.json({
        router: routerUsed,
        routerName,
        routerAddress,
        tokenAddress,
        tokenName: token.name || token.ticker,
        tokenTicker: token.ticker,
        tokenImage: token.image,
        direction,
        inputAmount: amount,
        outputAmount,
        currentPrice: tokenPrice,
        currentPriceUsd: tokenPrice,
        priceImpact: amount > 1 ? 0.5 : 0.1,
        fee: "0.25%",
        taxRate: taxRate > 0 ? `${taxRate / 100}%` : "0%",
        bondProgress: 100,
        graduated: true,
        bnbPrice,
        mcap: token.mcap,
      });
    }
  } catch (err) {
    console.error("Swap quote error:", err.message);
    res.status(500).json({ error: "Failed to get swap quote" });
  }
});

app.get("/api/swap/token-info", async (req, res) => {
  try {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: "Missing address" });

    const localToken = [...cachedNewTokens, ...cachedBondingTokens].find(
      t => t.address && t.address.toLowerCase() === address.toLowerCase()
    );
    if (localToken) {
      return res.json({
        address: localToken.address,
        mcap: localToken.mcap || 0,
        price: localToken.price || 0,
        holders: localToken.holders || 0,
        taxRate: localToken.taxRate || 0,
        name: localToken.name,
        ticker: localToken.ticker,
        image: localToken.image,
        graduated: localToken.graduated || localToken.listed,
      });
    }

    const dexResp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const dexData = await dexResp.json();

    if (dexData.pairs && dexData.pairs.length > 0) {
      const bscPairs = dexData.pairs.filter(p => p.chainId === "bsc");
      const pair = bscPairs[0] || dexData.pairs[0];
      return res.json({
        address,
        mcap: pair.marketCap || pair.fdv || 0,
        price: parseFloat(pair.priceUsd) || 0,
        holders: 0,
        taxRate: 0,
        name: pair.baseToken?.name || "",
        ticker: pair.baseToken?.symbol || "",
        image: "",
        graduated: true,
      });
    }

    return res.json({ address, mcap: 0, price: 0, holders: 0, taxRate: 0, name: "", ticker: "", image: "", graduated: true });
  } catch (err) {
    console.error("Token info error:", err.message);
    res.status(500).json({ error: "Failed to fetch token info" });
  }
});

app.get("/api/swap/tokens", (req, res) => {
  const allTokens = [...cachedNewTokens, ...cachedBondingTokens];
  const tokens = allTokens.map(t => ({
    address: t.address,
    name: t.name,
    ticker: t.ticker,
    image: t.image,
    price: t.price,
    mcap: t.mcap,
    graduated: t.graduated || t.listed,
    bondProgress: t.bondProgress,
    taxRate: t.taxRate,
    reserveBnb: t.reserveBnb,
    holders: t.holders,
  }));
  res.json({ tokens, bnbPrice });
});

app.use(express.static("public"));

const __filename2 = fileURLToPath(import.meta.url);
const __dirname2 = dirname(__filename2);

// Specific routes for swap to ensure index.html is served for client-side routing
app.get(["/bswap", "/swap", "/bflapswap", "/bflap-swap"], (req, res) => {
  res.sendFile(join(__dirname2, "public", "index.html"));
});

app.get("*", (req, res) => {
  if (!req.path.startsWith("/api") && !req.path.startsWith("/ws")) {
    res.sendFile(join(__dirname2, "public", "index.html"));
  }
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws._channel = null;
  console.log("WS client connected (awaiting subscribe)");

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "subscribe" && (msg.channel === "new" || msg.channel === "bonding")) {
        ws._channel = msg.channel;
        console.log(`WS client subscribed to: ${msg.channel}`);
        fetchFlapTokens().then(() => {
          if (ws.readyState !== 1) return;
          const data = msg.channel === "new" ? cachedNewTokens : cachedBondingTokens;
          if (data.length > 0) {
            ws.send(JSON.stringify({ type: "tokens_update", tokens: data }));
          }
        });
      }
    } catch (e) {}
  });

  ws.on("close", () => console.log(`WS client disconnected (${ws._channel || "no-channel"})`));
});

let recentBondingTokens = [];

// Search DexScreener for all Flap.sh tokens that have graduated to PancakeSwap BSC.
// All Flap.sh factory tokens have addresses ending in "7777" — this is the definitive
// filter. Any such address on PancakeSwap BSC graduated through the 16 BNB bonding curve
// (even if current liquidity dropped due to price action after graduation).
async function fetchGraduatedViaDexScreener(bnbPrice) {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const results = new Map();

  try {
    const [res7777, res8888] = await Promise.all([
      fetch('https://api.dexscreener.com/latest/dex/search?q=7777', { headers: { 'User-Agent': BROWSER_UA } }),
      fetch('https://api.dexscreener.com/latest/dex/search?q=8888', { headers: { 'User-Agent': BROWSER_UA } }),
    ]);
    const pairs = [
      ...((res7777.ok ? await res7777.json() : {})?.pairs || []),
      ...((res8888.ok ? await res8888.json() : {})?.pairs || []),
    ];

    for (const pair of pairs) {
      const addr = pair.baseToken?.address?.toLowerCase();
      if (!addr) continue;
      // Must be BSC PancakeSwap, Flap.sh address pattern (ends in 7777 or 8888),
      // and created within 30 days
      if (
        pair.chainId !== 'bsc' ||
        !isFlapAddress(addr) ||
        !pair.pairCreatedAt ||
        pair.pairCreatedAt < thirtyDaysAgo
      ) continue;

      // Skip if already have a better entry (prefer Flap.sh data)
      if (results.has(addr)) continue;

      results.set(addr, {
        address: pair.baseToken.address,
        name: pair.baseToken.name || pair.baseToken.symbol,
        ticker: pair.baseToken.symbol,
        mcap: pair.marketCap || 0,
        mcapBnb: (pair.marketCap || 0) / (bnbPrice || 1),
        price: parseFloat(pair.priceUsd) || 0,
        holders: 0,
        change24h: pair.priceChange?.h24 || 0,
        image: pair.info?.imageUrl || null,
        createdAt: new Date(pair.pairCreatedAt).toISOString(),
        graduatedAt: pair.pairCreatedAt,
        devHoldPercent: 0,
        burnPercent: 0,
        devWallet: null,
        sniperHoldPercent: 0,
        website: pair.info?.websites?.[0]?.url || null,
        twitter: null,
        telegram: null,
        bondingCurve: false,
        bondProgress: 100,
        reserveBnb: 0,
        graduated: true,
        listed: true,
        taxRate: 0,
        taxEarned: 0,
        beneficiary: null,
        description: null,
        section: 'listed',
        dexPaid: pair.boosts?.active > 0 || false,
        dexPairCount: 1,
        volume24h: pair.volume?.h24 || 0,
        liquidity: pair.liquidity?.usd || 0,
        buys24h: pair.txns?.h24?.buys || 0,
        sells24h: pair.txns?.h24?.sells || 0,
        dexUrl: pair.url || null,
      });
    }
  } catch (err) {
    console.error('[RECENT BONDING] DexScreener search error:', err.message);
  }

  return results;
}

// Fetch full token details from DexScreener for a list of addresses
async function lookupDexScreenerTokens(addresses) {
  const result = new Map();
  const batches = [];
  for (let i = 0; i < addresses.length; i += 30) {
    batches.push(addresses.slice(i, i + 30));
  }
  for (const batch of batches) {
    try {
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/bsc/${batch.join(',')}`, {
        headers: { 'User-Agent': BROWSER_UA },
      });
      if (!res.ok) continue;
      const pairs = await res.json();
      if (!Array.isArray(pairs)) continue;
      const byAddr = new Map();
      for (const pair of pairs) {
        const addr = pair.baseToken?.address?.toLowerCase();
        if (!addr) continue;
        if (!byAddr.has(addr) || (byAddr.get(addr).pairCreatedAt || 0) > (pair.pairCreatedAt || 0)) {
          byAddr.set(addr, pair);
        }
      }
      for (const [addr, pair] of byAddr) {
        result.set(addr, pair);
      }
    } catch (err) {
      console.error('[DEX LOOKUP] Batch error:', err.message);
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return result;
}

// Monitor PancakeSwap V2 factory for new PairCreated events with Flap.sh (7777) tokens.
// On first run: scans back 3 days. Subsequent runs: only new blocks.
async function fetchNewGraduationsFromChain(price) {
  try {
    const blockRes = await fetch(BSC_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
    });
    const blockData = await blockRes.json();
    if (!blockData.result) return;
    const currentBlock = parseInt(blockData.result, 16);

    if (lastCheckedBlock === 0) {
      // Start 3 days back on initial run
      lastCheckedBlock = currentBlock - 3 * BSC_BLOCKS_PER_DAY;
    }
    if (currentBlock <= lastCheckedBlock) return;

    const CHUNK = 5000;
    const newFlapAddresses = [];

    for (let from = lastCheckedBlock + 1; from <= currentBlock; from += CHUNK) {
      const to = Math.min(from + CHUNK - 1, currentBlock);
      try {
        const logsRes = await fetch(BSC_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
            params: [{
              address: PANCAKE_V2_FACTORY,
              topics: [PAIR_CREATED_TOPIC],
              fromBlock: '0x' + from.toString(16),
              toBlock: '0x' + to.toString(16),
            }],
          }),
        });
        const logsData = await logsRes.json();
        for (const log of (logsData.result || [])) {
          // PairCreated(indexed token0, indexed token1, pair, uint)
          // topics[1] = token0, topics[2] = token1 — each padded to 32 bytes
          const token0 = ('0x' + log.topics[1].slice(26)).toLowerCase();
          const token1 = ('0x' + log.topics[2].slice(26)).toLowerCase();
          if (isFlapAddress(token0)) newFlapAddresses.push(token0);
          else if (isFlapAddress(token1)) newFlapAddresses.push(token1);
        }
      } catch (e) {
        // chunk failed silently, next chunk will cover remaining blocks
      }
    }

    lastCheckedBlock = currentBlock;

    const newOnes = [...new Set(newFlapAddresses)].filter(a => !graduatedCache.has(a));
    if (newOnes.length === 0) return;

    console.log(`[CHAIN] ${newOnes.length} candidate graduation(s) from PancakeSwap — verifying on Flap.sh...`);

    // Get DexScreener market data for all candidates
    const tokenDetails = await lookupDexScreenerTokens(newOnes);

    // Separate known Flap.sh addresses (already seen in boardV2) from unknowns
    const knownToFlap = newOnes.filter(a => allKnownFlapAddresses.has(a));
    const unknownToFlap = newOnes.filter(a => !allKnownFlapAddresses.has(a));

    // Add known Flap.sh tokens directly — we already have their metadata
    for (const addr of knownToFlap) {
      if (graduatedCache.has(addr)) continue;
      const flapCoin = allKnownFlapAddresses.get(addr);
      const pair = tokenDetails.get(addr);
      const mapped = mapCoin(flapCoin, price, 'listed');
      mapped.listed = true; mapped.graduated = true; mapped.bondProgress = 100;
      if (pair) {
        mapped.volume24h = pair.volume?.h24 || 0;
        mapped.liquidity = pair.liquidity?.usd || 0;
        mapped.dexUrl = pair.url || null;
        mapped.change24h = pair.priceChange?.h24 || 0;
        mapped.mcap = pair.marketCap || mapped.mcap;
        mapped.graduatedAt = pair.pairCreatedAt || null;
      }
      graduatedCache.set(addr, mapped);
      console.log(`[CHAIN] Added (known): ${mapped.name} (${addr})`);
    }

    // For unknown addresses: verify each on Flap.sh API.
    // Only add if Flap.sh confirms the token — this filters out non-Flap.sh tokens
    // that happen to have addresses ending in 7777/8888.
    const COIN_QUERY = `query($address: String!) { coin(address: $address) { ${COIN_FIELDS} } }`;
    for (const addr of unknownToFlap) {
      if (graduatedCache.has(addr)) continue;
      try {
        const data = await queryFlap(COIN_QUERY, { address: addr });
        if (!data?.coin) {
          console.log(`[CHAIN] Skipped (not Flap.sh): ${addr}`);
          continue;
        }
        if (!data.coin.listed) {
          console.log(`[CHAIN] Skipped (not graduated yet): ${data.coin.name} (${addr})`);
          continue;
        }
        const pair = tokenDetails.get(addr);
        const mapped = mapCoin(data.coin, price, 'listed');
        mapped.listed = true; mapped.graduated = true; mapped.bondProgress = 100;
        if (pair) {
          mapped.volume24h = pair.volume?.h24 || 0;
          mapped.liquidity = pair.liquidity?.usd || 0;
          mapped.dexUrl = pair.url || null;
          mapped.change24h = pair.priceChange?.h24 || 0;
          mapped.mcap = pair.marketCap || mapped.mcap;
          mapped.graduatedAt = pair.pairCreatedAt || null;
        }
        graduatedCache.set(addr, mapped);
        allKnownFlapAddresses.set(addr, data.coin);
        console.log(`[CHAIN] Added (verified): ${data.coin.name} (${addr})`);
        await new Promise(r => setTimeout(r, 150));
      } catch (e) {
        // Flap.sh query failed or token not found — skip
      }
    }
  } catch (err) {
    console.error('[CHAIN] Error:', err.message);
  }
}

async function updateRecentBonding() {
  try {
    const [flapData, price] = await Promise.all([
      queryFlap(RECENT_BONDING_QUERY),
      fetchBnbPrice(),
    ]);

    // SOURCE 1: DexScreener — finds ALL graduated Flap.sh tokens (address ends in 7777 or 8888)
    // regardless of whether Flap.sh API has indexed them yet.
    const dexTokens = await fetchGraduatedViaDexScreener(price);
    for (const [addr, token] of dexTokens) {
      graduatedCache.set(addr, token);
    }

    // SOURCE 2: Flap.sh boardV2 — provides richer metadata (image, holders, tax, etc.)
    // Flap.sh data takes priority over DexScreener for tokens in both sources.
    // Every address seen from any section is tracked in allKnownFlapAddresses.
    const board = flapData?.boardV2;
    if (board) {
      const sections = ['verified', 'newlyCreated', 'graduating', 'listed'];
      for (const section of sections) {
        const coins = board[section]?.coins;
        if (!Array.isArray(coins)) continue;
        for (const coin of coins) {
          if (!coin.address) continue;
          const addrLow = coin.address.toLowerCase();

          // Track EVERY address we ever see — used for direct DexScreener graduation check
          allKnownFlapAddresses.set(addrLow, coin);

          // If boardV2 shows this token is still bonding, it was NOT graduated —
          // remove from graduatedCache in case it was mistakenly added by chain detection
          if (!coin.listed && graduatedCache.has(addrLow)) {
            graduatedCache.delete(addrLow);
            console.log(`[RECENT BONDING] Removed non-graduated token from cache: ${coin.name} (${addrLow})`);
          }

          // Graduating section also goes on the watchlist
          if (section === 'graduating' && !graduationWatchList.has(addrLow)) {
            graduationWatchList.set(addrLow, { coin, firstSeenAt: Date.now() });
          }

          if (coin.listed) {
            const mapped = mapCoin(coin, price, 'listed');
            const existing = graduatedCache.get(addrLow);
            if (existing) {
              mapped.volume24h = existing.volume24h;
              mapped.liquidity = existing.liquidity;
              mapped.dexUrl = existing.dexUrl;
              mapped.dexPaid = existing.dexPaid;
              mapped.change24h = existing.change24h;
              mapped.buys24h = existing.buys24h;
              mapped.sells24h = existing.sells24h;
              // Preserve graduation timestamp from better source
              mapped.graduatedAt = existing.graduatedAt || null;
            } else {
              // Newly detected as graduated — record detection time as graduation time
              // (DexScreener or chain detection will overwrite with exact pair creation time)
              mapped.graduatedAt = null;
            }
            graduatedCache.set(addrLow, mapped);
            graduationWatchList.delete(addrLow);
          }
        }
      }
    }

    // SOURCE 3: Direct DexScreener check on ALL known Flap.sh addresses not yet graduated.
    // This catches tokens that graduated after we saw them — regardless of which section
    // they were in. Checked in batches of 30 (DexScreener limit).
    const unknownAddrs = [...allKnownFlapAddresses.keys()].filter(a => !graduatedCache.has(a));
    if (unknownAddrs.length > 0) {
      try {
        const dexResults = await checkDexScreener(unknownAddrs);
        for (const addr of unknownAddrs) {
          const dex = dexResults[addr];
          if (dex && dex.pairCount > 0) {
            const coin = allKnownFlapAddresses.get(addr);
            const mapped = mapCoin(coin, price, 'listed');
            mapped.listed = true;
            mapped.graduated = true;
            mapped.bondProgress = 100;
            mapped.volume24h = dex.volume24h || 0;
            mapped.liquidity = dex.liquidity || 0;
            mapped.dexUrl = dex.dexUrl || null;
            mapped.dexPaid = dex.paid || false;
            mapped.change24h = dex.priceChange24h || 0;
            mapped.buys24h = dex.buys24h || 0;
            mapped.sells24h = dex.sells24h || 0;
            mapped.graduatedAt = dex.pairCreatedAt || null;
            graduatedCache.set(addr, mapped);
            console.log(`[RECENT BONDING] Graduation detected via direct check: ${coin.name} (${addr})`);
          }
        }
      } catch (err) {
        console.error('[RECENT BONDING] Direct DexScreener check error:', err.message);
      }
    }

    // SOURCE 4: BSC blockchain — watches PancakeSwap V2 factory PairCreated events
    // for any token address ending in 7777 or 8888. Catches graduations in real-time
    // even before DexScreener indexes them. On first run scans last 3 days.
    await fetchNewGraduationsFromChain(price);

    if (graduatedCache.size === 0) return;

    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;

    // Top 30 from last 30 days, sorted by graduation time (newest graduated first)
    // Filter out rugged tokens: mcap below $2,100 after graduation
    const RUG_MCAP_THRESHOLD = 2100;
    const sorted = [...graduatedCache.values()]
      .filter(t => {
        // Use graduatedAt (pair creation) as graduation timestamp; fall back to createdAt
        const gradTs = t.graduatedAt
          ? (typeof t.graduatedAt === 'number' ? Math.floor(t.graduatedAt / 1000) : Math.floor(new Date(t.graduatedAt).getTime() / 1000))
          : (t.createdAt ? Math.floor(new Date(t.createdAt).getTime() / 1000) : 0);
        if (gradTs < thirtyDaysAgo) return false;
        if ((t.mcap || 0) < RUG_MCAP_THRESHOLD && (t.mcap || 0) > 0) return false;
        return true;
      })
      .sort((a, b) => {
        // Sort by graduation time descending (most recently graduated first)
        const getGradMs = t => t.graduatedAt
          ? (typeof t.graduatedAt === 'number' ? t.graduatedAt : new Date(t.graduatedAt).getTime())
          : (t.createdAt ? new Date(t.createdAt).getTime() : 0);
        return getGradMs(b) - getGradMs(a);
      })
      .slice(0, 30);

    recentBondingTokens = sorted;

    console.log(`[RECENT BONDING] Updated: ${sorted.length} tokens (cache: ${graduatedCache.size}, dex: ${dexTokens.size})`);

    const msg = JSON.stringify({ type: 'recent_bonding', tokens: recentBondingTokens });
    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(msg);
    });
  } catch (err) {
    console.error("Recent bonding update error:", err.message);
  }
}

// Fetch once at startup
updateRecentBonding();

setInterval(async () => {
  await fetchFlapTokens();
  await updateRecentBonding();

  const newMsg = cachedNewTokens.length > 0 ? JSON.stringify({ type: "tokens_update", tokens: cachedNewTokens }) : null;
  const bondMsg = cachedBondingTokens.length > 0 ? JSON.stringify({ type: "tokens_update", tokens: cachedBondingTokens }) : null;

  wss.clients.forEach((client) => {
    if (client.readyState !== 1 || !client._channel) return;
    if (client._channel === "bonding" && bondMsg) {
      client.send(bondMsg);
    } else if (client._channel === "new" && newMsg) {
      client.send(newMsg);
    }
  });
}, 15000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[flap-server] serving on port ${PORT}`);
  fetchFlapTokens();
});
