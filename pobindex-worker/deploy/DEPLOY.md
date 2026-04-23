# POB Index — production deploy

This stack mirrors [rewardflow/deploy/DEPLOY.md](../../rewardflow/deploy/DEPLOY.md): **Nginx** terminates TLS and proxies to Node; **PM2** keeps processes alive.

## 1. Build the dashboard

From the repo root:

```bash
cd POBINDEX
npm install
npm run build
```

`dist/` is the static UI. The worker writes `POBINDEX/public/pobindex-data.json` (or `POBINDEX_DATA_JSON`).

## 2. Configure the worker

```bash
cd pobindex-worker
cp .env.example .env
# Edit .env: HELIUS_API_KEY, TREASURY_PRIVATE_KEY, INDEX_MINT,
# PRINTR_BEARER_TOKEN (JWT), PRINTR_ALLOWLIST_PATH or PRINTR_DISCOVERY_IDS
```

Printr’s preview API is described in **`printr-api.json`** (default `servers[0].url`). There is no token-list route; the worker calls **`GET /tokens/{id}`** and **`GET /tokens/{id}/deployments`** for each seed (`mint` → CAIP-10 Solana id, or `telecoinId`). Optional local auth: add a root key `"pobWorker": { "bearerToken": "…" }` to the same JSON (keep the file private if you do).

Use Node **20+** on the server (required by `better-sqlite3` and Helius SDK).

```bash
npm install
mkdir -p logs data
```

## 3. PM2 (UI + API)

```bash
sudo npm install -g pm2
cd pobindex-worker
mkdir -p logs
pm2 start deploy/ecosystem.config.js --env production
pm2 save
pm2 startup   # run the printed command with sudo
```

**pobindex-serve** — Express serves `POBINDEX/dist` and `GET /api/pobindex` reads the snapshot JSON from `POBINDEX_DATA_JSON`.

## 3b. Cron — rewards cycle (one-shot)

PM2 is best for long-running processes. Schedule the worker with system cron (example: every 6 hours):

```cron
15 */6 * * * cd /var/www/refi/pobindex-worker && /usr/bin/node scripts/run-cycle.js >> logs/cycle.log 2>&1
```

Dry run: `node scripts/run-cycle.js --dry-run`

## 4. Nginx example

```nginx
server {
    listen 443 ssl http2;
    server_name pobindex.example.com;

    ssl_certificate     /etc/letsencrypt/live/pobindex.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pobindex.example.com/privkey.pem;

    location /api/ {
        proxy_pass http://127.0.0.1:3050;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location / {
        root /var/www/refi/POBINDEX/dist;
        try_files $uri $uri/ /index.html;
    }
}
```

For the UI to load `/api/pobindex`, build with `VITE_USE_API=1`:

```bash
cd POBINDEX && VITE_USE_API=1 npm run build
```

Alternatively keep the default `pobindex-data.json` in `dist/` by copying the worker output into `dist/` after each cycle (same path as `public/` during dev).

## 5. Logs

PM2 writes to `pobindex-worker/logs/`. Inspect with `pm2 logs pobindex-cycle --lines 100`.
