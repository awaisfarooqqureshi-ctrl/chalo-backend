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

// 2. Update Status: Archive to MongoDB + Accounting + Cancellation Hits
router.post('/update-status', async (req, res) => {
    try {
        const { rideId, status, cancelledBy } = req.body; // cancelledBy: 'passenger' or 'driver'
        console.log(`🔄 Status Update Attempt: Ride=${rideId}, NewStatus=${status}, By=${cancelledBy}`);

        const db = admin.database();
        const rideRef = db.ref(`active_rides/${rideId}`);

        // Fetch current ride data BEFORE update/deletion
        const rideSnap = await rideRef.get();
        if (!rideSnap.exists()) return res.status(404).send("Ride not found");
        const finalRideData = rideSnap.val();

        await rideRef.update({ status });

        if (['COMPLETED', 'RIDE_COMPLETED'].includes(status)) {
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

                        // 1. Update Earnings
                        let monthlyEarnings = (driver.lastEarningsResetMonth === currentMonth) ? (driver.monthlyEarnings || 0) + fare : fare;

                        // 2. Today's Earnings Logic (Reset if day changed)
                        const startOfDay = new Date().setHours(0,0,0,0);
                        let todayEarnings = (driver.lastEarningsResetDay >= startOfDay) ? (driver.todayEarnings || 0) + fare : fare;

                        // 3. Increment Ride Counters
                        const totalRides = (driver.driverTotalRides || 0) + 1;
                        const completedRides = (driver.driverCompletedRides || 0) + 1;

                        await driverRef.update({
                            todayEarnings,
                            monthlyEarnings,
                            lifetimeEarnings: (driver.lifetimeEarnings || 0) + fare,
                            lastEarningsResetMonth: currentMonth,
                            lastEarningsResetDay: Date.now(),
                            driverTotalRides: totalRides,
                            driverCompletedRides: completedRides,
                            isOnline: true,
                            driverStatus: 'AVAILABLE'
                        });
                        console.log(`✅ Counters updated for ${driverId}: Rides=${completedRides}, Today=Rs.${todayEarnings}`);

                        // 3. BONUS LOGIC: Update progress for matching active schemes
                        const schemesSnap = await db.ref('bonus_schemes').get();
                        if (schemesSnap.exists()) {
                            const schemes = schemesSnap.val();
                            const rideVehicleType = (finalRideData.vehicleType || "Car").toLowerCase();
                            const isBikeOrRiksha = rideVehicleType.includes("bike") || rideVehicleType.includes("riksha") || rideVehicleType.includes("rickshaw");
                            const currentRideGroup = isBikeOrRiksha ? "BIKE_RIKSHAW" : "CAR";

                            for (const sId in schemes) {
                                const scheme = schemes[sId];
                                const schemeGroup = scheme.vehicleGroup || "ALL";

                                if (scheme.isActive && (schemeGroup === "ALL" || schemeGroup === currentRideGroup)) {
                                    const progressRef = db.ref(`driver_bonus_progress/${driverId}/${sId}`);
                                    const progSnap = await progressRef.get();
                                    let currentProgress = progSnap.exists() ? (progSnap.val().currentProgress || 0) : 0;
                                    let completionCount = progSnap.exists() ? (progSnap.val().completionCount || 0) : 0;

                                    let newProgress = currentProgress + 1;

                                    if (newProgress >= scheme.target) {
                                        const reward = Number(scheme.reward);
                                        const finalWallet = Math.round(((driver.walletBalance || 0) + reward) * 100) / 100;
                                        await driverRef.update({ walletBalance: finalWallet });

                                        await new Transaction({
                                            userId: driverId,
                                            title: `Bonus: ${scheme.title}`,
                                            amount: reward,
                                            type: "CREDIT",
                                            category: "BONUS",
                                            status: "COMPLETED",
                                            timestamp: Date.now()
                                        }).save();

                                        newProgress = 0;
                                        completionCount += 1;
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

                        // 4. Log Income Transaction to MongoDB
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
                } catch (accErr) { console.error("❌ Accounting/Bonus Error:", accErr.message); }
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

        } else if (['CANCELLED', 'RIDE_CANCELLED'].includes(status)) {
            // --- UPDATED: CANCELLATION HITS LOGIC (Audit Ready) ---
            const passengerId = finalRideData.passengerId;
            const driverId = finalRideData.driverId;

            if (cancelledBy === 'passenger' && passengerId) {
                const pRef = db.ref(`users/${passengerId}`);
                const pSnap = await pRef.get();
                if (pSnap.exists()) {
                    const p = pSnap.val();
                    const now = Date.now();
                    let count = (p.passengerCancellationCount || 0);
                    // Reset count if last cancel was > 1 hour ago
                    if (now - (p.lastCancellationTimestamp || 0) > 3600000) count = 0;

                    await pRef.update({
                        passengerCancellationCount: count + 1,
                        lastCancellationTimestamp: now
                    });
                    console.log(`📉 Passenger Cancellation Hit recorded for ${passengerId}`);
                }
            } else if (cancelledBy === 'driver' && driverId) {
                const dRef = db.ref(`users/${driverId}`);
                const dSnap = await dRef.get();
                if (dSnap.exists()) {
                    const d = dSnap.val();
                    const hits = (Number(d.cancellationHits) || 0) + 1;
                    await dRef.update({
                        cancellationHits: hits,
                        isOnline: true,
                        driverStatus: 'AVAILABLE'
                    });
                    console.log(`📉 Driver Cancellation Hit recorded for ${driverId}. Total Hits: ${hits}`);
                }
            }

            try {
                await new MongoRide({
                    ...finalRideData,
                    id: rideId,
                    status: 'CANCELLED',
                    offers: Object.values(finalRideData.offers || {})
                }).save();
                await rideRef.remove();
            } catch (e) { console.error("❌ Cancel Archive Error:", e.message); }
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

        const commissionAmount = Math.round((acceptedOffer.bidFare * commissionRate) / 100 * 100) / 100;

        // 1. Deduct from RTDB
        const currentBalance = (driver.walletBalance || 0);
        const newBalance = Math.round((currentBalance - commissionAmount) * 100) / 100;
        await driverRef.update({ walletBalance: newBalance, driverStatus: 'ON_CITY_RIDE' });

        // 2. Save Commission to MongoDB
        try {
            await new Transaction({
                userId: driverId,
                title: "Ride Commission",
                amount: commissionAmount,
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

// 6. Get History (Aggressive ID Matching + Direct Fallback)
router.get('/history/:userId', async (req, res) => {
    try {
        const rawId = req.params.userId;
        const regex = getIdentityFilter(rawId);

        console.log(`📜 History Fetch Request for: ${rawId}`);

        // Search using Regex (ends with last 10 digits) OR direct match
        const query = {
            $or: [
                { passengerId: rawId },
                { driverId: rawId },
                { passengerId: regex },
                { driverId: regex }
            ]
        };

        const rides = await MongoRide.find(query).sort({ timestamp: -1 }).limit(50);

        console.log(`✅ MongoDB Response: Found ${rides.length} rides for query.`);
        res.json(rides);
    } catch (e) {
        console.error("❌ History Route Error:", e.message);
        res.status(500).send(e.message);
    }
});

module.exports = router;
