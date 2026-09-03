const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const MongoRide = require('../models/Ride');
const Transaction = require('../models/Transaction');

// Helper: Extreme Robust Identity Matcher (Regex based)
function getIdentityFilter(userId) {
    if (!userId) return null;
    const digitsOnly = userId.toString().replace(/\D/g, '').slice(-10); // Last 10 digits
    return new RegExp(digitsOnly + '$'); // Matches anything ending in these 10 digits
}

// 1. Request Ride
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

// 2. Update Status: Archive to MongoDB + Accounting
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
                const driverId = finalRideData.driverId;
                const fare = finalRideData.offeredFare || 0;

                if (driverId) {
                    try {
                        const driverRef = db.ref(`users/${driverId}`);
                        const driverSnap = await driverRef.get();
                        if (driverSnap.exists()) {
                            const driver = driverSnap.val();
                            const now = new Date();
                            const currentMonth = now.getMonth();
                            let monthlyEarnings = (driver.lastEarningsResetMonth === currentMonth) ? (driver.monthlyEarnings || 0) + fare : fare;
                            await driverRef.update({ monthlyEarnings, lifetimeEarnings: (driver.lifetimeEarnings || 0) + fare, lastEarningsResetMonth: currentMonth });

                            await new Transaction({
                                userId: driverId,
                                title: "Ride Income (Directly Received)",
                                amount: parseFloat(fare),
                                type: "CREDIT",
                                category: "RIDE_INCOME",
                                status: "COMPLETED",
                                reference: rideId,
                                timestamp: Date.now()
                            }).save();
                        }
                    } catch (accErr) { console.error("❌ Accounting Error:", accErr.message); }
                }

                try {
                    const mongoData = {
                        ...finalRideData,
                        id: rideId,
                        status: 'COMPLETED',
                        paymentStatus: 'PAID',
                        offers: Object.values(finalRideData.offers || {})
                    };
                    if (mongoData.pickupLng && !mongoData.pickupLon) mongoData.pickupLon = mongoData.pickupLng;
                    if (mongoData.destinationLng && !mongoData.destinationLon) mongoData.destinationLon = mongoData.destinationLng;

                    await new MongoRide(mongoData).save();
                    console.log(`✅ Ride ${rideId} archived to MongoDB`);
                    await rideRef.remove();
                } catch (mongoErr) { console.error("❌ MongoDB Archive Error:", mongoErr.message); }
            }
        } else if (['CANCELLED', 'RIDE_CANCELLED'].includes(status)) {
            const snapshot = await rideRef.get();
            if (snapshot.exists()) {
                const data = snapshot.val();
                try {
                    await new MongoRide({ ...data, id: rideId, status: 'CANCELLED', offers: Object.values(data.offers || {}) }).save();
                    await rideRef.remove();
                } catch (e) { console.error("❌ Cancel Archive Error:", e.message); }
            }
        }
        const io = req.app.get('socketio');
        if (io) io.emit(`ride_status_updated_${rideId}`, { status });
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

// 3. Bid
router.post('/bid', async (req, res) => {
    try {
        const { rideId, offer } = req.body;
        const db = admin.database();
        await db.ref(`active_rides/${rideId}/offers/${offer.driverId}`).set(offer);
        await db.ref(`active_rides/${rideId}`).update({ status: 'BIDS_RECEIVED' });
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

// 4. Accept Bid: Commission Accounting
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

        // 1. Deduct from RTDB
        await driverRef.update({ walletBalance: (driver.walletBalance || 0) - commissionAmount, driverStatus: 'ON_CITY_RIDE' });

        // 2. Save Commission to MongoDB
        try {
            await new Transaction({
                userId: driverId,
                title: "Ride Commission",
                amount: parseFloat(commissionAmount),
                type: "DEBIT",
                category: "COMMISSION",
                status: "COMPLETED",
                reference: rideId,
                timestamp: Date.now()
            }).save();
            console.log(`📉 Commission of Rs.${commissionAmount} debited.`);
        } catch (tErr) { console.error("❌ Commission Log Error:", tErr.message); }

        const rideUpdates = { status: 'ACCEPTED', driverId: driverId, driverName: driver.name, offeredFare: acceptedOffer.bidFare, commissionAmount: commissionAmount, vehicleType: driver.vehicleInfo?.type || ride.vehicleType };
        await rideRef.update(rideUpdates);
        res.json({ ...ride, ...rideUpdates });
    } catch (e) { res.status(500).send(e.message); }
});

// 5. Update Payment
router.post('/update-payment', async (req, res) => {
    try {
        const { rideId, paymentStatus, paymentMethod } = req.body;
        await MongoRide.findOneAndUpdate({ id: rideId }, { paymentStatus, paymentMethod }, { new: true });
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

// 6. Get History (Aggressive ID Matching)
router.get('/history/:userId', async (req, res) => {
    try {
        const regex = getIdentityFilter(req.params.userId);
        if (!regex) return res.json([]);

        console.log(`📜 History Search: ending in ${regex.source}`);

        const rides = await MongoRide.find({
            $or: [ { passengerId: regex }, { driverId: regex } ]
        }).sort({ timestamp: -1 }).limit(40);

        res.json(rides);
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
