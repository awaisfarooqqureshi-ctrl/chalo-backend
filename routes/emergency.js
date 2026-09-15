const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

function cleanId(userId) {
    return userId ? userId.toString().replace(/\D/g, '').trim() : '';
}

router.post('/sos', async (req, res) => {
    try {
        const authenticatedUserId = cleanId(req.user?.userId);
        const { rideId, location } = req.body || {};
        const latitude = Number(location?.lat);
        const longitude = Number(location?.lng ?? location?.lon);

        if (!authenticatedUserId || !rideId ||
            !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
            latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
            return res.status(400).json({ success: false, message: 'Invalid SOS request' });
        }

        const db = admin.database();
        const rideSnap = await db.ref(`active_rides/${rideId}`).get();
        if (!rideSnap.exists()) {
            return res.status(404).json({ success: false, message: 'Active ride not found' });
        }

        const ride = rideSnap.val();
        const passengerId = cleanId(ride.passengerId || ride.userId);
        const driverId = cleanId(ride.driverId);
        let role;
        let userName;
        if (authenticatedUserId === passengerId) {
            role = 'Passenger';
            userName = ride.passengerName || ride.userName || 'Passenger';
        } else if (authenticatedUserId === driverId) {
            role = 'Driver';
            userName = ride.driverName || 'Driver';
        } else {
            return res.status(403).json({ success: false, message: 'Forbidden: You are not part of this ride' });
        }

        const alertRef = db.ref('emergency_alerts').push();
        const alertId = alertRef.key;

        const alertData = {
            userId: authenticatedUserId,
            userName,
            role,
            location: { lat: latitude, lng: longitude },
            mapLink: `https://www.google.com/maps?q=${latitude},${longitude}`,
            rideId,
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
