const express = require('express');
const router = express.Router();
const Ride = require('../models/Ride');

router.post('/request', async (req, res) => {
    try {
        const ride = await Ride.create(req.body);
        const io = req.app.get('socketio');
        if (io) io.emit('new_ride_request', ride);
        res.json(ride);
    } catch (e) { res.status(500).send(e.message); }
});

router.post('/update-status', async (req, res) => {
    try {
        const { rideId, status } = req.body;
        const ride = await Ride.findByIdAndUpdate(rideId, { status }, { new: true });
        const io = req.app.get('socketio');
        if (io) io.emit('ride_status_updated', ride);
        res.json(ride);
    } catch (e) { res.status(500).send(e.message); }
});

router.get('/active/:userId', async (req, res) => {
    try {
        const userId = req.params.userId.replace('+', '').trim();
        const ride = await Ride.findOne({
            $or: [{ passengerId: userId }, { driverId: userId }],
            status: { $in: ['PENDING', 'ACCEPTED'] }
        }).sort({ createdAt: -1 });
        res.json(ride);
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
