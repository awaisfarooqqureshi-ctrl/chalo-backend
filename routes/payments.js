const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const User = require('../models/User');
const admin = require('firebase-admin');

// Detect Environment (SANDBOX or LIVE)
const RAPID_ENV = (process.env.RAPID_ENVIRONMENT || 'SANDBOX').toUpperCase();

// Credentials
const MERCHANT_ID = process.env.RAPID_MERCHANT_ID || process.env.MERCHANT_ID || (RAPID_ENV === 'SANDBOX' ? 'client' : null);
const CLIENT_SECRET = process.env.RAPID_CLIENT_SECRET || process.env.CLIENT_SECRET || (RAPID_ENV === 'SANDBOX' ? 'secret' : null);
const WEBHOOK_SALT = process.env.RAPID_WEBHOOK_SALT || process.env.WEBHOOK_SALT;

const BASE_URL = "https://secure.rapid-gateway.com";

/** ── Step 1: Get Access Token ────────────────────────────── */
async function getAccessToken() {
    try {
        const auth = Buffer.from(`${MERCHANT_ID}:${CLIENT_SECRET}`).toString('base64');
        const response = await axios.post(`${BASE_URL}/oauth2/token`,
            'grant_type=client_credentials',
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );
        return response.data.access_token;
    } catch (error) {
        console.error('RapidGateway Token Error:', error.response?.data || error.message);
        throw new Error('Failed to get Access Token');
    }
}

router.post('/initiate', async (req, res) => {
    try {
        const paymentData = req.body.paymentIntent || req.body;
        const { amount, customer } = paymentData;

        // 1. Get Token
        const token = await getAccessToken();

        // 2. Prepare Data (Strictly matching successful test)
        let normalizedPhone = customer.phone.trim().replace(/\s+/g, '');
        if (normalizedPhone.startsWith('+92')) normalizedPhone = '0' + normalizedPhone.slice(3);
        else if (normalizedPhone.startsWith('92')) normalizedPhone = '0' + normalizedPhone.slice(2);

        // Standardize Basket ID with SBX- prefix for Sandbox success
        const basketId = `SBX-${customer.userId}-${Date.now()}`;

        const params = new URLSearchParams();
        params.append('MERCHANT_ID', (MERCHANT_ID === 'client' || !MERCHANT_ID) ? '920' : MERCHANT_ID);
        params.append('MERCHANT_NAME', 'Chalo Test');
        params.append('TXNAMT', Math.round(amount).toString());
        params.append('CURRENCY_CODE', 'PKR');
        params.append('CUSTOMER_MOBILE_NO', normalizedPhone);
        params.append('CUSTOMER_EMAIL_ADDRESS', 'customer@chalo.app');
        params.append('BASKET_ID', basketId);
        params.append('SUCCESS_URL', `https://chalo-backend-production-0bd5.up.railway.app/payments/success`);
        params.append('FAILURE_URL', `https://chalo-backend-production-0bd5.up.railway.app/payments/failure`);
        params.append('CHECKOUT_URL', `https://chalo-backend-production-0bd5.up.railway.app/payments/complete`);
        params.append('VERSION', 'MY_VER_1.0');
        params.append('PROCCODE', '0');

        // CHOOSE ENDPOINT BASED ON ENVIRONMENT
        const endpoint = (RAPID_ENV === 'LIVE') ? '/rapid/process-transaction' : '/sandbox/process-transaction';

        console.log(`🚀 Initiating ${RAPID_ENV} payment: Sending to ${endpoint}`);

        let checkoutUrl = null;
        try {
            const response = await axios.post(`${BASE_URL}${endpoint}`,
                params.toString(),
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    maxRedirects: 0,
                    validateStatus: (status) => status >= 200 && status < 400
                }
            );
            checkoutUrl = response.headers.location || response.headers['Location'];
        } catch (axiosError) {
            // Capture redirect from error response if axios throws
            checkoutUrl = axiosError.response?.headers?.location || axiosError.response?.headers?.['Location'];
            if (!checkoutUrl) throw axiosError;
        }

        if (!checkoutUrl) throw new Error("No Redirect URL found in response");

        console.log(`✅ Success! Redirect Captured: ${checkoutUrl}`);

        // Ensure app gets this URL in the JSON body
        return res.status(200).json({
            success: true,
            checkout_url: checkoutUrl,
            message: "Redirect captured successfully"
        });

    } catch (error) {
        console.error('Initiation Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Authoritative outcome from Webhook or Success Redirect
router.get('/success', async (req, res) => {
    const { status, amount, basket_id } = req.query;

    // In Sandbox, we can trust the redirect for testing, but in Live we wait for Webhook
    if (status === 'success' || status === 'SUCCESS') {
        const userId = basket_id?.split('-')[0]; // If we passed userId in basket_id
        console.log(`💰 Success Redirect: Amount=${amount}, User=${userId}`);
    }

    res.send("<div style='text-align:center;'><h1>✅ Payment Successful!</h1><p>Returning to app...</p></div>");
});

router.get('/failure', (req, res) => res.send("<h1>❌ Payment Failed</h1>"));
router.get('/complete', (req, res) => res.send("<h1>Processing...</h1>"));

module.exports = router;
