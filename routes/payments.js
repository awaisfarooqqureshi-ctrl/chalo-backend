const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const User = require('../models/User');
const admin = require('firebase-admin');

// Detect Environment
const RAPID_ENV = (process.env.RAPID_ENVIRONMENT || 'SANDBOX').toUpperCase();

// Credentials
const MERCHANT_ID = process.env.RAPID_MERCHANT_ID || process.env.MERCHANT_ID || (RAPID_ENV === 'SANDBOX' ? 'client' : null);
const CLIENT_SECRET = process.env.RAPID_CLIENT_SECRET || process.env.CLIENT_SECRET || (RAPID_ENV === 'SANDBOX' ? 'secret' : null);
const WEBHOOK_SALT = process.env.RAPID_WEBHOOK_SALT || process.env.WEBHOOK_SALT;

const BASE_URL = "https://secure.rapid-gateway.com";

/** ── Helper: Update User Balance in RTDB ─────────────────── */
async function updateBalance(userId, amount, basketId) {
    if (!userId || !amount) return;
    try {
        const db = admin.database();
        const userRef = db.ref(`users/${userId}`);

        // 1. Atomic Balance Update
        await userRef.child('walletBalance').transaction((current) => (current || 0) + Number(amount));

        // 2. Add Transaction Log
        const transId = userRef.child('transactions').push().key;
        await userRef.child(`transactions/${transId}`).set({
            id: transId,
            title: "Wallet Top-up",
            amount: Number(amount),
            type: "CREDIT",
            timestamp: Date.now(),
            status: "COMPLETED",
            reference: basketId
        });

        console.log(`✅ Wallet Updated for ${userId}: +${amount}`);
    } catch (e) {
        console.error("❌ Balance Update Failed:", e.message);
    }
}

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

        const token = await getAccessToken();

        let normalizedPhone = customer.phone.trim().replace(/\s+/g, '');
        if (normalizedPhone.startsWith('+92')) normalizedPhone = '0' + normalizedPhone.slice(3);
        else if (normalizedPhone.startsWith('92')) normalizedPhone = '0' + normalizedPhone.slice(2);

        // Format: SBX-UserID-Timestamp
        const basketId = `SBX-${customer.userId}-${Date.now()}`;

        const params = new URLSearchParams();
        params.append('MERCHANT_ID', (MERCHANT_ID === 'client') ? '920' : MERCHANT_ID);
        params.append('MERCHANT_NAME', 'Chalo Drive');
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

        const endpoint = (RAPID_ENV === 'LIVE') ? '/rapid/process-transaction' : '/sandbox/process-transaction';

        let checkoutUrl = null;
        try {
            const response = await axios.post(`${BASE_URL}${endpoint}`, params.toString(), {
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                maxRedirects: 0,
                validateStatus: (status) => status >= 200 && status < 400
            });
            checkoutUrl = response.headers.location || response.headers['Location'];
        } catch (err) {
            checkoutUrl = err.response?.headers?.location || err.response?.headers?.['Location'];
        }

        if (!checkoutUrl) throw new Error("No Redirect URL captured");
        res.json({ success: true, checkout_url: checkoutUrl });

    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Authoritative Redirect Success Page
router.get('/success', async (req, res) => {
    const { status, amount, basket_id } = req.query;

    if (status === 'success' || status === 'SUCCESS') {
        // Extract UserID from SBX-UserID-Timestamp
        const parts = basket_id?.split('-') || [];
        const userId = parts[1]; // Get the middle part

        if (userId) {
            await updateBalance(userId, amount, basket_id);
        }
    }

    res.send("<div style='text-align:center;font-family:sans-serif;padding-top:50px;'><h1>✅ Payment Successful!</h1><p>Your wallet has been updated. You can close this window.</p></div>");
});

// Webhook Callback
router.post('/callback', async (req, res) => {
    const { status, amount, merchantTransactionId } = req.body;

    if (status === 'SUCCESS' || status === 'completed') {
        const parts = merchantTransactionId?.split('-') || [];
        const userId = parts[1];
        if (userId) await updateBalance(userId, amount, merchantTransactionId);
    }
    res.status(200).send("OK");
});

router.get('/failure', (req, res) => res.send("<h1>❌ Payment Failed</h1>"));
router.get('/complete', (req, res) => res.send("<h1>Processing...</h1>"));

module.exports = router;
