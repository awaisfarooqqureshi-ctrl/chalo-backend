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
        throw new Error('Payment Gateway Authentication Failed');
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
            return res.status(503).json({ success: false, message: 'Payment credentials not configured.' });
        }

        // 1. Get Token
        const token = await getAccessToken();

        // 2. Prepare Transaction Data (Normalize phone for RapidGateway)
        let normalizedPhone = customer.phone.trim().replace(/\s+/g, '');
        if (normalizedPhone.startsWith('+92')) normalizedPhone = '0' + normalizedPhone.slice(3);
        else if (normalizedPhone.startsWith('92')) normalizedPhone = '0' + normalizedPhone.slice(2);
        else if (!normalizedPhone.startsWith('0') && normalizedPhone.length === 10) normalizedPhone = '0' + normalizedPhone;

        // RapidGateway Sandbox requires BASKET_ID to be unique and order-like
        const basketId = `ORDER-${Date.now()}`;

        const params = new URLSearchParams();
        params.append('MERCHANT_ID', (MERCHANT_ID === 'client') ? '920' : MERCHANT_ID);
        params.append('MERCHANT_NAME', 'Chalo Drive');
        params.append('TXNAMT', amount.toString());
        params.append('CURRENCY_CODE', 'PKR');
        params.append('CUSTOMER_MOBILE_NO', normalizedPhone);
        params.append('CUSTOMER_EMAIL_ADDRESS', 'customer@chalo.app');
        params.append('BASKET_ID', basketId);
        params.append('SUCCESS_URL', `https://chalo-backend-production-0bd5.up.railway.app/payments/success`);
        params.append('FAILURE_URL', `https://chalo-backend-production-0bd5.up.railway.app/payments/failure`);
        params.append('CHECKOUT_URL', `https://chalo-backend-production-0bd5.up.railway.app/payments/complete`);
        params.append('VERSION', 'MY_VER_1.0');
        params.append('PROCCODE', '0');

        console.log(`🚀 Initiating RapidGateway (${RAPID_ENV}):`, params.toString());

        const response = await axios.post(`${BASE_URL}/rapid/process-transaction`,
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
        const errorData = error.response?.data;
        console.error('RapidGateway Initiation Error:', {
            message: error.message,
            gatewayResponse: errorData,
            status: error.response?.status
        });
        res.status(500).json({
            success: false,
            message: errorData?.message || error.message || 'Payment initialization failed'
        });
    }
});

router.post('/callback', async (req, res) => {
    if (RAPID_ENV !== 'SANDBOX' && !isValidWebhookSignature(req)) {
        return res.status(401).send('Invalid signature');
    }

    const { status, amount, merchantTransactionId } = req.body;

    if (status === 'SUCCESS' || status === 'completed') {
        const userId = req.body.metadata?.userId || merchantTransactionId?.split('-')[0];
        if (userId) {
            try {
                const db = admin.database();
                const userRef = db.ref(`users/${userId}`);
                await userRef.child('walletBalance').transaction((current) => (current || 0) + Number(amount));
            } catch (e) { console.error("Balance Update Failed:", e.message); }
        }
    }
    res.status(200).send("OK");
});

router.get('/success', (req, res) => res.send("<h1>✅ Payment Successful!</h1>"));
router.get('/failure', (req, res) => res.send("<h1>❌ Payment Failed</h1>"));
router.get('/complete', (req, res) => res.send("<h1>Processing...</h1>"));

module.exports = router;
