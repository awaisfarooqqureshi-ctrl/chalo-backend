const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

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
                    }
                }

                // Save to Global History Node
                await db.ref(`history/${rideId}`).set(finalRideData);
                // Remove from Active
                await rideRef.remove();
            }
        } else if (['CANCELLED', 'RIDE_CANCELLED'].includes(status)) {
            const snapshot = await rideRef.get();
            if (snapshot.exists()) {
                const finalRideData = snapshot.val();
                await db.ref(`history/${rideId}`).set(finalRideData);
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
        const rideRef = db.ref(`active_rides/${rideId}`);

        const snapshot = await rideRef.get();
        if (!snapshot.exists()) return res.status(404).send("Ride not found");

        const ride = snapshot.val();
        const offers = ride.offers || [];

        if (!offer || !offer.driverId) {
            return res.status(400).send("Invalid offer data");
        }

        await rideRef.update({
            offers: [...offers, offer],
            status: 'BIDS_RECEIVED'
        });

        console.log(`💰 Full Bid received for: ${rideId} from ${offer.driverName}`);
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
        const offers = ride.offers || [];

        // 1. Calculate Commission
        const configSnap = await db.ref('admin_config/settings').get();
        const commissionRate = configSnap.val()?.commission_rate || 10;
        const acceptedOffer = offers.find(o => o.id === offerId || o.driverId === driverId);
        if (!acceptedOffer) return res.status(404).send("Offer not found");

        const commissionAmount = (acceptedOffer.bidFare * commissionRate) / 100;

        // 2. Update Offers status (one accepted, others rejected)
        const updatedOffers = offers.map(o => {
            if (o.id === offerId || o.driverId === driverId) return { ...o, status: 'ACCEPTED' };
            return { ...o, status: 'REJECTED' };
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
            vehicleInfo: {
                type: ride.vehicleType,
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

router.get('/history/:userId', async (req, res) => {
    // History logic is now handled on App side by observing user_history node
    res.json([]);
});

module.exports = router;
