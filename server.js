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
    const safeCartJson = JSON.stringify(cart || { total: 0, items: [] }).replace(/</g, '\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Checkout – NAZEERAH</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
            font-size: 14px;
            color: #333;
            background: #fff;
        }
        a { color: #333; text-decoration: none; }

        /* ── Header ── */
        .header {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 18px 40px;
            border-bottom: 1px solid #e6e6e6;
            position: relative;
        }
        .header-logo {
            font-size: 18px;
            font-weight: 700;
            letter-spacing: 4px;
            text-transform: uppercase;
        }
        .header-cart {
            position: absolute;
            right: 40px;
            top: 50%;
            transform: translateY(-50%);
        }
        .header-cart svg { width: 22px; height: 22px; }

        /* ── Layout ── */
        .layout {
            display: flex;
            min-height: calc(100vh - 61px);
        }
        .left-col {
            flex: 1;
            padding: 40px 60px 60px 40px;
            max-width: 56%;
            border-right: 1px solid #e6e6e6;
        }
        .right-col {
            width: 44%;
            padding: 40px 40px 60px 60px;
            background: #fafafa;
        }
        @media (max-width: 800px) {
            .layout { flex-direction: column-reverse; }
            .left-col, .right-col { max-width: 100%; width: 100%; padding: 24px 20px; border: none; }
            .right-col { border-bottom: 1px solid #e6e6e6; background: #fafafa; }
        }

        /* ── Section headings ── */
        .section-title {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 16px;
        }
        .section + .section { margin-top: 28px; }

        /* ── Fields ── */
        .field { margin-bottom: 12px; }
        .field-row { display: flex; gap: 12px; }
        .field-row .field { flex: 1; }
        .field input, .field select {
            width: 100%;
            padding: 12px 14px;
            border: 1px solid #d9d9d9;
            border-radius: 5px;
            font-size: 14px;
            background: #fff;
            outline: none;
            transition: border-color 0.15s;
            appearance: none;
            -webkit-appearance: none;
        }
        .field input:focus, .field select:focus { border-color: #999; }
        .field input::placeholder { color: #aaa; }
        .field-label {
            font-size: 11px;
            color: #737373;
            margin-bottom: 4px;
            display: block;
        }
        /* floating label style inputs */
        .field-wrap {
            position: relative;
            border: 1px solid #d9d9d9;
            border-radius: 5px;
            background: #fff;
            transition: border-color 0.15s;
        }
        .field-wrap:focus-within { border-color: #999; }
        .field-wrap label {
            position: absolute;
            left: 14px;
            top: 50%;
            transform: translateY(-50%);
            font-size: 14px;
            color: #aaa;
            pointer-events: none;
            transition: all 0.15s;
        }
        .field-wrap input, .field-wrap select {
            width: 100%;
            border: none;
            outline: none;
            padding: 20px 14px 6px;
            font-size: 14px;
            background: transparent;
            appearance: none;
            -webkit-appearance: none;
        }
        .field-wrap input:not(:placeholder-shown) + label,
        .field-wrap input:focus + label,
        .field-wrap select:focus + label,
        .field-wrap select.has-value + label {
            top: 10px;
            transform: none;
            font-size: 11px;
            color: #737373;
        }
        .field-wrap .select-arrow {
            position: absolute;
            right: 14px;
            top: 50%;
            transform: translateY(-50%);
            pointer-events: none;
            color: #737373;
        }

        /* ── Checkbox row ── */
        .checkbox-row {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 16px;
            font-size: 13px;
            color: #333;
        }
        .checkbox-row input[type=checkbox] { width: 16px; height: 16px; accent-color: #333; }

        /* ── Shipping method box ── */
        .shipping-box {
            border: 1px solid #d9d9d9;
            border-radius: 5px;
            padding: 14px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: #f5f5f5;
        }
        .shipping-box-left { font-size: 13px; }
        .shipping-box-left strong { display: block; font-weight: 500; }
        .shipping-box-left span { color: #737373; font-size: 12px; }
        .shipping-box-right { font-size: 13px; font-weight: 500; }

        /* ── Payment options ── */
        .payment-option {
            border: 1px solid #d9d9d9;
            border-radius: 5px;
            overflow: hidden;
            margin-bottom: 12px;
        }
        .payment-option-row {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 14px 16px;
            cursor: pointer;
            background: #fff;
        }
        .payment-option-row input[type=radio] { accent-color: #333; }
        .payment-option-row label { flex: 1; font-size: 14px; cursor: pointer; }
        .payment-option-row .card-icons { display: flex; gap: 6px; align-items: center; }
        .payment-option-row .card-icons img { height: 22px; border-radius: 3px; border: 1px solid #e6e6e6; }
        .card-fields {
            border-top: 1px solid #e6e6e6;
            padding: 16px;
            background: #fafafa;
            display: none;
        }
        .card-fields.visible { display: block; }

        /* ── Pay button ── */
        .pay-btn {
            width: 100%;
            padding: 16px;
            background: #b5933a;
            color: #fff;
            font-size: 16px;
            font-weight: 600;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            margin-top: 20px;
            transition: background 0.15s;
        }
        .pay-btn:hover:not(:disabled) { background: #9e7e2f; }
        .pay-btn:disabled { opacity: 0.65; cursor: not-allowed; }

        /* ── Footer links ── */
        .footer-links {
            display: flex;
            gap: 16px;
            flex-wrap: wrap;
            margin-top: 32px;
            font-size: 12px;
            color: #737373;
        }
        .footer-links a { color: #737373; text-decoration: underline; }

        /* ── Error ── */
        .error-msg { color: #c00; font-size: 13px; margin-top: 10px; display: none; }

        /* ── Right col: order summary ── */
        .order-items { list-style: none; margin-bottom: 20px; }
        .order-item {
            display: flex;
            align-items: center;
            gap: 14px;
            padding: 10px 0;
        }
        .order-item-img-wrap {
            position: relative;
            flex-shrink: 0;
        }
        .order-item-img {
            width: 64px;
            height: 64px;
            object-fit: cover;
            border-radius: 6px;
            border: 1px solid #e6e6e6;
            background: #f0f0f0;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 22px;
        }
        .order-item-badge {
            position: absolute;
            top: -6px;
            right: -6px;
            background: #737373;
            color: #fff;
            border-radius: 50%;
            width: 20px;
            height: 20px;
            font-size: 11px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 600;
        }
        .order-item-info { flex: 1; }
        .order-item-name { font-weight: 500; font-size: 14px; }
        .order-item-variant { color: #737373; font-size: 12px; margin-top: 2px; }
        .order-item-price { font-size: 14px; font-weight: 500; white-space: nowrap; }

        .discount-row {
            display: flex;
            gap: 8px;
            margin-bottom: 16px;
        }
        .discount-row input {
            flex: 1;
            padding: 10px 14px;
            border: 1px solid #d9d9d9;
            border-radius: 5px;
            font-size: 13px;
            outline: none;
        }
        .discount-row input:focus { border-color: #999; }
        .discount-row button {
            padding: 10px 18px;
            background: #fff;
            border: 1px solid #d9d9d9;
            border-radius: 5px;
            font-size: 13px;
            cursor: pointer;
            color: #333;
        }

        .summary-line {
            display: flex;
            justify-content: space-between;
            font-size: 14px;
            padding: 6px 0;
            color: #333;
        }
        .summary-line.total {
            font-size: 16px;
            font-weight: 600;
            padding-top: 14px;
            border-top: 1px solid #e6e6e6;
            margin-top: 8px;
            align-items: center;
        }
        .summary-line.total .total-label { font-size: 16px; }
        .summary-line.total .total-currency { font-size: 12px; color: #737373; margin-right: 4px; }
        .summary-line.total .total-amount { font-size: 22px; font-weight: 700; }
        .summary-line .muted { color: #737373; }
    </style>
</head>
<body>

<header class="header">
    <div class="header-logo">Nazeerah</div>
    <div class="header-cart">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
            <line x1="3" y1="6" x2="21" y2="6"/>
            <path d="M16 10a4 4 0 01-8 0"/>
        </svg>
    </div>
</header>

<div class="layout">

    <!-- ══ LEFT: Form ══ -->
    <div class="left-col">
        <form id="checkout-form">

            <!-- Contact -->
            <div class="section">
                <div class="section-title">Contact</div>
                <div class="field-wrap field">
                    <input id="email" name="email" type="email" placeholder=" " required autocomplete="email" />
                    <label for="email">Email</label>
                </div>
                <div class="checkbox-row">
                    <input type="checkbox" id="newsletter" name="newsletter" />
                    <label for="newsletter">Email me with news and offers</label>
                </div>
            </div>

            <!-- Delivery -->
            <div class="section">
                <div class="section-title">Delivery</div>

                <div class="field field-wrap" style="margin-bottom:12px;">
                    <select id="country" name="country" class="has-value" disabled>
                        <option value="EG" selected>Egypt</option>
                    </select>
                    <label for="country">Country/Region</label>
                    <span class="select-arrow">&#8964;</span>
                </div>

                <div class="field-row">
                    <div class="field-wrap field">
                        <input id="first_name" name="first_name" placeholder=" " required autocomplete="given-name" />
                        <label for="first_name">First name</label>
                    </div>
                    <div class="field-wrap field">
                        <input id="last_name" name="last_name" placeholder=" " required autocomplete="family-name" />
                        <label for="last_name">Last name</label>
                    </div>
                </div>

                <div class="field-wrap field">
                    <input id="address1" name="address1" placeholder=" " required autocomplete="address-line1" />
                    <label for="address1">Address</label>
                </div>

                <div class="field-wrap field">
                    <input id="address2" name="address2" placeholder=" " autocomplete="address-line2" />
                    <label for="address2">Apartment, suite, etc. (optional)</label>
                </div>

                <div class="field-row">
                    <div class="field-wrap field">
                        <input id="city" name="city" placeholder=" " required autocomplete="address-level2" />
                        <label for="city">City</label>
                    </div>
                    <div class="field-wrap field" style="position:relative;">
                        <select id="state" name="state" required autocomplete="address-level1">
                            <option value="" disabled selected></option>
                            <option>Cairo</option>
                            <option>Alexandria</option>
                            <option>Giza</option>
                            <option>Qalyubia</option>
                            <option>Sharqia</option>
                            <option>Dakahlia</option>
                            <option>Beheira</option>
                            <option>Monufia</option>
                            <option>Gharbia</option>
                            <option>Kafr el-Sheikh</option>
                            <option>Damietta</option>
                            <option>Port Said</option>
                            <option>Ismailia</option>
                            <option>Suez</option>
                            <option>North Sinai</option>
                            <option>South Sinai</option>
                            <option>Matrouh</option>
                            <option>Alexandria</option>
                            <option>Fayoum</option>
                            <option>Beni Suef</option>
                            <option>Minya</option>
                            <option>Asyut</option>
                            <option>Sohag</option>
                            <option>Qena</option>
                            <option>Luxor</option>
                            <option>Aswan</option>
                            <option>Red Sea</option>
                            <option>New Valley</option>
                        </select>
                        <label for="state">Governorate</label>
                        <span class="select-arrow">&#8964;</span>
                    </div>
                    <div class="field-wrap field">
                        <input id="zip" name="zip" placeholder=" " autocomplete="postal-code" />
                        <label for="zip">Postal code</label>
                    </div>
                </div>

                <div class="field-wrap field">
                    <input id="phone" name="phone" type="tel" placeholder=" " autocomplete="tel" />
                    <label for="phone">Phone (optional)</label>
                </div>
            </div>

            <!-- Shipping method -->
            <div class="section">
                <div class="section-title">Shipping method</div>
                <div class="shipping-box">
                    <div class="shipping-box-left">
                        <strong>Standard Shipping</strong>
                        <span>2 to 5 business days</span>
                    </div>
                    <div class="shipping-box-right">100 EGP</div>
                </div>
            </div>

            <!-- Payment -->
            <div class="section">
                <div class="section-title">Payment</div>
                <p style="font-size:12px;color:#737373;margin-bottom:12px;">All transactions are secure and encrypted.</p>

                <!-- Credit card option -->
                <div class="payment-option">
                    <div class="payment-option-row">
                        <input type="radio" name="paymob_method" id="pm_card" value="card" checked />
                        <label for="pm_card">Credit card</label>
                        <div class="card-icons">
                            <img src="https://cdn.shopify.com/shopifycloud/checkout-web/assets/0169ce6e7549e0ca.svg" alt="Visa" onerror="this.style.display='none'" />
                            <img src="https://cdn.shopify.com/shopifycloud/checkout-web/assets/ae9ceec48b2d2af7.svg" alt="Mastercard" onerror="this.style.display='none'" />
                            <span style="font-size:12px;color:#737373;">+5</span>
                        </div>
                    </div>
                    <div class="card-fields visible" id="card-fields-wrap">
                        <div class="field-wrap field">
                            <input name="_card_number" placeholder=" " autocomplete="cc-number" inputmode="numeric" />
                            <label>Card number</label>
                        </div>
                        <div class="field-row">
                            <div class="field-wrap field">
                                <input name="_card_expiry" placeholder=" " autocomplete="cc-exp" />
                                <label>Expiration date (MM / YY)</label>
                            </div>
                            <div class="field-wrap field">
                                <input name="_card_cvv" placeholder=" " autocomplete="cc-csc" />
                                <label>Security code</label>
                            </div>
                        </div>
                        <div class="field-wrap field">
                            <input name="_card_name" placeholder=" " autocomplete="cc-name" />
                            <label>Name on card</label>
                        </div>
                        <div class="checkbox-row" style="margin-top:4px;margin-bottom:0;">
                            <input type="checkbox" id="same_billing" name="same_billing" />
                            <label for="same_billing">Use shipping address as billing address</label>
                        </div>
                    </div>
                </div>

                <!-- Mobile wallet option -->
                <div class="payment-option">
                    <div class="payment-option-row">
                        <input type="radio" name="paymob_method" id="pm_wallet" value="wallet" />
                        <label for="pm_wallet">Mobile wallet</label>
                    </div>
                </div>

                <!-- Cash on delivery option -->
                <div class="payment-option">
                    <div class="payment-option-row">
                        <input type="radio" name="paymob_method" id="pm_cod" value="cod" />
                        <label for="pm_cod">Cash on Delivery</label>
                    </div>
                </div>
            </div>

            <p id="error" class="error-msg"></p>
            <button type="submit" id="pay-btn" class="pay-btn">Pay now</button>

            <div class="footer-links">
                <a href="#">Refund policy</a>
                <a href="#">Shipping</a>
                <a href="#">Privacy policy</a>
                <a href="#">Terms of service</a>
                <a href="#">Contact</a>
            </div>

        </form>
    </div>

    <!-- ══ RIGHT: Order summary ══ -->
    <div class="right-col">
        <ul class="order-items" id="order-items"></ul>

        <div class="discount-row">
            <input type="text" placeholder="Discount code or gift card" id="discount-input" />
            <button type="button" onclick="return false;">Apply</button>
        </div>

        <div id="order-totals"></div>
    </div>

</div>

<script>
(function() {
    var CART = ${safeCartJson};

    function formatEGP(val) {
        return new Intl.NumberFormat('en-EG', { style: 'currency', currency: 'EGP' }).format(val || 0);
    }

    /* ── Render right-col items ── */
    function renderItems() {
        var items = (CART && CART.items) || [];
        var el = document.getElementById('order-items');
        if (!items.length) { el.innerHTML = '<li style="color:#737373;font-size:13px;">No items in cart.</li>'; return; }
        el.innerHTML = items.map(function(item) {
            return '<li class="order-item">' +
                '<div class="order-item-img-wrap">' +
                    '<div class="order-item-img">' + (item.name ? item.name[0] : '?') + '</div>' +
                    '<div class="order-item-badge">' + (item.quantity || 1) + '</div>' +
                '</div>' +
                '<div class="order-item-info">' +
                    '<div class="order-item-name">' + (item.name || '') + '</div>' +
                    '<div class="order-item-variant">' + (item.category || '') + '</div>' +
                '</div>' +
                '<div class="order-item-price">' + formatEGP((item.price || 0) * (item.quantity || 1)) + '</div>' +
            '</li>';
        }).join('');
    }

    function renderTotals() {
        var subtotal = (CART && CART.total) || 0;
        var shipping = 100;
        var grand = subtotal + shipping;
        var el = document.getElementById('order-totals');
        el.innerHTML =
            '<div class="summary-line"><span>Subtotal &middot; ' + ((CART && CART.items && CART.items.length) || 0) + ' items</span><span>' + formatEGP(subtotal) + '</span></div>' +
            '<div class="summary-line"><span>Shipping</span><span class="muted">100 EGP</span></div>' +
            '<div class="summary-line total">' +
                '<span class="total-label">Total</span>' +
                '<span><span class="total-currency">EGP</span><span class="total-amount">' + formatEGP(grand) + '</span></span>' +
            '</div>';
    }

    renderItems();
    renderTotals();

    /* ── Toggle card fields ── */
    document.querySelectorAll('input[name=paymob_method]').forEach(function(radio) {
        radio.addEventListener('change', function() {
            var cardWrap = document.getElementById('card-fields-wrap');
            cardWrap.classList.toggle('visible', this.value === 'card');
        });
    });

    /* ── Form submit ── */
    var form = document.getElementById('checkout-form');
    var payBtn = document.getElementById('pay-btn');
    var errEl = document.getElementById('error');

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
                errEl.textContent = (json && (json.error || json.message)) || text || 'Checkout failed';
                errEl.style.display = 'block';
                return;
            }
            if (!json) { errEl.textContent = text || 'Checkout failed'; errEl.style.display = 'block'; return; }

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
                errEl.textContent = json.error || 'Checkout failed';
                errEl.style.display = 'block';
            }
        } catch (err) {
            errEl.textContent = err.message || 'Checkout failed. Please try again.';
            errEl.style.display = 'block';
        } finally {
            payBtn.disabled = false;
            payBtn.textContent = 'Pay now';
        }
    });
})();
</script>
</body>
</html>`;
}


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