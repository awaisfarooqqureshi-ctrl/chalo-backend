const express = require('express');
const router = express.Router();
const Ride = require('../models/Ride');

router.post('/request', async (req, res) => {
    try {
        const rideData = req.body;
        console.log("🚕 Incoming Ride Request:", JSON.stringify(rideData));

        // Create the ride in MongoDB
        const ride = await Ride.create(rideData);

        console.log(`✅ Ride Created with ID: ${ride._id}`);

        const io = req.app.get('socketio');
        if (io) {
            console.log("📡 Emitting new_ride_request to all drivers");
            io.emit('new_ride_request', ride);
        }

        res.json(ride);
    } catch (e) {
        console.error("❌ Ride Request Error:", e.message);
        res.status(500).send(e.message);
    }
});

router.post('/update-status', async (req, res) => {
    try {
        const { rideId, status } = req.body;
        console.log(`🔄 Updating Ride ${rideId} to Status: ${status}`);

        const ride = await Ride.findByIdAndUpdate(rideId, { status }, { new: true });

        if (!ride) {
            console.error(`❌ Ride ${rideId} not found for status update.`);
            return res.status(404).send("Ride not found");
        }

        const io = req.app.get('socketio');
        if (io) {
            console.log(`📡 Emitting ride_status_updated for Ride: ${rideId}`);
            io.emit('ride_status_updated', ride);
        }

        res.json(ride);
    } catch (e) {
        console.error("❌ Update Status Error:", e.message);
        res.status(500).send(e.message);
    }
});

router.get('/active/:userId', async (req, res) => {
    try {
        const userId = req.params.userId.replace('+', '').trim();
        console.log(`🔍 Checking active ride for User: ${userId}`);

        const ride = await Ride.findOne({
            $or: [{ passengerId: userId }, { driverId: userId }],
            status: { $in: ['PENDING', 'FINDING_DRIVER', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ON_TRIP'] }
        }).sort({ createdAt: -1 });

        if (ride) {
            console.log(`✅ Found active ride: ${ride._id}`);
        } else {
            console.log(`ℹ️ No active ride found for user: ${userId}`);
        }

        res.json(ride);
    } catch (e) {
        console.error("❌ Active Ride Fetch Error:", e.message);
        res.status(500).send(e.message);
    }
});

module.exports = router;
