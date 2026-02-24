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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});