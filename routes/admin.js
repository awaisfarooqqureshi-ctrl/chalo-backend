const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const Notification = require('../models/Notification');

/**
 * PRODUCTION ADMIN ROUTES
 * All testing/seeding routes have been removed for security.
 */

// 1. Get all Bonus Schemes
router.get('/bonuses', async (req, res) => {
    try {
        const db = admin.database();
        const snapshot = await db.ref('bonus_schemes').get();
        const bonuses = [];
        snapshot.forEach(child => {
            bonuses.push({ id: child.key, ...child.val() });
        });
        res.json(bonuses);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. Add or Update a Bonus Scheme
router.post('/bonuses', async (req, res) => {
    const { id, title, description, type, target, reward, vehicleGroup, isActive, colorHex } = req.body;
    if (!title || !target || !reward) return res.status(400).json({ success: false, message: "Missing data" });

    try {
        const db = admin.database();
        const bonusId = id || db.ref('bonus_schemes').push().key;
        const bonusData = { id: bonusId, title, description: description || "", type: type || "RIDE_COMPLETION", target: parseInt(target), reward: parseFloat(reward), vehicleGroup: vehicleGroup || "ALL", isActive: isActive !== undefined ? isActive : true, colorHex: colorHex || "#FFC107", updatedAt: Date.now() };
        await db.ref(`bonus_schemes/${bonusId}`).set(bonusData);
        res.json({ success: true, data: bonusData });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. Approve/Verify Driver Documents + Automated Notification
router.post('/approve-driver', async (req, res) => {
    const { userId, status, notes } = req.body; // status: approved, rejected
    try {
        const db = admin.database();
        const cleanId = userId.toString().replace(/\+/g, '').trim();

        // 1. Update Firebase RTDB
        const updates = {
            driverVerificationStatus: status,
            adminNote: notes || ""
        };

        // If approved, set driverRegistered to true just in case
        if (status === 'approved') {
            updates.driverRegistered = true;
        }

        await db.ref(`users/${cleanId}`).update(updates);

        // 2. Automated Notification Logic
        const title = status === 'approved' ? "Verification Approved! 🎉" : "Registration Rejected";
        const message = notes || (status === 'approved' ? "Welcome to Chalo! Your driver account is now active." : "Please check your profile for details on why your registration was rejected.");

        // A. Save to MongoDB Notification History
        try {
            const notif = new Notification({
                userId: cleanId,
                title,
                message,
                type: status === 'approved' ? 'SYSTEM' : 'REJECTION'
            });
            await notif.save();
        } catch (mErr) { console.error("❌ MongoDB Notif Save Failed:", mErr.message); }

        // B. Send Real-time Push Notification via FCM
        try {
            const tokenSnap = await db.ref(`users/${cleanId}/fcmToken`).get();
            if (tokenSnap.exists()) {
                const fcmToken = tokenSnap.val();
                await admin.messaging().send({
                    token: fcmToken,
                    notification: { title, body: message },
                    data: { type: 'VERIFICATION_UPDATE', status }
                });
                console.log(`🚀 Push sent to Driver ${cleanId}`);
            }
        } catch (pErr) { console.error("❌ FCM Push Failed:", pErr.message); }

        res.json({ success: true, message: `Driver status updated and notification sent.` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
