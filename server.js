const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

const checkoutSessions = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000;

function createCheckoutToken() {
    return require('crypto').randomBytes(24).toString('hex');
}

function getBaseUrl(req) {
    return (process.env.PAYMOB_APP_URL || process.env.APP_URL || (req && (req.protocol + '://' + req.get('host')))) || '';
}

function getMissingEnv(keys) {
    return keys.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
}

// ==================== KLAVIYO FUNCTIONS ====================

/**
 * Subscribe a profile to a Klaviyo list.
 * Two-step process required by the Klaviyo v3 API:
 *   1. Upsert the profile (to persist first_name / last_name)
 *   2. Subscribe the profile to the list via bulk-create-jobs
 *
 * Both calls are fire-and-forget — errors are logged but never block checkout.
 */
async function klaviyoSubscribe({ email, firstName, lastName, newsletter }) {
  const listId = process.env.KLAVIYO_LIST_ID;
  const apiKey = process.env.KLAVIYO_API_KEY;

  if (!listId || !apiKey) {
      return { skipped: true, reason: 'Missing KLAVIYO_API_KEY or KLAVIYO_LIST_ID' };
  }

  const headers = {
      'Authorization': `Klaviyo-API-Key ${apiKey}`,
      'revision': '2024-02-15',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
  };

  let profileResult = null;

  // Step 1: Upsert profile
  try {
      const r = await axios.post(
          'https://a.klaviyo.com/api/profiles/',
          {
              data: {
                  type: 'profile',
                  attributes: {
                      email,
                      first_name: firstName || '',
                      last_name:  lastName  || '',
                      properties: { newsletter_optin: !!newsletter }
                  }
              }
          },
          { headers }
      );
      profileResult = { status: r.status, data: r.data };
  } catch (err) {
      if (err?.response?.status === 409) {
          profileResult = { status: 409, note: 'Profile already exists' };
      } else {
          return {
              step: 'upsert_profile',
              error: err.message,
              status: err?.response?.status,
              details: err?.response?.data
          };
      }
  }

  // Step 2: Subscribe to list
  try {
      const r = await axios.post(
          'https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/',
          {
              data: {
                  type: 'profile-subscription-bulk-create-job',
                  attributes: {
                      custom_source: 'Nazeerah Checkout',
                      profiles: {
                          data: [
                              {
                                  type: 'profile',
                                  attributes: {
                                      email,
                                      subscriptions: {
                                          email: {
                                              marketing: { consent: 'SUBSCRIBED' }
                                          }
                                      }
                                  }
                              }
                          ]
                      }
                  },
                  relationships: {
                      list: {
                          data: { type: 'list', id: listId }
                      }
                  }
              }
          },
          { headers }
      );
      return {
          profileResult,
          subscribeResult: { status: r.status, data: r.data }
      };
  } catch (err) {
      return {
          step: 'subscribe',
          error: err.message,
          status: err?.response?.status,
          details: err?.response?.data
      };
  }
}
// ==================== SHOPIFY FUNCTIONS ====================


// ==================== EMAIL FUNCTIONS ====================

async function sendShopifyOrderConfirmation(shopifyOrderId) {
  try {
      await axios.post(
          `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/orders/${shopifyOrderId}/send_fulfillment_receipt.json`,
          {},
          { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN } }
      );
      console.log(`📧 Fulfillment receipt sent for order ${shopifyOrderId}`);
  } catch (err) {
      console.error('Fulfillment receipt error:', err?.response?.data || err.message);
  }

  // Also send the order confirmation email
  try {
      await axios.post(
          `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/orders/${shopifyOrderId}/send_invoice.json`,
          {},
          { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN } }
      );
      console.log(`📧 Order invoice sent for order ${shopifyOrderId}`);
  } catch (err) {
      console.error('Order invoice error:', err?.response?.data || err.message);
  }
}

/**
 * Validate a Shopify discount code against the Price Rules API.
 * Returns discount metadata + calculated discountAmount in EGP.
 */
async function validateShopifyDiscountCode(code, cartTotal) {
    // 1. Look up the discount code to get its price_rule_id
    const codeRes = await axios.get(
        `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/discount_codes/lookup.json?code=${encodeURIComponent(code)}`,
        { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN } }
    );

    const discountCode = codeRes.data.discount_code;
    if (!discountCode) throw new Error('Invalid discount code');

    // 2. Fetch the associated price rule
    const ruleRes = await axios.get(
        `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/price_rules/${discountCode.price_rule_id}.json`,
        { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN } }
    );

    const rule = ruleRes.data.price_rule;
    if (!rule) throw new Error('Price rule not found');

    // 3. Validate active window
    const now = new Date();
    if (rule.starts_at && new Date(rule.starts_at) > now)
        throw new Error('Discount code is not yet active');
    if (rule.ends_at && new Date(rule.ends_at) < now)
        throw new Error('Discount code has expired');

    // 4. Check usage limit
    if (rule.usage_limit !== null && discountCode.usage_count >= rule.usage_limit)
        throw new Error('Discount code has reached its usage limit');

    // 5. Check minimum order requirement
    if (rule.prerequisite_subtotal_range?.greater_than_or_equal_to) {
        const min = parseFloat(rule.prerequisite_subtotal_range.greater_than_or_equal_to);
        if (cartTotal < min)
            throw new Error(`Minimum order of EGP ${min} required for this discount`);
    }

    // 6. Calculate discount amount
    const discountType = rule.value_type; // 'percentage' | 'fixed_amount'
    let discountAmount = discountType === 'percentage'
        ? (Math.abs(parseFloat(rule.value)) / 100) * cartTotal
        : Math.min(Math.abs(parseFloat(rule.value)), cartTotal);
    discountAmount = Math.round(discountAmount * 100) / 100;

    return {
        code: discountCode.code,
        priceRuleId: discountCode.price_rule_id,
        discountAmount,
        discountType,
        value: rule.value,
        title: rule.title || code,
        usageCount: discountCode.usage_count
    };
}

/**
 * Create a Draft Order
 */
