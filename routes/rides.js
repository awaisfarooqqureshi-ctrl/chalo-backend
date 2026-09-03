const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const MongoRide = require('../models/Ride'); // Scale Optimization: Cold Storage Model
const Transaction = require('../models/Transaction');

// 1. Request Ride (Pure RTDB for real-time performance)
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
    } catch (e) { res.status(500).send(e.message); }
});

// 2. Update Status: Archive to MongoDB and cleanup RTDB
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

                // --- RESTORED: DRIVER EARNINGS LOGIC ---
                if (driverId) {
                    const driverRef = db.ref(`users/${driverId}`);
                    const driverSnap = await driverRef.get();
                    if (driverSnap.exists()) {
                        const driver = driverSnap.val();
                        const now = new Date();
                        const currentMonth = now.getMonth();

                        let monthlyEarnings = driver.monthlyEarnings || 0;
                        let lifetimeEarnings = driver.lifetimeEarnings || 0;

                        if (driver.lastEarningsResetMonth !== currentMonth) {
                            monthlyEarnings = fare;
                        } else {
                            monthlyEarnings += fare;
                        }

                        await driverRef.update({
                            monthlyEarnings: monthlyEarnings,
                            lifetimeEarnings: lifetimeEarnings + fare,
                            lastEarningsResetMonth: currentMonth
                        });
                        console.log(`💰 Earnings Updated for Driver ${driverId}: +Rs.${fare}`);

                        // --- SCALE OPTIMIZATION: SAVE RIDE INCOME TRANSACTION TO MONGODB ---
                        try {
                            await new Transaction({
                                userId: driverId,
                                title: "Ride Income",
                                amount: parseFloat(fare),
                                type: "CREDIT",
                                category: "RIDE_INCOME",
                                status: "COMPLETED",
                                reference: rideId,
                                timestamp: Date.now()
                            }).save();
                            console.log(`✅ Ride income transaction archived to MongoDB for ${driverId}`);
                        } catch (tErr) {
                            console.error("❌ Ride Transaction Archive Failed:", tErr.message);
                        }

                        // --- RESTORED: BONUS PROGRESS LOGIC ---
                        const vehicleType = finalRideData.vehicleType || "Car";
                        const vehicleGroup = ["bike", "rickshaw", "riksha"].includes(vehicleType.toLowerCase()) ? "BIKE_RIKSHAW" : "CAR";

                        const schemesSnap = await db.ref('bonus_schemes').get();
                        if (schemesSnap.exists()) {
                            const schemes = schemesSnap.val();
                            for (const sId in schemes) {
                                const scheme = schemes[sId];
                                if (scheme.isActive && (scheme.vehicleGroup === "ALL" || scheme.vehicleGroup === vehicleGroup)) {
                                    const progressRef = db.ref(`driver_bonus_progress/${driverId}/${sId}`);
                                    const progSnap = await progressRef.get();
                                    let currentProgress = 0;
                                    let completionCount = 0;
                                    if (progSnap.exists()) {
                                        const pVal = progSnap.val();
                                        currentProgress = pVal.currentProgress || 0;
                                        completionCount = pVal.completionCount || 0;
                                    }

                                    let newProgress = currentProgress + 1;

                                    if (newProgress >= scheme.target) {
                                        console.log(`🎊 Bonus Completed: ${scheme.title}`);
                                        completionCount += 1;
                                        const currentBalance = (driver.walletBalance || 0) + scheme.reward;
                                        await driverRef.update({ walletBalance: currentBalance });

                                        // --- SCALE OPTIMIZATION: SAVE TRANSACTION TO MONGODB ---
                                        try {
                                            await new Transaction({
                                                userId: driverId,
                                                title: `Bonus: ${scheme.title}`,
                                                amount: scheme.reward,
                                                type: "CREDIT",
                                                category: "BONUS",
                                                status: "COMPLETED",
                                                timestamp: Date.now()
                                            }).save();
                                            console.log(`✅ Bonus transaction archived to MongoDB for ${driverId}`);
                                        } catch (tErr) {
                                            console.error("❌ Bonus Transaction Archive Failed:", tErr.message);
                                        }

                                        newProgress = 0; // Renew cycle
                                    }

                                    await progressRef.set({
                                        schemeId: sId,
                                        currentProgress: newProgress,
                                        completionCount: completionCount,
                                        lastUpdated: Date.now()
                                    });
                                }
                            }
                        }
                    }
                }

                // --- SCALE OPTIMIZATION: Archive ONLY to MongoDB Atlas ---
                try {
                    console.log(`📦 Archiving ride ${rideId} to MongoDB...`);
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
                    console.log(`✅ Ride ${rideId} archived in MongoDB.`);
                } catch (mongoErr) { console.error("❌ MongoDB Archive Failed:", mongoErr.message); }

                // Strictly delete from RTDB. NO history nodes created here.
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

// 3. Bid
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

// 4. Accept Bid: Match Driver and Passenger + Deduct Commission
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

        // A. DEDUCT COMMISSION FROM WALLET
        await driverRef.update({
            walletBalance: (driver.walletBalance || 0) - commissionAmount,
            driverStatus: ride.serviceType === 'CARPOOL' ? 'ON_CARPOOL_PICKUP' : 'ON_CITY_RIDE'
        });

        // B. RECORD COMMISSION DEBIT IN MONGODB (Accounting Logic)
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
            console.log(`📉 Commission of Rs.${commissionAmount} debited for ride ${rideId}`);
        } catch (tErr) {
            console.error("❌ Commission Record Failed:", tErr.message);
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
    } catch (e) { res.status(500).send(e.message); }
});

// 5. Update Payment in MongoDB ONLY
router.post('/update-payment', async (req, res) => {
    try {
        const { rideId, paymentStatus, paymentMethod } = req.body;
        if (!rideId) return res.status(400).send("Ride ID required");

        // SCALE FIX: STRICTLY NO RTDB WRITES. Update MongoDB ONLY.
        const result = await MongoRide.findOneAndUpdate({ id: rideId }, { paymentStatus, paymentMethod }, { new: true });

        if (result) {
            console.log(`✅ MongoDB Payment updated for ride ${rideId}`);
        } else {
            console.warn(`⚠️ Ride ${rideId} not found in MongoDB for payment update`);
        }

        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

// 6. Get History (Scale-optimized MongoDB fetch)
router.get('/history/:userId', async (req, res) => {
    try {
        const rawId = req.params.userId;
        const cleanId = rawId.replace(/\+/g, '').replace(/^0/, '').trim();
        console.log(`📜 Fetching history for user: Raw=${rawId}, Clean=${cleanId}`);

        const rides = await MongoRide.find({
            $or: [
                { passengerId: new RegExp(cleanId, 'i') },
                { driverId: new RegExp(cleanId, 'i') },
                { passengerId: rawId },
                { driverId: rawId }
            ]
        }).sort({ timestamp: -1 }).limit(30);

        console.log(`✅ Found ${rides.length} rides in MongoDB for ${rawId}`);
        res.json(rides);
    } catch (e) {
        console.error("❌ History Fetch Error:", e.message);
        res.status(500).send(e.message);
    }
});

module.exports = router;
