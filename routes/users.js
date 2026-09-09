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
        console.log(`🏦 Wallet Fetch for: ${userId}`);

        const list = await DB.getTransactions(userId);

        // Final Normalization: Ensuring consistency for Android
        const cleanList = list.map(t => ({
            id: t.id || `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            title: t.title || "Transaction",
            amount: parseFloat(t.amount) || 0,
            type: t.type || "CREDIT",
            category: t.category || "GENERAL",
            status: t.status || "COMPLETED",
            timestamp: Number(t.timestamp) || Date.now()
        }));

        console.log(`✅ Returned ${cleanList.length} transactions for ${userId}`);
        res.json(cleanList);
    } catch (e) {
        console.error("🔥 Transaction API Error:", e.message);
        res.json([]);
    }
});

router.get('/summary/:userId', async (req, res) => {
    try {
        const userId = getCleanId(req.params.userId);
        console.log(`📊 Generating Summary for: ${userId}`);

        // Fetch enough transactions to cover at least a month
        const list = await DB.getTransactions(userId, 100);

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

        // Calculate week start (Last Sunday)
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay());
        weekStart.setHours(0,0,0,0);

        // Calculate month start
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

        let today = 0, weekly = 0, monthly = 0;

        list.forEach(t => {
            const amt = parseFloat(t.amount) || 0;
            const ts = Number(t.timestamp) || 0;

            if (t.category === 'RIDE_INCOME') {
                if (ts >= todayStart) today += amt;
                if (ts >= weekStart.getTime()) weekly += amt;
                if (ts >= monthStart) monthly += amt;
            }
        });

        console.log(`✅ Summary calculated for ${userId}: T=${today}, W=${weekly}, M=${monthly}`);
        res.json({
            todayEarnings: Math.round(today),
            weeklyEarnings: Math.round(weekly),
            monthlyEarnings: Math.round(monthly)
        });
    } catch (e) {
        console.error("🔥 Summary API Fatal Error:", e.message);
        res.status(500).json({ success: false, message: e.message });
    }
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

        console.log(`⭐ New Review Attempt: Target=${targetId}, Role=${role}, Rating=${data.rating}`);

        // 1. Save to Firestore via Service
        try {
            await DB.addReview({
                ...data,
                targetUserId: targetId,
                timestamp: Date.now()
            });
            console.log(`✅ Review archived in Firestore`);
        } catch (dbErr) {
            console.error("❌ Firestore Review Save Failed:", dbErr.message);
        }

        // 2. Update RTDB Aggregates
        const db = admin.database();
        const ref = db.ref(`users/${targetId}`);
        const snapshot = await ref.get();

        if (snapshot.exists()) {
            const p = snapshot.val();
            // If reviewer is Passenger, target is Driver
            const isTargetDriver = (role === "passenger");
            const prefix = isTargetDriver ? "driver" : "passenger";

            const oldCount = Number(p[`${prefix}ReviewCount`]) || 0;
            const oldRating = Number(p[`${prefix}Rating`]) || 5.0;

            const newCount = oldCount + 1;
            const newRating = Math.round(((oldRating * oldCount) + Number(data.rating)) / newCount * 10) / 10;

            const updates = {};
            updates[`${prefix}ReviewCount`] = newCount;
            updates[`${prefix}Rating`] = newRating;

            await ref.update(updates);
            console.log(`📊 RTDB Aggregate Updated for ${targetId}: ${prefix}Rating=${newRating}, Count=${newCount}`);
        } else {
            console.warn(`⚠️ Target user ${targetId} not found in RTDB. Count not updated.`);
        }

        res.json({ success: true });
    } catch (e) {
        console.error("❌ Review API Global Error:", e.message);
        res.status(500).send(e.message);
    }
});

module.exports = router;
