const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const DB = require('../services/db');

// Helper: Standardized Clean ID
function getCleanId(userId) {
    if (!userId) return "";
    return userId.toString().replace(/\+/g, '').trim();
}

// 1. Send Notification (Admin API)
router.post('/send', async (req, res) => {
    try {
        const { userId, title, message, type } = req.body;
        const cleanId = getCleanId(userId);

        // A. Save via Portable DB Service
        await DB.saveNotification({
            userId: cleanId,
            title,
            message,
            type: type || 'GENERAL'
        });

        // B. Send Push Notification via FCM
        const db = admin.database();
        const tokenSnap = await db.ref(`users/${cleanId}/fcmToken`).get();

        if (tokenSnap.exists()) {
            const fcmToken = tokenSnap.val();
            const payload = {
                notification: { title, body: message },
                data: { type: type || 'GENERAL', click_action: 'FLUTTER_NOTIFICATION_CLICK' }
            };
            await admin.messaging().send({ token: fcmToken, ...payload });
            console.log(`🚀 Push sent to ${cleanId}`);
        }

        res.json({ success: true, message: "Notification sent and archived" });
    } catch (e) {
        console.error("❌ Send Notification Error:", e.message);
        res.status(500).send(e.message);
    }
});

// 2. Get Notification History
router.get('/:userId', async (req, res) => {
    try {
        const history = await DB.getNotifications(getCleanId(req.params.userId));
        res.json(history);
    } catch (e) {
        console.error("❌ Get Notifications Error:", e.message);
        res.status(500).send(e.message);
    }
});

// 3. Mark as Read
router.post('/read', async (req, res) => {
    try {
        const { notificationId } = req.body;
        await DB.markNotificationRead(notificationId);
        res.json({ success: true });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

module.exports = router;
