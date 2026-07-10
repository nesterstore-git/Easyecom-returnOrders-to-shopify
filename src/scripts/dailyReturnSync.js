/**
 * Daily Return Sync — Runs at 00:00 IST (18:30 UTC)
 *
 * Fetches YESTERDAY's returns from:
 *   1. getAllReturns      (credit_note_start_date / credit_note_end_date)
 *   2. getPendingReturns  (created_after / created_before)
 *
 * Applies filters:
 *   - marketplace = Shopify only
 *   - return_type logic (RTO → Courier Return, else → Customer Return)
 *
 * Then:
 *   - Enriches customer names from Shopify (read-only GET)
 *   - Pushes each return to Shopify as an order
 *   - Saves daily result to sync_results/YYYY-MM-DD.json
 *
 * Called by server.js cron. Can also be run manually:
 *   node src/scripts/dailyReturnSync.js
 */

require('dotenv').config();
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { config } = require('../config/config');
const { generateToken } = require('../services/authService');
const logger = require('../utils/logger');

// ── Date helpers ──────────────────────────────────────────────────────────────
/**
 * Returns yesterday's date range in IST as UTC strings.
 * Runs at 00:00 IST → process yesterday's full day (00:00:00 → 23:59:59 IST).
 * IST = UTC+5:30, so yesterday 00:00 IST = yesterday 18:30 UTC (day before).
 */
function getYesterdayRangeIST() {
  const pad = n => String(n).padStart(2, '0');

  // Current time in IST (UTC+5:30)
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);

  // Yesterday's date in IST
  const year  = nowIST.getUTCFullYear();
  const month = nowIST.getUTCMonth();
  const day   = nowIST.getUTCDate() - 1; // yesterday

  // Build yesterday 00:00:00 IST and 23:59:59 IST as UTC timestamps
  const startUTC = new Date(Date.UTC(year, month, day, 0, 0, 0) - IST_OFFSET_MS);
  const endUTC   = new Date(Date.UTC(year, month, day, 23, 59, 59) - IST_OFFSET_MS);

  // Format in IST (what EasyEcom expects: "YYYY-MM-DD HH:MM:SS" in IST)
  const fmtIST = d => {
    const ist = new Date(d.getTime() + IST_OFFSET_MS);
    return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth()+1)}-${pad(ist.getUTCDate())} ${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}`;
  };

  const dateLabel = `${year}-${pad(month + 1)}-${pad(day)}`;

  return {
    dateLabel,
    startDate: fmtIST(startUTC),   // yesterday 00:00:00 IST
    endDate:   fmtIST(endUTC),     // yesterday 23:59:59 IST
  };
}

// ── EasyEcom headers ──────────────────────────────────────────────────────────
function easyecomHeaders(jwtToken) {
  return {
    'x-api-key': config.easyecom.xApiKey,
    Authorization: `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
  };
}

// ── Shopify headers ───────────────────────────────────────────────────────────
function shopifyHeaders() {
  return { 'X-Shopify-Access-Token': config.shopify.accessToken, 'Content-Type': 'application/json' };
}

function shopifyUrl(p) {
  return `https://${config.shopify.storeUrl}/admin/api/${config.shopify.apiVersion}${p}`;
}

// ── Paginated fetch ───────────────────────────────────────────────────────────
async function fetchPaginated(jwtToken, endpointPath, params, responseKey) {
  const all = [];
  let page = 1, nextUrl = null;

  do {
    let res;
    if (page === 1) {
      res = await axios.get(`${config.easyecom.baseUrl}/${endpointPath}`, { params, headers: easyecomHeaders(jwtToken) });
    } else {
      const url = nextUrl.startsWith('http') ? nextUrl : `${config.easyecom.baseUrl}${nextUrl}`;
      res = await axios.get(url, { headers: easyecomHeaders(jwtToken) });
    }
    const { message, data } = res.data;
    if (message && message !== 'Successful') break;
    const records = (data && Array.isArray(data[responseKey])) ? data[responseKey] : [];
    if (!records.length) break;
    all.push(...records);
    nextUrl = data?.nextUrl || null;
    page++;
    if (page > 100) break;
  } while (nextUrl);

  return all;
}

// ── Filters & format ──────────────────────────────────────────────────────────
function isShopify(r) { return (r.marketplace || '').toLowerCase() === 'shopify'; }

function resolveReturnType(record) {
  const rt = record.return_type || null;
  const reasons = (record.items || []).map(i => (i.return_reason || '').trim()).filter(Boolean);
  const primary = reasons[0] || record.return_reason || '';
  if (primary === 'RTO' && !rt) return 'Courier Return';
  if (primary !== 'Other' && primary !== '') return 'Customer Return';
  return rt || 'Return';
}

