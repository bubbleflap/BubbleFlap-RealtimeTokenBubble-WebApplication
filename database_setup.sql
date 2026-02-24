-- Bubble Flap Database Setup v2.0
-- Run this SQL on your PostgreSQL database to create the required tables

-- Site Settings table
CREATE TABLE IF NOT EXISTS site_settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Default settings
INSERT INTO site_settings (key, value) VALUES
  ('ca_address', '0x000000000000000000000000'),
  ('telegram', 'https://t.me/BubbleFlap'),
  ('twitter', 'https://x.com/BubbleFlapFun'),
  ('github', 'https://github.com/bubbleflap'),
  ('email', 'dev@bubbleflap.fun'),
  ('bflap_link', 'https://flap.sh/bnb/0x'),
  ('flapsh_link', 'https://flap.sh/bnb/board')
ON CONFLICT (key) DO NOTHING;

-- Site Visitors table (traffic tracking)
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
);

-- Indexes for site_visitors
CREATE INDEX IF NOT EXISTS idx_site_visitors_visitor_id ON site_visitors (visitor_id);
CREATE INDEX IF NOT EXISTS idx_site_visitors_ip_hash ON site_visitors (ip_hash);
CREATE INDEX IF NOT EXISTS idx_site_visitors_last_seen ON site_visitors (last_seen);
CREATE INDEX IF NOT EXISTS idx_site_visitors_created_at ON site_visitors (created_at);
CREATE INDEX IF NOT EXISTS idx_site_visitors_country ON site_visitors (country);

-- Cached New Tokens table (for 100-token display cap)
CREATE TABLE IF NOT EXISTS cached_new_tokens (
  address VARCHAR(100) PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cached_new_tokens_updated ON cached_new_tokens (updated_at);

-- DexPaid Detection table (persists first-detection timestamps)
CREATE TABLE IF NOT EXISTS dex_paid_detected (
  address VARCHAR(100) PRIMARY KEY,
  detected_at BIGINT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Volume Bot Campaigns table
CREATE TABLE IF NOT EXISTS volume_bot_campaigns (
  id SERIAL PRIMARY KEY,
  token_address VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  config JSONB NOT NULL,
  progress JSONB DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vb_campaigns_status ON volume_bot_campaigns (status);
CREATE INDEX IF NOT EXISTS idx_vb_campaigns_created ON volume_bot_campaigns (created_at);

-- Volume Bot Wallets table
CREATE TABLE IF NOT EXISTS volume_bot_wallets (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER REFERENCES volume_bot_campaigns(id),
  address VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vb_wallets_campaign ON volume_bot_wallets (campaign_id);
