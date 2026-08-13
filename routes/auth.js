const express = require('express');
const router = express.Router();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const User = require('../models/User');
const Otp = require('../models/Otp');

// --- SMS2CONNECT (MAGIC MAYO) CONFIGURATION ---
const SMS_CONFIG = {
    api_key: process.env.SMS_API_KEY || "your_api_key",
    sender_id: process.env.SMS_SENDER_ID || "YourBrand",
    baseUrl: "https://api.sms2connect.com/v1/send-sms"
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

// 1. Send OTP (Updated for SMS2Connect / Magic Mayo)
router.post('/send-otp-veevo', async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "Phone required" });

    // SMS2Connect format: +923XXXXXXXXX
    const formattedPhone = phone.startsWith('+') ? phone : '+' + phone;
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const message = `Your Chalo App OTP is: ${otpCode}. Valid for 5 minutes.`;

    try {
        const payload = {
            api_key: SMS_CONFIG.api_key,
            sender_id: SMS_CONFIG.sender_id,
            mobile: formattedPhone,
            message: message
        };

        console.log(`🚀 Requesting SMS from SMS2Connect for: ${formattedPhone}`);
        const response = await axios.post(SMS_CONFIG.baseUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        console.log("📩 SMS2Connect Response:", JSON.stringify(response.data));

        if (response.data.status === "success" || response.status === 200) {
            const cleanPhone = phone.replace('+', '').trim();
            await Otp.findOneAndUpdate({ phone: cleanPhone }, { otp: otpCode }, { upsert: true });
            res.json({ success: true, message: "OTP Sent Successfully" });
        } else {
            console.error("❌ SMS Gateway Error:", response.data);
            res.status(400).json({
                success: false,
                message: response.data.message || "Gateway Error",
                details: response.data
            });
        }
    } catch (error) {
        console.error("❌ SMS Connectivity Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, message: "SMS Gateway Unreachable" });
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
