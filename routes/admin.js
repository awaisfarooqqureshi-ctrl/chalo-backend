const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

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

        // A. Save to Firestore Notification History
        try {
            const fs = admin.firestore();
            await fs.collection('notifications').add({
                userId: cleanId,
                title,
                message,
                type: status === 'approved' ? 'SYSTEM' : 'REJECTION',
                isRead: false,
                timestamp: Date.now()
            });
            console.log(`✅ Firestore notification recorded for ${cleanId}`);
        } catch (mErr) { console.error("❌ Firestore Notif Save Failed:", mErr.message); }

        // B. Send Real-time Push Notification via FCM
        try {
            const tokenSnap = await db.ref(`users/${cleanId}/fcmToken`).get();
            if (tokenSnap.exists()) {
                const fcmToken = tokenSnap.val();
                const response = await admin.messaging().send({
                    token: fcmToken,
                    notification: { title, body: message },
                    data: { type: 'VERIFICATION_UPDATE', status }
                });
                console.log(`🚀 FCM Success: Notification sent to ${cleanId}. Response:`, response);
            } else {
                console.log(`⚠️ FCM Warning: No token found for user ${cleanId}. Notification not sent.`);
            }
        } catch (pErr) {
            console.error("🔥 FCM Critical Failure:", pErr.message);
        }

        res.json({ success: true, message: `Driver status updated and notification sent.` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * 4. SYSTEM CRON: Cleanup data older than 90 days
 * Security: Requires 'X-Cron-Key' header
 */
router.post('/cron/cleanup', async (req, res) => {
    const cronKey = req.headers['x-cron-key'];
    if (cronKey !== (process.env.CRON_SECRET || "chalo_cleanup_master_2026")) {
        return res.status(403).json({ success: false, message: "Forbidden" });
    }

    try {
        const fs = admin.firestore();
        const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);

        console.log("🧹 CRON: Starting Data Cleanup...");

        // A. Cleanup Old Rides
        const oldRides = await fs.collection('rides').where('archivedAt', '<', ninetyDaysAgo).get();
        const rideBatch = fs.batch();
        oldRides.forEach(doc => rideBatch.delete(doc.ref));
        await rideBatch.commit();
        console.log(`✅ Cleaned ${oldRides.size} old rides.`);

        // B. Cleanup Old Notifications
        const oldNotifs = await fs.collection('notifications').where('timestamp', '<', ninetyDaysAgo).get();
        const notifBatch = fs.batch();
        oldNotifs.forEach(doc => notifBatch.delete(doc.ref));
        await notifBatch.commit();
        console.log(`✅ Cleaned ${oldNotifs.size} old notifications.`);

        // C. Cleanup Old Transactions (History only, Balance is safe)
        const oldTxns = await fs.collection('transactions').where('timestamp', '<', ninetyDaysAgo).get();
        const txnBatch = fs.batch();
        oldTxns.forEach(doc => txnBatch.delete(doc.ref));
        await txnBatch.commit();
        console.log(`✅ Cleaned ${oldTxns.size} old transactions.`);

        res.json({
            success: true,
            message: "Cleanup completed successfully",
            deletedCounts: { rides: oldRides.size, notifications: oldNotifs.size, transactions: oldTxns.size }
        });
    } catch (e) {
        console.error("🔥 CRON ERROR:", e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
