const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const DB = require('../services/db');

// Helper: Standardized Clean ID
function getCleanId(userId) {
    if (!userId) return "";
    return userId.toString().replace(/\+/g, '').trim();
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

// 2. Update Status: Archive to Firestore + Accounting
router.post('/update-status', async (req, res) => {
    try {
        const { rideId, status, cancelledBy } = req.body;
        const db = admin.database();
        const rideRef = db.ref(`active_rides/${rideId}`);

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

                        let monthlyEarnings = (driver.lastEarningsResetMonth === currentMonth) ? (driver.monthlyEarnings || 0) + fare : fare;
                        const startOfDay = new Date().setHours(0,0,0,0);
                        let todayEarnings = (driver.lastEarningsResetDay >= startOfDay) ? (driver.todayEarnings || 0) + fare : fare;

                        await driverRef.update({
                            todayEarnings,
                            monthlyEarnings,
                            lifetimeEarnings: (driver.lifetimeEarnings || 0) + fare,
                            lastEarningsResetMonth: currentMonth,
                            lastEarningsResetDay: Date.now(),
                            driverTotalRides: (driver.driverTotalRides || 0) + 1,
                            driverCompletedRides: (driver.driverCompletedRides || 0) + 1,
                            isOnline: true,
                            driverStatus: 'AVAILABLE'
                        });

                        // Log Income via DB Service
                        await DB.addTransaction({
                            userId: getCleanId(driverId),
                            title: "Ride Income",
                            amount: fare,
                            type: "CREDIT",
                            category: "RIDE_INCOME",
                            reference: rideId
                        });

                        // BONUS LOGIC
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

                                        await DB.addTransaction({
                                            userId: getCleanId(driverId),
                                            title: `Bonus: ${scheme.title}`,
                                            amount: reward,
                                            type: "CREDIT",
                                            category: "BONUS"
                                        });

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
                    }
                } catch (accErr) { console.error("❌ Accounting Error:", accErr.message); }
            }

            // Archive to Firestore via Service
            try {
                await DB.saveRide(rideId, {
                    ...finalRideData,
                    status: 'COMPLETED',
                    paymentStatus: 'PAID'
                });
                await rideRef.remove();
            } catch (fsErr) { console.error("❌ Archive Error:", fsErr.message); }

        } else if (['CANCELLED', 'RIDE_CANCELLED'].includes(status)) {
            // Archive Cancelled via Service
            try {
                await DB.saveRide(rideId, {
                    ...finalRideData,
                    status: 'CANCELLED'
                });
                await rideRef.remove();
            } catch (e) {}
        }
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

// 4. Accept Bid
router.post('/accept-bid', async (req, res) => {
    try {
        const { rideId, offerId, driverId } = req.body;
        const db = admin.database();
        const rideRef = db.ref(`active_rides/${rideId}`);
        const driverRef = db.ref(`users/${driverId}`);

        const [rideSnap, driverSnap, configSnap] = await Promise.all([rideRef.get(), driverRef.get(), db.ref('admin_config/settings').get()]);
        if (!rideSnap.exists() || !driverSnap.exists()) return res.status(404).send("Not found");

        const ride = rideSnap.val();
        const driver = driverSnap.val();
        const commissionRate = configSnap.val()?.commission_rate || 10;
        const acceptedOffer = Object.values(ride.offers || {}).find(o => o.id === offerId || o.driverId === driverId);
        if (!acceptedOffer) return res.status(404).send("Offer not found");

        const commissionAmount = Math.round((acceptedOffer.bidFare * commissionRate) / 100 * 100) / 100;
        const newBalance = Math.round(((driver.walletBalance || 0) - commissionAmount) * 100) / 100;

        await driverRef.update({ walletBalance: newBalance, driverStatus: 'ON_CITY_RIDE' });

        await DB.addTransaction({
            userId: getCleanId(driverId),
            title: "Ride Commission",
            amount: commissionAmount,
            type: "DEBIT",
            category: "COMMISSION",
            reference: rideId
        });

        const updates = { status: 'ACCEPTED', driverId: driverId, driverName: driver.name, offeredFare: acceptedOffer.bidFare, commissionAmount, vehicleType: driver.vehicleInfo?.type || ride.vehicleType };
        await rideRef.update(updates);
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

// 6. Get History (ULTRA ROBUST + DEDUPLICATION)
router.get('/history/:userId', async (req, res) => {
    try {
        const userId = getCleanId(req.params.userId);
        const rawHistory = await DB.getRideHistory(userId);

        // DEDUPLICATION: Use a Map to ensure each ride ID only appears once
        const uniqueRides = new Map();

        rawHistory.forEach(ride => {
            if (!uniqueRides.has(ride.id)) {
                const cleanRide = { ...ride };

                // Normalization Logic
                if (cleanRide.offers && typeof cleanRide.offers === 'object' && !Array.isArray(cleanRide.offers)) {
                    cleanRide.offers = Object.values(cleanRide.offers);
                } else if (!cleanRide.offers) {
                    cleanRide.offers = [];
                }

                uniqueRides.set(ride.id, cleanRide);
            }
        });

        // Convert Map back to array and sort by time
        const cleanHistory = Array.from(uniqueRides.values());
        res.json(cleanHistory);

    } catch (e) {
        console.error("🔥 History Deduplication Error:", e.message);
        res.json([]);
    }
});

module.exports = router;
