/**
 * Combined: Fetch getAllReturns + getPendingReturns, enrich with Shopify
 * customer names, and save everything to one file: all_returns_enriched.json
 *
 * Filters + logic applied to BOTH endpoints:
 *   1. marketplace = Shopify only
 *   2. return_type: RTO + null → Courier Return | reason != Other → Customer Return
 *   3. Tags: easyecom-return-{reference_code}
 *   4. Total: ₹0.00
 *   5. Customer names looked up from Shopify (GET only — no push)
 *
 * Usage: npm run fetch-all-returns
 */

require('dotenv').config();
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { config } = require('../config/config');
const { validateConfig, validateShopifyConfig } = require('../config/config');
const { generateToken } = require('../services/authService');
const logger = require('../utils/logger');

const LIMIT      = 250;
const START_DATE = '2026-01-01 00:00:00';
const OUTPUT_PATH = path.join(process.cwd(), 'all_returns_enriched.json');

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 23:59:59`;
}

function easyecomHeaders(jwtToken) {
  return {
    'x-api-key': config.easyecom.xApiKey,
    Authorization: `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  };
}

function shopifyHeaders() {
  return { 'X-Shopify-Access-Token': config.shopify.accessToken };
}

// ─── Paginated fetch helper ───────────────────────────────────────────────────
async function fetchPaginated(jwtToken, firstPageParams, responseKey, label) {
  const all = [];
  let page = 1;
  let nextUrlValue = null;

  do {
    logger.info(`  [${label}] page ${page}...`);
    let response;

    if (page === 1) {
      response = await axios.get(`${config.easyecom.baseUrl}/${firstPageParams.path}`, {
        params: firstPageParams.params,
        headers: easyecomHeaders(jwtToken),
      });
    } else {
      const url = nextUrlValue.startsWith('http')
        ? nextUrlValue
        : `${config.easyecom.baseUrl}${nextUrlValue}`;
      response = await axios.get(url, { headers: easyecomHeaders(jwtToken) });
    }

    const { message, data } = response.data;
    if (message && message !== 'Successful') { logger.info(`  [${label}] "${message}". Done.`); break; }

    const records = (data && Array.isArray(data[responseKey])) ? data[responseKey] : [];
    if (!records.length) { logger.info(`  [${label}] No more data.`); break; }

    all.push(...records);
    nextUrlValue = (data && data.nextUrl) ? data.nextUrl : null;
    logger.info(`  [${label}] ${records.length} records (running total: ${all.length})`);
    page++;
    if (page > 500) { logger.error('500-page safety limit hit.'); break; }
  } while (nextUrlValue);

  return all;
}

// ─── Filters + formatting ─────────────────────────────────────────────────────
function isShopify(r) {
  return (r.marketplace || '').toLowerCase() === 'shopify';
}

function resolveReturnType(record) {
  const returnType    = record.return_type || null;
  const reasons       = (record.items || []).map(i => (i.return_reason || '').trim()).filter(Boolean);
  const primaryReason = reasons[0] || record.return_reason || '';
  if (primaryReason === 'RTO' && !returnType) return 'Courier Return';
  if (primaryReason !== 'Other' && primaryReason !== '') return 'Customer Return';
  return returnType || 'Return';
}

function mapPaymentStatus(pm) {
  if (!pm) return 'Paid';
  const m = pm.toLowerCase();
  if (m === 'cod') return 'Pending';
  if (m === 'partiallypaid' || m === 'partial') return 'Partially paid';
  return 'Paid';
}

