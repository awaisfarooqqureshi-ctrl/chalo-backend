const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const User = require('../models/User');

const RAPID_GATEWAY_API_KEY = process.env.RAPID_API_KEY;
const RAPID_WEBHOOK_SALT = process.env.RAPID_WEBHOOK_SALT;
const RAPID_WEBHOOK_SALT_PREVIOUS = process.env.RAPID_WEBHOOK_SALT_PREVIOUS;
const RAPID_API_URL = "https://api.rapidgateway.pk/v1/payments";
const RAPID_WEBHOOK_URL = process.env.RAPID_WEBHOOK_URL;

function isValidWebhookSignature(req) {
    const timestamp = String(req.get('X-RapidGateway-Timestamp') || '').trim();
    const receivedSignature = String(req.get('X-RapidGateway-Signature') || '').trim().toUpperCase();
    const rawBody = req.rawBody;

    if (!timestamp || !receivedSignature || !rawBody || !/^\d+$/.test(timestamp)) return false;

    const timestampSeconds = Number(timestamp);
    if (!Number.isSafeInteger(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) return false;

    const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
    return [RAPID_WEBHOOK_SALT, RAPID_WEBHOOK_SALT_PREVIOUS]
        .filter(Boolean)
        .some((salt) => {
            const expectedSignature = crypto
                .createHmac('sha256', salt)
                .update(signedPayload, 'utf8')
                .digest('hex')
                .toUpperCase();
            const expected = Buffer.from(expectedSignature, 'utf8');
            const received = Buffer.from(receivedSignature, 'utf8');
            return expected.length === received.length && crypto.timingSafeEqual(expected, received);
        });
}

router.post('/initiate', async (req, res) => {
    const paymentIntent = req.body?.paymentIntent || req.body;
    const amount = Number(paymentIntent?.amount);
    const currency = String(paymentIntent?.currency || 'PKR').trim();
    const method = String(paymentIntent?.method || '').trim();
    const details = paymentIntent?.details;
    const customer = paymentIntent?.customer;
    const userId = String(customer?.userId || req.body?.userId || '').trim();
    const phone = String(customer?.phone || req.body?.phone || '').trim();

    if (!RAPID_GATEWAY_API_KEY) {
        return res.status(503).json({ success: false, message: 'Payment service is not configured.' });
    }

    if (!Number.isFinite(amount) || amount <= 0 || !currency || !method || !userId || !phone) {
        return res.status(400).json({ success: false, message: 'A complete payment intent is required.' });
    }

    const merchantReference = `CHALO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const callbackUrl = RAPID_WEBHOOK_URL || `https://${req.get('host')}/payments/callback`;

    try {
        const response = await axios.post(RAPID_API_URL, {
            amount,
            currency,
            method,
            details,
            customer: { userId, phone },
            callback_url: callbackUrl,
            merchant_reference: merchantReference,
            metadata: { userId, merchantReference }
        }, { headers: { 'Authorization': `Bearer ${RAPID_GATEWAY_API_KEY}` } });

        const transactionId = response.data?.transaction_id ||
            response.data?.transactionId || response.data?.id || merchantReference;
        const checkoutUrl = response.data?.checkout_url || response.data?.checkoutUrl || null;
        res.json({ success: true, transaction_id: transactionId, checkout_url: checkoutUrl });
    } catch (error) {
        console.error('Rapid Gateway initiation failed:', error.response?.data || error.message);
        res.status(error.response?.status && error.response.status >= 400 && error.response.status < 500 ? error.response.status : 502)
            .json({ success: false, message: 'Payment gateway request failed.' });
    }
});

router.post('/callback', async (req, res) => {
    if (!RAPID_WEBHOOK_SALT) {
        return res.status(503).send('Webhook verification is not configured.');
    }

    if (!isValidWebhookSignature(req)) {
        return res.status(401).send('Invalid webhook signature.');
    }

    const status = String(req.body?.status || '').trim().toUpperCase();
    const amount = Number(req.body?.amount);
    const userId = String(req.body?.metadata?.userId || '').trim();
    if (status === 'SUCCESS' && Number.isFinite(amount) && amount > 0 && userId) {
        const cleanId = userId.replace('+', '').trim();
        await User.findByIdAndUpdate(cleanId, {
            $inc: { walletBalance: amount },
            $push: { transactions: { title: "Wallet Top-up", amount, type: "CREDIT" } }
        });
    }
    res.status(200).send("OK");
});

module.exports = router;
