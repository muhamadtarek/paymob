// CheckoutButton.jsx
import React, { useState } from 'react';
import axios from 'axios';

const CheckoutButton = ({ cartItems, customer }) => {
    const [loading, setLoading] = useState(false);

    const handleCheckout = async () => {
        setLoading(true);

        try {
            // Check if customer is from Egypt
            const isEgyptian = customer?.country === 'EG' ||
                customer?.country_code === 'EG';

            if (!isEgyptian) {
                // Redirect to normal Shopify checkout
                window.location.href = '/checkout';
                return;
            }

            // Prepare cart data
            const checkoutData = {
                cartItems: cartItems.map(item => ({
                    variantId: item.variant.id,
                    quantity: item.quantity,
                    name: item.product.title,
                    price: parseFloat(item.variant.price),
                    description: item.product.description
                })),
                customer: {
                    email: customer.email,
                    first_name: customer.firstName,
                    last_name: customer.lastName,
                    phone: customer.phone
                },
                billingData: {
                    email: customer.email,
                    first_name: customer.firstName,
                    last_name: customer.lastName,
                    phone_number: customer.phone,
                    city: customer.city || 'Cairo',
                    street: customer.address1,
                    building: customer.address2 || 'NA',
                    apartment: 'NA',
                    floor: 'NA',
                    postal_code: customer.zip || '00000',
                    state: customer.province || 'Cairo'
                }
            };

            // Call your backend
            const response = await axios.post(
                'https://your-backend.com/api/checkout/egypt',
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