const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const User = require('../models/User');

const MERCHANT_ID = process.env.RAPID_MERCHANT_ID;
const CLIENT_SECRET = process.env.RAPID_CLIENT_SECRET;
const WEBHOOK_SALT = process.env.RAPID_WEBHOOK_SALT;
const BASE_URL = process.env.RAPID_API_BASE_URL || "https://secure.rapid-gateway.com";

const SUCCESS_URL = process.env.RAPID_SUCCESS_URL;
const FAILURE_URL = process.env.RAPID_FAILURE_URL;
const CHECKOUT_URL = process.env.RAPID_CHECKOUT_URL;

/** ── Step 1: Get Bearer Token ────────────────────────────── */
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
        console.error('Failed to get RapidGateway token:', error.response?.data || error.message);
        throw error;
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
        const { amount, customer, basketId } = req.body.paymentIntent || req.body;

        // 1. Get Token
        const token = await getAccessToken();

        // 2. Submit Transaction (application/x-www-form-urlencoded)
        const params = new URLSearchParams();
        params.append('MERCHANT_ID', MERCHANT_ID);
        params.append('MERCHANT_NAME', 'Chalo Drive');
        params.append('TXNAMT', amount.toString());
        params.append('CURRENCY_CODE', 'PKR');
        params.append('CUSTOMER_MOBILE_NO', customer.phone);
        params.append('CUSTOMER_EMAIL_ADDRESS', 'customer@chalo.app'); // Default if not provided
        params.append('BASKET_ID', basketId || `CHALO-${Date.now()}`);
        params.append('SUCCESS_URL', SUCCESS_URL || `https://${req.get('host')}/payments/success`);
        params.append('FAILURE_URL', FAILURE_URL || `https://${req.get('host')}/payments/failure`);
        params.append('CHECKOUT_URL', CHECKOUT_URL || `https://${req.get('host')}/payments/complete`);
        params.append('VERSION', 'MY_VER_1.0');
        params.append('PROCCODE', '0');
        params.append('ORDER_DATE', new Date().toISOString().split('T')[0]);

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
        console.error('RapidGateway Initiation Error:', error.message);
        res.status(500).json({ success: false, message: 'Payment initialization failed' });
    }
});

// Authoritative Webhook outcome
router.post('/callback', async (req, res) => {
    if (!isValidWebhookSignature(req)) {
        return res.status(401).send('Invalid signature');
    }

    const { status, amount, merchantTransactionId } = req.body;

    if (status === 'SUCCESS') {
        // Find user by basket ID (stored in MongoDB transactions or extract from ID)
        // For simplicity, we can also pass userId in BASKET_ID like "USERID-TIMESTAMP"
        const userId = merchantTransactionId.split('-')[0];

        await User.findByIdAndUpdate(userId, {
            $inc: { walletBalance: Number(amount) },
            $push: { transactions: {
                title: "Wallet Top-up",
                amount: Number(amount),
                type: "CREDIT",
                timestamp: Date.now(),
                status: "COMPLETED"
            }}
        });
        console.log(`Wallet updated for user ${userId}: +${amount}`);
    }

    res.status(200).send("OK");
});

module.exports = router;
