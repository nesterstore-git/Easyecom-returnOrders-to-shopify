/**
 * Push return orders from all_returns_enriched.json to Shopify.
 *
 * Each return creates a Shopify order with:
 *   - financial_status: paid / pending (from Payment status)
 *   - fulfillment_status: null (Unfulfilled) — then a fulfillment is created
 *     with tracking_company = Delivery status ("Customer Return" / "Courier Return")
 *   - tags: from the return record
 *   - source_name: "EasySync Orders"
 *   - Total: ₹0.00
 *
 * Usage:
 *   Test single:  node src/scripts/pushReturnToShopify.js --test RCHR1-2526-12
 *   Push all:     node src/scripts/pushReturnToShopify.js --all
 *
 * NOTE: Does NOT modify EasyEcom. Only creates orders in Shopify.
 */

require('dotenv').config();
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { config } = require('../config/config');
const { validateShopifyConfig } = require('../config/config');
const logger = require('../utils/logger');

const INPUT_PATH  = path.join(process.cwd(), 'all_returns_enriched.json');
const RESULT_PATH = path.join(process.cwd(), 'return_push_result.json');

function shopifyHeaders() {
  return {
    'X-Shopify-Access-Token': config.shopify.accessToken,
    'Content-Type': 'application/json',
  };
}

function shopifyUrl(path) {
  return `https://${config.shopify.storeUrl}/admin/api/${config.shopify.apiVersion}${path}`;
}

// ── Map payment status string → Shopify financial_status ─────────────────────
function mapFinancialStatus(paymentStatus) {
  if (!paymentStatus) return 'paid';
  const s = paymentStatus.toLowerCase();
  if (s === 'pending') return 'pending';
  if (s === 'partially paid') return 'partially_paid';
  return 'paid';
}

// ── Lookup Shopify customer by reference_code → get customer.id ───────────────
async function findShopifyOrderByName(refCode) {
  try {
    const res = await axios.get(shopifyUrl('/orders.json'), {
      params: { name: `#${refCode}`, status: 'any', fields: 'id,customer' },
      headers: shopifyHeaders(),
    });
    return (res.data.orders || [])[0] || null;
  } catch {
    return null;
  }
}

// ── SKU → variant map built from /products.json (authoritative source) ─────────
// /variants.json?sku= can return wrong/archived variants — do NOT use it.
let _skuVariantMap = null;

async function getSkuVariantMap() {
  if (_skuVariantMap) return _skuVariantMap;

  _skuVariantMap = {};
  try {
    const res = await axios.get(shopifyUrl('/products.json'), {
      params: { status: 'active', limit: 250, fields: 'id,title,variants' },
      headers: shopifyHeaders(),
    });
    (res.data.products || []).forEach(p => {
      (p.variants || []).forEach(v => {
        // Only map if SKU exists AND not already mapped (first-found wins — avoids empty SKU overwrite)
        if (v.sku && v.sku.trim() && !_skuVariantMap[v.sku.trim()]) {
          _skuVariantMap[v.sku.trim()] = {
            variant_id:    v.id,
            product_title: p.title,
            variant_title: v.title,
          };
        }
      });
    });
    logger.info(`SKU map loaded: ${Object.keys(_skuVariantMap).length} SKUs from Shopify products`);
  } catch (err) {
    logger.error(`Could not load SKU map: ${err.message}`);
  }
  return _skuVariantMap;
}

async function findVariantBySku(sku) {
  const map = await getSkuVariantMap();
  const entry = map[sku?.trim()];
  if (!entry) {
    logger.info(`  SKU not found in Shopify: ${sku}`);
    return null;
  }
  return entry.variant_id;
}

// ── Validate SKU→variant before push and log any mismatches ──────────────────
async function validateSkus(skus) {
  const map = await getSkuVariantMap();
  skus.forEach(sku => {
    const entry = map[sku?.trim()];
    if (entry) {
      logger.info(`  SKU ${sku} → variant_id: ${entry.variant_id} | ${entry.product_title} (${entry.variant_title})`);
    } else {
      logger.info(`  SKU ${sku} → NOT found in Shopify — will use title fallback`);
    }
  });
}

