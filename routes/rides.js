const express = require('express');
const router = express.Router();
const Ride = require('../models/Ride'); // MongoDB Model for History
const admin = require('firebase-admin');

// 1. Request Ride: Creates in Firebase RTDB for Real-time, MongoDB for record
router.post('/request', async (req, res) => {
    try {
        const rideData = req.body;
        console.log("🚕 New Ride Request (Real-time via Firebase):", rideData.passengerName);

        const db = admin.database();
        const rideRef = db.ref('active_rides').push();
        const rideId = rideRef.key;

        const rideWithId = {
            ...rideData,
            id: rideId,
            _id: rideId,
            status: 'FINDING_DRIVER',
            timestamp: Date.now(),
            lastPing: Date.now()
        };

        // SAVE TO FIREBASE (Primary for Real-time)
        await rideRef.set(rideWithId);
        console.log(`🔥 Ride created in RTDB: ${rideId}`);

        // SAVE TO MONGODB (Secondary for History/Record)
        try {
            await Ride.create({ ...rideWithId, _id: undefined });
        } catch (mongoErr) {
            console.warn("⚠️ Mongo record creation failed:", mongoErr.message);
        }

        const io = req.app.get('socketio');
        if (io) io.emit('new_ride_request', rideWithId);

        res.status(201).json(rideWithId);
    } catch (e) {
        console.error("❌ Ride Request Error:", e.message);
        res.status(500).send(e.message);
    }
});

// 2. Update Status: Primary RTDB, Archive to MongoDB on Completion
router.post('/update-status', async (req, res) => {
    try {
        const { rideId, status } = req.body;
        const db = admin.database();
        const rideRef = db.ref(`active_rides/${rideId}`);

        console.log(`🔄 Status Update: ${rideId} -> ${status}`);

        // Update RTDB
        await rideRef.update({ status });

        // If ride is FINISHED (Completed or Cancelled), save final state to MongoDB and Remove from active
        if (status === 'COMPLETED' || status === 'CANCELLED' || status === 'RIDE_COMPLETED' || status === 'RIDE_CANCELLED') {
            const snapshot = await rideRef.get();
            if (snapshot.exists()) {
                const finalRideData = snapshot.val();
                console.log(`📦 Archiving Ride to MongoDB History: ${rideId}`);

                await Ride.findOneAndUpdate(
                    { id: rideId },
                    { ...finalRideData, status },
                    { upsert: true }
                );

                // Remove from Active RTDB
                await rideRef.remove();
                console.log(`🗑️ Removed ${rideId} from Active RTDB`);
            }
        }

        const io = req.app.get('socketio');
        if (io) io.emit(`ride_status_updated_${rideId}`, { status });

        res.json({ success: true });
    } catch (e) {
        console.error("❌ Status Update Error:", e.message);
        res.status(500).send(e.message);
    }
});

// 3. Bid: Update RTDB only (Fast Real-time)
router.post('/bid', async (req, res) => {
    try {
        const { rideId, driverId, bidFare, driverName, rating, vehicleModel, vehiclePlate, vehicleType, lat, lon } = req.body;
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
            rating: rating || 5.0,
            vehicleModel: vehicleModel || "",
            vehiclePlate: vehiclePlate || "",
            vehicleType: vehicleType || "Car",
            lat: lat || 0.0,
            lon: lon || 0.0,
            status: 'PENDING',
            timestamp: Date.now(),
            expiresAt: Date.now() + 10000
        };

        await rideRef.update({
            offers: [...offers, newOffer],
            status: 'BIDS_RECEIVED'
        });

        console.log(`💰 New Bid in RTDB for: ${rideId}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 4. History: Fetch EXCLUSIVELY from MongoDB
router.get('/history/:userId', async (req, res) => {
    try {
        const userId = req.params.userId.trim();
        console.log(`📜 Fetching MongoDB History for: ${userId}`);
        const rides = await Ride.find({
            $or: [{ passengerId: userId }, { driverId: userId }],
            status: { $in: ['COMPLETED', 'CANCELLED', 'RIDE_COMPLETED', 'RIDE_CANCELLED'] }
        }).sort({ timestamp: -1 }).limit(50);

        res.json(rides);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 5. Active: Fetch from RTDB (Real-time fallback)
router.get('/active/:userId', async (req, res) => {
    try {
        const userId = req.params.userId.trim();
        const db = admin.database();
        const snapshot = await db.ref('active_rides').get();

        let activeRide = null;
        snapshot.forEach((child) => {
            val = child.val();
            if ((val.passengerId === userId || val.driverId === userId) &&
                !['COMPLETED', 'CANCELLED'].includes(val.status)) {
                activeRide = val;
            }
        });

        res.json(activeRide);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

router.get('/pending', async (req, res) => {
    try {
        const db = admin.database();
        const snapshot = await db.ref('active_rides').get();
        const rides = [];
        snapshot.forEach((child) => {
            const val = child.val();
            if (['FINDING_DRIVER', 'BIDS_RECEIVED', 'PENDING'].includes(val.status)) {
                rides.push(val);
            }
        });
        res.json(rides);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

module.exports = router;
