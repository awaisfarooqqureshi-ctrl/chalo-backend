const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const MongoRide = require('../models/Ride');
const Transaction = require('../models/Transaction');

// Helper: Same search IDs for all routes to ensure robust lookup
function getSearchIds(userId) {
    if (!userId) return [];
    const rawId = userId.toString().trim();
    const cleanId = rawId.replace(/\+/g, '').replace(/^0/, '').replace(/^92/, '').trim();
    return [
        rawId,
        cleanId,
        `0${cleanId}`,
        `92${cleanId}`,
        `+92${cleanId}`,
        `+${cleanId}`
    ];
}

// 1. Request Ride (Active in RTDB)
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
    } catch (e) {
        console.error("❌ Request Ride Error:", e.message);
        res.status(500).send(e.message);
    }
});

// 2. Update Status: Archive to MongoDB + Accounting
router.post('/update-status', async (req, res) => {
    try {
        const { rideId, status } = req.body;
        console.log(`🔄 Status Update Attempt: Ride=${rideId}, NewStatus=${status}`);

        const db = admin.database();
        const rideRef = db.ref(`active_rides/${rideId}`);
        await rideRef.update({ status });

        if (['COMPLETED', 'RIDE_COMPLETED'].includes(status)) {
            const snapshot = await rideRef.get();
            if (snapshot.exists()) {
                const finalRideData = snapshot.val();
                const driverId = finalRideData.driverId;
                const fare = finalRideData.offeredFare || 0;

                // A. ACCOUNTING: Record Ride Income for Driver
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

                            // Save Transaction to MongoDB
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
                            console.log(`💰 Ride income recorded in MongoDB for ${driverId}`);
                        }
                    } catch (accErr) { console.error("❌ Earnings/Transaction Error:", accErr.message); }
                }

                // B. ARCHIVE: Save Ride to MongoDB
                try {
                    const mongoData = {
                        ...finalRideData,
                        id: rideId,
                        status: 'COMPLETED',
                        paymentStatus: 'PAID',
                        offers: Object.values(finalRideData.offers || {})
                    };

                    // Critical mapping for required fields
                    if (mongoData.pickupLng && !mongoData.pickupLon) mongoData.pickupLon = mongoData.pickupLng;
                    if (mongoData.destinationLng && !mongoData.destinationLon) mongoData.destinationLon = mongoData.destinationLng;

                    const savedRide = new MongoRide(mongoData);
                    await savedRide.save();
                    console.log(`✅ Ride ${rideId} archived to MongoDB`);

                    // Cleanup RTDB
                    await rideRef.remove();
                } catch (mongoErr) {
                    console.error("❌ MongoDB Ride Archive CRITICAL Error:", mongoErr.message);
                    if (mongoErr.errors) console.error("Validation Details:", JSON.stringify(mongoErr.errors));
                }
            }
        } else if (['CANCELLED', 'RIDE_CANCELLED'].includes(status)) {
            const snapshot = await rideRef.get();
            if (snapshot.exists()) {
                const data = snapshot.val();
                try {
                    await new MongoRide({
                        ...data,
                        id: rideId,
                        status: 'CANCELLED',
                        offers: Object.values(data.offers || {})
                    }).save();
                    console.log(`📦 Cancelled ride ${rideId} archived to MongoDB`);
                    await rideRef.remove();
                } catch (e) { console.error("❌ Cancel Archive Error:", e.message); }
            }
        }
        const io = req.app.get('socketio');
        if (io) io.emit(`ride_status_updated_${rideId}`, { status });
        res.json({ success: true });
    } catch (e) {
        console.error("❌ Status Update Route Error:", e.message);
        res.status(500).send(e.message);
    }
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

// 4. Accept Bid: Critical Commission Deduction Point
router.post('/accept-bid', async (req, res) => {
    try {
        const { rideId, offerId, driverId } = req.body;
        console.log(`🤝 Processing Bid Acceptance: Ride=${rideId}, Driver=${driverId}`);

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

        // 1. Deduct from RTDB Wallet
        await driverRef.update({
            walletBalance: (driver.walletBalance || 0) - commissionAmount,
            driverStatus: 'ON_CITY_RIDE'
        });

        // 2. Save Commission Debit to MongoDB (MANDATORY LOG)
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
            console.log(`📉 Commission of Rs.${commissionAmount} debited and logged in MongoDB.`);
        } catch (tErr) {
            console.error("❌ MongoDB Commission Log Failed:", tErr.message);
        }

        const rideUpdates = {
            status: 'ACCEPTED',
            driverId: driverId,
            driverName: driver.name,
            offeredFare: acceptedOffer.bidFare,
            commissionAmount: commissionAmount,
            vehicleType: driver.vehicleInfo?.type || ride.vehicleType
        };
        await rideRef.update(rideUpdates);
        res.json({ ...ride, ...rideUpdates });
    } catch (e) {
        console.error("❌ Accept Bid Error:", e.message);
        res.status(500).send(e.message);
    }
});

// 5. Update Payment
router.post('/update-payment', async (req, res) => {
    try {
        const { rideId, paymentStatus, paymentMethod } = req.body;
        await MongoRide.findOneAndUpdate({ id: rideId }, { paymentStatus, paymentMethod }, { new: true });
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

// 6. Get History (Robust Multi-ID Lookup)
router.get('/history/:userId', async (req, res) => {
    try {
        const searchIds = getSearchIds(req.params.userId);
        console.log(`📜 Fetching history for variant IDs:`, searchIds);

        const rides = await MongoRide.find({
            $or: [
                { passengerId: { $in: searchIds } },
                { driverId: { $in: searchIds } }
            ]
        }).sort({ timestamp: -1 }).limit(40);

        console.log(`✅ Found ${rides.length} rides in history for ${req.params.userId}`);
        res.json(rides);
    } catch (e) {
        console.error("❌ History Fetch Route Error:", e.message);
        res.status(500).send(e.message);
    }
});

module.exports = router;