// ── Build Shopify order payload from a return record ─────────────────────────
function buildPayload(ret, originalOrder, variantIds) {
  const skus   = (ret._meta.sku || '').split(',').map(s => s.trim()).filter(Boolean);
  const items  = (ret.Items || '').split(',').map(s => s.trim());

  const lineItems = skus.map((sku, i) => {
    const variantId = variantIds[i] || null;
    const title     = items[i]?.replace(/\s×\s\d+$/, '').trim() || sku;
    const qty       = parseInt((items[i]?.match(/×\s*(\d+)$/) || [])[1]) || 1;
    const item      = { title, sku, quantity: qty, price: '0.00', requires_shipping: true, taxable: false };
    if (variantId) item.variant_id = variantId;
    return item;
  });

  const nameParts = (ret.Customer || '').split(' ');
  const address   = {
    first_name: nameParts[0] || ret.Customer,
    last_name:  nameParts.slice(1).join(' ') || '',
    address1:   'N/A',
    city:       (ret.Destination || '').split(',')[0]?.trim() || 'N/A',
    province:   '',
    zip:        '000000',
    country:    'India',
    country_code: 'IN',
    phone:      ret._meta.customer_phone || '',
  };

  const customer = originalOrder?.customer?.id
    ? { id: originalOrder.customer.id }
    : { first_name: address.first_name, last_name: address.last_name, email: ret._meta.customer_email || '', phone: ret._meta.customer_phone || '' };

  return {
    order: {
      line_items:        lineItems,
      shipping_address:  address,
      billing_address:   address,
      customer,
      source_name:       'EasySync Orders',
      financial_status:  mapFinancialStatus(ret['Payment status']),
      fulfillment_status: null,
      total_price:       '0.00',
      shipping_lines:    [{ title: 'Return Shipping', price: '0.00', code: 'Return' }],
      tags:              ret.Tags,
      po_number:         ret.Order,
      note:              `Return order | EasyEcom: ${ret.Order} | ref: ${ret._meta.reference_code} | reason: ${ret._meta.return_reason}`,
      note_attributes: [
        { name: 'EasyEcom Order',      value: ret.Order },
        { name: 'Reference Code',      value: String(ret._meta.reference_code) },
        { name: 'Return Reason',       value: String(ret._meta.return_reason) },
        { name: 'Delivery Status',     value: ret['Delivery status'] },
        { name: 'Fulfillment Status',  value: ret['Fulfillment status'] },
        { name: 'Return Date',         value: String(ret._meta.return_date || 'Pending') },
        { name: 'SKU',                 value: String(ret._meta.sku) },
        { name: 'Inventory Status',    value: String(ret._meta.inventory_status) },
        { name: 'Source',              value: ret._source === 'completed' ? 'getAllReturns' : 'getPendingReturns' },
      ],
      send_receipt:             false,
      send_fulfillment_receipt: false,
      metafields: [
        { namespace: 'custom', key: 'delivery_status',   value: ret['Delivery status'],         type: 'single_line_text_field' },
        { namespace: 'custom', key: 'return_reason',     value: String(ret._meta.return_reason), type: 'single_line_text_field' },
        { namespace: 'custom', key: 'easyecom_reference', value: String(ret._meta.reference_code), type: 'single_line_text_field' },
      ],
    },
  };
}

