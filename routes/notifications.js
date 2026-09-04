const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const Notification = require('../models/Notification');

// Helper: Identity filter for robust lookup
function getIdentityFilter(userId) {
    if (!userId) return null;
    const digits = userId.toString().replace(/\D/g, '').slice(-10);
    return new RegExp(digits + '$');
}

// 1. Send Notification (Admin API)
router.post('/send', async (req, res) => {
    try {
        const { userId, title, message, type } = req.body;
        const cleanId = userId.toString().replace(/\+/g, '').trim();

        // A. Save to MongoDB for history
        const notif = new Notification({
            userId: cleanId,
            title,
            message,
            type: type || 'GENERAL'
        });
        await notif.save();

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
        res.status(500).send(e.message);
    }
});

// 2. Get Notification History (Limited to 15)
router.get('/:userId', async (req, res) => {
    try {
        const rawId = req.params.userId;
        const digits = rawId.replace(/\D/g, '').slice(-10);
        const regex = new RegExp(digits + '$');

        const history = await Notification.find({ userId: regex })
            .sort({ timestamp: -1 })
            .limit(15);

        res.json(history);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 3. Mark as Read
router.post('/read', async (req, res) => {
    try {
        const { notificationId } = req.body;
        await Notification.findByIdAndUpdate(notificationId, { isRead: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

module.exports = router;
