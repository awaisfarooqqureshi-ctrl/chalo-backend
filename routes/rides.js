const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const MongoRide = require('../models/Ride'); // Scale Optimization: Cold Storage Model

// 1. Request Ride: Pure RTDB
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
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 2. Update Status: Archive to 'history' node in RTDB
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
                    const driverRef = db.ref(`users/${driverId}`);
                    const driverSnap = await driverRef.get();
                    if (driverSnap.exists()) {
                        const driver = driverSnap.val();
                        const now = new Date();
                        const currentMonth = now.getMonth(); // 0-11

                        let monthlyEarnings = driver.monthlyEarnings || 0;
                        let lifetimeEarnings = driver.lifetimeEarnings || 0;

                        // Auto-reset monthly earnings if month changed
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

                        // --- UPDATE BONUS PROGRESS ---
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

                                    // Check if completed
                                    if (newProgress >= scheme.target) {
                                        console.log(`🎊 Bonus Completed: ${scheme.title} for Driver ${driverId}`);
                                        completionCount += 1;

                                        // 1. Give Reward
                                        const currentBalance = (driver.walletBalance || 0) + scheme.reward;
                                        await driverRef.update({ walletBalance: currentBalance });

                                        // 2. Add Transaction
                                        const tid = driverRef.child('transactions').push().key;
                                        await driverRef.child(`transactions/${tid}`).set({
                                            id: tid,
                                            title: `Bonus: ${scheme.title} (x${completionCount})`,
                                            amount: scheme.reward,
                                            type: "CREDIT",
                                            status: "COMPLETED",
                                            timestamp: Date.now()
                                        });

                                        // 3. Reset Progress (as requested: "aik dafa bouns complete hony k bad phir sy start ho jana chaye")
                                        newProgress = 0;

                                        // 4. Permanent History Log
                                        const historyId = db.ref(`bonus_history/${driverId}`).push().key;
                                        await db.ref(`bonus_history/${driverId}/${historyId}`).set({
                                            id: historyId,
                                            schemeId: sId,
                                            title: scheme.title,
                                            reward: scheme.reward,
                                            timestamp: Date.now(),
                                            cycle: completionCount
                                        });
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

                // --- SCALE OPTIMIZATION: Archive to MongoDB (Cold Storage) ---
                try {
                    console.log(`📦 Attempting to archive ride ${rideId} to MongoDB...`);

                    // Manual mapping to ensure compatibility and avoid middleware errors
                    const mongoData = {
                        ...finalRideData,
                        id: rideId,
                        offers: Object.values(finalRideData.offers || {})
                    };

                    // Fallback for field names
                    if (mongoData.pickupLng && !mongoData.pickupLon) mongoData.pickupLon = mongoData.pickupLng;
                    if (mongoData.destinationLng && !mongoData.destinationLon) mongoData.destinationLon = mongoData.destinationLng;
                    if (mongoData.fare && !mongoData.offeredFare) mongoData.offeredFare = mongoData.fare;
                    if (mongoData.offeredFare && !mongoData.fare) mongoData.fare = mongoData.offeredFare;

                    const mongoRide = new MongoRide(mongoData);
                    await mongoRide.save();
                    console.log(`✅ Ride ${rideId} archived successfully to MongoDB Atlas.`);
                } catch (mongoErr) {
                    console.error("❌ MongoDB Archive CRITICAL Error:", mongoErr.message);
                }

                // --- SCALE OPTIMIZATION: REMOVED RTDB HISTORY WRITE ---
                // We no longer write to db.ref(`history/${rideId}`) or user_history

                // Just Remove from Active (RTDB)
                await rideRef.remove();
            }
        } else if (['CANCELLED', 'RIDE_CANCELLED'].includes(status)) {
            const snapshot = await rideRef.get();
            if (snapshot.exists()) {
                const finalRideData = snapshot.val();

                // Archive cancelled ride to MongoDB only
                try {
                    const mongoData = {
                        ...finalRideData,
                        id: rideId,
                        offers: Object.values(finalRideData.offers || {})
                    };
                    await new MongoRide(mongoData).save();
                    console.log(`📦 Cancelled ride ${rideId} archived to MongoDB`);
                } catch (e) {
                    console.error("❌ MongoDB Cancel Archive Failed:", e.message);
                }

                // Remove from Active (RTDB)
                await rideRef.remove();
            }
        }

        const io = req.app.get('socketio');
        if (io) io.emit(`ride_status_updated_${rideId}`, { status });

        res.json({ success: true });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 3. Bid: Update RTDB with full offer object
