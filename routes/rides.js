const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const MongoRide = require('../models/Ride'); // Cold Storage Model

// 1. Request Ride (RTDB for Active)
router.post('/request', async (req, res) => {
    try {
        const rideData = req.body;
        const db = admin.database();
        const rideRef = db.ref('active_rides').push();
        const rideId = rideRef.key;
        const rideWithId = { ...rideData, id: rideId, status: 'FINDING_DRIVER', timestamp: Date.now(), lastPing: Date.now() };
        await rideRef.set(rideWithId);
        const io = req.app.get('socketio');
        if (io) io.emit('new_ride_request', rideWithId);
        res.status(201).json(rideWithId);
    } catch (e) { res.status(500).send(e.message); }
});

// 2. Update Status (Archive to MongoDB, No RTDB history)
router.post('/update-status', async (req, res) => {
    try {
        const { rideId, status } = req.body;
        const db = admin.database();
        const rideRef = db.ref(`active_rides/${rideId}`);
        await rideRef.update({ status });

        if (['COMPLETED', 'RIDE_COMPLETED'].includes(status)) {
            const snapshot = await rideRef.get();
            if (snapshot.exists()) {
                const finalRideData = snapshot.val();

                // --- SCALE OPTIMIZATION: ARCHIVE ONLY TO MONGODB ---
                try {
                    const mongoData = {
                        ...finalRideData,
                        id: rideId,
                        status: 'COMPLETED',
                        paymentStatus: 'PAID',
                        offers: Object.values(finalRideData.offers || {})
                    };
                    // Ensure lat/lon mapping for MongoDB
                    if (mongoData.pickupLng && !mongoData.pickupLon) mongoData.pickupLon = mongoData.pickupLng;
                    if (mongoData.destinationLng && !mongoData.destinationLon) mongoData.destinationLon = mongoData.destinationLng;

                    await new MongoRide(mongoData).save();
                    console.log(`✅ Ride ${rideId} archived to MongoDB Atlas.`);
                } catch (mongoErr) { console.error("❌ MongoDB Archive Failed:", mongoErr.message); }

                // Strictly delete from RTDB active_rides. DO NOT write to history node.
                await rideRef.remove();
            }
        } else if (['CANCELLED', 'RIDE_CANCELLED'].includes(status)) {
            const snapshot = await rideRef.get();
            if (snapshot.exists()) {
                const finalRideData = snapshot.val();
                try {
                    await new MongoRide({ ...finalRideData, id: rideId, status: 'CANCELLED', offers: Object.values(finalRideData.offers || {}) }).save();
                } catch (e) {}
                await rideRef.remove();
            }
        }
        const io = req.app.get('socketio');
        if (io) io.emit(`ride_status_updated_${rideId}`, { status });
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

// 3. Bid (RTDB)
router.post('/bid', async (req, res) => {
    try {
        const { rideId, offer } = req.body;
        const db = admin.database();
        if (!offer || !offer.driverId) return res.status(400).send("Invalid offer");
        await db.ref(`active_rides/${rideId}/offers/${offer.driverId}`).set(offer);
        await db.ref(`active_rides/${rideId}`).update({ status: 'BIDS_RECEIVED' });
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

// 4. Accept Bid (RTDB)
router.post('/accept-bid', async (req, res) => {
    try {
        const { rideId, offerId, driverId } = req.body;
        const db = admin.database();
        const rideRef = db.ref(`active_rides/${rideId}`);
        const driverRef = db.ref(`users/${driverId}`);
        const rideSnap = await rideRef.get();
        if (!rideSnap.exists()) return res.status(404).send("Ride not found");
        const ride = rideSnap.val();
        const driverSnap = await driverRef.get();
        if (!driverSnap.exists()) return res.status(404).send("Driver not found");
        const driver = driverSnap.val();
        const configSnap = await db.ref('admin_config/settings').get();
        const commissionRate = configSnap.val()?.commission_rate || 10;
        const acceptedOffer = Object.values(ride.offers || {}).find(o => o.id === offerId || o.driverId === driverId);
        if (!acceptedOffer) return res.status(404).send("Offer not found");
        const commissionAmount = (acceptedOffer.bidFare * commissionRate) / 100;
        await driverRef.update({ walletBalance: (driver.walletBalance || 0) - commissionAmount, driverStatus: 'ON_CITY_RIDE' });
        const rideUpdates = { status: 'ACCEPTED', driverId: driverId, driverName: driver.name, offeredFare: acceptedOffer.bidFare, commissionAmount: commissionAmount, vehicleType: driver.vehicleInfo?.type || ride.vehicleType };
        await rideRef.update(rideUpdates);
        res.json({ ...ride, ...rideUpdates });
    } catch (e) { res.status(500).send(e.message); }
});

// 5. Update Payment in MongoDB ONLY
router.post('/update-payment', async (req, res) => {
    try {
        const { rideId, paymentStatus, paymentMethod } = req.body;
        if (!rideId) return res.status(400).send("Ride ID required");
        // SCALE FIX: We ONLY update MongoDB Atlas history. STRICTLY NO RTDB history writes.
        const result = await MongoRide.findOneAndUpdate({ id: rideId }, { paymentStatus, paymentMethod }, { new: true });
        if (result) console.log(`✅ MongoDB Payment updated for ride ${rideId}`);
        else console.warn(`⚠️ Ride ${rideId} not found in MongoDB Cold Storage for payment update`);
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

// 6. Get History (MongoDB Source of Truth)
router.get('/history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const rides = await MongoRide.find({ $or: [{ passengerId: userId }, { driverId: userId }] }).sort({ timestamp: -1 }).limit(30);
        res.json(rides);
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