async function createDraftOrder(cartItems, customer, egpTotal, appliedDiscount) {
    function buildEgpLineItems() {
        return cartItems.map((item) => {
            const raw = item?.variantId;
            const numericVariantId = raw ? String(raw).split('/').pop() : null;
            const unitPrice = Number(item?.price || 0);
            const qty = item?.quantity || 1;
            const lineItem = {
                title: item?.name || 'Item',
                quantity: qty,
                price: '0.00',
                properties: [
                    { name: 'EGP Unit Price', value: String(unitPrice) },
                    { name: 'EGP Line Total', value: String(Math.round(unitPrice * qty * 100) / 100) },
                ],
            };
            if (numericVariantId && numericVariantId !== 'undefined' && numericVariantId !== 'null') {
                lineItem.properties.push({ name: 'variant_id', value: numericVariantId });
            }
            return lineItem;
        });
    }

    const shippingAddress = customer ? {
        first_name: customer.firstName || customer.first_name || '',
        last_name: customer.lastName || customer.last_name || '',
        address1: customer.address1 || '',
        address2: customer.address2 || '',
        city: customer.city || '',
        province: customer.province || customer.state || '',
        zip: customer.zip || '',
        country: customer.country || 'EG',
        country_code: customer.country_code || 'EG',
        phone: customer.phone || ''
    } : undefined;

    const shippingLine = { title: 'Flat Rate Shipping', price: '100.00', custom: true };

    async function postDraftOrder(lineItems, extra = {}) {
        const noteAttributes = [
            { name: 'egp_total', value: String(egpTotal || 0) },
            { name: 'currency', value: 'EGP' }
        ];

        if (appliedDiscount?.code) {
            noteAttributes.push(
                { name: 'discount_code', value: appliedDiscount.code },
                { name: 'discount_amount_egp', value: String(appliedDiscount.discountAmount) }
            );
        }

        const draftOrderPayload = {
            line_items: lineItems,
            customer: customer ? {
                first_name: customer.firstName || customer.first_name || '',
                last_name: customer.lastName || customer.last_name || '',
                email: customer.email || '',
                phone: customer.phone || ''
            } : {},
            shipping_address: shippingAddress,
            shipping_line: shippingLine,
            currency: 'EGP',
            presentment_currency: 'EGP',
            note: 'Paymob checkout pending',
            tags: 'paymob-pending',
            note_attributes: noteAttributes,
            use_customer_default_address: false,
            ...extra
        };

        // Apply discount to draft order via Shopify's applied_discount field
        if (appliedDiscount?.code) {
            draftOrderPayload.applied_discount = {
                description: appliedDiscount.title || appliedDiscount.code,
                value_type: appliedDiscount.discountType === 'percentage' ? 'percentage' : 'fixed_amount',
                value: String(
                    appliedDiscount.discountType === 'percentage'
                        ? Math.abs(parseFloat(appliedDiscount.value))
                        : appliedDiscount.discountAmount
                ),
                amount: String(appliedDiscount.discountAmount),
                title: appliedDiscount.code.toUpperCase()
            };
        }

        const response = await axios.post(
            `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/draft_orders.json`,
            { draft_order: draftOrderPayload },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
                }
            }
        );
        return response.data.draft_order;
    }

    try {
        return await postDraftOrder(buildEgpLineItems(), { tags: 'paymob-pending,egp-prices' });
    } catch (error) {
        console.error('Error creating draft order:', error?.response?.data || error.message);
        throw error;
    }
}

// ==================== PAYMOB FUNCTIONS ====================

async function paymobAuthenticate() {
    try {
        const response = await axios.post('https://accept.paymob.com/api/auth/tokens', {
            api_key: process.env.PAYMOB_API_KEY
        });
        return response.data.token;
    } catch (error) {
        console.error('Paymob auth error:', error.response?.data || error.message);
        throw error;
    }
}

async function paymobRegisterOrder(authToken, amount, merchantOrderId, items) {
    try {
        const paymobItems = items.map(item => ({
            name: item.name,
            amount_cents: Math.round(Number(item.price) * 100),
            description: item.description || item.name,
            quantity: item.quantity
        }));

        paymobItems.push({
            name: 'Flat Rate Shipping',
            amount_cents: 10000,
            description: 'Shipping',
            quantity: 1
        });

        const totalCents = paymobItems.reduce((sum, item) => sum + item.amount_cents * item.quantity, 0);

        const response = await axios.post('https://accept.paymob.com/api/ecommerce/orders', {
            auth_token: authToken,
            delivery_needed: false,
            amount_cents: totalCents,
            currency: 'EGP',
            merchant_order_id: merchantOrderId,
            items: paymobItems
        });

        return { ...response.data, _totalCents: totalCents };
    } catch (error) {
        console.error('Paymob order registration error:', error.response?.data || error.message);
        throw error;
    }
}

async function paymobGetPaymentKey(authToken, orderId, amount, billingData, integrationId) {
    try {
        const response = await axios.post('https://accept.paymob.com/api/acceptance/payment_keys', {
            auth_token: authToken,
            amount_cents: Math.round(amount * 100),
            expiration: 3600,
            order_id: orderId,
            billing_data: {
                apartment: billingData.apartment || 'NA',
                email: billingData.email || 'customer@example.com',
                floor: billingData.floor || 'NA',
                first_name: billingData.first_name || 'Customer',
                street: billingData.street || 'NA',
                building: billingData.building || 'NA',
                phone_number: billingData.phone_number || '+20000000000',
                shipping_method: 'PKG',
                postal_code: billingData.postal_code || '00000',
                city: billingData.city || 'Cairo',
                country: 'EG',
                last_name: billingData.last_name || 'Customer',
                state: billingData.state || 'Cairo'
            },
            currency: 'EGP',
            integration_id: integrationId
        });
        return response.data.token;
    } catch (error) {
        console.error('Paymob payment key error:', error.response?.data || error.message);
        throw error;
    }
}

// ==================== API ENDPOINTS ====================

/**
 * POST /api/discount/validate
 * Body: { code: string, cartTotal: number }
 * Validates a Shopify discount code and returns discount info.
 */
app.post('/api/discount/validate', async (req, res) => {
    try {
        const { code, cartTotal } = req.body;

        if (!code || typeof code !== 'string' || !code.trim())
            return res.status(400).json({ success: false, error: 'Discount code is required' });

        const missing = getMissingEnv(['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_ACCESS_TOKEN']);
        if (missing.length)
            return res.status(500).json({ success: false, error: `Missing env vars: ${missing.join(', ')}` });

        const discount = await validateShopifyDiscountCode(code.trim(), Number(cartTotal) || 0);
        return res.json({ success: true, discount });

    } catch (error) {
        if (error?.response?.status === 404)
            return res.json({ success: false, error: 'Discount code not found' });
        console.error('Discount validate error:', error?.response?.data || error.message);
        return res.json({ success: false, error: error.message || 'Invalid discount code' });
    }
});