router.post('/bid', async (req, res) => {
    try {
        const { rideId, offer } = req.body;
        const db = admin.database();

        if (!offer || !offer.driverId) {
            return res.status(400).send("Invalid offer data");
        }

        // Use driverId as the key in the offers Map for consistency and to avoid duplicates
        await db.ref(`active_rides/${rideId}/offers/${offer.driverId}`).set(offer);
        await db.ref(`active_rides/${rideId}`).update({ status: 'BIDS_RECEIVED' });

        console.log(`💰 Bid received for ride ${rideId} from driver ${offer.driverId}`);
        res.json({ success: true });
    } catch (e) {
        console.error("Bid Error:", e.message);
        res.status(500).send(e.message);
    }
});

// 4. Accept Bid: Match Driver and Passenger
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

        // Convert Map to Array for logic handling if needed
        const offersMap = ride.offers || {};
        const offers = Object.values(offersMap);

        // 1. Calculate Commission
        const configSnap = await db.ref('admin_config/settings').get();
        const commissionRate = configSnap.val()?.commission_rate || 10;
        const acceptedOffer = offers.find(o => o.id === offerId || o.driverId === driverId);
        if (!acceptedOffer) return res.status(404).send("Offer not found");

        const commissionAmount = (acceptedOffer.bidFare * commissionRate) / 100;

        // 2. Update Offers status in the Map
        const updatedOffers = { ...offersMap };
        Object.keys(updatedOffers).forEach(id => {
            if (id === driverId) updatedOffers[id] = { ...updatedOffers[id], status: 'ACCEPTED' };
            else updatedOffers[id] = { ...updatedOffers[id], status: 'REJECTED' };
        });

        // 3. Update Driver Record (Wallet + Status)
        await driverRef.update({
            walletBalance: (driver.walletBalance || 0) - commissionAmount,
            isOnline: ride.serviceType === 'CARPOOL', // Stay online if carpooling
            driverStatus: ride.serviceType === 'CARPOOL' ? 'ON_CARPOOL_PICKUP' : 'ON_CITY_RIDE'
        });

        // 4. Update Ride Record
        const rideUpdates = {
            status: 'ACCEPTED',
            driverId: driverId,
            driverName: driver.name,
            driverPhoto: driver.profilePhoto,
            driverPhone: driver.phoneNumber,
            offeredFare: acceptedOffer.bidFare,
            offers: updatedOffers,
            commissionAmount: commissionAmount,
            vehicleType: driver.vehicleInfo?.type || ride.vehicleType, // SYNC: Update root vehicleType to driver's actual type
            vehicleInfo: {
                type: driver.vehicleInfo?.type || ride.vehicleType,
                model: driver.vehicleInfo?.model || acceptedOffer.vehicleModel,
                numberPlate: driver.vehicleInfo?.numberPlate || acceptedOffer.vehiclePlate
            }
        };

        await rideRef.update(rideUpdates);

        console.log(`🤝 Ride ${rideId} accepted by Passenger for Driver ${driver.name}`);
        res.json({ ...ride, ...rideUpdates });

    } catch (e) {
        console.error("Accept Bid Error:", e.message);
        res.status(500).send(e.message);
    }
});

// 5. Get History from MongoDB (Scalable History)
router.get('/history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const rides = await MongoRide.find({
            $or: [{ passengerId: userId }, { driverId: userId }]
        }).sort({ timestamp: -1 }).limit(20);

        res.json(rides);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

module.exports = router;