function formatRecord(record, source) {
  const resolvedReturnType = resolveReturnType(record);
  const refCode = record.reference_code || '';

  const items = (record.items || []).map(i =>
    `${i.productName || i.sku} × ${i.returned_item_quantity || i.quantity || 1}`
  ).join(', ') || record.product_name || 'N/A';

  const tagSet = new Set();
  tagSet.add('Return');
  tagSet.add(`easyecom-return-${refCode}`);
  if (record.marketplace) tagSet.add(record.marketplace);
  tagSet.add(resolvedReturnType);
  if (record.payment_mode) tagSet.add(record.payment_mode);
  (record.items || []).forEach(i => { if (i.return_reason) tagSet.add(i.return_reason); });
  if (record.return_reason) tagSet.add(record.return_reason);
  const tags = [...tagSet].filter(Boolean).join(', ');

  const city      = record.forward_shipment_customer_city || record.customer_city || record.city || '';
  const stateCode = record.forward_shipment_customer_state_code || record.customer_state_code || record.state_code || '';

  return {
    Order:                record.credit_note_number || record.return_id || refCode,
    Customer:             record.forward_shipment_customer_name || record.customer_name || 'N/A',
    Channel:              record.marketplace || 'N/A',
    Total:                '₹0.00',
    'Payment status':     mapPaymentStatus(record.payment_mode),
    'Fulfillment status': source === 'pending' ? 'Pending Return' : 'Returned',
    Items:                items,
    'Delivery status':    resolvedReturnType,
    Tags:                 tags,
    Destination:          [city, stateCode].filter(Boolean).join(', ') || 'N/A',
    _source:              source,   // 'completed' | 'pending'

    _meta: {
      return_id:            record.return_id          || null,
      credit_note_id:       record.credit_note_id     || null,
      invoice_id:           record.invoice_id         || null,
      order_id:             record.order_id           || null,
      reference_code:       refCode,
      return_date:          record.return_date        || record.created_at || null,
      credit_note_date:     record.credit_note_date   || null,
      return_awb:           record.return_awb_number  || record.awb_number || 'N/A',
      sku:                  (record.items || []).map(i => i.sku).join(', ') || record.sku || 'N/A',
      inventory_status:     (record.items || []).map(i => i.inventory_status).join(', ') || record.inventory_status || 'N/A',
      return_reason:        (record.items || []).map(i => i.return_reason).filter(Boolean).join(', ') || record.return_reason || 'N/A',
      original_return_type: record.return_type        || null,
      resolved_return_type: resolvedReturnType,
    },
  };
}

// ─── Shopify customer enrichment ──────────────────────────────────────────────
async function getShopifyCustomer(referenceCode, cache) {
  if (cache[referenceCode] !== undefined) return cache[referenceCode];

  try {
    const res = await axios.get(
      `https://${config.shopify.storeUrl}/admin/api/${config.shopify.apiVersion}/orders.json`,
      {
        params: { name: `#${referenceCode}`, status: 'any', fields: 'id,name,customer,email,billing_address,shipping_address' },
        headers: shopifyHeaders(),
      }
    );
    const order = (res.data.orders || [])[0];
    if (!order) { cache[referenceCode] = null; return null; }

    const c = order.customer, s = order.shipping_address, b = order.billing_address;
    const fullName = [[c?.first_name || s?.first_name || b?.first_name, c?.last_name || s?.last_name || b?.last_name].filter(Boolean).join(' ')].filter(Boolean)[0] || null;
    const result = { customerName: fullName, email: c?.email || order.email || null, phone: c?.phone || s?.phone || b?.phone || null };
    cache[referenceCode] = result;
    return result;
  } catch {
    cache[referenceCode] = null;
    return null;
  }
}

