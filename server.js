const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Enable CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Short-lived checkout sessions: token -> { cart, createdAt }
const checkoutSessions = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 min

function createCheckoutToken() {
    return require('crypto').randomBytes(24).toString('hex');
}

function getBaseUrl(req) {
    return (process.env.PAYMOB_APP_URL || process.env.APP_URL || (req && (req.protocol + '://' + req.get('host')))) || '';
}

function getMissingEnv(keys) {
    return keys.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
}

// ==================== SHOPIFY FUNCTIONS ====================

/**
 * Create a Draft Order (Alternative method for saving cart)
 */
async function createDraftOrder(cartItems, customer, egpTotal) {
    // Custom line items with explicit prices; variant_id stored in properties for reference.
    function buildEgpLineItems() {
        return cartItems.map((item) => {
            const raw = item?.variantId;
            const numericVariantId = raw ? String(raw).split('/').pop() : null;
            const unitPrice = Number(item?.price || 0);
            const qty = item?.quantity || 1;
            // Price is set to 0 on the Shopify order; the real EGP amounts
            // are stored as line item properties for the team to see in the admin.
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

    // Build shipping address from customer object
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

    // Flat 100 EGP shipping fee
    const shippingLine = {
        title: 'Flat Rate Shipping',
        price: '100.00',
        custom: true
    };

    async function postDraftOrder(lineItems, extra = {}) {
        const draftOrder = {
            draft_order: {
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
                note_attributes: [
                    { name: 'egp_total', value: String(egpTotal || 0) },
                    { name: 'currency', value: 'EGP' }
                ],
                use_customer_default_address: false,
                ...extra
            }
        };

        const response = await axios.post(
            `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/draft_orders.json`,
            draftOrder,
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

/**
 * Step 1: Authenticate with Paymob
 */
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

/**
 * Step 2: Register Order with Paymob
 */
async function paymobRegisterOrder(authToken, amount, merchantOrderId, items) {
    try {
        // amount_cents per item is the UNIT price in cents; grand total must equal
        // sum(item.amount_cents * item.quantity) across all items including shipping.
        const paymobItems = items.map(item => ({
            name: item.name,
            amount_cents: Math.round(Number(item.price) * 100), // unit price in cents
            description: item.description || item.name,
            quantity: item.quantity
        }));

        // Add shipping as an explicit line item so the sum always matches
        paymobItems.push({
            name: 'Flat Rate Shipping',
            amount_cents: 10000, // 100.00 EGP in cents
            description: 'Shipping',
            quantity: 1
        });

        // Recalculate grand total from items to guarantee it matches exactly
        const totalCents = paymobItems.reduce(
            (sum, item) => sum + item.amount_cents * item.quantity, 0
        );

        const response = await axios.post('https://accept.paymob.com/api/ecommerce/orders', {
            auth_token: authToken,
            delivery_needed: false,
            amount_cents: totalCents,
            currency: 'EGP',
            merchant_order_id: merchantOrderId,
            items: paymobItems
        });

        // Return both the order data and the exact totalCents so the payment key
        // call uses the same figure.
        return { ...response.data, _totalCents: totalCents };
    } catch (error) {
        console.error('Paymob order registration error:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Step 3: Get Payment Key from Paymob
 */
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

function getPaymobMethodConfig(paymobMethod) {
    const method = String(paymobMethod || '').toLowerCase();

    // Fallback to default envs if method-specific ones aren't provided
    const defaults = {
        integrationId: process.env.PAYMOB_INTEGRATION_ID,
        iframeId: process.env.PAYMOB_IFRAME_ID
    };

    if (method === 'cod') {
        // Cash on delivery – only needs an integration id, no iframe
        return {
            integrationId: process.env.PAYMOB_INTEGRATION_ID_COD || defaults.integrationId,
            iframeId: null
        };
    }

    if (method === 'wallet') {
        return {
            integrationId: process.env.PAYMOB_INTEGRATION_ID_WALLET || defaults.integrationId,
            iframeId: process.env.PAYMOB_IFRAME_ID_WALLET || defaults.iframeId
        };
    }

    if (method === 'card') {
        return {
            integrationId: process.env.PAYMOB_INTEGRATION_ID_CARD || defaults.integrationId,
            iframeId: process.env.PAYMOB_IFRAME_ID_CARD || defaults.iframeId
        };
    }

    return defaults;
}

/**
 * Main checkout endpoint - creates cart and redirects to Paymob
 */
app.post('/api/checkout/egypt', async (req, res) => {
    try {
        const { cartItems, customer, billingData, paymobMethod } = req.body;

        const missingShopify = getMissingEnv(['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_ACCESS_TOKEN']);
        if (missingShopify.length) {
            return res.status(500).json({
                success: false,
                error: `Missing Shopify env vars: ${missingShopify.join(', ')}`
            });
        }

        const missingPaymobBase = getMissingEnv(['PAYMOB_API_KEY']);
        if (missingPaymobBase.length) {
            return res.status(500).json({
                success: false,
                error: `Missing Paymob env vars: ${missingPaymobBase.join(', ')}`
            });
        }

        const paymobConfig = getPaymobMethodConfig(paymobMethod);
        if (!paymobConfig.integrationId) {
            return res.status(500).json({
                success: false,
                error: 'Paymob configuration missing (integration_id)'
            });
        }

        // Step 1: Calculate total from cart items (prices are already in EGP).
        const itemsTotal = cartItems.reduce((sum, item) => sum + (Number(item.price || 0) * (item.quantity || 1)), 0);
        const totalAmount = itemsTotal + 100; // + 100 EGP flat shipping

        // Step 2: Create draft order with EGP total stored in note_attributes.
        const draftOrder = await createDraftOrder(cartItems, customer, totalAmount);

        // If cash-on-delivery, we don't need an iframe URL.
        // Complete the draft order immediately so a real Shopify order is created, with payment pending.
        if (String(paymobMethod || '').toLowerCase() === 'cod') {
            const codRedirectUrl =
                process.env.COD_SUCCESS_URL ||
                (process.env.FRONTEND_URL &&
                    `${process.env.FRONTEND_URL.replace(/\/$/, '')}/cod-thank-you?draft=${draftOrder.id}`) ||
                '/';

            // Complete draft order as COD (payment still pending on Shopify side)
            try {
                const completeRes = await axios.put(
                    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/draft_orders/${draftOrder.id}/complete.json`,
                    {
                        payment_pending: true
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
                        }
                    }
                );

                const shopifyOrderId = completeRes.data?.draft_order?.order_id;

                // Tag the real Shopify order with payment method booleans
                if (shopifyOrderId) {
                    await axios.put(
                        `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/orders/${shopifyOrderId}.json`,
                        {
                            order: {
                                id: shopifyOrderId,
                                note_attributes: [
                                    { name: 'payment_method', value: 'cod' },
                                    { name: 'is_cod',    value: 'true' },
                                    { name: 'is_card',   value: 'false' },
                                    { name: 'is_wallet', value: 'false' }
                                ]
                            }
                        },
                        {
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
                            }
                        }
                    );
                }

                return res.json({
                    success: true,
                    cod: true,
                    shopifyDraftOrderId: draftOrder.id,
                    shopifyOrderId,
                    redirectUrl: codRedirectUrl
                });
            } catch (e) {
                console.error('Error completing COD draft order:', e.response?.data || e.message);
                return res.status(500).json({
                    success: false,
                    error: 'Failed to complete COD order in Shopify'
                });
            }

        }

        // Step 3: Authenticate with Paymob
        const authToken = await paymobAuthenticate();

        // Step 4: Register order with Paymob
        const paymobOrder = await paymobRegisterOrder(
            authToken,
            totalAmount,
            draftOrder.id.toString(), // Use Shopify draft order ID
            cartItems.map(item => ({
                name: item.name,
                price: item.price,
                quantity: item.quantity,
                description: item.description
            }))
        );

        // Use the exact cent value from paymobRegisterOrder so payment key amount_cents
        // always matches the order amount_cents.
        const exactTotalCents = paymobOrder._totalCents;

        // Step 5: Get Paymob payment key
        const paymentKey = await paymobGetPaymentKey(
            authToken,
            paymobOrder.id,
            exactTotalCents / 100, // convert back to unit for the helper (it multiplies by 100 internally)
            billingData,
            paymobConfig.integrationId
        );

        // Step 6: Return Paymob iframe URL
        const paymobIframeUrl = paymobConfig.iframeId
            ? `https://accept.paymob.com/api/acceptance/iframes/${paymobConfig.iframeId}?payment_token=${paymentKey}`
            : null;

        res.json({
            success: true,
            paymentUrl: paymobIframeUrl,
            shopifyDraftOrderId: draftOrder.id,
            paymobOrderId: paymobOrder.id,
            paymentToken: paymentKey
        });

    } catch (error) {
        const status = error?.response?.status;
        const data = error?.response?.data;

        // Axios errors (Shopify/Paymob) often contain useful JSON in error.response.data
        if (status) {
            console.error('Checkout upstream error:', status, data || error.message);
            return res.status(status).json({
                success: false,
                error: (data && (data.error || data.errors || data.message)) || error.message,
                details: data
            });
        }

        console.error('Checkout error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Paymob webhook callback - handles payment confirmation
 */
app.post('/api/paymob/callback', async (req, res) => {
    try {
        const data = req.body;

        // Verify HMAC signature (Paymob sends HMAC as a query parameter)
        const hmacSecret = process.env.PAYMOB_HMAC;
        const crypto = require('crypto');
        const receivedHmac = req.query.hmac;

        const concatenatedString =
            data.amount_cents +
            data.created_at +
            data.currency +
            data.error_occured +
            data.has_parent_transaction +
            data.id +
            data.integration_id +
            data.is_3d_secure +
            data.is_auth +
            data.is_capture +
            data.is_refunded +
            data.is_standalone_payment +
            data.is_voided +
            data.order +
            data.owner +
            data.pending +
            data.source_data_pan +
            data.source_data_sub_type +
            data.source_data_type +
            data.success;

        const calculatedHmac = crypto
            .createHmac('sha512', hmacSecret)
            .update(concatenatedString)
            .digest('hex');

        if (calculatedHmac !== receivedHmac) {
            return res.status(400).json({ error: 'Invalid HMAC signature' });
        }

        // Check payment success
        if (data.success === 'true' || data.success === true) {
            const shopifyDraftOrderId = data.order.merchant_order_id;

            // Detect payment method from Paymob source_data_type
            const sourceType = String(data.source_data_type || '').toLowerCase();
            const isWallet = sourceType === 'wallet';
            const isCard   = !isWallet; // card / token / everything else that isn't wallet
            const method   = isWallet ? 'wallet' : 'card';

            // Complete the Shopify draft order
            const completeRes = await axios.put(
                `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/draft_orders/${shopifyDraftOrderId}/complete.json`,
                { payment_pending: false },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
                    }
                }
            );

            const shopifyOrderId = completeRes.data?.draft_order?.order_id;

            // Tag the real Shopify order with payment method booleans
            if (shopifyOrderId) {
                await axios.put(
                    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/orders/${shopifyOrderId}.json`,
                    {
                        order: {
                            id: shopifyOrderId,
                            note_attributes: [
                                { name: 'payment_method', value: method },
                                { name: 'is_cod',    value: 'false' },
                                { name: 'is_card',   value: String(isCard) },
                                { name: 'is_wallet', value: String(isWallet) }
                            ]
                        }
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
                        }
                    }
                );
            }

            console.log(`✅ Order ${shopifyDraftOrderId} completed successfully (method: ${method})`);
        }

        res.status(200).json({ received: true });
    } catch (error) {
        console.error('Callback error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Success page redirect handler
 */
app.get('/api/checkout/success', (req, res) => {
    const { order_id } = req.query;
    res.redirect(`${process.env.FRONTEND_URL}/thank-you?order=${order_id}`);
});

/**
 * Render full checkout page from cart payload — Nazeerah-style design
 * POST /api/checkout/render
 * Expects body: { total, items: [{ id, name, category, price, quantity, image }] }
 */
function getCartPayloadCheckoutPageHtml(cart) {
    const safeCartJson = JSON.stringify(cart || { total: 0, items: [] }).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Checkout — Nazeerah</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.cdnfonts.com/css/futura-pt" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #faf9f7;
      --white: #ffffff;
      --border: #e8e4df;
      --border-focus: #b5a898;
      --text: #1a1a1a;
      --muted: #888077;
      --gold: #9a8660;
      --gold-hover: #7d6d4e;
      --label: #6b6258;
      --error: #b03a2e;
      --radius: 3px;
    }

    html, body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Jost', sans-serif;
      font-weight: 300;
      font-size: 14px;
      line-height: 1.6;
      min-height: 100vh;
    }

    /* ── Header ── */
    .site-header {
      background: var(--white);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 2rem;
      height: 60px;
    }
    .site-header .breadcrumb {
      font-size: 12px;
      color: var(--muted);
      letter-spacing: 0.03em;
    }
    .site-header .breadcrumb a { color: var(--muted); text-decoration: none; }
    .site-header .breadcrumb a:hover { color: var(--text); }
    .site-header .breadcrumb .sep { margin: 0 6px; }
    .logo {
      font-family: 'Cormorant Garamond', serif;
      font-size: 22px;
      font-weight: 500;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      text-decoration: none;
      color: var(--text);
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
    }
    .cart-icon {
      margin-left: auto;
      color: var(--muted);
      cursor: pointer;
      display: flex;
      align-items: center;
    }
    .cart-icon svg { width: 20px; height: 20px; }

    /* ── Layout ── */
    .checkout-layout {
      display: flex;
      min-height: calc(100vh - 60px);
    }

    /* Left panel — form */
    .form-panel {
      flex: 0 0 55%;
      max-width: 55%;
      padding: 3rem 4rem 3rem 6%;
      background: var(--white);
      border-right: 1px solid var(--border);
    }

    /* Right panel — order summary */
    .summary-panel {
      flex: 1;
      padding: 3rem 5% 3rem 3rem;
      background: var(--bg);
    }

    @media (max-width: 860px) {
      .checkout-layout { flex-direction: column; }
      .form-panel { flex: none; max-width: 100%; padding: 2rem 1.5rem; border-right: none; border-bottom: 1px solid var(--border); }
      .summary-panel { padding: 2rem 1.5rem; }
    }

    /* ── Section headings ── */
    .section-title {
      font-family: 'Jost', sans-serif;
      font-size: 13px;
      font-weight: 500;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text);
      margin-bottom: 1.1rem;
      margin-top: 2rem;
    }
    .section-title:first-child { margin-top: 0; }

    /* ── Fields ── */
    .field { margin-bottom: 10px; }
    .field-row { display: flex; gap: 10px; }
    .field-row .field { flex: 1; }

    .field label {
      display: block;
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--label);
      margin-bottom: 5px;
    }

    .field input,
    .field select {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--white);
      color: var(--text);
      font-family: 'Jost', sans-serif;
      font-size: 13.5px;
      font-weight: 300;
      transition: border-color 0.2s;
      outline: none;
      appearance: none;
      -webkit-appearance: none;
    }
    .field input::placeholder { color: #c0bab3; }
    .field input:focus,
    .field select:focus { border-color: var(--border-focus); }

    .field .input-wrap { position: relative; }
    .field .input-icon {
      position: absolute;
      right: 11px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--muted);
      pointer-events: none;
      display: flex;
    }
    .field .input-icon svg { width: 15px; height: 15px; }

    /* Select chevron */
    .select-wrap { position: relative; }
    .select-wrap::after {
      content: '';
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      width: 0; height: 0;
      border-left: 4px solid transparent;
      border-right: 4px solid transparent;
      border-top: 5px solid var(--muted);
      pointer-events: none;
    }
    .select-wrap select { padding-right: 30px; cursor: pointer; }

    /* Country label inside field */
    .country-label {
      font-size: 10px;
      color: var(--muted);
      letter-spacing: 0.04em;
      display: block;
      margin-bottom: 2px;
    }
    .select-country {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--white);
      padding: 6px 12px 8px;
    }
    .select-country .country-label { font-size: 10px; color: var(--muted); }
    .select-country .country-value {
      font-size: 13.5px;
      font-family: 'Jost', sans-serif;
      font-weight: 300;
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    /* Checkbox */
    .checkbox-field {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      cursor: pointer;
      font-size: 13px;
      color: var(--text);
    }
    .checkbox-field input[type="checkbox"] {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      accent-color: var(--gold);
      cursor: pointer;
    }

    /* ── Shipping method box ── */
    .shipping-box {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 12px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--bg);
      margin-bottom: 10px;
    }
    .shipping-box-left .shipping-name {
      font-size: 13.5px;
      font-weight: 400;
      color: var(--text);
    }
    .shipping-box-left .shipping-desc {
      font-size: 12px;
      color: var(--muted);
    }
    .shipping-price {
      font-size: 13.5px;
      color: var(--text);
    }

    /* ── Payment options ── */
    .payment-subtitle {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 1rem;
    }

    .payment-option {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 1px;
      cursor: pointer;
      transition: border-color 0.2s;
      overflow: hidden;
    }
    .payment-option:has(input:checked),
    .payment-option.selected {
      border-color: var(--border-focus);
    }
    .payment-option-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      background: var(--white);
    }
    .payment-option-header label {
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      flex: 1;
      font-size: 13.5px;
      font-weight: 400;
    }
    .payment-option-header input[type="radio"] {
      width: 16px;
      height: 16px;
      accent-color: var(--text);
      flex-shrink: 0;
    }
    .payment-badges {
      display: flex;
      gap: 4px;
      margin-left: auto;
      align-items: center;
    }
    .badge {
      height: 20px;
      padding: 0 6px;
      border: 1px solid var(--border);
      border-radius: 2px;
      font-size: 10px;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      letter-spacing: 0.03em;
      color: var(--muted);
    }
    .badge-visa { font-style: italic; font-size: 12px; font-weight: 600; color: #1a1f71; border-color: #c8c8c8; }
    .badge-mc { font-size: 10px; font-weight: 700; color: #eb001b; border-color: #c8c8c8; }
    .badge-amex { background: #2671b2; color: white; border-color: #2671b2; font-size: 9px; }
    .badge-more { background: var(--bg); }

    /* COD option */
    .cod-option {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 12px 14px;
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 1px;
      cursor: pointer;
      transition: border-color 0.2s;
    }
    .cod-option:has(input:checked) { border-color: var(--border-focus); }
    .cod-option label {
      cursor: pointer;
      font-size: 13.5px;
      font-weight: 400;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .cod-option input[type="radio"] {
      width: 16px;
      height: 16px;
      accent-color: var(--text);
    }

    /* ── Pay button ── */
    .pay-btn {
      width: 100%;
      margin-top: 1.5rem;
      padding: 14px 20px;
      background: var(--gold);
      color: #fff;
      border: none;
      border-radius: var(--radius);
      font-family: 'Jost', sans-serif;
      font-size: 13px;
      font-weight: 400;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      cursor: pointer;
      transition: background 0.2s;
    }
    .pay-btn:hover:not(:disabled) { background: var(--gold-hover); }
    .pay-btn:disabled { opacity: 0.65; cursor: not-allowed; }

    .error-msg {
      color: var(--error);
      font-size: 12px;
      margin-top: 0.5rem;
      display: none;
    }

    /* ── Order summary (right panel) ── */
    .order-items { margin-bottom: 1.5rem; }

    .order-item {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 10px 0;
      border-bottom: 1px solid var(--border);
    }
    .order-item:last-child { border-bottom: none; }

    .item-img-wrap {
      position: relative;
      flex-shrink: 0;
      width: 60px;
      height: 75px;
    }
    .item-img-wrap img {
      width: 60px;
      height: 75px;
      object-fit: cover;
      border-radius: 2px;
      border: 1px solid var(--border);
      background: #f0ede9;
    }
    .item-img-placeholder {
      width: 60px;
      height: 75px;
      background: #ede9e3;
      border-radius: 2px;
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .item-img-placeholder svg { width: 22px; height: 22px; color: #bbb; }
    .item-qty-badge {
      position: absolute;
      top: -6px;
      right: -6px;
      width: 18px;
      height: 18px;
      background: var(--muted);
      color: white;
      border-radius: 50%;
      font-size: 10px;
      font-weight: 500;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .item-info { flex: 1; }
    .item-name {
      font-size: 13.5px;
      font-weight: 400;
      color: var(--text);
      line-height: 1.3;
    }
    .item-variant {
      font-size: 12px;
      color: var(--muted);
      margin-top: 2px;
    }
    .item-price {
      font-size: 13.5px;
      font-weight: 400;
      color: var(--text);
      white-space: nowrap;
    }

    /* Discount code */
    .discount-row {
      display: flex;
      gap: 8px;
      margin-bottom: 1.2rem;
    }
    .discount-row input {
      flex: 1;
      padding: 9px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      font-family: 'Jost', sans-serif;
      font-size: 13px;
      font-weight: 300;
      outline: none;
      background: var(--white);
      color: var(--text);
      transition: border-color 0.2s;
    }
    .discount-row input::placeholder { color: #c0bab3; }
    .discount-row input:focus { border-color: var(--border-focus); }
    .discount-row button {
      padding: 9px 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--white);
      font-family: 'Jost', sans-serif;
      font-size: 12.5px;
      letter-spacing: 0.04em;
      cursor: pointer;
      color: var(--text);
      transition: border-color 0.2s, background 0.2s;
    }
    .discount-row button:hover { border-color: var(--border-focus); background: var(--bg); }

    /* Totals */
    .totals { border-top: 1px solid var(--border); padding-top: 1rem; }
    .total-line {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 4px 0;
      font-size: 13px;
    }
    .total-line .tl-label { color: var(--muted); }
    .total-line .tl-value { color: var(--text); }
    .total-line.grand {
      padding-top: 10px;
      margin-top: 6px;
      border-top: 1px solid var(--border);
    }
    .total-line.grand .tl-label {
      font-size: 15px;
      font-weight: 500;
      color: var(--text);
    }
    .total-line.grand .tl-value {
      font-size: 18px;
      font-weight: 500;
    }
    .total-line.grand .currency-code {
      font-size: 11px;
      font-weight: 300;
      color: var(--muted);
      margin-right: 4px;
      letter-spacing: 0.05em;
    }
    .shipping-info-icon {
      display: inline-flex;
      vertical-align: middle;
      margin-left: 4px;
      color: var(--muted);
    }
    .shipping-info-icon svg { width: 13px; height: 13px; }
  </style>
</head>
<body>

<!-- Header -->
<header class="site-header">
  <nav class="breadcrumb" aria-label="breadcrumb">
    <a href="#">Cart</a>
    <span class="sep">›</span>
    <strong>Information</strong>
    <span class="sep">›</span>
    <span>Shipping</span>
    <span class="sep">›</span>
    <span>Payment</span>
  </nav>
  <a href="/" class="logo">Nazeerah</a>
  <div class="cart-icon" aria-label="cart">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
      <line x1="3" y1="6" x2="21" y2="6"/>
      <path d="M16 10a4 4 0 01-8 0"/>
    </svg>
  </div>
</header>

<!-- Main layout -->
<div class="checkout-layout">

  <!-- LEFT: Form -->
  <div class="form-panel">
    <form id="checkout-form" novalidate>

      <!-- Contact -->
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

      <!-- Delivery -->
      <div class="section-title">Delivery</div>

      <div class="field">
        <div class="select-country">
          <span class="country-label">Country/Region</span>
          <div class="country-value">
            Egypt
            <svg viewBox="0 0 10 6" width="10" height="6" fill="none">
              <path d="M1 1l4 4 4-4" stroke="#888" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
          </div>
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <div class="input-wrap">
            <input id="first_name" name="first_name" type="text" placeholder="First name" autocomplete="given-name" required />
          </div>
        </div>
        <div class="field">
          <div class="input-wrap">
            <input id="last_name" name="last_name" type="text" placeholder="Last name" autocomplete="family-name" required />
          </div>
        </div>
      </div>

      <div class="field">
        <div class="input-wrap">
          <input id="address1" name="address1" type="text" placeholder="Address" autocomplete="address-line1" required />
          <span class="input-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
            </svg>
          </span>
        </div>
      </div>

      <div class="field">
        <div class="input-wrap">
          <input id="address2" name="address2" type="text" placeholder="Apartment, suite, etc. (optional)" autocomplete="address-line2" />
        </div>
      </div>

      <div class="field-row">
        <div class="field">
          <div class="input-wrap">
            <input id="city" name="city" type="text" placeholder="City" autocomplete="address-level2" required />
          </div>
        </div>
        <div class="field">
          <div class="input-wrap">
            <input id="state" name="state" type="text" placeholder="Governorate" autocomplete="address-level1" required />
          </div>
        </div>
        <div class="field">
          <div class="input-wrap">
            <input id="zip" name="zip" type="text" placeholder="ZIP code" autocomplete="postal-code" />
          </div>
        </div>
      </div>

      <div class="field">
        <div class="input-wrap">
          <input id="phone" name="phone" type="tel" placeholder="Phone (optional)" autocomplete="tel" />
          <span class="input-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>
            </svg>
          </span>
        </div>
      </div>

      <!-- Shipping method -->
      <div class="section-title">Shipping method</div>
      <div class="shipping-box">
        <div class="shipping-box-left">
          <div class="shipping-name">Standard Shipping</div>
          <div class="shipping-desc">2 to 5 business days</div>
        </div>
        <div class="shipping-price">100 EGP</div>
      </div>

      <!-- Payment -->
      <div class="section-title">Payment</div>
      <p class="payment-subtitle">All transactions are secure and encrypted.</p>

      <!-- Credit card option -->
      <div class="payment-option selected" id="opt-card">
        <div class="payment-option-header">
          <label>
            <input type="radio" name="paymob_method" value="card" checked onchange="onPaymentChange(this)" />
            Credit card
          </label>
          <div class="payment-badges">
            <span class="badge badge-visa">VISA</span>
            <span class="badge badge-mc">MC</span>
            <span class="badge badge-amex">AMEX</span>
            <span class="badge badge-more">+5</span>
          </div>
        </div>
      </div>

      <!-- Wallet option -->
      <div class="payment-option" id="opt-wallet">
        <div class="payment-option-header">
          <label>
            <input type="radio" name="paymob_method" value="wallet" onchange="onPaymentChange(this)" />
            Mobile wallet
          </label>
        </div>
      </div>

      <!-- COD -->
      <div class="cod-option" id="opt-cod">
        <label>
          <input type="radio" name="paymob_method" value="cod" onchange="onPaymentChange(this)" />
          Cash on Delivery
        </label>
      </div>

      <button type="submit" id="pay-btn" class="pay-btn">Pay now</button>
      <p id="error-msg" class="error-msg"></p>

    </form>
  </div>

  <!-- RIGHT: Order summary -->
  <div class="summary-panel">
    <div id="order-items" class="order-items"></div>

    <div class="discount-row">
      <input type="text" placeholder="Discount code or gift card" />
      <button type="button">Apply</button>
    </div>

    <div class="totals" id="totals"></div>
  </div>

</div>

<script>
(function () {
  var CART = ${safeCartJson};

  /* ── Render order items ── */
  function fmt(v) {
    return new Intl.NumberFormat('en-EG', { style: 'currency', currency: 'EGP' }).format(v || 0);
  }

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
        + '<div class="item-img-wrap">'
        +   imgHtml
        +   '<span class="item-qty-badge">' + (item.quantity || 1) + '</span>'
        + '</div>'
        + '<div class="item-info">'
        +   '<div class="item-name">' + (item.name || 'Item') + '</div>'
        +   (item.category ? '<div class="item-variant">' + item.category + '</div>' : '')
        + '</div>'
        + '<div class="item-price">' + fmt((item.price || 0) * (item.quantity || 1)) + '</div>'
        + '</div>';
    });
    el.innerHTML = html;
  }

  function renderTotals() {
    var el = document.getElementById('totals');
    var subtotal = (CART && CART.total) || 0;
    var shipping = 100;
    var grand = subtotal + shipping;

    el.innerHTML =
      '<div class="total-line">'
      + '<span class="tl-label">Subtotal &middot; ' + ((CART && CART.items && CART.items.length) || 0) + ' items</span>'
      + '<span class="tl-value">' + fmt(subtotal) + '</span>'
      + '</div>'
      + '<div class="total-line">'
      + '<span class="tl-label">Shipping'
      + '<span class="shipping-info-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg></span>'
      + '</span>'
      + '<span class="tl-value">100 EGP</span>'
      + '</div>'
      + '<div class="total-line grand">'
      + '<span class="tl-label">Total</span>'
      + '<span class="tl-value"><span class="currency-code">EGP</span>' + fmt(grand) + '</span>'
      + '</div>';
  }

  renderItems();
  renderTotals();

  /* ── Payment method toggle ── */
  window.onPaymentChange = function (input) {
    var opts = ['opt-card', 'opt-wallet', 'opt-cod'];
    opts.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.remove('selected');
    });
    var target = document.getElementById('opt-' + input.value);
    if (target) target.classList.add('selected');
  };

  /* ── Form submit ── */
  var form = document.getElementById('checkout-form');
  var payBtn = document.getElementById('pay-btn');
  var errEl = document.getElementById('error-msg');

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    errEl.style.display = 'none';
    payBtn.disabled = true;
    payBtn.textContent = 'Processing...';

    try {
      var fd = new FormData(form);

      var customer = {
        email: fd.get('email'),
        firstName: fd.get('first_name'),
        lastName: fd.get('last_name'),
        phone: fd.get('phone'),
        city: fd.get('city'),
        address1: fd.get('address1'),
        address2: fd.get('address2'),
        zip: fd.get('zip'),
        province: fd.get('state'),
        country: 'EG',
        country_code: 'EG'
      };

      var billingData = {
        email: customer.email,
        first_name: customer.firstName,
        last_name: customer.lastName,
        phone_number: customer.phone,
        city: customer.city || 'Cairo',
        street: customer.address1 || 'NA',
        building: customer.address2 || 'NA',
        apartment: 'NA',
        floor: 'NA',
        postal_code: customer.zip || '00000',
        state: customer.province || 'Cairo'
      };

      var cartItems = ((CART && CART.items) || []).map(function (item) {
        var rawVariant = item.variantId || item.variant_id || item.id;
        return {
          variantId: 'gid://shopify/ProductVariant/' + rawVariant,
          quantity: item.quantity,
          name: item.name,
          price: item.price,
          description: item.category || item.name
        };
      });

      var body = {
        cartItems: cartItems,
        customer: customer,
        billingData: billingData,
        paymobMethod: fd.get('paymob_method')
      };

      var res = await fetch('/api/checkout/egypt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      var text = await res.text();
      var json;
      try { json = JSON.parse(text); } catch (_) { json = null; }

      if (!res.ok) {
        showError((json && (json.error || json.message)) || text || 'Checkout failed');
        return;
      }
      if (!json) { showError(text || 'Checkout failed'); return; }

      if (json.success && json.paymentUrl) {
        window.location.href = json.paymentUrl;
      } else if (json.success && json.cod) {
        if (json.redirectUrl) {
          window.location.href = json.redirectUrl;
        } else {
          payBtn.disabled = true;
          payBtn.textContent = 'Order placed (Cash on delivery)';
        }
      } else {
        showError(json.error || 'Checkout failed');
      }
    } catch (err) {
      showError(err.message || 'Checkout failed. Please try again.');
    } finally {
      if (!payBtn.disabled) {
        payBtn.disabled = false;
        payBtn.textContent = 'Pay now';
      }
    }
  });

  function showError(msg) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
    payBtn.disabled = false;
    payBtn.textContent = 'Pay now';
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
    if (!token) {
        return res.status(400).send('Missing token');
    }
    const session = checkoutSessions.get(token);
    if (!session) {
        return res.status(404).send('Checkout session expired or invalid');
    }
    const { cart, createdAt } = session;
    if (Date.now() - createdAt > SESSION_TTL_MS) {
        checkoutSessions.delete(token);
        return res.status(410).send('Checkout session expired');
    }

    // one-time use
    checkoutSessions.delete(token);
    res.type('html').send(getCartPayloadCheckoutPageHtml(cart));
});

// Debug endpoint: shows which env vars are missing (names only).
app.get('/api/debug/env', (req, res) => {
    const required = [
        'SHOPIFY_STORE_DOMAIN',
        'SHOPIFY_ADMIN_ACCESS_TOKEN',
        'PAYMOB_API_KEY',
        'PAYMOB_INTEGRATION_ID',
        'PAYMOB_IFRAME_ID',
        'PAYMOB_INTEGRATION_ID_CARD',
        'PAYMOB_IFRAME_ID_CARD',
        'PAYMOB_INTEGRATION_ID_WALLET',
        'PAYMOB_IFRAME_ID_WALLET',
        'PAYMOB_INTEGRATION_ID_KIOSK',
        'PAYMOB_IFRAME_ID_KIOSK'
    ];
    const missing = getMissingEnv(required);
    res.json({
        ok: missing.length === 0,
        missing
    });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\uD83D\uDE80 Server running on port ${PORT}`);
});