function mapPaymentStatus(pm) {
  if (!pm) return 'paid';
  const m = pm.toLowerCase();
  if (m === 'cod') return 'pending';
  if (m === 'partiallypaid') return 'partially_paid';
  return 'paid';
}

function formatRecord(record, source) {
  const resolvedType = resolveReturnType(record);
  const refCode = record.reference_code || '';
  const skus    = (record.items || []).map(i => i.sku).join(', ') || record.sku || 'N/A';
  const items   = (record.items || []).map(i =>
    `${i.productName || i.sku} × ${i.returned_item_quantity || i.quantity || 1}`
  ).join(', ') || record.product_name || 'N/A';

  const tagSet = new Set(['Return', `easyecom-return-${refCode}`]);
  if (record.marketplace) tagSet.add(record.marketplace);
  tagSet.add(resolvedType);
  if (record.payment_mode) tagSet.add(record.payment_mode);
  (record.items || []).forEach(i => { if (i.return_reason) tagSet.add(i.return_reason); });

  return {
    Order:                record.credit_note_number || record.return_id || refCode,
    Customer:             record.forward_shipment_customer_name || record.customer_name || 'N/A',
    Channel:              record.marketplace || 'N/A',
    Total:                '₹0.00',
    'Payment status':     mapPaymentStatus(record.payment_mode),
    'Fulfillment status': source === 'pending' ? 'Pending Return' : 'Returned',
    Items:                items,
    'Delivery status':    resolvedType,
    Tags:                 [...tagSet].filter(Boolean).join(', '),
    Destination:          [record.forward_shipment_customer_city || record.city || '', record.forward_shipment_customer_state_code || record.state_code || ''].filter(Boolean).join(', ') || 'N/A',
    _source:              source,
    _meta: {
      credit_note_id:       record.credit_note_id     || null,
      invoice_id:           record.invoice_id         || null,
      order_id:             record.order_id           || null,
      reference_code:       refCode,
      return_date:          record.return_date        || record.created_at || null,
      return_awb:           record.return_awb_number  || record.awb_number || 'N/A',
      sku:                  skus,
      inventory_status:     (record.items || []).map(i => i.inventory_status).join(', ') || record.inventory_status || 'N/A',
      return_reason:        (record.items || []).map(i => i.return_reason).filter(Boolean).join(', ') || record.return_reason || 'N/A',
      original_return_type: record.return_type || null,
      resolved_return_type: resolvedType,
    },
  };
}

// ── Shopify: enrich customer name ─────────────────────────────────────────────
const _shopifyCache = {};
async function enrichCustomer(ret) {
  const refCode = ret._meta?.reference_code;
  if (!refCode || ret.Customer !== 'N/A') return;
  if (!_shopifyCache[refCode]) {
    try {
      const res = await axios.get(shopifyUrl('/orders.json'), {
        params: { name: `#${refCode}`, status: 'any', fields: 'id,customer,email,shipping_address' },
        headers: shopifyHeaders(),
      });
      const order = (res.data.orders || [])[0];
      if (order) {
        const c = order.customer, s = order.shipping_address;
        const name = [c?.first_name || s?.first_name, c?.last_name || s?.last_name].filter(Boolean).join(' ');
        _shopifyCache[refCode] = { customerName: name || null, email: c?.email || order.email, phone: c?.phone || s?.phone };
      } else {
        _shopifyCache[refCode] = null;
      }
    } catch { _shopifyCache[refCode] = null; }
  }
  const d = _shopifyCache[refCode];
  if (d?.customerName) {
    ret.Customer = d.customerName;
    if (d.email) ret._meta.customer_email = d.email;
    if (d.phone) ret._meta.customer_phone = d.phone;
  }
}

// ── Shopify: find original order ──────────────────────────────────────────────
async function findOriginalOrder(refCode) {
  try {
    const res = await axios.get(shopifyUrl('/orders.json'), {
      params: { name: `#${refCode}`, status: 'any', fields: 'id,customer' },
      headers: shopifyHeaders(),
    });
    return (res.data.orders || [])[0] || null;
  } catch { return null; }
}

// ── SKU → variant map from /products.json (authoritative — NOT /variants.json) ─
let _skuMap = null;
async function getSkuMap() {
  if (_skuMap) return _skuMap;
  _skuMap = {};
  try {
    const res = await axios.get(shopifyUrl('/products.json'), {
      params: { status: 'active', limit: 250, fields: 'id,title,variants' },
      headers: shopifyHeaders(),
    });
    (res.data.products || []).forEach(p => {
      (p.variants || []).forEach(v => {
        if (v.sku?.trim() && !_skuMap[v.sku.trim()]) {
          _skuMap[v.sku.trim()] = { variant_id: v.id, product_title: p.title, variant_title: v.title };
        }
      });
    });
    logger.info(`SKU map: ${Object.keys(_skuMap).length} SKUs loaded from Shopify products`);
  } catch (err) { logger.error(`SKU map error: ${err.message}`); }
  return _skuMap;
}

