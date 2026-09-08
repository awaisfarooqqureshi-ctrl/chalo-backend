const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

// Helper: Standardized Clean ID for Firestore Lookups
function getCleanId(userId) {
    if (!userId) return "";
    return userId.toString().replace(/\+/g, '').trim();
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

// 2. Update Status: Archive to Cloud Firestore + Accounting + Cancellation Hits
router.post('/update-status', async (req, res) => {
    try {
        const { rideId, status, cancelledBy } = req.body;
        const db = admin.database();
        const fs = admin.firestore();
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

                        // SAVE TRANSACTION TO FIRESTORE
                        await fs.collection('transactions').add({
                            userId: getCleanId(driverId),
                            title: "Ride Income",
                            amount: fare,
                            type: "CREDIT",
                            category: "RIDE_INCOME",
                            reference: rideId,
                            timestamp: Date.now()
                        });

                        // BONUS LOGIC: Update progress for matching active schemes
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

                                        await fs.collection('transactions').add({
                                            userId: getCleanId(driverId),
                                            title: `Bonus: ${scheme.title}`,
                                            amount: reward,
                                            type: "CREDIT",
                                            category: "BONUS",
                                            timestamp: Date.now()
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
                } catch (accErr) { console.error("❌ Firestore Accounting Error:", accErr.message); }
            }

            // ARCHIVE RIDE TO FIRESTORE
            try {
                await fs.collection('rides').doc(rideId).set({
                    ...finalRideData,
                    status: 'COMPLETED',
                    paymentStatus: 'PAID',
                    archivedAt: Date.now()
                });
                await rideRef.remove();
            } catch (fsErr) { console.error("❌ Firestore Archive Error:", fsErr.message); }

        } else if (['CANCELLED', 'RIDE_CANCELLED'].includes(status)) {
            const passengerId = finalRideData.passengerId;
            const driverId = finalRideData.driverId;

            if (cancelledBy === 'passenger' && passengerId) {
                const pRef = db.ref(`users/${passengerId}`);
                const pSnap = await pRef.get();
                if (pSnap.exists()) {
                    const p = pSnap.val();
                    const now = Date.now();
                    let count = (p.passengerCancellationCount || 0);
                    if (now - (p.lastCancellationTimestamp || 0) > 3600000) count = 0;

                    const newCount = count + 1;
                    const updates = { passengerCancellationCount: newCount, lastCancellationTimestamp: now };

                    if (newCount >= 5) {
                        updates.tempBlockExpiry = now + 1800000;
                        console.log(`🚫 Passenger ${passengerId} auto-blocked for 30 mins.`);
                    }
                    await pRef.update(updates);
                }
            } else if (cancelledBy === 'driver' && driverId) {
                const dRef = db.ref(`users/${driverId}`);
                const dSnap = await dRef.get();
                if (dSnap.exists()) {
                    const hits = (Number(dSnap.val().cancellationHits) || 0) + 1;
                    await dRef.update({ cancellationHits: hits, isOnline: true, driverStatus: 'AVAILABLE' });
                }
            }

            try {
                await fs.collection('rides').doc(rideId).set({
                    ...finalRideData,
                    status: 'CANCELLED',
                    archivedAt: Date.now()
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
        const fs = admin.firestore();
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

        await fs.collection('transactions').add({
            userId: getCleanId(driverId),
            title: "Ride Commission",
            amount: commissionAmount,
            type: "DEBIT",
            category: "COMMISSION",
            reference: rideId,
            timestamp: Date.now()
        });

        const updates = { status: 'ACCEPTED', driverId: driverId, driverName: driver.name, offeredFare: acceptedOffer.bidFare, commissionAmount, vehicleType: driver.vehicleInfo?.type || ride.vehicleType };
        await rideRef.update(updates);
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

// 6. Get History (Firestore Fetch)
router.get('/history/:userId', async (req, res) => {
    try {
        const cleanId = getCleanId(req.params.userId);
        const fs = admin.firestore();

        const [pSnap, dSnap] = await Promise.all([
            fs.collection('rides').where('passengerId', '==', cleanId).orderBy('archivedAt', 'desc').limit(20).get(),
            fs.collection('rides').where('driverId', '==', cleanId).orderBy('archivedAt', 'desc').limit(20).get()
        ]);

        const history = [];
        pSnap.forEach(doc => history.push({ id: doc.id, ...doc.data() }));
        dSnap.forEach(doc => history.push({ id: doc.id, ...doc.data() }));
        history.sort((a, b) => b.archivedAt - a.archivedAt);

        res.json(history);
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
