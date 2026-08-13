const express = require('express');
const router = express.Router();
const User = require('../models/User');

const mapToAndroidUser = (user) => {
    if (!user) return null;
    return {
        uid: user._id,
        _id: user._id,
        name: user.name || "",
        phoneNumber: user.phone,
        role: user.role || "Passenger",
        walletBalance: user.walletBalance || 0.0,
        profilePhoto: user.profilePhoto || "",
        driverRegistered: user.driverRegistered || false,
        driverVerificationStatus: user.driverVerificationStatus || "not_submitted",
        isOnline: user.isOnline || false,
        welcomeBonusApplied: user.welcomeBonusApplied || false,
        vehicleInfo: user.vehicleInfo || null,
        gender: user.gender || "",
        dateOfBirth: user.dateOfBirth || "",
        accountStatus: "active",
        currentServiceMode: "CITY_RIDE"
    };
};

router.get('/profile/:userId', async (req, res) => {
    try {
        const rawId = req.params.userId;
        const cleanId = rawId.replace('+', '').trim();
        console.log(`🔍 Fetching profile for: ${cleanId} (Raw: ${rawId})`);

        const user = await User.findById(cleanId);
        if (user) {
            console.log(`✅ User found: ${user.name}`);
            res.json(mapToAndroidUser(user));
        } else {
            console.warn(`❌ User NOT found in MongoDB: ${cleanId}`);
            res.status(404).send("Not found");
        }
    } catch(e) {
        console.error("❌ Profile Fetch Error:", e.message);
        res.status(500).send(e.message);
    }
});

router.post('/update-profile', async (req, res) => {
    try {
        const profile = req.body;
        console.log("📝 Incoming Profile Update Data:", JSON.stringify(profile));

        const uid = (profile.uid || profile._id || "").toString().replace('+', '').trim();

        if (!uid) {
            console.error("❌ Update failed: No ID provided in request body.");
            return res.status(400).send("ID missing");
        }

        const updateData = {
            name: profile.name,
            gender: profile.gender,
            dateOfBirth: profile.dateOfBirth,
            role: profile.role || "Passenger",
            profilePhoto: profile.profilePhoto
        };

        console.log(`🔄 Updating user ${uid} in MongoDB with:`, JSON.stringify(updateData));

        const user = await User.findByIdAndUpdate(uid, updateData, { new: true });

        if (!user) {
            console.error(`❌ Update failed: User ${uid} not found in database.`);
            return res.status(404).send("User not found");
        }

        const responseData = mapToAndroidUser(user);
        console.log(`✅ User ${uid} updated successfully. Returning:`, JSON.stringify(responseData));
        res.json(responseData);
    } catch(e) {
        console.error("❌ Update Profile Error:", e.message);
        res.status(500).send(e.message);
    }
});

router.post('/register-driver', async (req, res) => {
    try {
        const { userId, vehicleInfo, documents } = req.body;
        const cleanId = userId.toString().replace('+', '').trim();
        console.log(`🚛 Registering driver: ${cleanId}`);

        const user = await User.findByIdAndUpdate(cleanId, {
            driverRegistered: true,
            driverVerificationStatus: 'pending',
            vehicleInfo,
            documents
        }, { new: true });

        if (!user) {
            console.error(`❌ Registration failed: User ${cleanId} not found.`);
            return res.status(404).json({ message: "User not found" });
        }

        console.log(`✅ Driver ${cleanId} registered successfully.`);
        res.json({ success: true, user: mapToAndroidUser(user) });
    } catch (e) {
        console.error("❌ Register Driver Error:", e.message);
        res.status(500).json({ message: e.message });
    }
});

router.get('/transactions/:userId', async (req, res) => {
    try {
        const cleanId = req.params.userId.replace('+', '').trim();
        const user = await User.findById(cleanId);
        res.json(user ? user.transactions : []);
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
