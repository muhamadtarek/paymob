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

// ==================== CURRENCY CONVERSION ====================

/**
 * Convert a USD price to EGP.
 * Priority:
 *   1. EGP_PER_USD env var  – set a fixed rate (e.g. EGP_PER_USD=50.5)
 *   2. Live rate from exchangerate-api (free, no key needed)
 *   3. Hard-coded fallback of 50 if the request fails
 */
let _cachedRate = null;
let _cachedRateAt = 0;
const RATE_TTL_MS = 60 * 60 * 1000; // cache for 1 hour

async function getUsdToEgpRate() {
    // Fixed rate from env takes highest priority
    if (process.env.EGP_PER_USD) {
        const fixed = parseFloat(process.env.EGP_PER_USD);
        if (!isNaN(fixed) && fixed > 0) return fixed;
    }
    // Return cached rate if still fresh
    if (_cachedRate && Date.now() - _cachedRateAt < RATE_TTL_MS) {
        return _cachedRate;
    }
    try {
        const r = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 5000 });
        const rate = r.data?.rates?.EGP;
        if (rate && rate > 0) {
            _cachedRate = rate;
            _cachedRateAt = Date.now();
            console.log(`💱 USD→EGP rate refreshed: ${rate}`);
            return rate;
        }
    } catch (e) {
        console.warn('Could not fetch live USD→EGP rate:', e.message);
    }
    // Fallback
    return _cachedRate || 50;
}

function convertUsdToEgp(usdAmount, rate) {
    return Math.round(Number(usdAmount) * rate * 100) / 100;
}

// ==================== SHOPIFY FUNCTIONS ====================

/**
 * Create a Draft Order (Alternative method for saving cart)
 */
