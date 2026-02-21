
# ![A preview of the BubbleFlap application](./public/logo.png) BubbleFlap — Real-Time Token Bubble Visualizer


<div align="center">

![BubbleFlap](https://img.shields.io/badge/BubbleFlap-Token%20Visualizer-blueviolet?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?style=for-the-badge&logo=express&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-10+-316192?style=for-the-badge&logo=postgresql&logoColor=white)
![WebSocket](https://img.shields.io/badge/WebSocket-Real--Time-orange?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

**A stunning real-time token visualizer for the BSC/BNB blockchain.**

**Watch tokens come alive as physics-based floating bubbles — sized by market cap, updated in real-time.**

[Live Demo](https://bubbleflap.fun) · [Report Bug](https://github.com/bubbleflap/BubbleFlap-RealtimeTokenBubble-WebApplication/issues) · [Request Feature](https://github.com/bubbleflap/BubbleFlap-RealtimeTokenBubble-WebApplication/issues) [**WE LOVE FLAP.SH**](https://flap.sh/)

</div>

![A preview of the BubbleFlap application](./public/12.jpg)
---

## ✨ Features

### 🫧 Interactive Bubble Canvas
- **Physics-based floating bubbles** with drift, repulsion, and center gravity
- **Market cap-based sizing** — bigger bubbles = bigger market cap
- **Scroll-to-zoom**, drag-to-pan, pinch-to-zoom on mobile
- **Smooth organic movement** inspired by wump.fun
- **BFLAPSWAP** - Decentralized Token Exchange

### 📊 Real On-Chain Data
- Live token data from **Flap.sh GraphQL API** (BSC/BNB chain)
- **Market Cap, Price, Holders, Dev Hold %, Burn %, Tax** — all real blockchain data
- BNB price from **Binance API** for accurate USD conversion
- Token images via **IPFS/Pinata** gateway

### 📱 Multiple Views
| View | Description |
|------|-------------|
| **New Tokens** | Freshly created tokens with NEW detection (15s glow animation) |
| **Bonding** | Tokens in the bonding curve phase |
| **Dex Paid** | Tokens with paid DexScreener profiles |
| **Whitepaper** | Project documentation and vision |

### 🤖 AI Chatbot — Bot Bubble Flap
- Powered by **Claude Sonnet**
- Token analysis, contract address lookup
- Rich token cards with on-chain data
- Multilingual support (English / 中文)

### 🔥 NEW Token Detection
- Newly created tokens appear as **max-size centered bubbles**
- **Red pulsing glow** + "NEW" badge for 15 seconds
- Multiple new tokens spread in grid layout to avoid overlap

### 🔁 BFLAPSWAP - Decentralized Token Exchange

A fast, efficient, and fully integrated token swap interface built for the BNB Smart Chain. It allows users to trade any BEP-20 token directly within the BubbleFlap ecosystem.

#### Core Swap Functionality
- **Seamless Swapping**: Trade any BEP-20 token for another on the BNB Smart Chain.
- **Real-time Data**: Fetches live price quotes, liquidity, and balance information.
- **Wallet Integration**: Connects securely with Web3 wallets like MetaMask, Trust Wallet, etc.
- **Transaction Previews**: Clearly displays `Price Impact`, `Minimum Received`, and `Liquidity Provider Fee` before you confirm.
- **Swap** ungraduated and graduated token from flap.sh

#### 🧠 Smart Routing & Controls
- **Multi-Hop Routing**: Finds the most efficient path for your trade by routing through multiple liquidity pools (e.g., `TOKEN A` -> `WBNB` -> `TOKEN B`) to guarantee the best possible price. This can be toggled on or off.
- **Customizable Slippage**: Set your slippage tolerance (e.g., 0.1%, 0.5%, 1.0%) to protect against price volatility.
- **Transaction Deadline**: Configure a time limit to prevent pending transactions from executing at an unfavorable price later.

#### 💻 Technology & Integration
- **Frontend Framework**: Built with **React/Next.js** for a fast and responsive user experience.
- **Blockchain Interaction**: Utilizes **ethers.js / viem** for robust communication with the BNB Smart Chain.
- **Liquidity Source**: Integrates directly with **PancakeSwap's Router and SDK** to tap into the largest liquidity pools on BSC.
- **Wallet Connectivity**: Powered by standard libraries like **Wagmi/Web3-React** for broad wallet compatibility.
### 🌐 Additional Features
- **Click-to-copy** contract address with toast notification
- **DexScreener** badge and quick link
- **BOND/DEX** status badges
- **Responsive design** for desktop, tablet, and mobile
- **Multilingual** — English and Chinese (中文 default)
- **Dark theme** with glassmorphism UI

---

## 🏗️ Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Node.js + Express.js |
| **Real-Time** | WebSocket (ws library) |
| **Database** | PostgreSQL |
| **Frontend** | React 19 + TypeScript + Tailwind CSS |
| **Data Source** | Flap.sh GraphQL API (BSC/BNB chain) |
| **AI** | Claude Sonnet |
| **Price Feed** | Binance API |
| **Images** | IPFS via Pinata gateway |

---

## 🚀 Quick Start

### Prerequisites
- **Node.js** 18+ installed
- **PostgreSQL** database
- (Optional) *Claude API key** for AI chatbot

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
ADMIN_PASSWORD=your_secure_password
CLAUDE_API_KEY=sk-or-v1-your-key  # Optional
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
├── app.js              # Main server (Express + WebSocket + API)
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
| `/api/new-tokens` | GET | New/unbonded tokens for bubble canvas |
| `/api/bonding-tokens` | GET | Tokens in bonding curve phase |
| `/api/bonded-tokens` | GET | Graduated/DEX-listed tokens |
| `/api/dexpaid-tokens` | GET | Tokens with paid DexScreener profiles |
| `/api/tokens` | GET | All token data combined |
| `/api/settings` | GET/POST | Site settings (admin protected) |
| `/api/admin/login` | POST | Admin authentication |
| `/api/admin/visitors` | GET | Visitor traffic data (admin protected) |
| `/api/chat` | POST | AI chatbot endpoint |
| `/ws` | WebSocket | Real-time token updates |

### WebSocket Protocol
Connect to `/ws` and subscribe to channels:
```json
{ "type": "subscribe", "channel": "new" }
{ "type": "subscribe", "channel": "bonding" }
```

Server pushes updates every ~15 seconds:
```json
{ "type": "new-tokens", "data": [...] }
{ "type": "bonding-tokens", "data": [...] }
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
| `ADMIN_PASSWORD` | Yes | Password for admin panel access |
| `CLAUDE_API_KEY` | No | CLAUDE API key for AI chatbot |
| `PORT` | No | Server port (default: 3001) |
| `NODE_ENV` | No | Set to `production` for production mode |

### Admin Panel
Access the admin panel by clicking the admin icon in the header. Use your `ADMIN_PASSWORD` to log in.

From the admin panel you can:
- View real-time visitor traffic and charts
- Update site settings (contract address, social links)
- Monitor online users

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

> All data is real on-chain data from the BSC/BNB blockchain, matching BscScan.

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
