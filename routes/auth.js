const express = require('express');
const router = express.Router();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const User = require('../models/User');
const Otp = require('../models/Otp');

// --- MAGIC MAYO / CUBIX TECHNOLOGY CONFIGURATION ---
const MAGIC_MAYO_CONFIG = {
    username: process.env.MAGIC_MAYO_USER || "rchnp",
    password: process.env.MAGIC_MAYO_PASS || "rchnp1281",
    mask: process.env.MAGIC_MAYO_MASK || "SMS Test.", // Approved Mask from your report
    baseUrl: "http://magicmayo.pk/api/sendsms.php" // Standard URL for MM/Cubix
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

// 1. Send OTP (Updated for Magic Mayo / Cubix)
router.post('/send-otp-veevo', async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "Phone required" });

    // Format: 923XXXXXXXXX (no +)
    const cleanPhone = phone.replace('+', '').trim();
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const message = `Your Chalo App OTP is: ${otpCode}`;

    try {
        // Standard Magic Mayo URL with parameters
        const mmUrl = `${MAGIC_MAYO_CONFIG.baseUrl}?username=${MAGIC_MAYO_CONFIG.username}&password=${MAGIC_MAYO_CONFIG.password}&to=${cleanPhone}&message=${encodeURIComponent(message)}&mask=${encodeURIComponent(MAGIC_MAYO_CONFIG.mask)}`;

        console.log(`🚀 Sending SMS to ${cleanPhone} via Magic Mayo...`);
        const response = await axios.get(mmUrl);

        console.log("📩 Magic Mayo Response:", JSON.stringify(response.data));

        // Magic Mayo success: Often returns a numeric ID or starts with "OK"
        if (response.data.toString().toLowerCase().includes("ok") || response.status === 200) {
            await Otp.findOneAndUpdate({ phone: cleanPhone }, { otp: otpCode }, { upsert: true });
            res.json({ success: true, message: "OTP Sent Successfully via Magic Mayo" });
        } else {
            console.error("❌ SMS Refused:", response.data);
            res.status(400).json({
                success: false,
                message: "Gateway Refusal",
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
