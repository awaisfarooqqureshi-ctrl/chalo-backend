const express = require('express');
const router = express.Router();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const bcrypt = require('bcryptjs');

// --- FASTSMSALERTS.COM CONFIGURATION ---
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

    const cleanPhone = phone.replace(/\D/g, '').trim();
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    // RE-INVENTED TEMPLATE
    const message = `<#> Your Chalo App OTP is: ${otpCode}. bdGiWfgWrVy`;

    console.log(`✉️ Dispatching OTP to: ${cleanPhone}`);

    try {
        await axios.get(SMS_CONFIG.baseUrl, {
            params: {
                id: SMS_CONFIG.id,
                pass: SMS_CONFIG.pass,
                mask: SMS_CONFIG.mask,
                to: cleanPhone,
                msg: message,
                type: 'json',
                lang: 'english'
            },
            timeout: 10000
        });

        // SAVE OTP TO FIREBASE RTDB
        await admin.database().ref(`temp_otps/${cleanPhone}`).set({
            otp: otpCode,
            timestamp: Date.now()
        });

        res.json({ success: true, message: "OTP Sent Successfully" });
    } catch (error) {
        console.error("❌ SMS Gateway Error:", error.message);
        res.status(500).json({ success: false, message: "SMS Gateway Unreachable" });
    }
});

// 2. Verify OTP & Create User in RTDB
router.post('/verify-otp-veevo', async (req, res) => {
    let { phone, otp } = req.body;
    const cleanPhone = phone.replace(/\D/g, '').trim();

    try {
        const otpRef = admin.database().ref(`temp_otps/${cleanPhone}`);
        const snapshot = await otpRef.get();

        if (!snapshot.exists() || snapshot.val().otp !== otp) {
            return res.status(400).json({ success: false, message: "Invalid OTP" });
        }

        await otpRef.remove();

        const userRef = admin.database().ref(`users/${cleanPhone}`);
        const userSnap = await userRef.get();
        let userData;

        if (!userSnap.exists()) {
            userData = {
                uid: cleanPhone,
                phoneNumber: phone,
                name: "New User",
                role: "Passenger",
                walletBalance: 0,
                accountStatus: "active",
                driverRegistered: false,
                welcomeBonusApplied: false,
                createdAt: Date.now()
            };
            await userRef.set(userData);
        } else {
            userData = userSnap.val();
        }

        const firebaseToken = await admin.auth().createCustomToken(cleanPhone);
        const token = jwt.sign({ userId: cleanPhone }, CHALO_SECRET);

        res.json({ token, userId: cleanPhone, user: userData, firebaseToken, message: "Success" });
    } catch (e) {
        res.status(500).send("Login failed");
    }
});

/**
 * 3. Dashboard Admin Login (Firestore Powered)
 */
router.post('/admin/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const fs = admin.firestore();
        const adminSnap = await fs.collection('admins').where('email', '==', email).limit(1).get();

        if (adminSnap.empty) {
            return res.status(401).json({ success: false, message: "Invalid credentials" });
        }

        const adminDoc = adminSnap.docs[0];
        const adminUser = adminDoc.data();

        if (!adminUser.isActive) return res.status(401).json({ success: false, message: "Account inactive" });

        const isMatch = await bcrypt.compare(password, adminUser.password);
        if (!isMatch) return res.status(401).json({ success: false, message: "Invalid credentials" });

        await adminDoc.ref.update({ lastLogin: Date.now() });

        const accessToken = jwt.sign(
            { userId: adminDoc.id, email: adminUser.email, role: adminUser.role, isAdmin: true },
            CHALO_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            accessToken,
            admin: { id: adminDoc.id, name: adminUser.name, email: adminUser.email, role: adminUser.role }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

/**
 * 4. Initial Admin Setup (One-time)
 */
router.post('/admin/setup-initial', async (req, res) => {
    const { name, email, password, secretKey } = req.body;

    if (secretKey !== process.env.ADMIN_SETUP_KEY && secretKey !== "chalo_setup_2026") {
        return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    try {
        const fs = admin.firestore();
        const existing = await fs.collection('admins').where('email', '==', email).get();
        if (!existing.empty) return res.status(400).json({ success: false, message: "Already exists" });

        const hashedPassword = await bcrypt.hash(password, 10);
        await fs.collection('admins').add({
            name, email, password: hashedPassword, role: 'SUPER_ADMIN', isActive: true, createdAt: Date.now()
        });

        res.json({ success: true, message: "Master Admin created in Firestore" });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;

module.exports = router;
