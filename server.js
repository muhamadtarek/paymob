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

// ==================== SHOPIFY FUNCTIONS ====================

/**
 * Create a Shopify Cart using Storefront API
 */
async function createShopifyCart(cartItems, customerEmail = null) {
    const query = `
    mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart {
          id
          checkoutUrl
          lines(first: 10) {
            edges {
              node {
                id
                quantity
                merchandise {
                  ... on ProductVariant {
                    id
                    title
                    price {
                      amount
                      currencyCode
                    }
                    product {
                      title
                    }
                  }
                }
              }
            }
          }
          cost {
            totalAmount {
              amount
              currencyCode
            }
            subtotalAmount {
              amount
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

    const variables = {
        input: {
            lines: cartItems.map(item => ({
                merchandiseId: item.variantId,
                quantity: item.quantity
            })),
            ...(customerEmail && {
                buyerIdentity: {
                    email: customerEmail
                }
            })
        }
    };

    try {
        const response = await axios.post(
            `https://${process.env.SHOPIFY_STORE_DOMAIN}/api/2025-01/graphql.json`,
            { query, variables },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Storefront-Access-Token': process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN
                }
            }
        );

        return response.data.data.cartCreate.cart;
    } catch (error) {
        console.error('Error creating Shopify cart:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Create a Draft Order (Alternative method for saving cart)
 */
async function createDraftOrder(cartItems, customer) {
    const lineItems = cartItems.map(item => ({
        variant_id: item.variantId.split('/').pop(), // Extract numeric ID
        quantity: item.quantity
    }));

    const draftOrder = {
        draft_order: {
            line_items: lineItems,
            customer: customer || {},
            note: 'Paymob checkout pending',
            tags: 'paymob-pending',
            use_customer_default_address: false
        }
    };

    try {
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
    } catch (error) {
        console.error('Error creating draft order:', error.response?.data || error.message);
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
        const response = await axios.post('https://accept.paymob.com/api/ecommerce/orders', {
            auth_token: authToken,
            delivery_needed: false,
            amount_cents: Math.round(amount * 100), // Convert to cents
            currency: 'EGP',
            merchant_order_id: merchantOrderId,
            items: items.map(item => ({
                name: item.name,
                amount_cents: Math.round(item.price * 100),
                description: item.description || item.name,
                quantity: item.quantity
            }))
        });

        return response.data;
    } catch (error) {
        console.error('Paymob order registration error:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Step 3: Get Payment Key from Paymob
 */
async function paymobGetPaymentKey(authToken, orderId, amount, billingData) {
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
            integration_id: process.env.PAYMOB_INTEGRATION_ID
        });

        return response.data.token;
    } catch (error) {
        console.error('Paymob payment key error:', error.response?.data || error.message);
        throw error;
    }
}

// ==================== API ENDPOINTS ====================

/**
 * Main checkout endpoint - creates cart and redirects to Paymob
 */
app.post('/api/checkout/egypt', async (req, res) => {
    try {
        const { cartItems, customer, billingData } = req.body;

        // Step 1: Create draft order for tracking and pricing
        const draftOrder = await createDraftOrder(cartItems, customer);

        // Step 2: Calculate total amount from draft order
        const totalAmount = parseFloat(draftOrder.total_price);

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

        // Step 5: Get Paymob payment key
        const paymentKey = await paymobGetPaymentKey(
            authToken,
            paymobOrder.id,
            totalAmount,
            billingData
        );

        // Step 6: Return Paymob iframe URL
        const paymobIframeUrl = `https://accept.paymob.com/api/acceptance/iframes/${process.env.PAYMOB_IFRAME_ID}?payment_token=${paymentKey}`;

        res.json({
            success: true,
            paymentUrl: paymobIframeUrl,
            shopifyDraftOrderId: draftOrder.id,
            paymobOrderId: paymobOrder.id,
            paymentToken: paymentKey
        });

    } catch (error) {
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
                        <label><input type="radio" name="paymob_method" value="kiosk" /> Kiosk / cash</label>
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
            html += '<div class="total-row"><span>Total</span><span class="price">' + formatPrice(cart.total || 0) + '</span></div>';
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
                    return {
                        variantId: 'gid://shopify/ProductVariant/' + item.id,
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
                var json = await res.json();
                if (json.success && json.paymentUrl) {
                    window.location.href = json.paymentUrl;
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

app.post('/api/checkout/render', (req, res) => {
    const { total, items } = req.body || {};
    const cart = {
        total: typeof total === 'number' ? total : 0,
        items: Array.isArray(items) ? items : []
    };
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
    checkoutSessions.delete(token); // one-time use so page can be refreshed without re-POST
    res.type('html').send(getCartPayloadCheckoutPageHtml(cart));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});