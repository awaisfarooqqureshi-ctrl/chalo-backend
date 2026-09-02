const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

/**
 * PRODUCTION ADMIN ROUTES
 * All testing/seeding routes have been removed for security.
 */

// 1. Get all Bonus Schemes
router.get('/bonuses', async (req, res) => {
    try {
        const db = admin.database();
        const snapshot = await db.ref('bonus_schemes').get();
        const bonuses = [];
        snapshot.forEach(child => {
            bonuses.push({ id: child.key, ...child.val() });
        });
        res.json(bonuses);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. Add or Update a Bonus Scheme
router.post('/bonuses', async (req, res) => {
    const { id, title, description, type, target, reward, vehicleGroup, isActive, colorHex } = req.body;
    if (!title || !target || !reward) return res.status(400).json({ success: false, message: "Missing data" });

    try {
        const db = admin.database();
        const bonusId = id || db.ref('bonus_schemes').push().key;
        const bonusData = { id: bonusId, title, description: description || "", type: type || "RIDE_COMPLETION", target: parseInt(target), reward: parseFloat(reward), vehicleGroup: vehicleGroup || "ALL", isActive: isActive !== undefined ? isActive : true, colorHex: colorHex || "#FFC107", updatedAt: Date.now() };
        await db.ref(`bonus_schemes/${bonusId}`).set(bonusData);
        res.json({ success: true, data: bonusData });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. Approve/Verify Driver Documents
router.post('/approve-driver', async (req, res) => {
    const { userId, status, notes } = req.body; // status: approved, rejected
    try {
        const db = admin.database();
        await db.ref(`users/${userId}`).update({
            driverVerificationStatus: status,
            verificationNotes: notes || ""
        });
        res.json({ success: true, message: `Driver status updated to ${status}` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
