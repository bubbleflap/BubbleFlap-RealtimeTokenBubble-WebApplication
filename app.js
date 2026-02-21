const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const pg = require("pg");
const crypto = require("crypto");

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

const knownNewlyCreated = new Set();
const newlyDetectedTimestamps = new Map();
let isFirstFetch = true;

let bnbPrice = 600;
let lastPriceFetch = 0;

const dexCache = new Map();
const DEX_CACHE_TTL = 120000;
const dexPaidDetectedAtMap = new Map();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS site_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      INSERT INTO site_settings (key, value) VALUES 
        ('ca_address', '0x000000000000000000000000'),
        ('telegram', 'https://t.me/BubbleFlap'),
        ('twitter', 'https://x.com/BubbleFlapFun'),
        ('github', 'https://github.com/bubbleflap'),
        ('email', 'dev@bubbleflap.fun'),
        ('bflap_link', 'https://flap.sh/bnb/0x'),
        ('flapsh_link', 'https://flap.sh/bnb/board')
      ON CONFLICT (key) DO NOTHING
    `);
    await pool.query(`
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
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_site_visitors_visitor_id ON site_visitors (visitor_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_site_visitors_ip_hash ON site_visitors (ip_hash)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_site_visitors_last_seen ON site_visitors (last_seen)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_site_visitors_created_at ON site_visitors (created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_site_visitors_country ON site_visitors (country)`);
  } catch (err) {
    console.error("DB init error:", err.message);
  }
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

const LISTED_COINS_QUERY = `{
  coins(options: { listed: true, hideListed: false, duel: false, asc: false, limit: 100, offset: 0, sort: 0 }) {
    ${COIN_FIELDS}
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
            dexCache.set(addr.toLowerCase(), {
              time: now,
              paid: hasPaid,
              pairCount: tokenPairs.length,
              priceUsd: tokenPairs[0]?.priceUsd || null,
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
    result[addr.toLowerCase()] = cached || { paid: false, pairCount: 0, priceUsd: null };
  }
  return result;
}

function calcPrice(coin, bnb) {
  const supply = parseFloat(coin.supply) || 0;
  const mcapBnb = parseFloat(coin.marketcap) || 0;
  if (supply > 0 && mcapBnb > 0) {
    return (mcapBnb / supply) * bnb;
  }
  return 0;
}

const BURN_ADDRESS = "0x000000000000000000000000000000000000dead";
const TOTAL_SUPPLY = 1_000_000_000;

function calcBurnPercent(coin) {
  if (!coin.holders || !Array.isArray(coin.holders)) return 0;
  const burnHolder = coin.holders.find((h) => h.holder?.toLowerCase() === BURN_ADDRESS);
  if (!burnHolder) return 0;
  const burnAmount = parseFloat(burnHolder.amount) || 0;
  return (burnAmount / TOTAL_SUPPLY) * 100;
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
  };
}

async function fetchFlapTokens() {
  const now = Date.now();
  if (cachedTokens.length > 0 && now - lastFetchTime < CACHE_TTL) {
    return cachedTokens;
  }

  try {
    const [data, listedData, price] = await Promise.all([
      queryFlap(BOARD_QUERY),
      queryFlap(LISTED_COINS_QUERY).catch(err => {
        console.error("Listed coins query error:", err.message);
        return null;
      }),
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

    if (listedData?.coins) {
      for (const coin of listedData.coins) {
        if (!seen.has(coin.address)) {
          seen.add(coin.address);
          allCoins.push({ coin, section: "listed" });
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

app.use(express.static("public"));

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

setInterval(async () => {
  await fetchFlapTokens();

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
