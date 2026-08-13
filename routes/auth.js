const express = require('express');
const router = express.Router();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const User = require('../models/User');
const Otp = require('../models/Otp');

// --- SENDPK.COM (MAGIC MAYO) FINAL CONFIGURATION ---
const SENDPK_CONFIG = {
    username: process.env.SENDPK_USERNAME || "rchnp",
    password: process.env.SENDPK_PASSWORD || "rchnp1281",
    api_key: process.env.SENDPK_API_KEY || "51a0a0596b897986a43d3952635885d0",
    sender: process.env.SENDPK_SENDER || "rchnp", // Brand/Masking
    baseUrl: "https://sendpk.com/api/sms.php"
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
        gender: user.gender || "",
        dateOfBirth: user.dateOfBirth || "",
        accountStatus: "active", currentServiceMode: "CITY_RIDE"
    };
};

// 1. Send OTP (Updated with your provided credentials)
router.post('/send-otp-veevo', async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "Phone required" });

    // Format: 923XXXXXXXXX
    const cleanPhone = phone.replace('+', '').trim();
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const message = `Your Chalo App OTP is: ${otpCode}. Valid for 5 minutes.`;

    try {
        // Sendpk using GET/URL params for maximum reliability
        const sendpkUrl = `${SENDPK_CONFIG.baseUrl}?username=${SENDPK_CONFIG.username}&password=${SENDPK_CONFIG.password}&api_key=${SENDPK_CONFIG.api_key}&sender=${encodeURIComponent(SENDPK_CONFIG.sender)}&mobile=${cleanPhone}&message=${encodeURIComponent(message)}&type=text&format=json`;

        console.log(`🚀 Sending SMS to ${cleanPhone} via Sendpk...`);
        const response = await axios.get(sendpkUrl);

        console.log("📩 Sendpk API Response:", JSON.stringify(response.data));

        // Check for success in response
        if (response.data.status === "success" || response.data.code === "200" || response.data.message_id) {
            await Otp.findOneAndUpdate({ phone: cleanPhone }, { otp: otpCode }, { upsert: true });
            res.json({ success: true, message: "OTP Sent Successfully" });
        } else {
            console.error("❌ SMS Refused:", response.data);
            res.status(400).json({
                success: false,
                message: response.data.message || "Gateway Refusal",
                details: response.data
            });
        }
    } catch (error) {
        console.error("❌ SMS Connection Error:", error.message);
        res.status(500).json({ success: false, message: "SMS Server Unreachable" });
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
