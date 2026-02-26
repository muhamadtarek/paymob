/**
 * Egypt checkout flow:
 * 1. POST cart to /api/checkout/render
 * 2. Backend returns { success, redirectUrl }
 * 3. User is sent to redirectUrl to see the checkout page (order details + shipping + Paymob)
 */

const CHECKOUT_API_BASE = 'https://paymob-eight.vercel.app';

async function getCartData() {
    try {
        const response = await fetch('/cart.js');
        const cart = await response.json();
        return {
            total: cart.total_price / 100,
            items: cart.items.map((item) => ({
                // IMPORTANT: Paymob flow uses Shopify Draft Orders which require variant_id
                id: item.variant_id?.toString(),
                variantId: item.variant_id?.toString(),
                name: item.product_title,
                category: item.product_type,
                price: item.price / 100,
                quantity: item.quantity
            }))
        };
    } catch (error) {
        return null;
    }
}

async function handleEgyptCheckout() {
    try {
        const countryRes = await fetch('https://ipapi.co/country/');
        const country = (await countryRes.text()).trim();
        if (country !== 'EG') return false;

        const cartData = await getCartData();
        if (!cartData || !cartData.items?.length) {
            console.warn('No cart data or empty cart');
            return false;
        }

        const response = await fetch(`${CHECKOUT_API_BASE}/api/checkout/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cartData)
        });

        const data = await response.json();

        if (data.success && data.redirectUrl) {
            window.location.href = data.redirectUrl;
            return true;
        }

        console.warn('Backend did not return redirectUrl:', data);
        return false;
    } catch (error) {
        console.error('Egypt checkout error:', error);
        return false;
    }
}

document.addEventListener(
    'click',
    function (e) {
        if (!e.target || typeof e.target.closest !== 'function') return;

        const checkoutElement = e.target.closest(
            '.checkout__button, [name="checkout"], .shopify-payment-button, shop-pay-wallet-button, .checkout-button, [href*="checkout"], .cart__checkout, .btn--checkout'
        );

        if (checkoutElement) {
            e.preventDefault();
            e.stopPropagation();

            (async () => {
                const wasRedirected = await handleEgyptCheckout();
                if (!wasRedirected) {
                    window.location.href = '/checkout';
                }
            })();
        }
    },
    true
);
