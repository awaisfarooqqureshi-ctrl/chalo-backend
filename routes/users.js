const express = require('express');
const router = express.Router();
const User = require('../models/User');

const mapToAndroidUser = (user) => {
    if (!user) return null;
    return {
        uid: user._id, _id: user._id,
        name: user.name || "", phoneNumber: user.phone,
        role: user.role || "Passenger", walletBalance: user.walletBalance || 0.0,
        profilePhoto: user.profilePhoto || "",
        driverRegistered: user.driverRegistered || false,
        driverVerificationStatus: user.driverVerificationStatus || "not_submitted",
        isOnline: user.isOnline || false,
        vehicleInfo: user.vehicleInfo || null,
        accountStatus: "active", currentServiceMode: "CITY_RIDE"
    };
};

router.get('/profile/:userId', async (req, res) => {
    try {
        const cleanId = req.params.userId.replace('+', '').trim();
        const user = await User.findById(cleanId);
        user ? res.json(mapToAndroidUser(user)) : res.status(404).send("Not found");
    } catch(e) { res.status(500).send(e.message); }
});

router.post('/update-profile', async (req, res) => {
    try {
        const profile = req.body;
        const uid = (profile.uid || profile._id || "").replace('+', '').trim();
        const user = await User.findByIdAndUpdate(uid, {
            name: profile.name, gender: profile.gender,
            dateOfBirth: profile.dateOfBirth, role: profile.role || "Passenger",
            profilePhoto: profile.profilePhoto
        }, { new: true });
        res.json(mapToAndroidUser(user));
    } catch(e) { res.status(500).send(e.message); }
});

router.post('/register-driver', async (req, res) => {
    try {
        const { userId, vehicleInfo, documents } = req.body;
        const cleanId = userId.replace('+', '').trim();
        const user = await User.findByIdAndUpdate(cleanId, {
            driverRegistered: true, driverVerificationStatus: 'pending',
            vehicleInfo, documents
        }, { new: true });
        res.json({ success: true, user: mapToAndroidUser(user) });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

router.get('/transactions/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId.replace('+', ''));
        res.json(user ? user.transactions : []);
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
