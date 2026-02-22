# 🚀 BubbleFlap Deployment Guide

This guide covers deploying BubbleFlap to various hosting platforms.

---

## 📋 Prerequisites

Before deploying, ensure you have:
- **Node.js 18+** available on your hosting
- A **PostgreSQL** database (version 10+)
- Your environment variables ready (see `.env.example`)

---

## 🖥️ Option 1: VPS / Cloud Server

Works with: **DigitalOcean, AWS EC2, Linode, Vultr, Hetzner**, or any Linux VPS.

### Step 1: Set Up the Server

```bash
# SSH into your server
ssh user@your-server-ip

# Install Node.js 18+ (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PostgreSQL
sudo apt-get install -y postgresql postgresql-contrib
```

### Step 2: Create Database

```bash
sudo -u postgres psql

# Inside PostgreSQL:
CREATE USER bubbleflap WITH PASSWORD 'your_secure_password';
CREATE DATABASE bubbleflap OWNER bubbleflap;
\q

# Run the schema setup
psql -U bubbleflap -d bubbleflap -f database_setup.sql
```

### Step 3: Deploy the Application

```bash
# Clone the repository
git clone https://github.com/bubbleflap/BubbleFlap-RealtimeTokenBubble-WebApplication.git
cd BubbleFlap-RealtimeTokenBubble-WebApplication

# Install dependencies
npm install

# Create environment file
cp .env.example .env
nano .env  # Edit with your values
```

### Step 4: Set Up Process Manager (PM2)

```bash
# Install PM2 globally
npm install -g pm2

# Start the application
pm2 start app.js --name bubbleflap

# Set PM2 to start on system boot
pm2 startup
pm2 save
```

### Step 5: Set Up Nginx Reverse Proxy (Recommended)

```nginx
# /etc/nginx/sites-available/bubbleflap
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Enable the site
sudo ln -s /etc/nginx/sites-available/bubbleflap /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# (Optional) Add SSL with Let's Encrypt
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

---

## 🚂 Option 2: Railway

[Railway](https://railway.app) offers easy one-click deployment with built-in PostgreSQL.

### Step 1: Create a Railway Project
1. Go to [railway.app](https://railway.app) and sign in
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your BubbleFlap repository

### Step 2: Add PostgreSQL
1. Click **"+ New"** → **"Database"** → **"PostgreSQL"**
2. Railway automatically sets the `DATABASE_URL` variable

### Step 3: Set Environment Variables
In your Railway project settings, add:
- `ADMIN_PASSWORD` = your_password
- `OPENROUTER_API_KEY` = your_key (optional)
- `NODE_ENV` = production
- `PORT` = 3001

### Step 4: Deploy
Railway auto-deploys when you push to GitHub. Your app will be live at `yourapp.up.railway.app`.

---

## 🎨 Option 3: Render

[Render](https://render.com) offers free tier hosting with PostgreSQL support.

### Step 1: Create a Web Service
1. Go to [render.com](https://render.com) and sign in
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository

### Step 2: Configure the Service
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Environment**: Node

### Step 3: Add PostgreSQL
1. Click **"New +"** → **"PostgreSQL"**
2. Copy the **Internal Database URL**
3. Add it as `DATABASE_URL` in your web service environment variables

### Step 4: Set Environment Variables
Add these in the Render dashboard:
- `DATABASE_URL` = (from PostgreSQL service)
- `ADMIN_PASSWORD` = your_password
- `OPENROUTER_API_KEY` = your_key (optional)
- `NODE_ENV` = production

---

## 🦋 Option 4: Fly.io

[Fly.io](https://fly.io) offers edge deployment with PostgreSQL.

### Step 1: Install Fly CLI
```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

### Step 2: Launch App
```bash
cd BubbleFlap-RealtimeTokenBubble-WebApplication
fly launch
```

### Step 3: Create PostgreSQL Database
```bash
fly postgres create --name bubbleflap-db
fly postgres attach bubbleflap-db
```

### Step 4: Set Secrets
```bash
fly secrets set ADMIN_PASSWORD=your_password
fly secrets set OPENROUTER_API_KEY=your_key
fly secrets set NODE_ENV=production
```

### Step 5: Deploy
```bash
fly deploy
```

---

## 🔧 Post-Deployment Checklist

After deploying, verify these work:

- [ ] Homepage loads with floating token bubbles
- [ ] Tokens update in real-time (watch for new bubbles appearing)
- [ ] Click on a bubble → tooltip shows token details
- [ ] Switch between New / Bonding / Dex Paid views
- [ ] Admin panel login works (`/admin` or admin icon)
- [ ] AI chatbot responds (requires `OPENROUTER_API_KEY`)
- [ ] WebSocket connection is active (check browser console)

---

## 🔄 Updating

To update your deployment after making changes:

### VPS with PM2:
```bash
cd BubbleFlap-RealtimeTokenBubble-WebApplication
git pull
npm install  # Only if dependencies changed
pm2 restart bubbleflap
```

### Railway / Render:
Just push to GitHub — auto-deploys.

### Fly.io:
```bash
fly deploy
```

---

## ❓ Troubleshooting

| Issue | Solution |
|-------|---------|
| Tokens not loading | Check that Flap.sh API (`bnb.taxed.fun`) is accessible from your server |
| Database connection error | Verify `DATABASE_URL` is correct and PostgreSQL is running |
| WebSocket not connecting | Ensure your reverse proxy (Nginx) supports WebSocket upgrades |
| AI chatbot not responding | Check `CLAUDE_API_KEY` is set and valid |
| Admin login failing | Verify `ADMIN_PASSWORD` environment variable is set |

---

## 📞 Support

If you run into issues:
- Open an [issue on GitHub](https://github.com/bubbleflap/BubbleFlap-RealtimeTokenBubble-WebApplication/issues)
- Join our [Telegram](https://t.me/BubbleFlap)

---

<div align="center">

**Happy deploying! 🫧**

</div>
