const express = require('express');
const router = express.Router();
const EmergencyAlert = require('../models/Emergency');

router.post('/sos', async (req, res) => {
    try {
        const alert = await EmergencyAlert.create(req.body);
        const io = req.app.get('socketio');
        if (io) io.emit('new_emergency_alert', alert);
        res.json({ success: true, alert });
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
