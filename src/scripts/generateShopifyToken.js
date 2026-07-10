/**
 * Shopify OAuth Access Token Generator
 *
 * Usage:
 *   npm run shopify-auth
 *
 * What it does:
 *   1. Validates SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_STORE_URL are set in .env
 *   2. Builds and prints the Shopify authorization URL
 *   3. Starts a local server on port 3000 to capture the OAuth callback automatically
 *   4. Exchanges the authorization code for a permanent access token (shpat_...)
 *   5. Saves the token to SHOPIFY_ACCESS_TOKEN in your .env file
 *
 * Prerequisites:
 *   - Create a Shopify app at: https://partners.shopify.com
 *     OR via: Shopify Admin > Settings > Apps > Develop Apps > Create App
 *   - Set Redirect URI in app settings to: http://localhost:3000/auth/callback
 *   - Required Admin API scopes: read_orders, write_orders, read_products, write_products
 *   - Fill in .env: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_STORE_URL
 */

require('dotenv').config();
const http     = require('http');
const crypto   = require('crypto');
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const { config } = require('../config/config');
const logger   = require('../utils/logger');

const REQUIRED_SCOPES = [
  'read_all_orders', 'read_orders', 'write_orders',
  'read_products', 'write_products',
  'read_fulfillments', 'write_fulfillments',
  'read_locations', 'write_merchant_managed_fulfillment_orders',
  'write_returns',
].join(',');

// ── Build OAuth URL ───────────────────────────────────────────────────────────
function buildAuthorizationUrl() {
  const nonce  = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id:    config.shopify.apiKey,
    scope:        REQUIRED_SCOPES,
    redirect_uri: config.shopify.redirectUri,
    state:        nonce,
    'grant_options[]': 'per-user',
  });
  return { url: `https://${config.shopify.storeUrl}/admin/oauth/authorize?${params.toString()}`, nonce };
}

// ── HMAC validation ───────────────────────────────────────────────────────────
function validateHmac(queryParams) {
  const { hmac, ...rest } = queryParams;
  if (!hmac) return false;
  const message = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('&');
  const digest  = crypto.createHmac('sha256', config.shopify.apiSecret).update(message).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

// ── Exchange code for token ───────────────────────────────────────────────────
async function exchangeCodeForToken(shop, code) {
  logger.info(`Exchanging code for access token from: ${shop}`);
  const res = await axios.post(`https://${shop}/admin/oauth/access_token`, {
    client_id: config.shopify.apiKey, client_secret: config.shopify.apiSecret, code,
  });
  const { access_token, scope } = res.data;
  if (!access_token) throw new Error('No access_token returned from Shopify');
  logger.success(`Access token received! Scopes granted: ${scope}`);
  return access_token;
}

// ── Save token to .env ────────────────────────────────────────────────────────
function saveTokenToEnv(token) {
  const envPath = path.join(process.cwd(), '.env');
  let content   = fs.readFileSync(envPath, 'utf8');
  content = content.includes('SHOPIFY_ACCESS_TOKEN=')
    ? content.replace(/SHOPIFY_ACCESS_TOKEN=.*/, `SHOPIFY_ACCESS_TOKEN=${token}`)
    : content + `\nSHOPIFY_ACCESS_TOKEN=${token}\n`;
  fs.writeFileSync(envPath, content, 'utf8');
  logger.success('Token saved to .env file.');
}

// ── Local callback server ─────────────────────────────────────────────────────
function waitForCallback(expectedNonce) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url.startsWith('/auth/callback')) { res.writeHead(404); res.end('Not found'); return; }
      const params = Object.fromEntries(new URL(req.url, 'http://localhost:3000').searchParams.entries());
      if (params.state !== expectedNonce) { res.writeHead(400); res.end('Invalid state.'); server.close(); return reject(new Error('CSRF failed')); }
      if (!validateHmac(params))          { res.writeHead(400); res.end('HMAC failed.');   server.close(); return reject(new Error('HMAC failed')); }
      try {
        const token = await exchangeCodeForToken(params.shop, params.code);
        saveTokenToEnv(token);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2 style="color:green">✓ Token Generated!</h2><p>Saved to .env. Close this tab.</p></body></html>`);
        server.close(); resolve(token);
      } catch (err) { res.writeHead(500); res.end(err.message); server.close(); reject(err); }
    });
    server.listen(3000, () => logger.info('Callback server listening on http://localhost:3000/auth/callback'));
    server.on('error', err => reject(new Error(`Server error: ${err.message}`)));
    setTimeout(() => { server.close(); reject(new Error('Timeout: no callback in 5 minutes')); }, 5 * 60 * 1000);
  });
}

/**
 * Validates Shopify app credentials are present in .env
 */
function validateAppCredentials() {
  const missing = [];
  if (!config.shopify.apiKey || config.shopify.apiKey.includes('your_api_key')) {
    missing.push('SHOPIFY_API_KEY');
  }
  if (!config.shopify.apiSecret || config.shopify.apiSecret.includes('your_api_secret')) {
    missing.push('SHOPIFY_API_SECRET');
  }
  if (!config.shopify.storeUrl || config.shopify.storeUrl.includes('your-store-name')) {
    missing.push('SHOPIFY_STORE_URL');
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing credentials in .env: ${missing.join(', ')}\n\n` +
      `Steps to get them:\n` +
      `  1. Go to: https://partners.shopify.com  (or Shopify Admin > Settings > Apps > Develop Apps)\n` +
      `  2. Create a new app\n` +
      `  3. Under "Configuration", set Allowed redirect URL: http://localhost:3000/auth/callback\n` +
      `  4. Copy "API key" → SHOPIFY_API_KEY\n` +
      `  5. Copy "API secret key" → SHOPIFY_API_SECRET\n` +
      `  6. Set SHOPIFY_STORE_URL=your-store.myshopify.com`
    );
  }
}

