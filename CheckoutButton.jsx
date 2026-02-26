// CheckoutButton.jsx
import React, { useState } from 'react';
import axios from 'axios';

const CheckoutButton = ({ cartItems, customer, cartEndpoint }) => {
    const [loading, setLoading] = useState(false);

    const handleCheckout = async () => {
        setLoading(true);

        try {
            let effectiveCartItems = cartItems;
            let effectiveCustomer = customer;

            // Optionally fetch cart & customer data from a different endpoint
            if (cartEndpoint && (!effectiveCartItems || !effectiveCustomer)) {
                const cartResponse = await axios.get(cartEndpoint);
                effectiveCartItems = cartResponse.data.cartItems;
                effectiveCustomer = cartResponse.data.customer;
            }

            // Check if customer is from Egypt
            const isEgyptian = effectiveCustomer?.country === 'EG' ||
                effectiveCustomer?.country_code === 'EG';

            if (!isEgyptian) {
                // Redirect to normal Shopify checkout
                window.location.href = '/checkout';
                return;
            }

            // Prepare cart data
            const checkoutData = {
                cartItems: effectiveCartItems.map(item => ({
                    variantId: item.variant.id,
                    quantity: item.quantity,
                    name: item.product.title,
                    price: parseFloat(item.variant.price),
                    description: item.product.description
                })),
                customer: {
                    email: effectiveCustomer.email,
                    first_name: effectiveCustomer.firstName,
                    last_name: effectiveCustomer.lastName,
                    phone: effectiveCustomer.phone
                },
                billingData: {
                    email: effectiveCustomer.email,
                    first_name: effectiveCustomer.firstName,
                    last_name: effectiveCustomer.lastName,
                    phone_number: effectiveCustomer.phone,
                    city: effectiveCustomer.city || 'Cairo',
                    street: effectiveCustomer.address1,
                    building: effectiveCustomer.address2 || 'NA',
                    apartment: 'NA',
                    floor: 'NA',
                    postal_code: effectiveCustomer.zip || '00000',
                    state: effectiveCustomer.province || 'Cairo'
                }
            };

            // Call backend using POST request to the current server
            const response = await axios.post(
                '/api/checkout/egypt',
                checkoutData
            );

            if (response.data.success) {
                // Redirect to Paymob iframe
                window.location.href = response.data.paymentUrl;
            }
        } catch (error) {
            console.error('Checkout error:', error);
            alert('Checkout failed. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <button
            onClick={handleCheckout}
            disabled={loading}
            className="checkout-button"
        >
            {loading ? 'Processing...' : 'Proceed to Checkout'}
        </button>
    );
};

export default CheckoutButton;