async function createDraftOrder(cartItems, customer, egpTotal) {
    // Always use custom line items with explicit EGP prices.
    // Shopify ignores the `price` field on variant line items and uses the
    // variant's stored price in the store's base currency (USD) instead.
    // By omitting variant_id and setting price explicitly, Shopify takes our
    // EGP value as-is. We store the variant_id in `properties` for reference.
    function buildEgpLineItems() {
        return cartItems.map((item) => {
            const raw = item?.variantId;
            const numericVariantId = raw ? String(raw).split('/').pop() : null;
            // We set price to "0" intentionally.
            // Shopify's base currency is USD — any price we send gets stored as USD
            // and displayed as "$X USD" in the admin, which is wrong.
            // The real EGP prices are stored in note_attributes (egp_items + egp_total)
            // so your team can see the correct amounts on the order page.
            const lineItem = {
                title: item?.name || 'Item',
                quantity: item?.quantity || 1,
                price: '0.00',
                properties: [
                    { name: 'EGP Price', value: String(Number(item?.price || 0)) },
                    { name: 'EGP Line Total', value: String(Math.round(Number(item?.price || 0) * (item?.quantity || 1) * 100) / 100) },
                ]
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
                // currency + presentment_currency both set to EGP so Shopify
                // records the order in EGP rather than converting to USD.
                currency: 'EGP',
                presentment_currency: 'EGP',
                note: 'Paymob checkout pending',
                tags: 'paymob-pending',
                // Store the canonical EGP total in note_attributes so it
                // survives as-is even if Shopify re-prices in USD internally.
                note_attributes: [
                    { name: 'Currency', value: 'EGP' },
                    { name: 'EGP Total (excl. shipping)', value: String(Math.round((egpTotal - 100) * 100) / 100 || 0) },
                    { name: 'EGP Shipping', value: '100.00' },
                    { name: 'EGP Grand Total', value: String(egpTotal || 0) },
                    ...cartItems.map((item, i) => ({
                        name: `Item ${i + 1}: ${item?.name || 'Item'}`,
                        value: `Qty ${item?.quantity || 1} x EGP ${Number(item?.price || 0)} = EGP ${Math.round(Number(item?.price || 0) * (item?.quantity || 1) * 100) / 100}`
                    }))
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
        // Always build EGP custom line items — variant line items would have
        // their price silently overwritten by Shopify's stored USD price.
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
        // amount_cents on each item must be the UNIT price in cents (not total).
        // The grand total (amount_cents on the order) must equal
        // sum(item.amount_cents * item.quantity) across all items including shipping.
        // A mismatch causes Paymob to reject or silently convert the currency.
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
        // call uses the same figure — preventing any currency mismatch.
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

        // Step 1: Calculate EGP total from cart items BEFORE creating the draft order
        // so we can store it on the order itself — Shopify will always save prices
        // in the store's base currency (USD) regardless of what we send.
        const itemsTotal = cartItems.reduce((sum, item) => sum + (Number(item.price || 0) * (item.quantity || 1)), 0);
        const totalAmount = itemsTotal + 100; // + 100 EGP flat shipping

        // Step 2: Create draft order, embedding EGP total in note_attributes.
        // IMPORTANT: For Shopify to honour currency:'EGP' you must enable EGP
        // in your store's Markets / Currencies settings. If EGP is not enabled,
        // Shopify will silently ignore the currency field and store USD instead.
        // The egp_total note_attribute is the canonical source of truth regardless.
        const draftOrder = await createDraftOrder(cartItems, customer, totalAmount);

        // Warn if Shopify ignored EGP (happens when EGP is not an enabled currency)
        if (draftOrder.currency && draftOrder.currency !== 'EGP') {
            console.warn(
                `⚠️  Shopify stored the draft order in ${draftOrder.currency} instead of EGP. ` +
                `Enable EGP in Shopify Admin → Settings → Markets to fix this. ` +
                `Paymob will still charge the correct EGP amount from note_attributes.`
            );
        }

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

        // Use the exact cent value calculated inside paymobRegisterOrder so that
        // the payment key amount_cents always matches the order amount_cents.
        // A mismatch is what causes Paymob to treat the amount as USD and convert.
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

            // Complete the Shopify draft order
            await axios.put(
                `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/draft_orders/${shopifyDraftOrderId}/complete.json`,
                {
                    payment_pending: false
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
                    }
                }
            );

            console.log(`✅ Order ${shopifyDraftOrderId} completed successfully`);
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
 * Render full checkout page from cart payload
 * POST /api/checkout/render
 * Expects body: { total, items: [{ id, name, category, price, quantity }] }
 */
function getCartPayloadCheckoutPageHtml(cart) {
    const safeCartJson = JSON.stringify(cart || { total: 0, items: [] }).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Checkout</title>
    <style>
        :root {
            color-scheme: light dark;
        }
        body {
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            margin: 0;
            padding: 0;
            background: #f5f5f5;
        }
        .page {
            max-width: 720px;
            margin: 2rem auto;
            padding: 1.5rem;
            background: #ffffff;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.05);
        }
        h1, h2 {
            margin: 0 0 1rem;
        }
        .grid {
            display: grid;
            grid-template-columns: 1.2fr 1fr;
            gap: 1.5rem;
        }
        @media (max-width: 768px) {
            .grid {
                grid-template-columns: 1fr;
            }
        }
        .card {
            border-radius: 10px;
            border: 1px solid #eee;
            padding: 1rem;
        }
        .items {
            list-style: none;
            padding: 0;
            margin: 0 0 0.75rem;
        }
        .items li {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            padding: 0.35rem 0;
            border-bottom: 1px dashed #eee;
            font-size: 0.95rem;
        }
        .items li:last-child {
            border-bottom: none;
        }
        .item-name {
            font-weight: 500;
        }
        .item-meta {
            color: #777;
            font-size: 0.85rem;
        }
        .price {
            font-variant-numeric: tabular-nums;
        }
        .total-row {
            display: flex;
            justify-content: space-between;
            font-weight: 600;
            margin-top: 0.75rem;
            padding-top: 0.75rem;
            border-top: 1px solid #ddd;
        }
        .field {
            margin-bottom: 0.75rem;
        }
        .field label {
            display: block;
            font-size: 0.85rem;
            margin-bottom: 0.25rem;
        }
        .field input, .field select {
            width: 100%;
            box-sizing: border-box;
            padding: 0.55rem 0.6rem;
            border-radius: 6px;
            border: 1px solid #ccc;
            font-size: 0.9rem;
        }
        .field-row {
            display: flex;
            gap: 0.75rem;
        }
        .field-row .field {
            flex: 1;
        }
        .paymob-options {
            display: flex;
            flex-direction: column;
            gap: 0.35rem;
            margin-bottom: 0.75rem;
            font-size: 0.9rem;
        }
        .paymob-options label {
            display: flex;
            align-items: center;
            gap: 0.4rem;
        }
        .checkout-button {
            width: 100%;
            padding: 0.9rem 1.2rem;
            font-size: 0.95rem;
            background: #000;
            color: #fff;
            border: none;
            border-radius: 999px;
            cursor: pointer;
            font-weight: 600;
        }
        .checkout-button:hover:not(:disabled) {
            background: #333;
        }
        .checkout-button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .note {
            font-size: 0.8rem;
            color: #777;
            margin-top: 0.35rem;
        }
        .error {
            color: #c00;
            margin-top: 0.5rem;
            font-size: 0.85rem;
        }
    </style>
</head>
<body>
<main class="page">
    <h1>Checkout</h1>
    <div class="grid">
        <section class="card">
            <h2>Order summary</h2>
            <div id="order-summary"></div>
        </section>
        <section class="card">
            <h2>Shipping & payment</h2>
            <form id="checkout-form">
                <div class="field-row">
                    <div class="field">
                        <label for="first_name">First name</label>
                        <input id="first_name" name="first_name" required autocomplete="given-name" />
                    </div>
                    <div class="field">
                        <label for="last_name">Last name</label>
                        <input id="last_name" name="last_name" required autocomplete="family-name" />
                    </div>
                </div>
                <div class="field">
                    <label for="email">Email</label>
                    <input id="email" name="email" type="email" required autocomplete="email" />
                </div>
                <div class="field">
                    <label for="phone">Phone</label>
                    <input id="phone" name="phone" required autocomplete="tel" />
                </div>
                <div class="field">
                    <label for="address1">Address</label>
                    <input id="address1" name="address1" required autocomplete="address-line1" />
                </div>
                <div class="field">
                    <label for="address2">Apartment, suite, etc. (optional)</label>
                    <input id="address2" name="address2" autocomplete="address-line2" />
                </div>
                <div class="field-row">
                    <div class="field">
                        <label for="city">City</label>
                        <input id="city" name="city" required autocomplete="address-level2" />
                    </div>
                    <div class="field">
                        <label for="state">State / Governorate</label>
                        <input id="state" name="state" required autocomplete="address-level1" />
                    </div>
                </div>
                <div class="field-row">
                    <div class="field">
                        <label for="zip">Postal code</label>
                        <input id="zip" name="zip" autocomplete="postal-code" />
                    </div>
                    <div class="field">
                        <label for="country">Country</label>
                        <select id="country" name="country" disabled>
                            <option value="EG" selected>Egypt</option>
                        </select>
                    </div>
                </div>
                <div class="field">
                    <label>Paymob payment option</label>
                    <div class="paymob-options">
                        <label><input type="radio" name="paymob_method" value="card" checked /> Card</label>
                        <label><input type="radio" name="paymob_method" value="wallet" /> Mobile wallet</label>
                        <label><input type="radio" name="paymob_method" value="cod" /> Cash on delivery</label>
                    </div>
                    <p class="note">Payment is securely processed by Paymob.</p>
                </div>
                <button type="submit" id="pay-btn" class="checkout-button">
                    Pay with Paymob
                </button>
                <p id="error" class="error" style="display:none;"></p>
            </form>
        </section>
    </div>
</main>
<script>
    (function() {
        var CART = ${safeCartJson};
        var summaryEl = document.getElementById('order-summary');
        var form = document.getElementById('checkout-form');
        var payBtn = document.getElementById('pay-btn');
        var errEl = document.getElementById('error');

        function formatPrice(value) {
            return new Intl.NumberFormat('en-EG', { style: 'currency', currency: 'EGP' }).format(value || 0);
        }

        function renderSummary() {
            var cart = CART || { total: 0, items: [] };
            if (!cart.items || !cart.items.length) {
                summaryEl.textContent = 'No items in cart.';
                return;
            }
            var html = '<ul class="items">';
            cart.items.forEach(function(item) {
                html += '<li>' +
                    '<div>' +
                        '<div class="item-name">' + (item.name || '') + '</div>' +
                        '<div class="item-meta">Qty ' + (item.quantity || 1) + (item.category ? ' • ' + item.category : '') + '</div>' +
                    '</div>' +
                    '<div class="price">' + formatPrice((item.price || 0) * (item.quantity || 1)) + '</div>' +
                '</li>';
            });
            html += '</ul>';
            var shipping = 100;
            var grandTotal = (cart.total || 0) + shipping;
            html += '<div class="total-row" style="font-weight:400;color:#555;"><span>Subtotal</span><span class="price">' + formatPrice(cart.total || 0) + '</span></div>';
            html += '<div class="total-row" style="font-weight:400;color:#555;"><span>Shipping (flat rate)</span><span class="price">' + formatPrice(shipping) + '</span></div>';
            html += '<div class="total-row"><span>Total</span><span class="price">' + formatPrice(grandTotal) + '</span></div>';
            summaryEl.innerHTML = html;
        }

        function showError(msg) {
            errEl.textContent = msg;
            errEl.style.display = 'block';
        }

        form.addEventListener('submit', async function(e) {
            e.preventDefault();
            errEl.style.display = 'none';
            payBtn.disabled = true;
            payBtn.textContent = 'Processing...';

            try {
                var cart = CART || { total: 0, items: [] };
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

                var cartItems = (cart.items || []).map(function(item) {
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

                if (!json) {
                    showError(text || 'Checkout failed');
                    return;
                }
                if (json.success && json.paymentUrl) {
                    // Card / wallet – redirect to Paymob iframe
                    window.location.href = json.paymentUrl;
                } else if (json.success && json.cod) {
                    // Cash on delivery – redirect to a normal thank-you / confirmation page
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
                payBtn.disabled = false;
                payBtn.textContent = 'Pay with Paymob';
            }
        });

        renderSummary();
    })();
</script>
</body>
</html>`;
}

app.post('/api/checkout/render', async (req, res) => {
    try {
        const { total, items } = req.body || {};

        // Convert USD prices → EGP before storing in session.
        // The Shopify storefront sends prices in the store's base currency (USD).
        // Everything downstream (Paymob, draft order notes) must work in EGP.
        const rate = await getUsdToEgpRate();
        console.log(`💱 Converting cart prices USD→EGP at rate: ${rate}`);

        const egpItems = (Array.isArray(items) ? items : []).map(item => ({
            ...item,
            price: convertUsdToEgp(item.price || 0, rate)
        }));

        const egpTotal = typeof total === 'number'
            ? convertUsdToEgp(total, rate)
            : egpItems.reduce((s, i) => s + (i.price * (i.quantity || 1)), 0);

        const cart = { total: egpTotal, items: egpItems };
        const token = createCheckoutToken();
        checkoutSessions.set(token, { cart, createdAt: Date.now() });
        const baseUrl = getBaseUrl(req);
        const redirectUrl = baseUrl
            ? (baseUrl.replace(/\/$/, '') + '/api/checkout/page?token=' + token)
            : ('/api/checkout/page?token=' + token);
        res.json({ success: true, redirectUrl });
    } catch (err) {
        console.error('Error in /api/checkout/render:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
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
    console.log(`🚀 Server running on port ${PORT}`);
});