const express = require('express');
const router = express.Router();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');

// --- FASTSMSALERTS.COM CONFIGURATION (Secrets from .env) ---
const SMS_CONFIG = {
    id: process.env.FASTSMS_ID,
    pass: process.env.FASTSMS_PASS,
    mask: process.env.FASTSMS_MASK,
    baseUrl: "https://fastsmsalerts.com/api/composesmsbulkotp"
};

const CHALO_SECRET = process.env.CHALO_SECRET || 'fallback_secret';

// 1. Send OTP (Optimized for Auto-Verification)
router.post('/send-otp-veevo', async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "Phone required" });

    // Clean number to strictly digits (923001234567)
    const cleanPhone = phone.replace(/\D/g, '').trim();
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // EXACT MATCH with your portal template for Auto-OTP detection
    const message = `<#> Your Chalo App OTP is: ${otpCode}. bdGiWfgWrVy`;

    console.log(`✉️ Attempting to send SMS to: ${cleanPhone}`);
    console.log(`📝 Message Content: ${message}`);

    try {
        const fastSmsUrl = `${SMS_CONFIG.baseUrl}?id=${SMS_CONFIG.id}&pass=${SMS_CONFIG.pass}&mask=${encodeURIComponent(SMS_CONFIG.mask)}&to=${cleanPhone}&msg=${encodeURIComponent(message)}&type=json&lang=english`;

        const response = await axios.get(fastSmsUrl);
        console.log("📡 Gateway API Response:", JSON.stringify(response.data));

        const isSuccess = response.data && (response.data.status === "success" || response.data.message_id || (typeof response.data === 'string' && response.data.includes("Successfully")));

        if (isSuccess || response.status === 200) {
            // SAVE OTP TO FIREBASE RTDB
            const db = admin.database();
            await db.ref(`temp_otps/${cleanPhone}`).set({
                otp: otpCode,
                timestamp: Date.now()
            });

            console.log(`✅ OTP ${otpCode} successfully saved in DB for ${cleanPhone}`);
            res.json({ success: true, message: "OTP Sent Successfully" });
        } else {
            console.error("❌ Gateway Refused SMS:", response.data);
            res.status(400).json({ success: false, message: "Gateway Refused SMS", gatewayResponse: response.data });
        }
    } catch (error) {
        console.error("❌ SMS Gateway Error:", error.message);
        res.status(500).json({ success: false, message: "SMS Gateway Unreachable" });
    }
});

// 2. Verify OTP & Create User in RTDB (Optimized for Rewards)
router.post('/verify-otp-veevo', async (req, res) => {
    let { phone, otp } = req.body;
    const cleanPhone = phone.replace(/\D/g, '').trim();

    try {
        const db = admin.database();
        const otpRef = db.ref(`temp_otps/${cleanPhone}`);
        const snapshot = await otpRef.get();

        if (!snapshot.exists() || snapshot.val().otp !== otp) {
            return res.status(400).json({ success: false, message: "Invalid OTP" });
        }

        // Delete OTP after use
        await otpRef.remove();

        // 1. Fetch System Config (No bonus at signup anymore)

        // 2. Check if user exists in RTDB
        const userRef = db.ref(`users/${cleanPhone}`);
        const userSnap = await userRef.get();
        let userData;

        if (!userSnap.exists()) {
            console.log(`🆕 Creating brand new user: ${cleanPhone}`);
            userData = {
                uid: cleanPhone,
                phoneNumber: phone,
                name: "New User",
                role: "Passenger",
                walletBalance: 0,
                accountStatus: "active",
                driverRegistered: false,
                driverVerificationStatus: "not_submitted",
                welcomeBonusApplied: false,
                createdAt: Date.now(),
                transactions: {}
            };
            await userRef.set(userData);
        } else {
            userData = userSnap.val();
        }

        const firebaseToken = await admin.auth().createCustomToken(cleanPhone);
        const token = jwt.sign({ userId: cleanPhone }, CHALO_SECRET);

        res.json({
            token,
            userId: cleanPhone,
            user: userData,
            firebaseToken,
            message: "Success"
        });
    } catch (e) {
        console.error("❌ Login Verification Error:", e.message);
        res.status(500).send("Login failed");
    }
});

module.exports = router;
