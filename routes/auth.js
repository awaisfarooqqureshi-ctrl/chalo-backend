const express = require('express');
const router = express.Router();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const User = require('../models/User');
const Otp = require('../models/Otp');

// --- FASTSMSALERTS.COM CONFIGURATION (FIXED URL) ---
const SMS_CONFIG = {
    id: process.env.FASTSMS_ID || "rchnp",
    pass: process.env.FASTSMS_PASS || "rchnp1281",
    mask: process.env.FASTSMS_MASK || "SMS Test.",
    baseUrl: "https://fastsmsalerts.com/api/composesmsbulkotp"
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

// 1. Send OTP (Updated with correct FastSMS URL and parameters)
router.post('/send-otp-veevo', async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "Phone required" });

    // Format: 923XXXXXXXXX
    const cleanPhone = phone.replace('+', '').trim();
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const message = `Your Chalo App OTP is: ${otpCode}. Valid for 5 minutes.`;

    try {
        // FastSMSAlerts exact parameters: id, pass, mask, to, msg, type
        const fastSmsUrl = `${SMS_CONFIG.baseUrl}?id=${SMS_CONFIG.id}&pass=${SMS_CONFIG.pass}&mask=${encodeURIComponent(SMS_CONFIG.mask)}&to=${cleanPhone}&msg=${encodeURIComponent(message)}&type=json&lang=english`;

        console.log(`🚀 Sending SMS via FastSMSAlerts to: ${cleanPhone}`);
        console.log(`🔗 Payload URL: ${fastSmsUrl.replace(SMS_CONFIG.pass, '********')}`); // Log masked URL for debugging

        const response = await axios.get(fastSmsUrl);

        console.log("📩 FastSMS Gateway Response:", JSON.stringify(response.data));

        // FastSMS returns an object, we check for common success indicators
        // Often it returns a message ID or a string indicating success
        const isSuccess = response.data && (response.data.status === "success" || response.data.message_id || (typeof response.data === 'string' && response.data.includes("Successfully")));

        if (isSuccess || response.status === 200) {
            await Otp.findOneAndUpdate({ phone: cleanPhone }, { otp: otpCode }, { upsert: true });
            res.json({ success: true, message: "OTP Sent Successfully" });
        } else {
            console.error("❌ SMS Refused by Gateway:", response.data);
            res.status(400).json({
                success: false,
                message: "Gateway Refused SMS",
                details: response.data
            });
        }
    } catch (error) {
        console.error("❌ SMS Connection Error:", error.message);
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
            console.log(`🆕 Creating brand new user record for: ${cleanPhone}`);
            user = await User.create({
                _id: cleanPhone, phone: phone, name: "",
                walletBalance: 50, transactions: [{ title: "Welcome Bonus", amount: 50, type: "CREDIT" }]
            });
        }

        const firebaseToken = await admin.auth().createCustomToken(user._id);
        const token = jwt.sign({ userId: user._id }, CHALO_SECRET);

        const androidUser = mapToAndroidUser(user);
        console.log(`✅ User ${cleanPhone} verified. Returning profile: ${JSON.stringify(androidUser)}`);

        res.json({
            token,
            userId: user._id,
            _id: user._id,
            user: androidUser,
            firebaseToken,
            message: "Success"
        });
    } catch (e) {
        console.error("❌ Login Verification Error:", e.message);
        res.status(500).send("Login failed");
    }
});

module.exports = router;
