const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const multer = require('multer');
const StorageService = require('../services/storage');
const DB = require('../services/db');

// Multer Setup
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

// Helper: Standardized Clean ID
function getCleanId(userId) {
    if (!userId) return "";
    return userId.toString().replace(/\+/g, '').trim();
}

// --- Image Upload Proxy ---
router.post('/upload-image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: "No file" });

        const uploadType = req.body.type || 'PHOTO';
        const isSensitive = ['DOC', 'CNIC', 'LICENSE'].includes(uploadType);

        // Uses our new Portable Storage Service
        const resultUrl = await StorageService.upload(
            req.file.buffer,
            req.file.originalname,
            req.file.mimetype,
            isSensitive
        );

        res.json({ success: true, url: resultUrl });
    } catch (e) {
        console.error("🔥 Upload Error:", e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- Driver Registration ---
router.post('/register-driver', async (req, res) => {
    try {
        const { userId, vehicleInfo, documents, isOwner } = req.body;
        const cleanId = getCleanId(userId);
        const db = admin.database();

        const userRef = db.ref(`users/${cleanId}`);
        const userSnap = await userRef.get();
        const userProfile = userSnap.val() || {};

        const updates = {
            driverRegistered: true,
            driverVerificationStatus: 'pending',
            isOwner,
            vehicleInfo,
            cnic: documents.cnic,
            ...documents
        };

        // Welcome Bonus
        if (!userProfile.welcomeBonusApplied) {
            const bonus = 300;
            updates.walletBalance = Math.round(((Number(userProfile.walletBalance) || 0) + bonus) * 100) / 100;
            updates.welcomeBonusApplied = true;

            await DB.addTransaction({
                userId: cleanId,
                title: "Driver Welcome Bonus",
                amount: bonus,
                type: "CREDIT",
                category: "BONUS"
            });
        }
        await userRef.update(updates);

        // Uses our new Portable Database Service
        await DB.updateDriverRecord(cleanId, {
            cnic: documents.cnic,
            plate: vehicleInfo.numberPlate,
            status: 'pending'
        });

        res.json({ success: true });
    } catch (e) {
        console.error("❌ Registration Error:", e.message);
        res.status(500).json({ message: e.message });
    }
});

// --- History & Summary ---
router.get('/transactions/:userId', async (req, res) => {
    try {
        const list = await DB.getTransactions(getCleanId(req.params.userId));
        res.json(list);
    } catch (e) { res.status(500).send(e.message); }
});

router.get('/summary/:userId', async (req, res) => {
    try {
        const list = await DB.getTransactions(getCleanId(req.params.userId));
        const startOfDay = new Date().setHours(0,0,0,0);

        let today = 0;
        list.forEach(t => {
            if (t.timestamp >= startOfDay && t.category === 'RIDE_INCOME') today += t.amount;
        });

        res.json({ todayEarnings: today, monthlyEarnings: 0 });
    } catch (e) { res.status(500).send(e.message); }
});

router.get('/profile/:userId', async (req, res) => {
    try {
        const cleanId = getCleanId(req.params.userId);
        const snap = await admin.database().ref(`users/${cleanId}`).get();
        if (snap.exists()) res.json(snap.val());
        else res.status(404).send("Not found");
    } catch(e) { res.status(500).send(e.message); }
});

router.post('/review', async (req, res) => {
    try {
        const data = req.body;
        const targetId = getCleanId(data.targetUserId);
        const role = (data.role || "Passenger").toLowerCase();

        // 1. Save to Firestore via Service
        await DB.addReview({
            ...data,
            targetUserId: targetId,
            timestamp: Date.now()
        });

        // 2. Update RTDB Aggregates
        const ref = admin.database().ref(`users/${targetId}`);
        const snapshot = await ref.get();

        if (snapshot.exists()) {
            const p = snapshot.val();
            const prefix = (role === "passenger") ? "driver" : "passenger";
            const count = (Number(p[`${prefix}ReviewCount`]) || 0) + 1;
            const oldRating = Number(p[`${prefix}Rating`]) || 5.0;
            const newRating = Math.round(((oldRating * (count - 1)) + Number(data.rating)) / count * 10) / 10;
            await ref.update({ [`${prefix}ReviewCount`]: count, [`${prefix}Rating`]: newRating });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