async function findVariantBySku(sku) {
  const map = await getSkuMap();
  return map[sku?.trim()]?.variant_id || null;
}

// ── Shopify: create order + set delivery status ───────────────────────────────
async function pushToShopify(ret) {
  const refCode  = ret._meta?.reference_code;
  const original = refCode ? await findOriginalOrder(refCode) : null;
  const skus     = (ret._meta.sku || '').split(',').map(s => s.trim()).filter(Boolean);
  const variantIds = await Promise.all(skus.map(sku => findVariantBySku(sku)));
  const itemLabels = (ret.Items || '').split(',').map(s => s.trim());

  const lineItems = skus.map((sku, i) => {
    const variantId = variantIds[i] || null;
    const title     = itemLabels[i]?.replace(/\s×\s\d+$/, '').trim() || sku;
    const qty       = parseInt((itemLabels[i]?.match(/×\s*(\d+)$/) || [])[1]) || 1;
    const item      = { title, sku, quantity: qty, price: '0.00', requires_shipping: true, taxable: false };
    if (variantId) item.variant_id = variantId;
    return item;
  });

  const nameParts = (ret.Customer || '').split(' ');
  const address   = {
    first_name:   nameParts[0] || ret.Customer,
    last_name:    nameParts.slice(1).join(' ') || '',
    address1:     'N/A',
    city:         (ret.Destination || '').split(',')[0]?.trim() || 'N/A',
    province:     '',
    zip:          '000000',
    country:      'India',
    country_code: 'IN',
    phone:        ret._meta?.customer_phone || '',
  };

  const customer = original?.customer?.id
    ? { id: original.customer.id }
    : { first_name: address.first_name, last_name: address.last_name, email: ret._meta?.customer_email || '', phone: ret._meta?.customer_phone || '' };

  const payload = {
    order: {
      line_items:        lineItems,
      shipping_address:  address,
      billing_address:   address,
      customer,
      source_name:       'EasySync Orders',
      financial_status:  ret['Payment status'].toLowerCase().replace(' ', '_'),
      fulfillment_status: null,
      total_price:       '0.00',
      shipping_lines:    [{ title: 'Return Shipping', price: '0.00', code: 'Return' }],
      tags:              ret.Tags,
      po_number:         ret.Order,
      note:              `Return | EasyEcom: ${ret.Order} | ref: ${refCode} | reason: ${ret._meta?.return_reason}`,
      note_attributes: [
        { name: 'EasyEcom Order',     value: ret.Order },
        { name: 'Reference Code',     value: String(refCode) },
        { name: 'Return Reason',      value: String(ret._meta?.return_reason) },
        { name: 'Delivery Status',    value: ret['Delivery status'] },
        { name: 'Fulfillment Status', value: ret['Fulfillment status'] },
        { name: 'Return Date',        value: String(ret._meta?.return_date || 'Pending') },
        { name: 'Source',             value: ret._source === 'completed' ? 'getAllReturns' : 'getPendingReturns' },
      ],
      send_receipt:             false,
      send_fulfillment_receipt: false,
      metafields: [
        { namespace: 'custom', key: 'delivery_status',    value: ret['Delivery status'],        type: 'single_line_text_field' },
        { namespace: 'custom', key: 'return_reason',      value: String(ret._meta?.return_reason), type: 'single_line_text_field' },
        { namespace: 'custom', key: 'easyecom_reference', value: String(refCode),               type: 'single_line_text_field' },
      ],
    },
  };

  const createRes    = await axios.post(shopifyUrl('/orders.json'), payload, { headers: shopifyHeaders() });
  const shopifyOrder = createRes.data.order;

  // Set Delivery status via fulfillment
  try {
    const foRes  = await axios.get(shopifyUrl(`/orders/${shopifyOrder.id}/fulfillment_orders.json`), { headers: shopifyHeaders() });
    const openFOs = (foRes.data.fulfillment_orders || []).filter(fo => fo.status === 'open');
    const liFOs   = openFOs.map(fo => ({
      fulfillment_order_id: fo.id,
      fulfillment_order_line_items: fo.line_items.filter(li => li.fulfillable_quantity > 0).map(li => ({ id: li.id, quantity: li.fulfillable_quantity })),
    })).filter(fo => fo.fulfillment_order_line_items.length > 0);

    if (liFOs.length) {
      // Step 1: Create fulfillment (Fulfilled)
      const fulfillRes = await axios.post(shopifyUrl('/fulfillments.json'), {
        fulfillment: {
          notify_customer: false,
          tracking_info: { company: ret['Delivery status'], number: `RET-${Date.now()}`, url: null },
          line_items_by_fulfillment_order: liFOs,
          location_id: 83535724773,
        },
      }, { headers: shopifyHeaders() });

      // Step 2: Create Return on the fulfillment → sets Fulfillment status to "Returned"
      const fulfillLineItems = fulfillRes.data.fulfillment?.line_items || [];
      if (fulfillLineItems.length) {
        await axios.post(shopifyUrl(`/orders/${shopifyOrder.id}/returns.json`), {
          return: {
            line_items: fulfillLineItems.map(li => ({
              fulfillment_line_item_id: li.id,
              quantity: li.quantity,
              restock_type: 'no_restock',
            })),
            customer_note: `${ret['Delivery status']} — EasySync`,
            notify_customer: false,
          },
        }, { headers: shopifyHeaders() });
      }
    }
  } catch (err) {
    logger.error(`  Return status warning: ${JSON.stringify(err.response?.data || err.message)}`);
  }

  return { shopifyOrderId: shopifyOrder.id, shopifyOrderNumber: shopifyOrder.order_number, shopifyOrderName: shopifyOrder.name };
}

