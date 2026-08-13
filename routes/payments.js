const express = require('express');
const router = express.Router();
const axios = require('axios');
const User = require('../models/User');

const RAPID_GATEWAY_API_KEY = process.env.RAPID_API_KEY || "SANDBOX_KEY_HERE";
const RAPID_API_URL = "https://api.rapidgateway.pk/v1/payments";

router.post('/initiate', async (req, res) => {
    const { userId, amount, phone } = req.body;
    try {
        const response = await axios.post(RAPID_API_URL, {
            amount, currency: 'PKR', customer: { phone },
            callback_url: `https://${req.get('host')}/payments/callback`,
            metadata: { userId }
        }, { headers: { 'Authorization': `Bearer ${RAPID_GATEWAY_API_KEY}` } });
        res.json({ success: true, checkout_url: response.data.checkout_url });
    } catch (e) { res.status(500).json({ success: false, message: "Gateway Error" }); }
});

router.post('/callback', async (req, res) => {
    const { status, amount, metadata } = req.body;
    if (status === 'SUCCESS' && metadata?.userId) {
        const cleanId = metadata.userId.replace('+', '').trim();
        await User.findByIdAndUpdate(cleanId, {
            $inc: { walletBalance: amount },
            $push: { transactions: { title: "Wallet Top-up", amount, type: "CREDIT" } }
        });
    }
    res.status(200).send("OK");
});

module.exports = router;
