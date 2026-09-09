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
    // SCALE FIX: Remove ALL non-digits to match App's RTDB path logic
    return userId.toString().replace(/\D/g, '').trim();
}

function getPakistanDateKey(timestamp) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Karachi',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date(Number(timestamp) || 0));
}

function getPakistanMonthKey(timestamp) {
    return getPakistanDateKey(timestamp).slice(0, 7);
}

function getPakistanWeekKey(timestamp) {
    const dateKey = getPakistanDateKey(timestamp);
    const date = new Date(`${dateKey}T00:00:00Z`);
    const day = date.getUTCDay();
    const daysFromMonday = (day + 6) % 7;
    date.setUTCDate(date.getUTCDate() - daysFromMonday);
    return date.toISOString().slice(0, 10);
}

function isEarningTransaction(transaction) {
    return transaction.category === 'RIDE_INCOME' || transaction.category === 'BONUS';
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

        const requestedLimit = Number.parseInt(req.query.limit, 10);
        const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;
        const list = await DB.getTransactions(userId, limit);

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
        const rawId = req.params.userId;
        const cleanId = getCleanId(rawId);
        const db = admin.database();

        // All accounting date boundaries are calculated in Pakistan time.
        const list = await DB.getTransactions(cleanId, 500);

        const todayKey = getPakistanDateKey(Date.now());
        const monthKey = todayKey.slice(0, 7);
        const weekKey = getPakistanWeekKey(Date.now());
        const todayTransactions = list.filter(t => getPakistanDateKey(t.timestamp) === todayKey);
        const weeklyTransactions = list.filter(t => getPakistanWeekKey(t.timestamp) === weekKey);
        const monthlyTransactions = list.filter(t => getPakistanMonthKey(t.timestamp) === monthKey);

        const sumTransactions = (items, predicate) => items
            .filter(predicate)
            .reduce((total, item) => total + (parseFloat(item.amount) || 0), 0);
        const earningPredicate = item => isEarningTransaction(item) && item.type === 'CREDIT';
        const commissionPredicate = item => item.category === 'COMMISSION' && item.type === 'DEBIT';

        const todayEarnings = sumTransactions(todayTransactions, earningPredicate);
        const weeklyEarnings = sumTransactions(weeklyTransactions, earningPredicate);
        const monthlyEarnings = sumTransactions(monthlyTransactions, earningPredicate);
        const todayCommission = sumTransactions(todayTransactions, commissionPredicate);
        const monthlyCommission = sumTransactions(monthlyTransactions, commissionPredicate);
        const rideCount = monthlyTransactions.filter(t => t.category === 'RIDE_INCOME').length;

        // 2. SMART WALLET FETCH (Force numeric conversion for App compatibility)
        let userSnap = await db.ref(`users/${cleanId}/walletBalance`).get();

        if (!userSnap.exists() && rawId !== cleanId) {
            userSnap = await db.ref(`users/${rawId}/walletBalance`).get();
        }

        const rawBalance = userSnap.val();
        const walletBalance = (rawBalance !== null && rawBalance !== undefined) ? parseFloat(rawBalance) : 0;

        res.json({
            timezone: 'Asia/Karachi',
            todayKey,
            weekKey,
            monthKey,
            todayEarnings: Math.round(todayEarnings),
            weeklyEarnings: Math.round(weeklyEarnings),
            monthlyTotal: Math.round(monthlyEarnings),
            monthlyEarnings: Math.round(monthlyEarnings),
            todayCommission: Math.round(todayCommission),
            monthlyCommission: Math.round(monthlyCommission),
            todayNet: Math.round(todayEarnings - todayCommission),
            monthlyNet: Math.round(monthlyEarnings - monthlyCommission),
            walletBalance: walletBalance,
            rideCount: rideCount,
            todayTransactions,
            monthlyTransactions
        });
    } catch (e) {
        console.error("🔥 Summary API Error:", e.message);
        res.status(200).json({ todayEarnings: 0, monthlyTotal: 0, walletBalance: 0 });
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
