const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const DB = require('../services/db');

// Helper: Standardized Clean ID
function getCleanId(userId) {
    if (!userId) return "";
    return userId.toString().replace(/\D/g, '').trim();
}

function distanceKm(lat1, lon1, lat2, lon2) {
    const earthRadiusKm = 6371;
    const toRadians = value => value * Math.PI / 180;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sharedRoutesMatch(first, second) {
    return distanceKm(first.pickupLat, first.pickupLon, second.pickupLat, second.pickupLon) <= 5 &&
        distanceKm(first.destinationLat, first.destinationLon, second.destinationLat, second.destinationLon) <= 5;
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
        const authenticatedUserId = getCleanId(req.user?.userId);
        const allowedStatuses = new Set([
            'FINDING_DRIVER', 'BIDS_RECEIVED', 'ACCEPTED',
            'DRIVER_EN_ROUTE_TO_PASSENGER', 'DRIVER_ARRIVED',
            'PASSENGER_PICKED_UP', 'TRIP_ACTIVE', 'RIDE_STARTED',
            'ON_TRIP', 'ARRIVED', 'COMPLETED', 'RIDE_COMPLETED',
            'CANCELLED', 'RIDE_CANCELLED'
        ]);
        if (!rideId || !allowedStatuses.has(status)) {
            return res.status(400).json({ success: false, message: 'Invalid ride status update' });
        }
        if (!authenticatedUserId) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const db = admin.database();
        const rideRef = db.ref(`active_rides/${rideId}`);

        const rideSnap = await rideRef.get();
        if (!rideSnap.exists()) return res.status(404).send("Ride not found");
        const finalRideData = rideSnap.val();
        const passengerId = getCleanId(finalRideData.passengerId || finalRideData.userId);
        const driverId = getCleanId(finalRideData.driverId);
        if (authenticatedUserId !== passengerId && authenticatedUserId !== driverId) {
            return res.status(403).json({ success: false, message: 'Forbidden: You are not part of this ride' });
        }
        if (cancelledBy && getCleanId(cancelledBy) !== authenticatedUserId &&
            !['driver', 'passenger'].includes(String(cancelledBy).toLowerCase())) {
            return res.status(400).json({ success: false, message: 'Invalid cancellation actor' });
        }
        if (['COMPLETED', 'RIDE_COMPLETED', 'CANCELLED', 'RIDE_CANCELLED'].includes(finalRideData.status)) {
            return res.status(409).json({ success: false, message: 'Ride is already in a terminal state' });
        }

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

                        // --- SECURITY FIX: DO NOT UPDATE WALLET BALANCE WITH RIDE FARE ---
                        // Only update metadata and status. Balance changes ONLY on Top-up or Commission.
                        await driverRef.update({
                            driverTotalRides: (driver.driverTotalRides || 0) + 1,
                            driverCompletedRides: (driver.driverCompletedRides || 0) + 1,
                            isOnline: true,
                            driverStatus: 'AVAILABLE'
                        });

                        // Log Income for the Statement (Stored in Firestore Transactions)
                        await DB.addTransaction({
                            userId: getCleanId(driverId),
                            title: "Ride Income (Cash)",
                            amount: fare,
                            type: "CREDIT",
                            category: "RIDE_INCOME",
                            reference: rideId,
                            status: "COMPLETED"
                        });

                        // 3. BONUS LOGIC: Smart Vehicle Grouping
                        const schemesSnap = await db.ref('bonus_schemes').get();
                        if (schemesSnap.exists()) {
                            const schemes = schemesSnap.val();

                            // DETERMINING THE VEHICLE GROUP
                            const vType = (finalRideData.vehicleType || "Car").toLowerCase();
                            let currentRideGroup = "CAR"; // Default for Comfort, Mini, etc.

                            if (vType.includes("bike") || vType.includes("riksha") || vType.includes("rickshaw")) {
                                currentRideGroup = "BIKE_RIKSHAW";
                            } else if (["mini", "comfort", "premium", "van", "car"].some(word => vType.includes(word))) {
                                currentRideGroup = "CAR";
                            }

                            for (const sId in schemes) {
                                const scheme = schemes[sId];
                                const schemeGroup = scheme.vehicleGroup || "ALL";

                                // Only process if Group matches OR scheme is for ALL
                                if (scheme.isActive && (schemeGroup === "ALL" || schemeGroup === currentRideGroup)) {
                                    const progressRef = db.ref(`driver_bonus_progress/${driverId}/${sId}`);
                                    const progSnap = await progressRef.get();
                                    let currentProgress = progSnap.exists() ? (progSnap.val().currentProgress || 0) : 0;
                                    let completionCount = progSnap.exists() ? (progSnap.val().completionCount || 0) : 0;

                                    let newProgress = currentProgress + 1;

                                    if (newProgress >= scheme.target) {
                                        const reward = Number(scheme.reward);
                                        const finalWallet = Math.round(((driver.walletBalance || 0) + reward) * 100) / 100;

                                        // CRITICAL: Bonus DOES go into Wallet Balance
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

// 3. Bid (Updated with Commission Check)
router.post('/bid', async (req, res) => {
    try {
        const { rideId, offer } = req.body;
        const authenticatedUserId = getCleanId(req.user?.userId);
        if (!rideId || !offer || !authenticatedUserId) {
            return res.status(400).json({ success: false, message: 'Invalid bid request' });
        }

        const driverId = authenticatedUserId;
        const securedOffer = { ...offer, driverId };
        const db = admin.database();

        // --- PRE-BID WALLET CHECK ---
        const driverRef = db.ref(`users/${driverId}`);
        const driverSnap = await driverRef.get();
        if (!driverSnap.exists()) return res.status(404).send("Driver not found");

        const driver = driverSnap.val();
        if (String(driver.role || '').toLowerCase() !== 'driver' &&
            driver.driverRegistered !== true) {
            return res.status(403).json({ success: false, message: 'Only registered drivers can place bids' });
        }
        const configSnap = await db.ref('admin_config/settings').get();
        const commissionRate = configSnap.val()?.commission_rate || 10;

        const bidFare = Number(securedOffer.bidFare);
        if (!Number.isFinite(bidFare) || bidFare <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid bid fare' });
        }
        const estimatedCommission = (bidFare * commissionRate) / 100;

        // Strict Rule: No balance, No bid
        if ((driver.walletBalance || 0) < estimatedCommission) {
            return res.status(400).json({
                success: false,
                message: "Insufficient balance. Please recharge your wallet to bid on this ride."
            });
        }

        await db.ref(`active_rides/${rideId}/offers/${driverId}`).set(securedOffer);
        await db.ref(`active_rides/${rideId}`).update({ status: 'BIDS_RECEIVED' });
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

// 4. Accept Bid (Updated: Advanced Commission Deduction)
router.post('/accept-bid', async (req, res) => {
    try {
        const { rideId, offerId, driverId } = req.body;
        const db = admin.database();
        const rideRef = db.ref(`active_rides/${rideId}`);
        const driverRef = db.ref(`users/${driverId}`);

        const [rideSnap, driverSnap, configSnap] = await Promise.all([
            rideRef.get(),
            driverRef.get(),
            db.ref('admin_config/settings').get()
        ]);

        if (!rideSnap.exists() || !driverSnap.exists()) return res.status(404).send("Not found");

        const ride = rideSnap.val();
        const driver = driverSnap.val();
        const commissionRate = configSnap.val()?.commission_rate || 10;
        const authenticatedUserId = getCleanId(req.user?.userId);
        const rideOwnerId = getCleanId(ride.passengerId || ride.userId);

        if (!authenticatedUserId || !rideOwnerId || authenticatedUserId !== rideOwnerId) {
            return res.status(403).json({ success: false, message: "Forbidden: Only the ride owner can accept a bid" });
        }
        if (['ACCEPTED', 'COMPLETED', 'RIDE_COMPLETED', 'CANCELLED', 'RIDE_CANCELLED'].includes(ride.status)) {
            return res.status(409).json({ success: false, message: "Ride is no longer accepting bids" });
        }

        const acceptedOffer = Object.values(ride.offers || {}).find(o =>
            o.id === offerId &&
            getCleanId(o.driverId) === getCleanId(driverId)
        );
        if (!acceptedOffer) return res.status(404).send("Offer not found");

        const activeRidesSnap = await db.ref('active_rides').get();
        const activeSharedRides = [];
        activeRidesSnap.forEach(child => {
            const activeRide = child.val();
            if (child.key !== rideId && activeRide.driverId === driverId && activeRide.serviceType === 'CARPOOL' &&
                !['COMPLETED', 'RIDE_COMPLETED', 'CANCELLED', 'RIDE_CANCELLED'].includes(activeRide.status)) {
                activeSharedRides.push(activeRide);
            }
        });

        const sharedRide = ride.serviceType === 'CARPOOL';
        const currentSeats = activeSharedRides.reduce((total, item) => total + Number(item.seatsBooked || 1), 0);
        if (sharedRide && activeSharedRides.some(item => !sharedRoutesMatch(item, ride))) {
            return res.status(409).json({ success: false, message: 'Shared ride is outside the driver route.' });
        }
        if (sharedRide && currentSeats + Number(ride.seatsBooked || 1) > 4) {
            return res.status(409).json({ success: false, message: 'No shared seats remaining.' });
        }

        const poolId = sharedRide
            ? (activeSharedRides.find(item => item.poolId)?.poolId || activeSharedRides[0]?.id || rideId)
            : null;

        const commissionAmount = Math.round((acceptedOffer.bidFare * commissionRate) / 100 * 100) / 100;

        // --- ADVANCED DEDUCTION ---
        const currentBalance = (driver.walletBalance || 0);
        const newBalance = Math.round((currentBalance - commissionAmount) * 100) / 100;

        // Re-verify balance
        if (currentBalance < commissionAmount) {
            return res.status(400).json({ success: false, message: "Driver balance insufficient for commission." });
        }

        await driverRef.update({
            walletBalance: newBalance,
            driverStatus: sharedRide ? 'ON_CARPOOL_PICKUP' : 'ON_CITY_RIDE',
            isOnline: sharedRide ? true : false
        });

        // Archive Commission via Service
        await DB.addTransaction({
            userId: getCleanId(driverId),
            title: "Ride Commission (Advance)",
            amount: commissionAmount,
            type: "DEBIT",
            category: "COMMISSION",
            reference: rideId
        });

        const updates = {
            status: 'ACCEPTED',
            driverId: driverId,
            driverName: driver.name,
            offeredFare: acceptedOffer.bidFare,
            commissionAmount,
            vehicleType: driver.vehicleInfo?.type || ride.vehicleType,
            ...(sharedRide ? { poolId } : {})
        };
        await rideRef.update(updates);
        if (sharedRide && activeSharedRides.length > 0) {
            const updatesForPool = {};
            activeRidesSnap.forEach(child => {
                const activeRide = child.val();
                if (activeRide.driverId === driverId && activeRide.serviceType === 'CARPOOL' &&
                    !['COMPLETED', 'RIDE_COMPLETED', 'CANCELLED', 'RIDE_CANCELLED'].includes(activeRide.status)) {
                    updatesForPool[`active_rides/${child.key}/poolId`] = poolId;
                }
            });
            await db.ref().update(updatesForPool);
        }
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
