const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

router.post('/sos', async (req, res) => {
    try {
        const db = admin.database();
        const alertRef = db.ref('emergency_alerts').push();
        const alertId = alertRef.key;

        const alertData = {
            ...req.body,
            id: alertId,
            timestamp: Date.now()
        };

        await alertRef.set(alertData);

        const io = req.app.get('socketio');
        if (io) io.emit('new_emergency_alert', alertData);

        res.json({ success: true, alert: alertData });
    } catch (e) {
        console.error("SOS Proxy Error:", e.message);
        res.status(500).send(e.message);
    }
});

module.exports = router;
