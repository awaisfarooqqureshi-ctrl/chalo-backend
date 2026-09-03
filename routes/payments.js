const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');

// Detect Environment and Base URL
const RAPID_ENV = (process.env.RAPID_ENVIRONMENT || 'SANDBOX').toUpperCase();
const BASE_URL = (process.env.RAPID_API_BASE_URL || "https://secure.rapid-gateway.com").replace(/\/$/, "");

// Credentials Mapping Logic
let RAPID_CLIENT_ID, RAPID_CLIENT_SECRET, RAPID_MERCHANT_ID;

if (RAPID_ENV === 'SANDBOX' || RAPID_ENV === 'TEST') {
    // Standard Rapid Sandbox Credentials
    RAPID_CLIENT_ID = "client";
    RAPID_CLIENT_SECRET = "secret";
    RAPID_MERCHANT_ID = process.env.RAPID_MERCHANT_ID || "920";
} else {
    // Production Credentials from Railway
    RAPID_CLIENT_ID = process.env.RAPID_CLIENT_ID || process.env.RAPID_MERCHANT_ID;
    RAPID_CLIENT_SECRET = process.env.RAPID_CLIENT_SECRET;
    RAPID_MERCHANT_ID = process.env.RAPID_MERCHANT_ID;
}

console.log(`💳 Payment System Initialized:`);
console.log(`   Mode: ${RAPID_ENV}`);
console.log(`   Base: ${BASE_URL}`);
console.log(`   MID:  ${RAPID_MERCHANT_ID}`);
console.log(`   🔑 OAuth Attempt: ID=${RAPID_CLIENT_ID?.substring(0,2)}***, Secret=${RAPID_CLIENT_SECRET?.substring(0,2)}***`);

/** ── Helper: Update User Balance in RTDB ─────────────────── */
async function updateBalance(userId, amount, basketId) {
    if (!userId || !amount) return;
    try {
        const db = admin.database();
        // Clean user ID: Keep only digits/letters
        const cleanId = userId.toString().replace(/[.$#[\]]/g, '').trim();
        const userRef = db.ref(`users/${cleanId}`);

        console.log(`🏦 Crediting Wallet: User=${cleanId}, Amount=${amount}`);

        // 1. Atomic Balance Update
        await userRef.child('walletBalance').transaction((current) => {
            return (parseFloat(current) || 0) + parseFloat(amount);
        });

        // 2. Add Transaction Log
        const transId = userRef.child('transactions').push().key;
        await userRef.child(`transactions/${transId}`).set({
            id: transId,
            title: "Wallet Recharge",
            amount: parseFloat(amount),
            type: "CREDIT",
            timestamp: Date.now(),
            status: "COMPLETED",
            reference: basketId
        });

        console.log(`✅ Success: User ${cleanId} balance updated.`);
    } catch (e) {
        console.error("❌ Balance Update Failed:", e.message);
    }
}

/** ── Step 1: Get Access Token ────────────────────────────── */
async function getAccessToken() {
    try {
        if (!RAPID_CLIENT_ID || !RAPID_CLIENT_SECRET) {
            throw new Error("Missing Rapid Credentials (CLIENT_ID or SECRET)");
        }
        const auth = Buffer.from(`${RAPID_CLIENT_ID}:${RAPID_CLIENT_SECRET}`).toString('base64');
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
        throw new Error(`Auth Failed: ${JSON.stringify(error.response?.data || error.message)}`);
    }
}

/** ── NEW: Embedded Checkout Flow (Step 2: Create Session) ─── */
router.post('/initiate', async (req, res) => {
    try {
        console.log("💰 Payment Request Received:", JSON.stringify(req.body));

        // Supporting various body formats (Direct or nested)
        const data = req.body.paymentIntent || req.body;
        const amount = data.amount;
        const userId = data.userId || data.customer?.userId;
        const phone = data.phone || data.customer?.phone;

        if (!amount || !userId || !phone) {
            return res.status(400).json({
                success: false,
                message: "Invalid Request: amount, userId, and phone are required",
                received: { amount, userId, phone }
            });
        }

        const token = await getAccessToken();

        // 1. Prepare Customer Info
        let normalizedPhone = phone.toString().trim().replace(/\D/g, '');
        if (normalizedPhone.startsWith('92')) normalizedPhone = '0' + normalizedPhone.slice(2);
        if (!normalizedPhone.startsWith('0')) normalizedPhone = '0' + normalizedPhone;

        const basketId = `CHALO-${userId}-${Date.now()}`;

        // 2. Request Checkout Session from Rapid
        const sessionPayload = {
            merchantId: parseInt(RAPID_MERCHANT_ID),
            amount: parseFloat(amount),
            currency: 'PKR',
            basketId: basketId,
            customerEmail: 'customer@chalo.app',
            customerMobile: normalizedPhone
        };

        console.log("🚀 Creating Rapid Session with Payload:", JSON.stringify(sessionPayload));

        try {
            const response = await axios.post(`${BASE_URL}/v1/checkout-sessions`, sessionPayload, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'X-Environment': (RAPID_ENV === 'LIVE') ? 'LIVE' : 'TEST'
                }
            });

            const { sessionId, clientSecret, publishableKey } = response.data;
            console.log("✅ Rapid Session Created:", sessionId);

            // Construct absolute URL for the checkout page
            const protocol = req.headers['x-forwarded-proto'] || 'https';
            const host = req.get('host');
            const checkoutUrl = `${protocol}://${host}/payments/checkout?sid=${sessionId}&secret=${clientSecret}&pk=${publishableKey}&amt=${amount}&bid=${basketId}`;

            res.json({
                success: true,
                checkout_url: checkoutUrl
            });
        } catch (axiosError) {
            console.error("❌ Rapid API Post Failed:", axiosError.response?.data || axiosError.message);
            return res.status(axiosError.response?.status || 500).json({
                success: false,
                message: "Rapid API call failed",
                error: axiosError.response?.data || axiosError.message
            });
        }

    } catch (error) {
        console.error("❌ Rapid Session Error Details:", error.response?.data || error.message);
        res.status(500).json({
            success: false,
            message: "Internal Server Error during payment initiation",
            error: error.response?.data || error.message
        });
    }
});

