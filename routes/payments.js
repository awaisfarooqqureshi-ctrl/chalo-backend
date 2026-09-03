const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const admin = require('firebase-admin');
const Transaction = require('../models/Transaction');

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

/** ── Helper: Update User Balance in RTDB (Secure & Idempotent) ───── */
async function updateBalance(userId, amount, basketId) {
    if (!userId || !amount || !basketId) return;
    try {
        const db = admin.database();
        const cleanId = userId.toString().replace(/[.$#[\]]/g, '').trim();

        // 1. Check if this transaction was already processed (Prevention of double-crediting)
        const processedRef = db.ref(`processed_payments/${basketId}`);
        const alreadyProcessed = await processedRef.get();
        if (alreadyProcessed.exists()) {
            console.log(`⚠️ Payment ${basketId} already processed. Skipping.`);
            return;
        }

        const userRef = db.ref(`users/${cleanId}`);
        console.log(`🏦 Securely crediting wallet: User=${cleanId}, Amount=${amount}, ID=${basketId}`);

        // 2. Atomic Balance Update
        await userRef.child('walletBalance').transaction((current) => {
            return (parseFloat(current) || 0) + parseFloat(amount);
        });

        // 3. Mark as processed
        await processedRef.set({
            userId: cleanId,
            amount: parseFloat(amount),
            timestamp: Date.now()
        });

        // 4. Add Transaction Log (Now in MongoDB)
        try {
            await new Transaction({
                userId: cleanId,
                title: "Wallet Top-up",
                amount: parseFloat(amount),
                type: "CREDIT",
                status: "COMPLETED",
                reference: basketId,
                timestamp: Date.now()
            }).save();
            console.log(`📦 Transaction archived to MongoDB for ${cleanId}`);
        } catch (mongoErr) {
            console.error("❌ MongoDB Transaction Archive Failed:", mongoErr.message);
        }

        console.log(`✅ Success: User ${cleanId} wallet updated.`);
    } catch (e) {
        console.error("❌ Balance Update Failed:", e.message);
    }
}

/** ── STEP 1: Get Access Token (Standard OAuth2) ──────────────── */
async function getAccessToken() {
    try {
        // For Sandbox, these MUST be 'client' and 'secret' literally.
        const cid = (RAPID_ENV === 'SANDBOX' || RAPID_ENV === 'TEST') ? "client" : RAPID_CLIENT_ID;
        const sec = (RAPID_ENV === 'SANDBOX' || RAPID_ENV === 'TEST') ? "secret" : RAPID_CLIENT_SECRET;

        if (!cid || !sec) throw new Error("Missing Rapid Credentials");

        const auth = Buffer.from(`${cid}:${sec}`).toString('base64');
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
        console.error('Rapid Auth Failed:', error.response?.data || error.message);
        throw new Error("Rapid Gateway Authentication Failed");
    }
}

/** ── STEP 2: Initiate Hosted Checkout (Redirect Flow) ───────── */
router.post('/initiate', async (req, res) => {
    try {
        const data = req.body.paymentIntent || req.body;
        const { amount, userId, phone } = data;

        if (!amount || !userId || !phone) return res.status(400).json({ success: false, message: "Missing data" });

        const token = await getAccessToken();

        // Standardize Phone (03XXXXXXXXX)
        let normalizedPhone = phone.toString().trim().replace(/\D/g, '');
        if (normalizedPhone.startsWith('92')) normalizedPhone = '0' + normalizedPhone.slice(2);
        if (!normalizedPhone.startsWith('0')) normalizedPhone = '0' + normalizedPhone;

        const basketId = `CHALO-${userId}-${Date.now()}`;

        // Prepare URLSearchParams for Redirect Flow (x-www-form-urlencoded)
        const params = new URLSearchParams();
        params.append('MERCHANT_ID', RAPID_MERCHANT_ID);
        params.append('MERCHANT_NAME', process.env.APP_NAME || 'Chalo Drive');
        params.append('TXNAMT', Math.round(amount).toString());
        params.append('CURRENCY_CODE', 'PKR');
        params.append('CUSTOMER_MOBILE_NO', normalizedPhone);
        params.append('CUSTOMER_EMAIL_ADDRESS', 'customer@chalo.app');
        params.append('BASKET_ID', basketId);

        // ENVIRONMENT DETECTION: Dynamic Endpoint routing based on Server Config
        const endpoint = (RAPID_ENV === 'LIVE' || RAPID_ENV === 'PRODUCTION')
            ? '/rapid/process-transaction'
            : '/sandbox/process-transaction';

        // Set authoritative URLs from environment variables
        const successUrl = process.env.RAPID_SUCCESS_URL || `https://${req.get('host')}/payments/success?uid=${userId}&amt=${amount}&bid=${basketId}`;
        const failureUrl = process.env.RAPID_FAILURE_URL || `https://${req.get('host')}/payments/failure`;

        params.append('SUCCESS_URL', successUrl);
        params.append('FAILURE_URL', failureUrl);
        params.append('VERSION', 'MY_VER_1.0');
        params.append('PROCCODE', '0');

        console.log(`💳 Payment Trigger: ${RAPID_ENV} mode via ${BASE_URL}${endpoint}`);

        console.log(`🚀 Initiating Redirect Checkout: ${BASE_URL}${endpoint}`);

        // We use maxRedirects: 0 because Rapid returns a 302 with the checkout URL in Location header
        try {
            await axios.post(`${BASE_URL}${endpoint}`, params.toString(), {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                maxRedirects: 0
            });
        } catch (redirErr) {
            const checkoutUrl = redirErr.response?.headers?.location || redirErr.response?.headers?.Location;
            if (checkoutUrl) {
                return res.json({ success: true, checkout_url: checkoutUrl });
            }
        }

        throw new Error("Failed to capture Checkout URL");

    } catch (error) {
        console.error("❌ Initiation Error:", error.message);
        res.status(500).json({ success: false, message: error.message });
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
    // Robust extraction from multiple possible sources
    const status = req.query.status || 'success';
    const amount = req.query.amt || req.query.amount;
    const basketId = req.query.bid || req.query.basket_id;
    const userId = req.query.uid;

    console.log("🏁 Success Redirect Hit:", { status, amount, basketId, userId });

    if (status.toLowerCase() === 'success') {
        if (userId && amount) {
            await updateBalance(userId, amount, basketId);
        } else if (basketId) {
            // Fallback: try extracting from basketId if uid/amt missing
            const parts = basketId.split('-');
            const extractedId = parts.slice(1, -1).join('-');
            // Note: can't extract amount from basketId easily without extra logic
            if (extractedId && amount) await updateBalance(extractedId, amount, basketId);
        }
    }

    res.send(`
        <div style='text-align:center;font-family:sans-serif;padding:50px;background:#f9f9f9;border-radius:20px;'>
            <h1 style='color:#4CAF50;'>✅ Payment Successful!</h1>
            <p style='font-size:18px;'>Rs. ${amount || ""} has been added to your wallet.</p>
            <p style='color:gray;'>You can close this window now.</p>
            <button onclick="window.close()" style="background:#FFC107; border:none; padding:10px 20px; border-radius:5px; font-weight:bold; cursor:pointer;">Close</button>
        </div>
    `);
});

// Webhook Callback (The true Source of Truth)
router.post('/callback', async (req, res) => {
    try {
        console.log("📡 Webhook Received:", JSON.stringify(req.body));

        const { status, amount, merchantTransactionId, basketId } = req.body;
        const bid = merchantTransactionId || basketId;

        if (status === 'SUCCESS' || status === 'completed') {
            const parts = bid?.split('-') || [];
            const userId = parts.slice(1, -1).join('-');

            if (userId && amount) {
                await updateBalance(userId, amount, bid);
            } else {
                console.error("❌ Webhook missing data:", { userId, amount, bid });
            }
        }
        res.status(200).send("OK");
    } catch (e) {
        console.error("❌ Webhook Error:", e.message);
        res.status(500).send("Internal Error");
    }
});

router.get('/failure', (req, res) => res.send("<h1>❌ Payment Failed</h1>"));
router.get('/complete', (req, res) => res.send("<h1>Processing...</h1>"));

module.exports = router;