// ── Step A: Create fulfillment → Step B: Create Return → shows "Returned" ─────
// Shopify's "Returned" in Fulfillment status column requires:
//   1. Fulfillment created (status = Fulfilled)
//   2. Return created using the fulfillment's line item IDs (status = Returned)
async function addReturnDeliveryStatus(shopifyOrder, deliveryStatus) {
  try {
    // Step A: Get fulfillment orders and create fulfillment
    const foRes = await axios.get(shopifyUrl(`/orders/${shopifyOrder.id}/fulfillment_orders.json`), { headers: shopifyHeaders() });
    const openFOs = (foRes.data.fulfillment_orders || []).filter(fo => fo.status === 'open');

    const lineItemsByFO = openFOs.map(fo => ({
      fulfillment_order_id: fo.id,
      fulfillment_order_line_items: fo.line_items
        .filter(li => li.fulfillable_quantity > 0)
        .map(li => ({ id: li.id, quantity: li.fulfillable_quantity })),
    })).filter(fo => fo.fulfillment_order_line_items.length > 0);

    if (!lineItemsByFO.length) { logger.info('  No fulfillable items — skipping.'); return; }

    const fulfillRes = await axios.post(shopifyUrl('/fulfillments.json'), {
      fulfillment: {
        notify_customer: false,
        tracking_info: { company: deliveryStatus, number: `RET-${Date.now()}`, url: null },
        line_items_by_fulfillment_order: lineItemsByFO,
        // location_id required for Returns API to work (406 without it)
        location_id: 83535724773,
      },
    }, { headers: shopifyHeaders() });

    const fulfillment = fulfillRes.data.fulfillment;
    logger.info(`  Fulfillment created (ID: ${fulfillment?.id}) — status: Fulfilled`);

    // Step B: Create Return using fulfillment line item IDs → sets status to "Returned"
    const fulfillLineItems = fulfillment?.line_items || [];
    if (!fulfillLineItems.length) { logger.info('  No fulfillment line items for return.'); return; }

    const returnRes = await axios.post(shopifyUrl(`/orders/${shopifyOrder.id}/returns.json`), {
      return: {
        line_items: fulfillLineItems.map(li => ({
          fulfillment_line_item_id: li.id,
          quantity: li.quantity,
          restock_type: 'no_restock',   // don't add back to inventory
        })),
        customer_note: `${deliveryStatus} — processed via EasySync`,
        notify_customer: false,
      },
    }, { headers: shopifyHeaders() });

    const returnId = returnRes.data.return?.id;
    logger.info(`  Return created (ID: ${returnId}) — Fulfillment status: Returned ✓`);
  } catch (err) {
    logger.error(`  Return status warning: ${JSON.stringify(err.response?.data || err.message)}`);
  }
}

