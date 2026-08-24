const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

// 1. Request Ride: Pure RTDB
router.post('/request', async (req, res) => {
    try {
        const rideData = req.body;
        const db = admin.database();
        const rideRef = db.ref('active_rides').push();
        const rideId = rideRef.key;

        const rideWithId = {
            ...rideData,
            id: rideId,
            status: 'FINDING_DRIVER',
            timestamp: Date.now(),
            lastPing: Date.now()
        };

        await rideRef.set(rideWithId);

        const io = req.app.get('socketio');
        if (io) io.emit('new_ride_request', rideWithId);

        res.status(201).json(rideWithId);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 2. Update Status: Archive to 'history' node in RTDB
router.post('/update-status', async (req, res) => {
    try {
        const { rideId, status } = req.body;
        const db = admin.database();
        const rideRef = db.ref(`active_rides/${rideId}`);

        await rideRef.update({ status });

        if (['COMPLETED', 'CANCELLED', 'RIDE_COMPLETED', 'RIDE_CANCELLED'].includes(status)) {
            const snapshot = await rideRef.get();
            if (snapshot.exists()) {
                const finalRideData = snapshot.val();
                // Save to Global History Node
                await db.ref(`history/${rideId}`).set(finalRideData);
                // Remove from Active
                await rideRef.remove();
            }
        }

        const io = req.app.get('socketio');
        if (io) io.emit(`ride_status_updated_${rideId}`, { status });

        res.json({ success: true });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 3. Bid
router.post('/bid', async (req, res) => {
    try {
        const { rideId, driverId, bidFare, driverName } = req.body;
        const db = admin.database();
        const rideRef = db.ref(`active_rides/${rideId}`);

        const snapshot = await rideRef.get();
        if (!snapshot.exists()) return res.status(404).send("Ride not found");

        const ride = snapshot.val();
        const offers = ride.offers || [];
        const newOffer = {
            id: Date.now().toString(),
            driverId,
            driverName,
            bidFare: parseFloat(bidFare),
            status: 'PENDING',
            timestamp: Date.now()
        };

        await rideRef.update({
            offers: [...offers, newOffer],
            status: 'BIDS_RECEIVED'
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

router.get('/history/:userId', async (req, res) => {
    // History logic is now handled on App side by observing user_history node
    res.json([]);
});

module.exports = router;
