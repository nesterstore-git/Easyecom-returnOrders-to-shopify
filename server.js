/**
 * Production server for Render deployment.
 *
 * - Express health check endpoint (required by Render)
 * - Cron job: runs daily at 00:00 IST (18:30 UTC) to sync yesterday's returns to Shopify
 *
 * Render deployment:
 *   Build Command : npm install
 *   Start Command : node server.js
 *   Environment   : set all vars from .env.example in Render dashboard
 */

require('dotenv').config();
const express  = require('express');
const cron     = require('node-cron');
const { runDailySync } = require('./src/scripts/dailyReturnSync');
const logger   = require('./src/utils/logger');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Health check (required by Render) ────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'EasyEcom → Shopify Daily Return Sync',
    version: '1.0.0',
    nextSync: 'Daily at 00:00 IST (18:30 UTC)',
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ── Manual trigger endpoint (protected by API key) ────────────────────────────
app.post('/sync/trigger', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.SYNC_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  logger.info('Manual sync triggered via API');
  res.json({ status: 'sync started', message: 'Check sync_results/ for output' });
  // Run in background — don't await (don't block the response)
  runDailySync().catch(err => logger.error('Manual sync error:', err.message));
});

// ── Cron: 00:00 IST = 18:30 UTC ──────────────────────────────────────────────
// Cron format: minute hour day month weekday
// 18:30 UTC = 00:00 IST
cron.schedule('30 18 * * *', async () => {
  logger.info('⏰ Cron triggered: 00:00 IST — Starting daily return sync...');
  try {
    const result = await runDailySync();
    logger.info(`Cron sync done: pushed=${result?.pushed}, failed=${result?.failed}`);
  } catch (err) {
    logger.error(`Cron sync error: ${err.message}`);
  }
}, {
  timezone: 'UTC',  // cron uses UTC; 18:30 UTC = 00:00 IST
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`\n${'='.repeat(55)}`);
  logger.info('  EasyEcom → Shopify Return Sync Server');
  logger.info(`${'='.repeat(55)}`);
  logger.info(`  Server   : http://localhost:${PORT}`);
  logger.info(`  Health   : http://localhost:${PORT}/health`);
  logger.info(`  Cron     : Daily at 00:00 IST (18:30 UTC)`);
  logger.info(`  Store    : ${process.env.SHOPIFY_STORE_URL || 'not set'}`);
  logger.info(`${'='.repeat(55)}\n`);
});

module.exports = app;