// ── Main sync function ────────────────────────────────────────────────────────
async function runDailySync() {
  const { dateLabel, startDate, endDate } = getYesterdayRangeIST();

  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`DAILY RETURN SYNC — ${dateLabel}`);
  logger.info(`Range: ${startDate}  →  ${endDate}`);
  logger.info(`${'='.repeat(60)}\n`);

  // Step 1: Generate EasyEcom token
  const { token } = await generateToken();

  // Step 2: Fetch yesterday's returns from both endpoints
  logger.info('Fetching getAllReturns...');
  const allReturnsRaw = await fetchPaginated(token, 'orders/getAllReturns', {
    credit_note_start_date: startDate,
    credit_note_end_date:   endDate,
    limit: 250,
  }, 'credit_notes');

  logger.info('Fetching getPendingReturns...');
  const pendingRaw = await fetchPaginated(token, 'getPendingReturns', {
    created_after:  startDate,
    created_before: endDate,
    limit: 250,
  }, 'pending_returns');

  // Step 3: Filter Shopify only + format
  const completedFmt = allReturnsRaw.filter(isShopify).map(r => formatRecord(r, 'completed'));
  const pendingFmt   = pendingRaw.filter(isShopify).map(r => formatRecord(r, 'pending'));
  const combined     = [...completedFmt, ...pendingFmt];

  logger.info(`\nYesterday's Shopify returns: ${completedFmt.length} completed + ${pendingFmt.length} pending = ${combined.length} total`);

  if (!combined.length) {
    logger.info('No returns for yesterday. Sync complete.\n');
    saveSyncResult(dateLabel, { total: 0, pushed: [], failed: [], skipped: 'No returns found' });
    return;
  }

  // Step 4: Enrich customer names from Shopify
  logger.info('Enriching customer names...');
  for (const ret of combined) await enrichCustomer(ret);

  // Step 5: Push each return to Shopify
  logger.info('Pushing to Shopify...\n');
  const pushed = [], failed = [];

  for (let i = 0; i < combined.length; i++) {
    const ret = combined[i];
    logger.info(`[${i + 1}/${combined.length}] ${ret.Order} | ${ret.Customer} | ${ret['Delivery status']}`);
    try {
      const result = await pushToShopify(ret);
      pushed.push({ easyecomOrder: ret.Order, referenceCode: ret._meta?.reference_code, ...result });
      logger.info(`  ✓ Created ${result.shopifyOrderName}`);
    } catch (err) {
      const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      logger.error(`  ✗ Failed: ${msg}`);
      failed.push({ easyecomOrder: ret.Order, referenceCode: ret._meta?.reference_code, error: msg });
    }
  }

  // Step 6: Save result
  saveSyncResult(dateLabel, { total: combined.length, pushed, failed });

  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`SYNC COMPLETE — ${dateLabel}`);
  logger.info(`Pushed: ${pushed.length} | Failed: ${failed.length}`);
  logger.info(`${'='.repeat(60)}\n`);

  return { date: dateLabel, total: combined.length, pushed: pushed.length, failed: failed.length };
}

function saveSyncResult(dateLabel, result) {
  const dir = path.join(process.cwd(), 'sync_results');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${dateLabel}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ date: dateLabel, syncedAt: new Date().toISOString(), ...result }, null, 2), 'utf8');
  logger.info(`Result saved: sync_results/${dateLabel}.json`);
}

// ── Run directly if called as script ─────────────────────────────────────────
if (require.main === module) {
  runDailySync().catch(err => {
    logger.error('Daily sync failed:', err.message);
    process.exit(1);
  });
}

module.exports = { runDailySync };
