const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const User = require('../models/User');
const admin = require('firebase-admin');

// Detect Environment (SANDBOX or LIVE)
const RAPID_ENV = (process.env.RAPID_ENVIRONMENT || 'SANDBOX').toUpperCase();

// Credentials logic: Use provided env vars, or fallback to Rapid Sandbox defaults
const MERCHANT_ID = process.env.RAPID_MERCHANT_ID || process.env.MERCHANT_ID || (RAPID_ENV === 'SANDBOX' ? 'client' : null);
const CLIENT_SECRET = process.env.RAPID_CLIENT_SECRET || process.env.CLIENT_SECRET || (RAPID_ENV === 'SANDBOX' ? 'secret' : null);
const WEBHOOK_SALT = process.env.RAPID_WEBHOOK_SALT || process.env.WEBHOOK_SALT;

const BASE_URL = "https://secure.rapid-gateway.com";
const SUCCESS_URL = process.env.RAPID_SUCCESS_URL;
const FAILURE_URL = process.env.RAPID_FAILURE_URL;
const CHECKOUT_URL = process.env.RAPID_CHECKOUT_URL;

/** ── Step 1: Get Access Token (OAuth2) ───────────────────────── */
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
        throw new Error('Failed to authenticate with Payment Gateway');
    }
}

/** ── Webhook Signature Verification ──────────────────────── */
function isValidWebhookSignature(req) {
    const timestamp = req.get('X-RapidGateway-Timestamp');
    const signature = req.get('X-RapidGateway-Signature');
    const rawBody = req.rawBody;

    if (!timestamp || !signature || !rawBody || !WEBHOOK_SALT) return false;

    const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
    const expectedSignature = crypto
        .createHmac('sha256', WEBHOOK_SALT)
        .update(signedPayload, 'utf8')
        .digest('hex')
        .toUpperCase();

    return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(signature.toUpperCase())
    );
}

router.post('/initiate', async (req, res) => {
    try {
        const paymentData = req.body.paymentIntent || req.body;
        const { amount, customer } = paymentData;

        if (!MERCHANT_ID || !CLIENT_SECRET) {
            console.error("Missing RapidGateway Credentials. Current Env:", RAPID_ENV);
            return res.status(503).json({ success: false, message: 'Payment credentials not configured.' });
        }

        // 1. Get Token
        const token = await getAccessToken();

        // 2. Prepare Transaction Data
        const basketId = `${customer.userId}-${Date.now()}`;
        const params = new URLSearchParams();
        params.append('MERCHANT_ID', MERCHANT_ID);
        params.append('MERCHANT_NAME', 'Chalo Drive');
        params.append('TXNAMT', amount.toString());
        params.append('CURRENCY_CODE', 'PKR');
        params.append('CUSTOMER_MOBILE_NO', customer.phone);
        params.append('CUSTOMER_EMAIL_ADDRESS', 'customer@chalo.app');
        params.append('BASKET_ID', basketId);
        params.append('SUCCESS_URL', SUCCESS_URL || `https://${req.get('host')}/payments/success`);
        params.append('FAILURE_URL', FAILURE_URL || `https://${req.get('host')}/payments/failure`);
        params.append('CHECKOUT_URL', CHECKOUT_URL || `https://${req.get('host')}/payments/complete`);
        params.append('VERSION', 'MY_VER_1.0');
        params.append('PROCCODE', '0');
        params.append('ORDER_DATE', new Date().toISOString().split('T')[0]);

        // Sandbox check: Use /sandbox endpoint if in sandbox mode
        const endpoint = (RAPID_ENV === 'SANDBOX') ? '/sandbox/process-transaction' : '/rapid/process-transaction';

        console.log(`Initiating ${RAPID_ENV} payment for User: ${customer.userId}, Amount: ${amount}`);

        const response = await axios.post(`${BASE_URL}${endpoint}`,
            params.toString(),
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                maxRedirects: 0,
                validateStatus: (status) => status === 302 || (status >= 200 && status < 300)
            }
        );

        const checkoutUrl = response.headers.location;
        if (!checkoutUrl) throw new Error("No redirect URL received from Gateway");

        res.json({ success: true, checkout_url: checkoutUrl });

    } catch (error) {
        console.error('Initiation Failed:', error.message);
        res.status(500).json({
            success: false,
            message: error.message || 'Payment initialization failed'
        });
    }
});

router.post('/callback', async (req, res) => {
    // Note: Sandbox testing sometimes doesn't send signed webhooks if manually triggered
    if (RAPID_ENV !== 'SANDBOX' && !isValidWebhookSignature(req)) {
        return res.status(401).send('Invalid signature');
    }

    const { status, amount, merchantTransactionId } = req.body;

    if (status === 'SUCCESS' || status === 'completed') {
        const userId = merchantTransactionId.split('-')[0];
        const amountNum = Number(amount);

        try {
            const db = admin.database();
            const userRef = db.ref(`users/${userId}`);

            // Update RTDB Balance
            await userRef.child('walletBalance').transaction((current) => (current || 0) + amountNum);

            // Log Transaction
            const transId = userRef.child('transactions').push().key;
            await userRef.child(`transactions/${transId}`).set({
                id: transId,
                title: "Wallet Top-up",
                amount: amountNum,
                type: "CREDIT",
                timestamp: Date.now(),
                status: "COMPLETED"
            });

            console.log(`✅ Wallet updated for user ${userId}: +${amountNum}`);
        } catch (e) {
            console.error("Database Update Failed:", e.message);
        }
    }

    res.status(200).send("OK");
});

// Helper pages for WebView redirects
router.get('/success', (req, res) => {
    res.send("<html><body style='text-align:center;padding-top:50px;'><h1>✅ Payment Successful!</h1><p>You can now close this window.</p></body></html>");
});

router.get('/failure', (req, res) => {
    res.send("<html><body style='text-align:center;padding-top:50px;'><h1>❌ Payment Failed</h1><p>Please try again from the app.</p></body></html>");
});

router.get('/complete', (req, res) => {
    res.send("<html><body style='text-align:center;padding-top:50px;'><h1>Processing...</h1><p>Returning you to the app.</p></body></html>");
});

module.exports = router;