/**
 * Prompts user to paste a redirect URL (fallback if auto-capture fails)
 * @returns {Promise<string>} the code from the URL
 */
function promptForCode() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    rl.question(
      '\nPaste the full redirect URL from your browser (or just the "code" value):\n> ',
      (answer) => {
        rl.close();
        const answer2 = answer.trim();
        if (!answer2) return reject(new Error('No input provided'));

        // If they pasted a full URL, extract the code param
        if (answer2.startsWith('http')) {
          try {
            const url = new URL(answer2);
            const code = url.searchParams.get('code');
            if (!code) return reject(new Error('No "code" param found in URL'));
            return resolve(code);
          } catch {
            return reject(new Error('Invalid URL'));
          }
        }

        // They pasted just the code value
        resolve(answer2);
      }
    );
  });
}

async function main() {
  try {
    validateAppCredentials();

    // Step 1: Build auth URL
    const { url, nonce } = buildAuthorizationUrl();

    console.log('\n============================================================');
    console.log(' SHOPIFY OAUTH — Generate Access Token');
    console.log('============================================================');
    console.log(`Store     : ${config.shopify.storeUrl}`);
    console.log(`App Key   : ${config.shopify.apiKey}`);
    console.log(`Callback  : ${config.shopify.redirectUri}`);
    console.log('============================================================\n');
    console.log('Step 1: Open this URL in your browser and approve the app:\n');
    console.log(`  ${url}\n`);
    console.log('Step 2: After approval, Shopify will redirect to:');
    console.log(`  ${config.shopify.redirectUri}?code=XXXX&shop=XXXX&...\n`);
    console.log('Step 3: The local server will auto-capture the callback and save your token.\n');
    console.log('Waiting for OAuth callback on http://localhost:3000/auth/callback ...\n');

    let token;

    try {
      // Try auto-capture via local server
      token = await waitForCallback(nonce);
    } catch (serverErr) {
      // Fallback: let user paste the redirect URL manually
      logger.info(`Auto-capture failed (${serverErr.message}). Switching to manual mode.`);
      console.log('\nManual fallback: After approving in browser, copy the full redirect URL.');

      const code = await promptForCode();
      token = await exchangeCodeForToken(config.shopify.storeUrl, code);
      saveTokenToEnv(token);
    }

    console.log('\n============================================================');
    console.log(' TOKEN GENERATED SUCCESSFULLY');
    console.log('============================================================');
    console.log(`Token      : ${token.substring(0, 12)}...${token.slice(-4)}`);
    console.log(`Saved to   : .env  (SHOPIFY_ACCESS_TOKEN)`);
    console.log('============================================================\n');
    console.log('You can now run:');
    console.log('  npm run fetch-all-returns\n');

  } catch (err) {
    console.error(`\nError: ${err.message}\n`);
    process.exit(1);
  }
}

main();
