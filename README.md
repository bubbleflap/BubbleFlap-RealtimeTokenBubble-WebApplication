# ![A preview of the BubbleFlap application](./public/logo.png) BubbleFlap — Real-Time Token Bubble Visualizer

<div align="center">

![BubbleFlap](https://img.shields.io/badge/BubbleFlap-Token%20Visualizer-blueviolet?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?style=for-the-badge&logo=express&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-10+-316192?style=for-the-badge&logo=postgresql&logoColor=white)
![WebSocket](https://img.shields.io/badge/WebSocket-Real--Time-orange?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

[get $BFLAP](https://bubbleflap.fun/bswap)

**A stunning real-time token visualizer and trading platform for the BSC/BNB blockchain.**

**0xa2320fff1069ed5b4b02ddb386823e837a7e7777**

**Watch tokens come alive as physics-based floating bubbles — sized by market cap, updated in real-time.**

[Live Demo](https://bubbleflap.fun) · [Report Bug](https://github.com/bubbleflap/BubbleFlap-RealtimeTokenBubble-WebApplication/issues) · [Request Feature](https://github.com/bubbleflap/BubbleFlap-RealtimeTokenBubble-WebApplication/issues) [**WE LOVE FLAP.SH**](https://flap.sh/)

</div>

![A preview of the BubbleFlap application](./public/13.png)
![A preview of the BubbleFlap application](./public/14.png)
![A preview of the BubbleFlap application](./public/15.png)
![A preview of the BubbleFlap application](./public/16.png)
![A preview of the BubbleFlap application](./public/17.png)
---

## ✨ Features

### 🫧 Interactive Bubble Canvas
- **Physics-based floating bubbles** with drift, repulsion, and center gravity
- **Market cap-based sizing** — bigger bubbles = bigger market cap
- **Direct DOM rendering via requestAnimationFrame** for smooth 60fps animation across 100+ tokens
- **Scroll-to-zoom**, drag-to-pan, pinch-to-zoom on mobile
- **Smooth organic movement** inspired by wump.fun
- **Database-backed token caching** — up to 100 tokens displayed (live API + DB history)

### 📊 Real On-Chain Data
- Live token data from **Flap.sh GraphQL API** (BSC/BNB chain)
- **On-chain graduation detection** via LaunchedToDEX events from Flap.sh Portal contract
- **DexScreener data enrichment** — live market cap, volume, liquidity for all graduated tokens
- **Market Cap, Price, Holders, Dev Hold %, Burn %, Tax** — all real blockchain data
- BNB price from **Binance API** for accurate USD conversion
- Token images via **IPFS/Pinata** gateway
- **Scam/rug filter** — tokens under $3K mcap auto-removed from graduated list

### 📱 Multiple Views
| View | Description |
|------|-------------|
| **New Tokens** | Up to 100 freshly created tokens with NEW detection (15s glow animation), database caching for history |
| **Recent Bonding** | Top 60 recently graduated tokens detected via on-chain LaunchedToDEX events, enriched with DexScreener data |
| **Dex Paid** | Dual-source discovery: Flap.sh API + DexScreener search, merged and deduplicated |
| **BFlapSwap** | Built-in DEX aggregator for instant token swapping |
| **Volume Bot** | Automated volume generation tool with gas optimization |
| **Whitepaper** | Project documentation, vision, and roadmap |

### 🤖 AI Chatbot — Bot Bubble Flap
- Powered by **Claude AI** (Anthropic)
- Token analysis, contract address lookup
- Rich token cards with on-chain data
- Quick Swap button — opens BFlapSwap with token pre-filled
- Multilingual support (English / 中文)

### 🔥 NEW Token Detection
- Newly created tokens appear as **max-size centered bubbles**
- **Red pulsing glow** + "NEW" badge for 15 seconds
- Multiple new tokens spread in grid layout to avoid overlap

### 🔁 BFlapSwap — Decentralized Token Exchange

A fast, efficient, and fully integrated token swap interface built for the BNB Smart Chain. It allows users to trade any BEP-20 token directly within the BubbleFlap ecosystem.

#### Core Swap Functionality
- **Seamless Swapping**: Trade any BEP-20 token for another on the BNB Smart Chain.
- **Real-time Data**: Fetches live price quotes, liquidity, and balance information.
- **Wallet Integration**: Connects securely with MetaMask, Trust Wallet, OKX Wallet, and Binance Wallet.
- **Transaction Previews**: Clearly displays `Price Impact`, `Minimum Received`, and `Liquidity Provider Fee` before you confirm.
- **Swap** ungraduated and graduated tokens from flap.sh
- **Quick Swap** from tooltips and chatbot — pre-fills token in BFlapSwap

#### 🧠 Smart Routing & Controls
- **Multi-Hop Routing**: Finds the most efficient path for your trade by routing through multiple liquidity pools (e.g., `TOKEN A` -> `WBNB` -> `TOKEN B`) to guarantee the best possible price. This can be toggled on or off.
- **Customizable Slippage**: Set your slippage tolerance (e.g., 0.1%, 0.5%, 1.0%) to protect against price volatility.
- **Transaction Deadline**: Configure a time limit to prevent pending transactions from executing at an unfavorable price later.

#### 💻 Technology & Integration
- **Frontend Framework**: Built with **React 19 + TypeScript** for a fast and responsive user experience.
- **Blockchain Interaction**: Utilizes **ethers.js** for robust communication with the BNB Smart Chain.
- **Liquidity Source**: Integrates directly with **PancakeSwap V2 Router** to tap into the largest liquidity pools on BSC.
- **Wallet Connectivity**: Supports MetaMask, Trust Wallet, OKX Wallet, and Binance Wallet.

### 📈 Volume Bot

An automated volume generation tool for BSC tokens. Create natural-looking trading activity with configurable parameters.

- **Wallet Management**: Import your wallet to fund the bot. Keys are stored locally and never shared.
- **Configurable Parameters**: Set token contract address, buy/sell amounts (min/max BNB range), interval between trades, and number of rounds.
- **Gas Optimization**: Uses optimized gas settings by default and automatically adjusts to match blockchain network conditions when needed. Smart routing through PancakeSwap V2.
- **Execution Control**: Start and stop campaigns at any time. Real-time status updates show completed rounds, BNB spent, and current progress.
- **Campaign History**: All campaigns tracked in database for reference.

### 🌐 Additional Features
- **Click-to-copy** contract address with toast notification
- **DexScreener** badge and quick link
- **BOND/DEX** status badges
- **Ave.ai logo verification** badge via Moralis API
- **Responsive design** for desktop, tablet, and mobile
- **Multilingual** — English and Chinese (中文)
- **Dark theme** with glassmorphism UI
- **Drag-to-resize** Recent Bonding panel (280px to 600px)
- **Channel-based WebSocket** subscriptions per page

---

## 🏗️ Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Node.js + Express.js |
| **Real-Time** | WebSocket (ws library) with channel subscriptions |
| **Database** | PostgreSQL |
| **Frontend** | React 19 + TypeScript + Vite 6 + Tailwind CSS v4 |
| **Data Source** | Flap.sh GraphQL API + BSC on-chain events + DexScreener API |
| **AI** | Claude AI (Anthropic) |
| **Price Feed** | Binance API |
| **Swap Engine** | PancakeSwap V2 Router via ethers.js |
| **Images** | IPFS via Pinata gateway |

---

## 🚀 Quick Start

### Prerequisites
- **Node.js** 18+ installed
- **PostgreSQL** database
- (Optional) **Claude API key** for AI chatbot

### 1. Clone the Repository
```bash
git clone https://github.com/bubbleflap/BubbleFlap-RealtimeTokenBubble-WebApplication.git
cd BubbleFlap-RealtimeTokenBubble-WebApplication
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Set Up Environment Variables
```bash
cp .env.example .env
```

Edit `.env` with your values:
```env
DATABASE_URL=postgresql://user:password@localhost:5432/bubbleflap
CLAUDE_API_KEY=your-claude-api-key  # Optional, for AI chatbot
MORALIS_API_KEY=your_moralis_key       # Optional, for Ave.ai logo detection
PORT=3001
NODE_ENV=production
```

### 4. Set Up Database
Run the SQL setup script on your PostgreSQL database:
```bash
psql -U your_user -d bubbleflap -f database_setup.sql
```

### 5. Start the Server
```bash
npm start
```

Your BubbleFlap instance will be running at `http://localhost:3001` 🎉

---

## 📁 Project Structure

```
BubbleFlap/
├── app.js              # Main server (Express + WebSocket + API + Volume Bot)
├── public/             # Built frontend files
│   ├── index.html      # Main HTML entry point
│   ├── favicon.png     # Site favicon
│   ├── social.jpg      # Social media preview image
│   └── assets/         # JS, CSS, and image assets
├── database_setup.sql  # Database schema setup
├── package.json        # Dependencies
├── .env.example        # Environment variable template
└── README.md           # This file
```

---

## 🔌 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/new-tokens` | GET | New/unbonded tokens for bubble canvas (up to 100) |
| `/api/bonding-tokens` | GET | Tokens in bonding curve phase |
| `/api/bonded-tokens` | GET | Graduated/DEX-listed tokens |
| `/api/recent-bonding` | GET | Top 60 recently graduated tokens with DexScreener data |
| `/api/dexpaid-tokens` | GET | Tokens with paid DexScreener profiles (dual-source) |
| `/api/tokens` | GET | All token data combined |
| `/api/chat` | POST | AI chatbot endpoint |
| `/api/volume-bot/*` | Various | Volume bot campaign management |
| `/ws` | WebSocket | Real-time token updates |

### WebSocket Protocol
Connect to `/ws` and subscribe to channels:
```json
{ "type": "subscribe", "channel": "new" }
{ "type": "subscribe", "channel": "bonding" }
```

Server pushes updates every ~15 seconds:
```json
{ "type": "tokens_update", "tokens": [...] }
{ "type": "recent_bonding", "tokens": [...] }
```

---

## 🌍 Deployment

See the full [Deployment Guide](DEPLOYMENT.md) for detailed instructions on deploying to:
- **VPS / Cloud Server** (DigitalOcean, AWS, Linode, Vultr)
- **Railway / Render / Fly.io**
- **Any Node.js hosting**

---

## ⚙️ Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `CLAUDE_API_KEY` | No | Claude API key for AI chatbot |
| `MORALIS_API_KEY` | No | Moralis API key for Ave.ai logo detection |
| `PORT` | No | Server port (default: 3001) |
| `NODE_ENV` | No | Set to `production` for production mode |

---

## 🧮 Token Data Explained

| Field | Source | Calculation |
|-------|--------|-------------|
| **Market Cap** | On-chain BNB reserves × Binance BNB/USD price | Real-time |
| **Price** | Market cap ÷ circulating supply | Real-time |
| **Dev Hold %** | Creator wallet balance ÷ 1,000,000,000 total supply | On-chain |
| **Burn %** | Dead address (0x...dead) balance ÷ 1,000,000,000 total supply | On-chain |
| **Holders** | Flap.sh API holder count | Real-time |
| **Tax** | Smart contract buy/sell tax | On-chain |
| **Volume 24h** | DexScreener API (graduated tokens) | Real-time |
| **Liquidity** | DexScreener API (graduated tokens) | Real-time |

> All data is real on-chain data from the BSC/BNB blockchain, matching BscScan.

---

## 🔄 What's New in v2.0

- **On-chain graduation detection** — scans BSC blockchain for LaunchedToDEX events every 15 seconds
- **DexScreener data enrichment** — all graduated tokens get live mcap, volume, liquidity data
- **100-token New page** — database caching keeps token history, live API always takes priority
- **Volume Bot** — automated buy/sell volume generation with gas optimization
- **BFlapSwap** — built-in DEX aggregator with wallet connection
- **Dual-source DexPaid** — Flap.sh API + DexScreener search, merged and deduplicated
- **Scam filter** — tokens under $3K mcap auto-removed from graduated list
- **Channel-based WebSocket** — each page subscribes to its own data channel

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

## 🤝 Contributing

Contributions are welcome! Feel free to:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 💬 Community

- **Website**: [bubbleflap.fun](https://bubbleflap.fun)
- **Telegram**: [t.me/BubbleFlap](https://t.me/BubbleFlap)
- **Twitter/X**: [@BubbleFlapFun](https://x.com/BubbleFlapFun)

---

<div align="center">

**Built with 💜 by the BubbleFlap team**

*Real tokens. Real data. Real bubbles.*

</div>
