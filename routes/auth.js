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

// 1. Send OTP (Saving to RTDB instead of MongoDB)
router.post('/send-otp-veevo', async (req, res) => {
    let { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "Phone required" });

    const cleanPhone = phone.replace('+', '').trim();
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const message = `Your Chalo App OTP is: ${otpCode}. Valid for 5 minutes.`;

    try {
        const fastSmsUrl = `${SMS_CONFIG.baseUrl}?id=${SMS_CONFIG.id}&pass=${SMS_CONFIG.pass}&mask=${encodeURIComponent(SMS_CONFIG.mask)}&to=${cleanPhone}&msg=${encodeURIComponent(message)}&type=json&lang=english`;

        const response = await axios.get(fastSmsUrl);
        const isSuccess = response.data && (response.data.status === "success" || response.data.message_id || (typeof response.data === 'string' && response.data.includes("Successfully")));

        if (isSuccess || response.status === 200) {
            // SAVE OTP TO FIREBASE RTDB (Auto-expire in 5 mins logic should be on client or manual cleanup)
            const db = admin.database();
            await db.ref(`temp_otps/${cleanPhone}`).set({
                otp: otpCode,
                timestamp: Date.now()
            });

            res.json({ success: true, message: "OTP Sent Successfully" });
        } else {
            res.status(400).json({ success: false, message: "Gateway Refused SMS" });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: "SMS Gateway Unreachable" });
    }
});

// 2. Verify OTP & Create User in RTDB
router.post('/verify-otp-veevo', async (req, res) => {
    let { phone, otp } = req.body;
    const cleanPhone = phone.replace('+', '').trim();

    try {
        const db = admin.database();
        const otpRef = db.ref(`temp_otps/${cleanPhone}`);
        const snapshot = await otpRef.get();

        // MASTER OTP logic for testing specific number
        const isMasterOtp = (cleanPhone === "923125550557" && otp === "123456");

        if (!isMasterOtp && (!snapshot.exists() || snapshot.val().otp !== otp)) {
            return res.status(400).json({ success: false, message: "Invalid OTP" });
        }

        // Delete OTP after use
        await otpRef.remove();

        // Check if user exists in RTDB
        const userRef = db.ref(`users/${cleanPhone}`);
        const userSnap = await userRef.get();
        let userData;

        if (!userSnap.exists()) {
            console.log(`🆕 Creating brand new user in RTDB for: ${cleanPhone}`);
            userData = {
                uid: cleanPhone,
                phoneNumber: phone,
                name: "",
                role: "Passenger",
                walletBalance: 50,
                accountStatus: "active",
                driverRegistered: false,
                driverVerificationStatus: "not_submitted",
                transactions: {
                    "welcome": {
                        title: "Welcome Bonus",
                        amount: 50,
                        type: "CREDIT",
                        timestamp: Date.now(),
                        status: "COMPLETED"
                    }
                }
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

// Master Route to pre-create/reset the test user
router.get('/setup-test-user', async (req, res) => {
    const cleanPhone = "923125550557";
    try {
        const db = admin.database();
        const userRef = db.ref(`users/${cleanPhone}`);

        const testUser = {
            uid: cleanPhone,
            phoneNumber: `+${cleanPhone}`,
            name: "Test Driver",
            role: "Driver",
            walletBalance: 1000,
            accountStatus: "active",
            driverRegistered: true,
            driverVerificationStatus: "approved",
            currentServiceMode: "CITY_RIDE",
            driverRating: 5.0,
            driverReviewCount: 10,
            vehicleInfo: {
                model: "Honda Civic 2023",
                numberPlate: "ABC-123",
                type: "Comfort",
                color: "Black"
            },
            isOnline: false,
            transactions: {
                "initial": {
                    title: "System Credit",
                    amount: 1000,
                    type: "CREDIT",
                    timestamp: Date.now(),
                    status: "COMPLETED"
                }
            }
        };

        await userRef.set(testUser);
        res.send(`<h1>✅ User ${cleanPhone} created successfully as a Driver!</h1><p>You can now login with OTP: <b>123456</b></p>`);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

module.exports = router;