/** ── NEW: Simple Hosted Checkout Page (Step 3: Mount SDK) ─── */
router.get('/checkout', (req, res) => {
    const { sid, secret, pk, amt, bid } = req.query;

    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <title>Chalo Payment</title>
            <script src="https://secure.rapid-gateway.com/sdk/v1/rapidpay.js"></script>
            <style>
                body { margin: 0; padding: 20px; font-family: sans-serif; background: #fff; }
                #rp-checkout { width: 100%; min-height: 450px; }
                .loader { text-align: center; padding: 50px; }
            </style>
        </head>
        <body>
            <div id="rp-checkout">
                <div class="loader">Loading secure payment...</div>
            </div>
            <script>
                try {
                    const rp = RapidPay("${pk}");
                    const checkout = rp.mountCheckout('#rp-checkout', {
                        clientSecret: "${secret}",
                        amount: ${amt},
                        currency: 'PKR',
                        merchantName: 'Chalo Drive',
                        onSuccess: ({ sessionId }) => {
                            window.location.href = "/payments/success?status=success&basket_id=${bid}&amount=${amt}";
                        },
                        onPending: ({ sessionId }) => {
                            alert("Payment is pending. Please wait.");
                        },
                        onError: (e) => {
                            console.error(e);
                            alert("Payment Error: " + (e.message || "Unknown error"));
                        },
                    });
                } catch (err) {
                    document.getElementById('rp-checkout').innerHTML = "<h1>Error initializing gateway</h1>";
                }
            </script>
        </body>
        </html>
    `);
});

// Authoritative Redirect Success Page
router.get('/success', async (req, res) => {
    const { status, amount, basket_id } = req.query;

    if (status === 'success' || status === 'SUCCESS') {
        // Extract UserID robustly from SBX-UserID-Timestamp
        // UID could contain hyphens, so we join everything between first and last dash
        const parts = basket_id?.split('-') || [];
        const userId = parts.slice(1, -1).join('-');

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
        const userId = parts.slice(1, -1).join('-');
        if (userId) await updateBalance(userId, amount, merchantTransactionId);
    }
    res.status(200).send("OK");
});

router.get('/failure', (req, res) => res.send("<h1>❌ Payment Failed</h1>"));
router.get('/complete', (req, res) => res.send("<h1>Processing...</h1>"));

module.exports = router;