function getPaymobMethodConfig(paymobMethod) {
    const method = String(paymobMethod || '').toLowerCase();
    const defaults = {
        integrationId: process.env.PAYMOB_INTEGRATION_ID,
        iframeId: process.env.PAYMOB_IFRAME_ID
    };
    if (method === 'cod') return { integrationId: process.env.PAYMOB_INTEGRATION_ID_COD || defaults.integrationId, iframeId: null };
    if (method === 'wallet') return { integrationId: process.env.PAYMOB_INTEGRATION_ID_WALLET || defaults.integrationId, iframeId: process.env.PAYMOB_IFRAME_ID_WALLET || defaults.iframeId };
    if (method === 'card') return { integrationId: process.env.PAYMOB_INTEGRATION_ID_CARD || defaults.integrationId, iframeId: process.env.PAYMOB_IFRAME_ID_CARD || defaults.iframeId };
    return defaults;
}

/**
 * POST /api/checkout/egypt
 * Now accepts optional appliedDiscount from the frontend.
 */
app.post('/api/checkout/egypt', async (req, res) => {
    try {
        const { cartItems, customer, billingData, paymobMethod, appliedDiscount } = req.body;

        const missingShopify = getMissingEnv(['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_ACCESS_TOKEN']);
        if (missingShopify.length)
            return res.status(500).json({ success: false, error: `Missing Shopify env vars: ${missingShopify.join(', ')}` });

        const missingPaymob = getMissingEnv(['PAYMOB_API_KEY']);
        if (missingPaymob.length)
            return res.status(500).json({ success: false, error: `Missing Paymob env vars: ${missingPaymob.join(', ')}` });

        const paymobConfig = getPaymobMethodConfig(paymobMethod);
        if (!paymobConfig.integrationId)
            return res.status(500).json({ success: false, error: 'Paymob configuration missing (integration_id)' });

        const itemsTotal = cartItems.reduce((sum, item) => sum + (Number(item.price || 0) * (item.quantity || 1)), 0);
        const discountAmount = appliedDiscount?.discountAmount ? Number(appliedDiscount.discountAmount) : 0;
        const totalAmount = itemsTotal + 100 - discountAmount; // items + 100 EGP shipping - discount

        const draftOrder = await createDraftOrder(cartItems, customer, totalAmount, appliedDiscount || null);

        // Subscribe to Klaviyo — fire-and-forget (never blocks checkout)
        klaviyoSubscribe({
            email:     customer.email,
            firstName: customer.firstName || customer.first_name,
            lastName:  customer.lastName  || customer.last_name,
            newsletter: req.body.newsletter  // true | false from frontend checkbox
        }).catch(err => console.error('Klaviyo subscribe error:', err?.response?.data || err.message));

        if (String(paymobMethod || '').toLowerCase() === 'cod') {
          try {
              const completeRes = await axios.put(
                  `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/draft_orders/${draftOrder.id}/complete.json`,
                  { payment_pending: true },
                  { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN } }
              );
      
              const shopifyOrderId = completeRes.data?.draft_order?.order_id;
              let shopifyOrderNumber = draftOrder.id; // fallback
      
              if (shopifyOrderId) {
                  // Fetch the real order to get the order_number (e.g. 1234)
                  const orderRes = await axios.get(
                      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/orders/${shopifyOrderId}.json`,
                      { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN } }
                  );
                  shopifyOrderNumber = orderRes.data?.order?.order_number || shopifyOrderId;
      
                  // Tag the order with payment method
                  await axios.put(
                      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/orders/${shopifyOrderId}.json`,
                      { order: { id: shopifyOrderId, note_attributes: [
                          { name: 'payment_method', value: 'cod' },
                          { name: 'is_cod', value: 'true' },
                          { name: 'is_card', value: 'false' },
                          { name: 'is_wallet', value: 'false' }
                      ]}},
                      { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN } }
                  );

                  sendShopifyOrderConfirmation(shopifyOrderId)
                  .catch(err => console.error('Confirmation email error:', err.message));
              }
      
              const codRedirectUrl =
                  process.env.COD_SUCCESS_URL ||
                  (process.env.FRONTEND_URL && `${process.env.FRONTEND_URL.replace(/\/$/, '')}/pages/thank-you?order_number=${shopifyOrderNumber}`) ||
                  '/';
      
              return res.json({ success: true, cod: true, shopifyDraftOrderId: draftOrder.id, shopifyOrderId, redirectUrl: codRedirectUrl });
      
          } catch (e) {
              console.error('Error completing COD draft order:', e.response?.data || e.message);
              return res.status(500).json({ success: false, error: 'Failed to complete COD order in Shopify' });
          }
      }

        const authToken = await paymobAuthenticate();

        // Register with Paymob using the post-discount total
        const paymobOrder = await paymobRegisterOrder(
            authToken,
            totalAmount,
            draftOrder.id.toString(),
            cartItems.map(item => ({ name: item.name, price: item.price, quantity: item.quantity, description: item.description }))
        );

        const exactTotalCents = paymobOrder._totalCents;

        const paymentKey = await paymobGetPaymentKey(
            authToken, paymobOrder.id, exactTotalCents / 100, billingData, paymobConfig.integrationId
        );

        const paymobIframeUrl = paymobConfig.iframeId
            ? `https://accept.paymob.com/api/acceptance/iframes/${paymobConfig.iframeId}?payment_token=${paymentKey}`
            : null;

        res.json({ success: true, paymentUrl: paymobIframeUrl, shopifyDraftOrderId: draftOrder.id, paymobOrderId: paymobOrder.id, paymentToken: paymentKey });

    } catch (error) {
        const status = error?.response?.status;
        const data = error?.response?.data;
        if (status) {
            console.error('Checkout upstream error:', status, data || error.message);
            return res.status(status).json({ success: false, error: (data && (data.error || data.errors || data.message)) || error.message, details: data });
        }
        console.error('Checkout error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Paymob webhook callback
 */
app.post('/api/paymob/callback', async (req, res) => {
    try {
        const data = req.body;
        const hmacSecret = process.env.PAYMOB_HMAC;
        const crypto = require('crypto');
        const receivedHmac = req.query.hmac;

        const concatenatedString =
            data.amount_cents + data.created_at + data.currency + data.error_occured +
            data.has_parent_transaction + data.id + data.integration_id + data.is_3d_secure +
            data.is_auth + data.is_capture + data.is_refunded + data.is_standalone_payment +
            data.is_voided + data.order + data.owner + data.pending + data.source_data_pan +
            data.source_data_sub_type + data.source_data_type + data.success;

        const calculatedHmac = crypto.createHmac('sha512', hmacSecret).update(concatenatedString).digest('hex');
        if (calculatedHmac !== receivedHmac) return res.status(400).json({ error: 'Invalid HMAC signature' });

        if (data.success === 'true' || data.success === true) {
            const shopifyDraftOrderId = data.order.merchant_order_id;
            const sourceType = String(data.source_data_type || '').toLowerCase();
            const isWallet = sourceType === 'wallet';
            const isCard = !isWallet;
            const method = isWallet ? 'wallet' : 'card';

            const completeRes = await axios.put(
                `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/draft_orders/${shopifyDraftOrderId}/complete.json`,
                { payment_pending: false },
                { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN } }
            );

            const shopifyOrderId = completeRes.data?.draft_order?.order_id;

            if (shopifyOrderId) {
                await axios.put(
                    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/orders/${shopifyOrderId}.json`,
                    { order: { id: shopifyOrderId, note_attributes: [
                        { name: 'payment_method', value: method },
                        { name: 'is_cod', value: 'false' },
                        { name: 'is_card', value: String(isCard) },
                        { name: 'is_wallet', value: String(isWallet) }
                    ]}},
                    { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN } }
                );

                sendShopifyOrderConfirmation(shopifyOrderId)
                .catch(err => console.error('Confirmation email error:', err.message));
            }

            console.log(`✅ Order ${shopifyDraftOrderId} completed successfully (method: ${method})`);
        }

        res.status(200).json({ received: true });
    } catch (error) {
        console.error('Callback error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/checkout/success', (req, res) => {
    const { order_id } = req.query;
    res.redirect(`${process.env.FRONTEND_URL}/pages/thank-you?order=${order_id}`);
});

// ==================== CHECKOUT PAGE HTML ====================

function getCartPayloadCheckoutPageHtml(cart) {
    const safeCartJson = JSON.stringify(cart || { total: 0, items: [] }).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Checkout — Nazeerah</title>
  <link rel="icon" type="image/png" href="https://cdn.shopify.com/s/files/1/0691/2930/6408/files/Naz_logo_emblem.png?v=1712855831" />

  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #ffffff;
      --white: #ffffff;
      --border: #e8e4df;
      --border-focus: #b5a898;
      --text: #1a1a1a;
      --muted: #888077;
      --gold: #BEA64D;
      --label: #6b6258;
      --error: #b03a2e;
      --success: #2d6a4f;        /* ← new */
      --success-bg: #f0f7f4;     /* ← new */
      --success-border: #a8d5bf; /* ← new */
      --radius: 3px;
    }

    @font-face {
      font-family: 'Futura PT';
      src: url('https://cdn.shopify.com/s/files/1/0691/2930/6408/files/FuturaCyrillicBook.woff?v=1772642061') format('woff');
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: 'Futura PT';
      src: url('https://cdn.shopify.com/s/files/1/0691/2930/6408/files/FuturaCyrillicLight.woff?v=1772642061') format('woff');
      font-weight: 300;
      font-style: normal;
      font-display: swap;
    }
    html, body {
      background: var(--bg); color: var(--text);
      font-family: 'Futura PT', sans-serif; font-weight: 300;
      font-size: 14px; line-height: 1.6; min-height: 100vh;
    }

    /* ── Header ── */
    .site-header {
      background: var(--white); border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 2rem; height: 60px;
    }
    .logo {
      font-family: 'Cormorant Garamond', serif; font-size: 22px;
      font-weight: 500; letter-spacing: 0.18em; text-transform: uppercase;
      text-decoration: none; color: var(--text);
      position: absolute; left: 50%; transform: translateX(-50%);
    }
    .cart-icon { margin-left: auto; color: var(--muted); cursor: pointer; display: flex; align-items: center; }
    .cart-icon svg { width: 20px; height: 20px; }

    /* ── Layout ── */
    .checkout-layout { display: flex; min-height: calc(100vh - 60px); }
    .form-panel {
      flex: 0 0 55%; max-width: 55%;
      padding: 3rem 4rem 3rem 6%;
      background: var(--white); border-right: 1px solid var(--border);
    }
    .summary-panel { flex: 1; padding: 3rem 5% 3rem 3rem; background: var(--bg); }

    @media (max-width: 860px) {
      .checkout-layout { flex-direction: column; }
      .form-panel { flex: none; max-width: 100%; padding: 2rem 1.5rem; border-right: none; border-bottom: 1px solid var(--border); }
      .summary-panel { padding: 2rem 1.5rem; }
    }

    /* ── Section headings ── */
    .section-title {
      font-family: 'Futura PT', sans-serif; font-size: 13px; font-weight: 500;
      letter-spacing: 0.08em; text-transform: uppercase; color: var(--text);
      margin-bottom: 1.1rem; margin-top: 2rem;
    }
    .section-title:first-child { margin-top: 0; }

    /* ── Fields ── */
    .field { margin-bottom: 10px; }
    .field-row { display: flex; gap: 10px; }
    .field-row .field { flex: 1; }
    .field label { display: block; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--label); margin-bottom: 5px; }
    .field input, .field select {
      width: 100%; padding: 10px 12px; border: 1px solid var(--border);
      border-radius: var(--radius); background: #f5f3f0; color: var(--text);
      font-family: 'Futura PT', sans-serif; font-size: 13.5px; font-weight: 300;
      transition: border-color 0.2s; outline: none; appearance: none; -webkit-appearance: none;
    }
    .field input::placeholder { color: #9b948c; }
    .field input:focus, .field select:focus { border-color: var(--border-focus); }
    .field .input-wrap { position: relative; }
    .field .input-icon { position: absolute; right: 11px; top: 50%; transform: translateY(-50%); color: var(--muted); pointer-events: none; display: flex; }
    .field .input-icon svg { width: 15px; height: 15px; }

    .select-country { border: 1px solid var(--border); border-radius: var(--radius); background: var(--white); padding: 6px 12px 8px; }
    .select-country .country-label { font-size: 10px; color: var(--muted); letter-spacing: 0.04em; display: block; margin-bottom: 2px; }
    .select-country .country-value { font-size: 13.5px; font-family: 'Futura PT', sans-serif; font-weight: 300; color: var(--text); display: flex; align-items: center; justify-content: space-between; }

    .checkbox-field { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; cursor: pointer; font-size: 13px; color: var(--text); }
    .checkbox-field input[type="checkbox"] { width: 14px; height: 14px; flex-shrink: 0; accent-color: var(--gold); cursor: pointer; }

    /* ── Shipping ── */
    .shipping-box {
      border: 1px solid var(--border); border-radius: var(--radius);
      padding: 12px 14px; display: flex; justify-content: space-between;
      align-items: center; background: var(--bg); margin-bottom: 10px;
    }
    .shipping-box-left .shipping-name { font-size: 13.5px; font-weight: 400; color: var(--text); }
    .shipping-box-left .shipping-desc { font-size: 12px; color: var(--muted); }
    .shipping-price { font-size: 13.5px; color: var(--text); }

    /* ── Payment ── */
    .payment-subtitle { font-size: 12px; color: var(--muted); margin-bottom: 1rem; }
    .payment-option { border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 1px; cursor: pointer; transition: border-color 0.2s; overflow: hidden; }
    .payment-option:has(input:checked), .payment-option.selected { border-color: var(--border-focus); }
    .payment-option-header { display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: var(--white); }
    .payment-option-header label { display: flex; align-items: center; gap: 10px; cursor: pointer; flex: 1; font-size: 13.5px; font-weight: 400; }
    .payment-option-header input[type="radio"] { width: 16px; height: 16px; accent-color: var(--text); flex-shrink: 0; }
    .payment-badges { display: flex; gap: 4px; margin-left: auto; align-items: center; }
    .badge { height: 20px; padding: 0 6px; border: 1px solid var(--border); border-radius: 2px; font-size: 10px; font-weight: 500; display: inline-flex; align-items: center; letter-spacing: 0.03em; color: var(--muted); }
    .badge-visa { font-style: italic; font-size: 12px; font-weight: 600; color: #1a1f71; border-color: #c8c8c8; }
    .badge-mc { font-size: 10px; font-weight: 700; color: #eb001b; border-color: #c8c8c8; }
    .badge-amex { background: #2671b2; color: white; border-color: #2671b2; font-size: 9px; }
    .cod-option { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; display: flex; align-items: center; gap: 10px; margin-top: 1px; cursor: pointer; transition: border-color 0.2s; }
    .cod-option:has(input:checked) { border-color: var(--border-focus); }
    .cod-option label { cursor: pointer; font-size: 13.5px; font-weight: 400; display: flex; align-items: center; gap: 10px; }
    .cod-option input[type="radio"] { width: 16px; height: 16px; accent-color: var(--text); }

    /* ── Pay button ── */
    .pay-btn {
      width: 100%; margin-top: 1.5rem; padding: 14px 20px;
      background: var(--gold); color: #fff; border: none; border-radius: var(--radius);
      font-family: 'Futura PT', sans-serif; font-size: 13px; font-weight: 400;
      letter-spacing: 0.12em; text-transform: uppercase; cursor: pointer; transition: background 0.2s;
    }
    .pay-btn:hover:not(:disabled) { opacity: 0.9; }
    .pay-btn:disabled { opacity: 0.65; cursor: not-allowed; }
    .error-msg { color: var(--error); font-size: 12px; margin-top: 0.5rem; display: none; }

    /* ── Order items ── */
    .order-items { margin-bottom: 1.5rem; }
    .order-item { display: flex; align-items: center; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--border); }
    .order-item:last-child { border-bottom: none; }
    .item-img-wrap { position: relative; flex-shrink: 0; width: 60px; height: 75px; }
    .item-img-wrap img { width: 60px; height: 75px; object-fit: cover; border-radius: 2px; border: 1px solid var(--border); background: #f0ede9; }
    .item-img-placeholder { width: 60px; height: 75px; background: #ede9e3; border-radius: 2px; border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; }
    .item-img-placeholder svg { width: 22px; height: 22px; color: #bbb; }
    .item-qty-badge { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; background: var(--muted); color: white; border-radius: 50%; font-size: 10px; font-weight: 500; display: flex; align-items: center; justify-content: center; }
    .item-info { flex: 1; }
    .item-name { font-size: 13.5px; font-weight: 400; color: var(--text); line-height: 1.3; }
    .item-price { font-size: 13.5px; font-weight: 400; color: var(--text); white-space: nowrap; }

    /* ── Discount section ── */
    .discount-row { display: flex; gap: 8px; margin-bottom: 6px; }
    .discount-row input {
      flex: 1; padding: 9px 12px; border: 1px solid var(--border);
      border-radius: var(--radius); font-family: 'Futura PT', sans-serif;
      font-size: 13px; font-weight: 300; outline: none;
      background: var(--white); color: var(--text);
      transition: border-color 0.2s;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .discount-row input::placeholder { color: #c0bab3; text-transform: none; letter-spacing: 0; }
    .discount-row input:focus { border-color: var(--border-focus); }
    .discount-row button {
      padding: 9px 16px; border: 1px solid var(--border); border-radius: var(--radius);
      background: var(--white); font-family: 'Futura PT', sans-serif; font-size: 12.5px;
      letter-spacing: 0.04em; cursor: pointer; color: var(--text); white-space: nowrap;
      transition: border-color 0.2s, background 0.2s, opacity 0.2s;
    }
    .discount-row button:hover:not(:disabled) { border-color: var(--border-focus); background: var(--bg); }
    .discount-row button:disabled { opacity: 0.6; cursor: not-allowed; }

    /* Applied discount tag */
    .discount-tag {
      display: none;
      align-items: center;
      gap: 8px;
      background: var(--success-bg);
      border: 1px solid var(--success-border);
      border-radius: var(--radius);
      padding: 6px 10px;
      font-size: 12px;
      color: var(--success);
      font-weight: 500;
      letter-spacing: 0.04em;
      margin-bottom: 6px;
    }
    .discount-tag.visible { display: flex; }
    .discount-tag .tag-code { display: flex; align-items: center; gap: 5px; }
    .discount-tag .tag-savings { font-weight: 300; opacity: 0.85; margin-left: 2px; }
    .discount-tag .tag-remove {
      margin-left: auto; background: none; border: none; cursor: pointer;
      color: var(--success); font-size: 18px; line-height: 1; opacity: 0.55;
      padding: 0; display: flex; align-items: center;
    }
    .discount-tag .tag-remove:hover { opacity: 1; }

    /* Feedback line under discount row */
    .discount-feedback { font-size: 12px; min-height: 18px; margin-bottom: 10px; }
    .discount-feedback.error   { color: var(--error); }
    .discount-feedback.success { color: var(--success); }

    /* Totals */
    .totals { border-top: 1px solid var(--border); padding-top: 1rem; }
    .total-line { display: flex; justify-content: space-between; align-items: baseline; padding: 4px 0; font-size: 13px; }
    .total-line .tl-label { color: var(--muted); }
    .total-line .tl-value { color: var(--text); }

    /* Discount line in totals */
    .total-line.discount-line .tl-label,
    .total-line.discount-line .tl-value { color: var(--success); font-weight: 400; }

    .total-line.grand { padding-top: 10px; margin-top: 6px; border-top: 1px solid var(--border); }
    .total-line.grand .tl-label { font-size: 15px; font-weight: 500; color: var(--text); }
    .total-line.grand .tl-value { font-size: 18px; font-weight: 500; }
    .total-line.grand .currency-code { font-size: 11px; font-weight: 300; color: var(--muted); margin-right: 4px; letter-spacing: 0.05em; }
  
    .checkout-footer-links {
      margin-top: 2rem;
      padding-top: 1.2rem;
      border-top: 1px solid var(--border);
      display: flex;
      flex-wrap: wrap;
      gap: 18px;
      font-size: 12px;
    }

    .checkout-footer-links a {
      color: var(--muted);
      text-decoration: underline;
      transition: color 0.2s;
    }

    .checkout-footer-links a:hover {
      color: var(--text);
    }

    </style>
</head>
<body>

<header class="site-header">
  <img src="https://cdn.shopify.com/s/files/1/0691/2930/6408/files/nazeerah-logo-black.svg?v=1732712680" alt="Nazeerah" width="150" height="150" class="logo">
  <div class="cart-icon" aria-label="cart">
    <a href="https://nazeerah.com">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
        <line x1="3" y1="6" x2="21" y2="6"/>
        <path d="M16 10a4 4 0 01-8 0"/>
      </svg>
    </a>
  </div>
</header>

<div class="checkout-layout">

  <!-- LEFT: Form -->
  <div class="form-panel">
    <form id="checkout-form" novalidate>

      <div class="section-title">Contact</div>
      <div class="field">
        <div class="input-wrap">
          <input id="email" name="email" type="email" placeholder="Email" autocomplete="email" required />
        </div>
      </div>
      <label class="checkbox-field">
        <input type="checkbox" name="newsletter" />
        Email me with news and offers
      </label>

      <div class="section-title">Delivery</div>
      <div class="field">
        <div class="select-country">
          <span class="country-label">Country/Region</span>
          <div class="country-value">
            Egypt
            <svg viewBox="0 0 10 6" width="10" height="6" fill="none"><path d="M1 1l4 4 4-4" stroke="#888" stroke-width="1.2" stroke-linecap="round"/></svg>
          </div>
        </div>
      </div>

      <div class="field-row">
        <div class="field"><div class="input-wrap"><input id="first_name" name="first_name" type="text" placeholder="First name" autocomplete="given-name" required /></div></div>
        <div class="field"><div class="input-wrap"><input id="last_name" name="last_name" type="text" placeholder="Last name" autocomplete="family-name" required /></div></div>
      </div>

      <div class="field">
        <div class="input-wrap">
          <input id="address1" name="address1" type="text" placeholder="Address" autocomplete="address-line1" required />
          <span class="input-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg></span>
        </div>
      </div>

      <div class="field"><div class="input-wrap"><input id="address2" name="address2" type="text" placeholder="Apartment, suite, etc. (optional)" autocomplete="address-line2" /></div></div>

      <div class="field-row">
        <div class="field"><div class="input-wrap"><input id="city" name="city" type="text" placeholder="City" autocomplete="address-level2" required /></div></div>
        <div class="field"><div class="input-wrap"><input id="state" name="state" type="text" placeholder="Governorate" autocomplete="address-level1" required /></div></div>
        <div class="field"><div class="input-wrap"><input id="zip" name="zip" type="text" placeholder="ZIP code" autocomplete="postal-code" /></div></div>
      </div>

      <div class="field">
        <div class="input-wrap">
          <input id="phone" name="phone" type="tel" placeholder="Phone (optional)" autocomplete="tel" />
          <span class="input-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg></span>
        </div>
      </div>

      <div class="section-title">Shipping method</div>
      <div class="shipping-box">
        <div class="shipping-box-left">
          <div class="shipping-name">Standard Shipping</div>
          <div class="shipping-desc">2 to 8 business days</div>
        </div>
        <div class="shipping-price">100 EGP</div>
      </div>

      <div class="section-title">Payment</div>
      <p class="payment-subtitle">All transactions are secure and encrypted.</p>


      <div class="cod-option selected" id="opt-cod">
        <label>
          <input type="radio" name="paymob_method" value="cod" checked onchange="onPaymentChange(this)" />
          Cash on Delivery
        </label>
      </div>

      <button type="submit" id="pay-btn" class="pay-btn">Pay now</button>
      <p id="error-msg" class="error-msg"></p>

      <div class="checkout-footer-links">
        <a href="https://nazeerah.com/en-eg/pages/return-policy">Refund policy</a>
        <a href="https://nazeerah.com/en-eg/pages/shipping-policy">Shipping</a>
        <a href="https://nazeerah.com/en-eg/policies/privacy-policy">Privacy policy</a>
        <a href="https://nazeerah.com/en-eg/policies/terms-of-service">Terms of service</a>
        <a href="https://nazeerah.com/en-eg/pages/contact">Contact</a>
      </div>

    </form>
  </div>

  <!-- RIGHT: Order summary -->
  <div class="summary-panel">
    <div id="order-items" class="order-items"></div>

    <!-- Discount code -->
    <div class="discount-row">
      <input type="text" id="discount-input" placeholder="Discount code or gift card" autocomplete="off" />
      <button type="button" id="discount-btn">Apply</button>
    </div>
    <div id="discount-tag" class="discount-tag"></div>
    <div id="discount-feedback" class="discount-feedback"></div>

    <div class="totals" id="totals"></div>
  </div>

</div>

<script>
(function () {
  var CART = ${safeCartJson};
  var appliedDiscount = null; // holds validated discount object from server

  /* ── Formatting ── */
  function fmt(v) {
    return new Intl.NumberFormat('en-EG', { style: 'currency', currency: 'EGP' }).format(v || 0);
  }

  /* ── Render items ── */
  function renderItems() {
    var el = document.getElementById('order-items');
    var items = (CART && CART.items) || [];
    if (!items.length) { el.innerHTML = '<p style="color:var(--muted);font-size:13px;">No items in cart.</p>'; return; }
    var html = '';
    items.forEach(function (item) {
      var imgHtml = item.image
        ? '<img src="' + item.image + '" alt="' + (item.name || '') + '" />'
        : '<div class="item-img-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg></div>';
      html += '<div class="order-item">'
        + '<div class="item-img-wrap">' + imgHtml + '<span class="item-qty-badge">' + (item.quantity || 1) + '</span></div>'
        + '<div class="item-info"><div class="item-name">' + (item.name || 'Item') + '</div></div>'
        + '<div class="item-price">' + fmt((item.price || 0) * (item.quantity || 1)) + '</div>'
        + '</div>';
    });
    el.innerHTML = html;
  }

  /* ── Render totals (re-runs whenever discount changes) ── */
  function renderTotals() {
    var el = document.getElementById('totals');
    var subtotal    = (CART && CART.total) || 0;
    var shipping    = 100;
    var discountAmt = appliedDiscount ? appliedDiscount.discountAmount : 0;
    var grand       = subtotal + shipping - discountAmt;

    var discountRow = '';
    if (appliedDiscount && discountAmt > 0) {
      discountRow =
        '<div class="total-line discount-line">'
        + '<span class="tl-label">Discount (' + appliedDiscount.code.toUpperCase() + ')</span>'
        + '<span class="tl-value">\u2212' + fmt(discountAmt) + '</span>'
        + '</div>';
    }

    el.innerHTML =
      '<div class="total-line">'
        + '<span class="tl-label">Subtotal &middot; ' + ((CART && CART.items && CART.items.length) || 0) + ' items</span>'
        + '<span class="tl-value">' + fmt(subtotal) + '</span>'
      + '</div>'
      + '<div class="total-line">'
        + '<span class="tl-label">Shipping</span>'
        + '<span class="tl-value">100 EGP</span>'
      + '</div>'
      + discountRow
      + '<div class="total-line grand">'
        + '<span class="tl-label">Total</span>'
        + '<span class="tl-value"><span class="currency-code"></span>' + fmt(grand) + '</span>'
      + '</div>';
  }

  renderItems();
  renderTotals();

  /* ── Discount UI ── */
  var discountInput    = document.getElementById('discount-input');
  var discountBtn      = document.getElementById('discount-btn');
  var discountTag      = document.getElementById('discount-tag');
  var discountFeedback = document.getElementById('discount-feedback');

  discountBtn.addEventListener('click', applyDiscount);
  discountInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); applyDiscount(); }
  });

  async function applyDiscount() {
    var code = (discountInput.value || '').trim();
    if (!code) { setFeedback('Please enter a discount code.', 'error'); return; }

    discountBtn.disabled = true;
    discountBtn.textContent = 'Checking\u2026';
    setFeedback('', '');
    hideTag();

    try {
      var subtotal = (CART && CART.total) || 0;
      var res  = await fetch('/api/discount/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, cartTotal: subtotal })
      });
      var json = await res.json();

      if (!json.success) {
        appliedDiscount = null;
        setFeedback(json.error || 'Invalid discount code.', 'error');
        renderTotals();
        return;
      }

      appliedDiscount = json.discount;
      discountInput.value = '';

      var saving = appliedDiscount.discountType === 'percentage'
        ? Math.abs(parseFloat(appliedDiscount.value)).toFixed(0) + '% off'
        : '\u2212' + fmt(appliedDiscount.discountAmount);

      showTag(appliedDiscount.code.toUpperCase(), saving);
      setFeedback('Discount applied \u2014 you save ' + fmt(appliedDiscount.discountAmount) + '!', 'success');
      renderTotals();

    } catch (err) {
      setFeedback('Could not validate code. Please try again.', 'error');
    } finally {
      discountBtn.disabled  = false;
      discountBtn.textContent = 'Apply';
    }
  }

  function removeDiscount() {
    appliedDiscount = null;
    hideTag();
    setFeedback('', '');
    renderTotals();
  }

  function showTag(code, saving) {
    discountTag.innerHTML =
      '<span class="tag-code">'
        + '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        + code
      + '</span>'
      + '<span class="tag-savings">' + saving + '</span>'
      + '<button class="tag-remove" title="Remove">&times;</button>';
    discountTag.classList.add('visible');
    discountTag.querySelector('.tag-remove').addEventListener('click', removeDiscount);
  }

  function hideTag() {
    discountTag.classList.remove('visible');
    discountTag.innerHTML = '';
  }

  function setFeedback(msg, type) {
    discountFeedback.textContent = msg;
    discountFeedback.className   = 'discount-feedback' + (type ? ' ' + type : '');
  }

  /* ── Payment method toggle ── */
  window.onPaymentChange = function (input) {
    ['opt-card', 'opt-wallet', 'opt-cod'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.remove('selected');
    });
    var target = document.getElementById('opt-' + input.value);
    if (target) target.classList.add('selected');
  };

  /* ── Form submit ── */
  var form   = document.getElementById('checkout-form');
  var payBtn = document.getElementById('pay-btn');
  var errEl  = document.getElementById('error-msg');

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    errEl.style.display = 'none';
    payBtn.disabled     = true;
    payBtn.textContent  = 'Processing\u2026';

    try {
      var fd = new FormData(form);

      var customer = {
        email: fd.get('email'), firstName: fd.get('first_name'), lastName: fd.get('last_name'),
        phone: fd.get('phone'), city: fd.get('city'), address1: fd.get('address1'),
        address2: fd.get('address2'), zip: fd.get('zip'), province: fd.get('state'),
        country: 'EG', country_code: 'EG'
      };

      var billingData = {
        email: customer.email, first_name: customer.firstName, last_name: customer.lastName,
        phone_number: customer.phone, city: customer.city || 'Cairo',
        street: customer.address1 || 'NA', building: customer.address2 || 'NA',
        apartment: 'NA', floor: 'NA', postal_code: customer.zip || '00000',
        state: customer.province || 'Cairo'
      };

      var cartItems = ((CART && CART.items) || []).map(function (item) {
        var rawVariant = item.variantId || item.variant_id || item.id;
        return {
          variantId: 'gid://shopify/ProductVariant/' + rawVariant,
          quantity: item.quantity, name: item.name, price: item.price,
          description: item.category || item.name
        };
      });

      var body = {
        cartItems, customer, billingData,
        paymobMethod: fd.get('paymob_method'),
        newsletter:   fd.get('newsletter') === 'on',  // ← forward checkbox state
        appliedDiscount: appliedDiscount || null
      };

      var res  = await fetch('/api/checkout/egypt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      var text = await res.text();
      var json;
      try { json = JSON.parse(text); } catch (_) { json = null; }

      if (!res.ok) { showError((json && (json.error || json.message)) || text || 'Checkout failed'); return; }
      if (!json)   { showError(text || 'Checkout failed'); return; }

      if      (json.success && json.paymentUrl) { window.location.href = json.paymentUrl; }
      else if (json.success && json.cod)        { window.location.href = json.redirectUrl || '/'; }
      else    { showError(json.error || 'Checkout failed'); }

    } catch (err) {
      showError(err.message || 'Checkout failed. Please try again.');
    } finally {
      if (!payBtn.disabled) { payBtn.disabled = false; payBtn.textContent = 'Pay now'; }
    }
  });

  function showError(msg) {
    errEl.textContent   = msg;
    errEl.style.display = 'block';
    payBtn.disabled     = false;
    payBtn.textContent  = 'Pay now';
  }
})();
</script>
</body>
</html>`;
}

app.post('/api/checkout/render', (req, res) => {
    const cart = req.body || {};
    const token = createCheckoutToken();
    checkoutSessions.set(token, { cart, createdAt: Date.now() });
    const baseUrl = getBaseUrl(req);
    const redirectUrl = baseUrl ? (baseUrl.replace(/\/$/, '') + '/api/checkout/page?token=' + token) : ('/api/checkout/page?token=' + token);
    res.json({ success: true, redirectUrl });
});

app.get('/api/checkout/page', (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(400).send('Missing token');

    const session = checkoutSessions.get(token);
    if (!session) return res.status(404).send('Checkout session expired or invalid');

    const { cart, createdAt } = session;
    if (Date.now() - createdAt > SESSION_TTL_MS) {
        checkoutSessions.delete(token);
        return res.status(410).send('Checkout session expired');
    }

    checkoutSessions.delete(token); // one-time use
    res.type('html').send(getCartPayloadCheckoutPageHtml(cart));
});
app.get('/signup-egypt', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign Up — Nazeerah</title>
  <link rel="icon" type="image/png" href="https://cdn.shopify.com/s/files/1/0691/2930/6408/files/Naz_logo_emblem.png?v=1712855831" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Jost:wght@300;400;500&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    @font-face {
      font-family: 'Futura PT';
      src: url('https://cdn.shopify.com/s/files/1/0691/2930/6408/files/FuturaCyrillicBook.woff?v=1772642061') format('woff');
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: 'Futura PT';
      src: url('https://cdn.shopify.com/s/files/1/0691/2930/6408/files/FuturaCyrillicLight.woff?v=1772642061') format('woff');
      font-weight: 300;
      font-style: normal;
      font-display: swap;
    }

    body {
      font-family: 'Futura PT', 'Jost', sans-serif;
      background: #ffffff;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .logo-wrap {
      margin-bottom: 2.5rem;
      text-align: center;
    }
    .logo-wrap img {
      width: 250px;
      height: auto;
    }
    .heading {
      font-family: 'Futura PT', 'Jost', sans-serif;
      font-weight: 400;
      font-size: 18px;
      letter-spacing: 0.25em;
      text-transform: uppercase;
      color: #1a1a1a;
      text-align: center;
      margin-bottom: 1rem;
    }
    .subheading {
      font-family: 'Futura PT', 'Jost', sans-serif;
      font-weight: 300;
      font-size: 18px;
      letter-spacing: 0.04em;
      color: #000000;
      text-align: center;
      line-height: 1.7;
      max-width: 360px;
    }
    .form-wrap {
      width: 100%;
      max-width: 480px;
    }
  </style>
</head>
<body>

  <div class="logo-wrap">
    <img
      src="https://cdn.shopify.com/s/files/1/0691/2930/6408/files/nazeerah-logo-black.svg?v=1732712680"
      alt="Nazeerah"
    />
  </div>

  <div class="form-wrap">
    <div class="klaviyo-form-X3kaev"></div>
  </div>

  <script>
    window._klOnsite = window._klOnsite || [];
    window._klOnsite.push(['openForm', 'DISABLE_POPUPS']);
  </script>
  <script async type="text/javascript" src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=TUQk9P"></script>

</body>
</html>`);
});

app.get('/signup', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign Up — Nazeerah</title>
  <link rel="icon" type="image/png" href="https://cdn.shopify.com/s/files/1/0691/2930/6408/files/Naz_logo_emblem.png?v=1712855831" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Jost:wght@300;400;500&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    @font-face {
      font-family: 'Futura PT';
      src: url('https://cdn.shopify.com/s/files/1/0691/2930/6408/files/FuturaCyrillicBook.woff?v=1772642061') format('woff');
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: 'Futura PT';
      src: url('https://cdn.shopify.com/s/files/1/0691/2930/6408/files/FuturaCyrillicLight.woff?v=1772642061') format('woff');
      font-weight: 300;
      font-style: normal;
      font-display: swap;
    }

    body {
      font-family: 'Futura PT', 'Jost', sans-serif;
      background: #ffffff;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .logo-wrap {
      margin-bottom: 2.5rem;
      text-align: center;
    }
    .logo-wrap img {
      width: 250px;
      height: auto;
    }
    .heading {
      font-family: 'Futura PT', 'Jost', sans-serif;
      font-weight: 400;
      font-size: 18px;
      letter-spacing: 0.25em;
      text-transform: uppercase;
      color: #1a1a1a;
      text-align: center;
      margin-bottom: 1rem;

    }
    .subheading {
      font-family: 'Futura PT', 'Jost', sans-serif;
      font-weight: 300;
      font-size: 18px;
      letter-spacing: 0.04em;
      color: #000000;
      text-align: center;
      line-height: 1.7;
      max-width: 360px;
    }
    .form-wrap {
      width: 100%;
      max-width: 480px;
    }
  </style>
</head>
<body>

  <div class="logo-wrap">
    <img
      src="https://cdn.shopify.com/s/files/1/0691/2930/6408/files/nazeerah-logo-black.svg?v=1732712680"
      alt="Nazeerah"
    />
  </div>

  <div class="form-wrap">
    <div class="klaviyo-form-TfGCcx"></div>
  </div>

  <script>
    window._klOnsite = window._klOnsite || [];
    window._klOnsite.push(['openForm', 'DISABLE_POPUPS']);
  </script>
  <script async type="text/javascript" src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=TUQk9P"></script>

</body>
</html>`);
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));