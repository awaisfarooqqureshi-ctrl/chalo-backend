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

        // Remove legacy accounting fields from RTDB profile during registration
        const dbRef = db.ref(`users/${cleanId}`);
        await dbRef.update({
            todayEarnings: null,
            weeklyEarnings: null,
            monthlyEarnings: null,
            lifetimeEarnings: null
        });

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

        // CLEANUP: Removed Firestore duplicate driver record.
        // We now rely solely on RTDB for active driver profiles.

        res.json({ success: true });
    } catch (e) {
        console.error("❌ Registration Error:", e.message);
        res.status(500).json({ message: e.message });
    }
});

router.get('/transactions/:userId', async (req, res) => {
    try {
        const userId = getCleanId(req.params.userId);
        console.log(`🏦 Fetching History for: ${userId}`);

        // Show only latest 20 items to user
        const list = await DB.getTransactions(userId, 20);

        const cleanList = list.map(t => ({
            id: t.id || `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            title: t.title || "Transaction",
            amount: parseFloat(t.amount) || 0,
            type: t.type || "CREDIT",
            category: t.category || "GENERAL",
            status: t.status || "COMPLETED",
            timestamp: Number(t.timestamp) || Date.now()
        }));

        res.json(cleanList);
    } catch (e) {
        console.error("🔥 History API Error:", e.message);
        res.json([]);
    }
});

router.get('/summary/:userId', async (req, res) => {
    try {
        const userId = getCleanId(req.params.userId);
        const list = await DB.getTransactions(userId, 500); // Check last 500 txns

        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

        let totalMonthlyCash = 0;
        let rideCount = 0;

        list.forEach(t => {
            if (t.category === 'RIDE_INCOME' && t.timestamp >= startOfMonth) {
                totalMonthlyCash += parseFloat(t.amount) || 0;
                rideCount++;
            }
        });

        res.json({
            monthlyTotal: Math.round(totalMonthlyCash),
            rideCount: rideCount,
            monthName: now.toLocaleString('default', { month: 'long' })
        });
    } catch (e) {
        res.status(200).json({ monthlyTotal: 0, rideCount: 0 });
    }
});

// 2. Get Transaction History (Limit 20 for UI efficiency)
router.get('/transactions/:userId', async (req, res) => {
    try {
        const userId = getCleanId(req.params.userId);
        const list = await DB.getTransactions(userId, 20);

        const cleanList = list.map(t => ({
            id: t.id || `TXN_${Date.now()}`,
            amount: Number(t.amount) || 0,
            title: t.title || "Transaction",
            type: t.type || "CREDIT",
            category: t.category || "GENERAL",
            timestamp: Number(t.timestamp) || Date.now()
        }));

        res.json(cleanList);
    } catch (e) { res.json([]); }
});

// 3. Submit Review (Includes Reviewer Details)
router.post('/review', async (req, res) => {
    try {
        const data = req.body;
        const targetId = getCleanId(data.targetUserId);
        const reviewerId = getCleanId(data.reviewerId);

        // Fetch current reviewer's profile for name and photo
        const db = admin.database();
        const reviewerSnap = await db.ref(`users/${reviewerId}`).get();
        const reviewerData = reviewerSnap.val() || {};

        const reviewRecord = {
            ...data,
            reviewerName: reviewerData.name || "Anonymous",
            reviewerPhoto: reviewerData.profilePhoto || "",
            targetUserId: targetId,
            timestamp: Date.now()
        };

        // 1. Save to Firestore
        await DB.addReview(reviewRecord);

        // 2. Update Aggregates (Counts)
        const ref = db.ref(`users/${targetId}`);
        const snapshot = await ref.get();
        if (snapshot.exists()) {
            const p = snapshot.val();
            const prefix = (data.role?.toLowerCase() === "passenger") ? "driver" : "passenger";
            const count = (Number(p[`${prefix}ReviewCount`]) || 0) + 1;
            const oldRating = Number(p[`${prefix}Rating`]) || 5.0;
            const newRating = Math.round(((oldRating * (count - 1)) + Number(data.rating)) / count * 10) / 10;
            await ref.update({ [`${prefix}ReviewCount`]: count, [`${prefix}Rating`]: newRating });
        }
        res.json({ success: true });
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

// 4. Get Reviews (Limit 20)
router.get('/reviews/:userId', async (req, res) => {
    try {
        const cleanId = getCleanId(req.params.userId);
        const list = await DB.getReviews(cleanId, 20);
        res.json(list);
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
