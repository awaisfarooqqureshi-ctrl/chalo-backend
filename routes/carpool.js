const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

function getUserId(req) {
    return req.user?.userId?.toString().replace(/\D/g, '').trim() || '';
}

// Publish Carpool Offer: Pure RTDB
router.post('/offer', async (req, res) => {
    try {
        const db = admin.database();
        const driverId = getUserId(req);
        const totalSeats = Number(req.body.totalSeats);
        const price = Number(req.body.price);
        if (!driverId || !req.body.pickupLocation || !req.body.destination || totalSeats < 1 || price < 0) {
            return res.status(400).json({ success: false, message: 'Invalid carpool offer' });
        }
        const offerRef = db.ref('carpool_offers').push();
        const offerId = offerRef.key;

        const offerData = {
            driverName: req.body.driverName || 'Driver',
            pickupLocation: req.body.pickupLocation,
            destination: req.body.destination,
            pickupLat: Number(req.body.pickupLat) || 0,
            pickupLon: Number(req.body.pickupLng ?? req.body.pickupLon) || 0,
            destinationLat: Number(req.body.destLat ?? req.body.destinationLat) || 0,
            destinationLon: Number(req.body.destLng ?? req.body.destinationLon) || 0,
            departureTime: req.body.departureTime || '',
            carpoolType: req.body.carpoolType || 'STOP_TO_STOP',
            driverId,
            totalSeats,
            availableSeats: totalSeats,
            price,
            id: offerId,
            status: 'ACTIVE',
            createdAt: Date.now()
        };

        await offerRef.set({ ...offerData, pricePerSeat: price });
        res.json({ success: true, offer: offerData });
    } catch (e) {
        console.error("Carpool Offer Error:", e.message);
        res.status(500).send(e.message);
    }
});

router.post('/book', async (req, res) => {
    try {
        const db = admin.database();
        const passengerId = getUserId(req);
        const offerId = req.body.offerId?.toString();
        const seats = Number(req.body.seats);
        if (!passengerId || !offerId || !Number.isInteger(seats) || seats < 1) {
            return res.status(400).json({ success: false, message: 'Invalid booking request' });
        }

        const offerRef = db.ref(`carpool_offers/${offerId}`);
        let booking;
        const result = await offerRef.transaction(current => {
            if (!current || current.status !== 'ACTIVE') return;
            const bookings = current.bookings || {};
            if (bookings[passengerId] && ['PENDING', 'CONFIRMED'].includes(bookings[passengerId].status)) return;

            const reservedSeats = Object.values(bookings)
                .filter(item => ['PENDING', 'CONFIRMED'].includes(item.status))
                .reduce((sum, item) => sum + Number(item.seatsBooked || 0), 0);
            const availableSeats = Number(current.totalSeats || current.availableSeats || 0) - reservedSeats;
            if (seats > availableSeats) return;

            booking = {
                passengerId,
                passengerName: req.body.passengerName || 'Passenger',
                seatsBooked: seats,
                pickupLat: Number(req.body.pickupLat) || 0,
                pickupLon: Number(req.body.pickupLon) || 0,
                destinationLat: Number(req.body.destinationLat) || 0,
                destinationLon: Number(req.body.destinationLon) || 0,
                pickupLocation: req.body.pickupLocation || '',
                destination: req.body.destination || '',
                status: 'PENDING',
                timestamp: Date.now()
            };
            bookings[passengerId] = booking;
            return { ...current, bookings, availableSeats: availableSeats - seats };
        });

        if (!result.committed || !booking) return res.status(409).json({ success: false, message: 'Not enough seats or booking already exists' });
        res.json({ success: true, booking });
    } catch (e) {
        console.error('Carpool booking error:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/approve', async (req, res) => {
    try {
        const db = admin.database();
        const driverId = getUserId(req);
        const offerId = req.body.offerId?.toString();
        const passengerId = req.body.passengerId?.toString();
        const offerSnap = await db.ref(`carpool_offers/${offerId}`).get();
        const offer = offerSnap.val();
        if (!offer || offer.driverId !== driverId) return res.status(403).json({ success: false, message: 'Only the offer driver can approve bookings' });

        const bookingRef = db.ref(`carpool_offers/${offerId}/bookings/${passengerId}`);
        const bookingSnap = await bookingRef.get();
        const booking = bookingSnap.val();
        if (!booking || booking.status !== 'PENDING') return res.status(409).json({ success: false, message: 'Booking is not pending' });

        const rideRef = db.ref('active_rides').push();
        const ride = {
            id: rideRef.key,
            serviceType: 'CARPOOL',
            poolId: offerId,
            passengerId,
            passengerName: booking.passengerName || 'Passenger',
            driverId,
            driverName: offer.driverName || 'Driver',
            pickupLocation: booking.pickupLocation,
            pickupLat: booking.pickupLat,
            pickupLon: booking.pickupLon,
            destination: booking.destination,
            destinationLat: booking.destinationLat,
            destinationLon: booking.destinationLon,
            offeredFare: Number(offer.price || offer.pricePerSeat || 0) * Number(booking.seatsBooked || 1),
            vehicleType: offer.vehicleType || 'Car',
            seatsBooked: Number(booking.seatsBooked || 1),
            status: 'WAITING_FOR_PASSENGERS',
            timestamp: Date.now(),
            lastPing: Date.now()
        };
        await rideRef.set(ride);
        await bookingRef.update({ status: 'CONFIRMED', rideId: rideRef.key, confirmedAt: Date.now() });
        res.json({ success: true, ride });
    } catch (e) {
        console.error('Carpool approval error:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/reject', async (req, res) => {
    try {
        const db = admin.database();
        const driverId = getUserId(req);
        const offerId = req.body.offerId?.toString();
        const passengerId = req.body.passengerId?.toString();
        const offerSnap = await db.ref(`carpool_offers/${offerId}`).get();
        if (!offerSnap.exists() || offerSnap.val().driverId !== driverId) return res.status(403).json({ success: false, message: 'Only the offer driver can reject bookings' });
        const bookingRef = db.ref(`carpool_offers/${offerId}/bookings/${passengerId}`);
        const bookingSnap = await bookingRef.get();
        if (!bookingSnap.exists() || bookingSnap.val().status !== 'PENDING') return res.status(409).json({ success: false, message: 'Booking is not pending' });
        await bookingRef.update({ status: 'REJECTED', rejectedAt: Date.now() });
        await db.ref(`carpool_offers/${offerId}/availableSeats`).transaction(current => Number(current || 0) + Number(bookingSnap.val().seatsBooked || 0));
        res.json({ success: true });
    } catch (e) {
        console.error('Carpool rejection error:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get('/offers', async (req, res) => {
    try {
        const db = admin.database();
        const snapshot = await db.ref('carpool_offers').get();
        const offers = [];
        snapshot.forEach(child => {
            const val = child.val();
            if (val.status === 'ACTIVE') offers.push(val);
        });
        res.json(offers.reverse());
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
