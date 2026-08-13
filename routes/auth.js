const express = require('express');
const router = express.Router();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const User = require('../models/User');
const Otp = require('../models/Otp');

const VEEVO_CONFIG = {
    apiKey: "51a0a0596b897986a43d3952635885d0",
    baseUrl: "https://api.veevotech.com/v3/sendsms"
};

const CHALO_SECRET = 'CHALO_APP_SECRET_KEY_2024';

const mapToAndroidUser = (user) => {
    if (!user) return null;
    return {
        uid: user._id, _id: user._id,
        name: user.name || "", phoneNumber: user.phone,
        role: user.role || "Passenger", walletBalance: user.walletBalance || 0.0,
        profilePhoto: user.profilePhoto || "",
        driverRegistered: user.driverRegistered || false,
        driverVerificationStatus: user.driverVerificationStatus || "not_submitted",
        isOnline: user.isOnline || false,
        vehicleInfo: user.vehicleInfo || null,
        accountStatus: "active", currentServiceMode: "CITY_RIDE"
    };
};

// 1. Send OTP
router.post('/send-otp-veevo', async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "Phone required" });

    const cleanPhone = phone.replace('+', '').trim();
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const message = `Your Chalo App OTP is: ${otpCode}`;

    try {
        const veevoUrl = `${VEEVO_CONFIG.baseUrl}?apikey=${VEEVO_CONFIG.apiKey}&receivernum=${cleanPhone}&textmessage=${encodeURIComponent(message)}&sendernum=Default`;
        await axios.get(veevoUrl);
        await Otp.findOneAndUpdate({ phone: cleanPhone }, { otp: otpCode }, { upsert: true });
        res.json({ success: true, message: "OTP Sent" });
    } catch (error) {
        console.error("Veevo Error:", error.message);
        res.status(500).json({ success: false });
    }
});

// 2. Verify OTP
router.post('/verify-otp-veevo', async (req, res) => {
    let { phone, otp } = req.body;
    const cleanPhone = phone.replace('+', '').trim();
    try {
        const record = await Otp.findOne({ phone: cleanPhone, otp: otp });
        if (!record) return res.status(400).json({ success: false, message: "Invalid OTP" });

        await Otp.deleteOne({ _id: record._id });

        let user = await User.findById(cleanPhone);
        if (!user) {
            user = await User.create({
                _id: cleanPhone, phone: phone, name: "",
                walletBalance: 50, transactions: [{ title: "Welcome Bonus", amount: 50, type: "CREDIT" }]
            });
        }

        const firebaseToken = await admin.auth().createCustomToken(user._id);
        const token = jwt.sign({ userId: user._id }, CHALO_SECRET);
        res.json({ token, userId: user._id, _id: user._id, user: mapToAndroidUser(user), firebaseToken, message: "Success" });
    } catch (e) {
        res.status(500).send("Login failed");
    }
});

module.exports = router;