// ── Push a single return record to Shopify ────────────────────────────────────
async function pushSingleReturn(ret) {
  logger.info(`Processing: ${ret.Order} | ${ret.Customer} | ${ret['Delivery status']}`);

  // 1. Find original Shopify order for customer linking
  const original = ret._meta.reference_code
    ? await findShopifyOrderByName(ret._meta.reference_code)
    : null;
  if (original) logger.info(`  Linked to original Shopify order ID: ${original.id}`);

  // 2. Resolve variant IDs from SKUs using products.json map (not variants.json)
  const skus = (ret._meta.sku || '').split(',').map(s => s.trim()).filter(Boolean);
  await validateSkus(skus);
  const variantIds = await Promise.all(skus.map(sku => findVariantBySku(sku)));
  logger.info(`  Resolved ${variantIds.filter(Boolean).length}/${skus.length} variant IDs from products.json map`);

  // 3. Build payload and create order
  const payload      = buildPayload(ret, original, variantIds);
  const createRes    = await axios.post(shopifyUrl('/orders.json'), payload, { headers: shopifyHeaders() });
  const shopifyOrder = createRes.data.order;
  logger.info(`  Created Shopify order #${shopifyOrder.order_number} (ID: ${shopifyOrder.id})`);

  // 4. Set Delivery status via fulfillment
  await addReturnDeliveryStatus(shopifyOrder, ret['Delivery status']);

  return {
    easyecomOrder:    ret.Order,
    referenceCode:    ret._meta.reference_code,
    shopifyOrderId:   shopifyOrder.id,
    shopifyOrderNumber: shopifyOrder.order_number,
    shopifyOrderName: shopifyOrder.name,
    deliveryStatus:   ret['Delivery status'],
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  validateShopifyConfig();

  if (!fs.existsSync(INPUT_PATH)) {
    console.error('\nall_returns_enriched.json not found. Run "npm run fetch-all-returns" first.\n');
    process.exit(1);
  }

  const { returns } = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf8'));
  const args        = process.argv.slice(2);
  const testFlag    = args.indexOf('--test');
  const allFlag     = args.includes('--all');

  let targets;

  if (testFlag !== -1) {
    // --test <reference_code> : push just one by _meta.reference_code
    const refCode = args[testFlag + 1];
    if (!refCode) { console.error('\nUsage: node pushReturnToShopify.js --test <reference_code>\nExample: node pushReturnToShopify.js --test 1293\n'); process.exit(1); }
    targets = returns.filter(r => String(r._meta?.reference_code) === String(refCode));
    if (!targets.length) { console.error(`\nNo return found with reference_code = "${refCode}"\nAvailable reference codes: ${returns.map(r => r._meta?.reference_code).join(', ')}\n`); process.exit(1); }
    console.log(`\nTEST MODE — pushing 1 order: reference_code=${refCode} (Order: ${targets[0].Order})\n`);
  } else if (allFlag) {
    // Load already-pushed reference codes to avoid duplicates
    const resultPath = path.join(process.cwd(), 'return_push_result.json');
    let alreadyPushed = new Set();
    if (fs.existsSync(resultPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        (existing.pushed || []).forEach(p => { if (p.referenceCode) alreadyPushed.add(String(p.referenceCode)); });
      } catch { /* ignore */ }
    }

    // Also allow manual skip list via SKIP_REFS env or hardcoded
    const manualSkip = (process.env.SKIP_REFS || '').split(',').map(s => s.trim()).filter(Boolean);
    manualSkip.forEach(r => alreadyPushed.add(r));

    // Filter out already-pushed orders
    const skipped = returns.filter(r => alreadyPushed.has(String(r._meta?.reference_code)));
    targets = returns.filter(r => !alreadyPushed.has(String(r._meta?.reference_code)));

    console.log(`\nPUSH ALL — ${returns.length} total | Already pushed: ${skipped.length} (skipped) | To push: ${targets.length}`);
    if (skipped.length > 0) {
      console.log('Skipping (already pushed):');
      skipped.forEach(r => console.log(`  ref:${r._meta?.reference_code} | ${r.Order} | ${r.Customer}`));
    }
    console.log('');
  } else {
    console.log('\nUsage:');
    console.log('  Test one : node src/scripts/pushReturnToShopify.js --test RCHR1-2526-12');
    console.log('  Push all : node src/scripts/pushReturnToShopify.js --all\n');
    process.exit(0);
  }

  const pushed = [], failed = [];

  for (let i = 0; i < targets.length; i++) {
    const ret = targets[i];
    logger.info(`\n[${i + 1}/${targets.length}]`);
    try {
      const result = await pushSingleReturn(ret);
      pushed.push(result);
      console.log(`  ✓ ${ret.Order} → Shopify ${result.shopifyOrderName}`);
    } catch (err) {
      const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      logger.error(`  Failed: ${msg}`);
      failed.push({ order: ret.Order, error: msg });
    }
  }

  // Merge with existing pushed list to maintain full history
  let existingPushed = [];
  if (fs.existsSync(RESULT_PATH)) {
    try { existingPushed = JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8')).pushed || []; } catch { /* ignore */ }
  }
  const result = { pushed: [...existingPushed, ...pushed], failed, total: targets.length, lastRunAt: new Date().toISOString() };
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');

  console.log('\n============================================================');
  console.log(' RETURN PUSH — Summary');
  console.log('============================================================');
  console.log(`Total   : ${result.total}`);
  console.log(`Pushed  : ${pushed.length}`);
  console.log(`Failed  : ${failed.length}`);
  if (pushed.length) {
    console.log('\nPushed:');
    pushed.forEach(p => console.log(`  ${p.easyecomOrder} → ${p.shopifyOrderName} (${p.deliveryStatus})`));
  }
  if (failed.length) {
    console.log('\nFailed:');
    failed.forEach(f => console.log(`  ${f.order} → ${f.error}`));
  }
  console.log(`\nSaved to: return_push_result.json`);
  console.log('============================================================\n');
}

main().catch(e => { console.error(e.response?.data || e.message); process.exit(1); });