async function enrichCustomers(records) {
  const cache = {};
  let enriched = 0, notFound = 0;

  for (let i = 0; i < records.length; i++) {
    const r       = records[i];
    const refCode = r._meta?.reference_code;
    const current = r.Customer;

    process.stdout.write(`  [${i + 1}/${records.length}] #${refCode || '?'} → `);

    if (current && current !== 'N/A' && current !== 'DUMMY') {
      console.log(`"${current}" (kept)`);
      continue;
    }
    if (!refCode) { console.log('skipped'); notFound++; continue; }

    const data = await getShopifyCustomer(refCode, cache);
    if (data?.customerName) {
      r.Customer = data.customerName;
      if (data.email) r._meta.customer_email = data.email;
      if (data.phone) r._meta.customer_phone = data.phone;
      console.log(`"${data.customerName}"`);
      enriched++;
    } else {
      console.log('not found');
      notFound++;
    }
  }
  return { enriched, notFound };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  validateConfig();
  validateShopifyConfig();

  const endDate = todayStr();

  // Step 1: EasyEcom token
  logger.info('Step 1: Generating EasyEcom access token...');
  const { token } = await generateToken();

  // Step 2: Fetch getAllReturns using created_after / created_before (confirmed from Postman)
  logger.info('\nStep 2: Fetching getAllReturns...');
  const allReturnsRaw = await fetchPaginated(
    token,
    { path: 'orders/getAllReturns', params: { limit: LIMIT, created_after: START_DATE, created_before: endDate } },
    'credit_notes',
    'getAllReturns'
  );

  // Step 3: Fetch getPendingReturns (created_after / created_before)
  logger.info('\nStep 3: Fetching getPendingReturns...');
  const pendingRaw = await fetchPaginated(
    token,
    { path: 'getPendingReturns', params: { created_after: START_DATE, created_before: endDate, limit: LIMIT } },
    'pending_returns',
    'getPendingReturns'
  );

  // Step 4: Filter Shopify + format
  const completedFormatted = allReturnsRaw.filter(isShopify).map(r => formatRecord(r, 'completed'));
  const pendingFormatted   = pendingRaw.filter(isShopify).map(r => formatRecord(r, 'pending'));
  const combined = [...completedFormatted, ...pendingFormatted];

  logger.info(`\nFiltered: ${completedFormatted.length} completed + ${pendingFormatted.length} pending = ${combined.length} total Shopify returns`);

  // Step 5: Enrich with Shopify customer names
  console.log('\nStep 4: Enriching customer names from Shopify...');
  const { enriched, notFound } = await enrichCustomers(combined);

  // Breakdown by return type
  const byType = combined.reduce((acc, r) => { const t = r['Delivery status']; acc[t] = (acc[t] || 0) + 1; return acc; }, {});
  const bySource = combined.reduce((acc, r) => { acc[r._source] = (acc[r._source] || 0) + 1; return acc; }, {});

  // Step 6: Save
  const output = {
    summary: {
      totalFetched:          { getAllReturns: allReturnsRaw.length, getPendingReturns: pendingRaw.length },
      shopifyOnly:           combined.length,
      filters:               ['marketplace = Shopify'],
      returnTypeLogic:       ['RTO + return_type null → Courier Return', 'return_reason != Other → Customer Return'],
      breakdownByReturnType: byType,
      breakdownBySource:     bySource,
      customerEnrichment:    { enriched, notFound },
      dateRange:             { from: START_DATE, to: endDate },
      fetchedAt:             new Date().toISOString(),
    },
    returns: combined,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');

  console.log('\n============================================================');
  console.log(' ALL RETURNS ENRICHED — Complete');
  console.log('============================================================');
  console.log(`getAllReturns fetched    : ${allReturnsRaw.length} → ${completedFormatted.length} Shopify`);
  console.log(`getPendingReturns fetched: ${pendingRaw.length} → ${pendingFormatted.length} Shopify`);
  console.log(`Total combined          : ${combined.length}`);
  console.log(`Customer enriched       : ${enriched} | Not found: ${notFound}`);
  console.log('');
  console.log('Breakdown by type:');
  Object.entries(byType).forEach(([t, c]) => console.log(`  ${t.padEnd(20)}: ${c}`));
  console.log('');
  console.log(`Saved to: all_returns_enriched.json`);
  console.log('NOTE: Nothing was pushed to Shopify.');
  console.log('============================================================\n');
}

main().catch(e => { console.error(e.response?.data || e.message); process.exit(1); });
