const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const Transaction = require('../models/Transaction');
const Review = require('../models/Review');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// 1. Cloudinary Setup
cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
const storage = new CloudinaryStorage({ cloudinary: cloudinary, params: { folder: 'chalo_docs', format: async () => 'jpg' } });
const upload = multer({ storage: storage });

// Helper: Robust Multi-ID Identity Matcher
function getSearchIds(userId) {
    if (!userId) return [];
    const rawId = userId.toString().trim();
    const cleanId = rawId.replace(/\+/g, '').replace(/^0/, '').replace(/^92/, '').trim();
    return [rawId, cleanId, `0${cleanId}`, `92${cleanId}`, `+92${cleanId}`, `+${cleanId}`];
}

// --- 2. RESTORED: Image Upload Proxy ---
router.post('/upload-image', upload.single('image'), (req, res) => {
    if (!req.file) {
        console.error("❌ No file in request");
        return res.status(400).json({ success: false, message: "No file uploaded" });
    }
    console.log(`✅ File uploaded to Cloudinary: ${req.file.path}`);
    res.json({ success: true, url: req.file.path });
});

// --- 3. RESTORED: Driver Registration with Duplicate Checks ---
router.post('/register-driver', async (req, res) => {
    try {
        const { userId, vehicleInfo, documents, isOwner } = req.body;
        const cleanId = userId.toString().replace(/\+/g, '').trim();
        const cnicNumber = documents.cnic;
        const plateNumber = vehicleInfo.numberPlate;

        const db = admin.database();
        const usersRef = db.ref('users');
        const allUsersSnap = await usersRef.get();
        const allUsers = allUsersSnap.val() || {};

        for (const uid in allUsers) {
            if (uid === cleanId) continue;
            const user = allUsers[uid];
            if (cnicNumber && user.cnic === cnicNumber) return res.status(400).json({ success: false, message: "CNIC already registered" });
            if (plateNumber && user.vehicleInfo?.numberPlate === plateNumber) return res.status(400).json({ success: false, message: "Vehicle already registered" });
        }

        const userRef = db.ref(`users/${cleanId}`);
        const userProfile = (await userRef.get()).val() || {};

        const updates = { driverRegistered: true, driverVerificationStatus: 'pending', isOwner, vehicleInfo, cnic: cnicNumber, ...documents };

        // Welcome Bonus Logic (Drivers Only)
        if (!userProfile.welcomeBonusApplied) {
            const configSnap = await db.ref('admin_config/settings').get();
            const config = configSnap.val() || {};
            const bonus = Math.round((Number(config.welcome_bonus_amount) || 300) * 100) / 100;

            if (bonus > 0) {
                const currentBalance = (Number(userProfile.walletBalance) || 0);
                updates.walletBalance = Math.round((currentBalance + bonus) * 100) / 100;
                updates.welcomeBonusApplied = true;
                await new Transaction({
                    userId: cleanId,
                    title: "Driver Welcome Bonus",
                    amount: bonus,
                    type: "CREDIT",
                    category: "BONUS",
                    timestamp: Date.now()
                }).save();
                console.log(`🎁 Driver ${cleanId} received Rs.${bonus} Welcome Bonus.`);
            }
        }
        await userRef.update(updates);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

// --- 4. Profile & History Routes ---
router.get('/profile/:userId', async (req, res) => {
    try {
        const cleanId = req.params.userId.replace(/\+/g, '').trim();
        const snap = await admin.database().ref(`users/${cleanId}`).get();
        if (snap.exists()) res.json(snap.val());
        else res.status(404).send("Not found");
    } catch(e) { res.status(500).send(e.message); }
});

router.get('/transactions/:userId', async (req, res) => {
    try {
        const searchIds = getSearchIds(req.params.userId);
        const list = await Transaction.find({ userId: { $in: searchIds } }).sort({ timestamp: -1 }).limit(20);
        res.json(list);
    } catch (e) { res.status(500).send(e.message); }
});

router.get('/summary/:userId', async (req, res) => {
    try {
        const searchIds = getSearchIds(req.params.userId);
        const startOfDay = new Date().setHours(0,0,0,0);
        const daily = await Transaction.aggregate([{ $match: { userId: { $in: searchIds }, category: 'RIDE_INCOME', timestamp: { $gte: startOfDay } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
        const monthly = await Transaction.aggregate([{ $match: { userId: { $in: searchIds }, category: 'RIDE_INCOME', timestamp: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
        res.json({ todayEarnings: daily[0]?.total || 0, monthlyEarnings: monthly[0]?.total || 0 });
    } catch (e) { res.status(500).send(e.message); }
});

router.post('/review', async (req, res) => {
    try {
        const data = req.body;
        console.log(`📝 Review Submission: From=${data.reviewerId} To=${data.targetUserId}, Role=${data.role}`);

        // 1. Mandatory Save to MongoDB
        const mongoRole = (data.role || "Passenger").charAt(0).toUpperCase() + (data.role || "Passenger").slice(1).toLowerCase();
        await new Review({
            ...data,
            role: mongoRole === "Driver" || mongoRole === "Passenger" ? mongoRole : "Passenger",
            rideId: data.rideId || "MANUAL",
            timestamp: Date.now()
        }).save();
        console.log(`✅ Review saved to MongoDB as role: ${mongoRole}`);

        // 2. Update RTDB Aggregates
        const cleanId = data.targetUserId.toString().replace(/\+/g, '').trim();
        const ref = admin.database().ref(`users/${cleanId}`);
        const snapshot = await ref.get();

        if (snapshot.exists()) {
            const p = snapshot.val();
            // If reviewer is Passenger, target is Driver
            const isTargetDriver = (data.role || "").toLowerCase() === "passenger";
            const prefix = isTargetDriver ? "driver" : "passenger";

            const oldCount = Number(p[`${prefix}ReviewCount`]) || 0;
            const oldRating = Number(p[`${prefix}Rating`]) || 5.0;

            const newCount = oldCount + 1;
            const newRating = Math.round(((oldRating * oldCount) + Number(data.rating)) / newCount * 10) / 10;

            const updates = {};
            updates[`${prefix}ReviewCount`] = newCount;
            updates[`${prefix}Rating`] = newRating;

            await ref.update(updates);
            console.log(`⭐ RTDB Aggregate Updated for ${cleanId}: ${prefix}Rating=${newRating}, Count=${newCount}`);
        }
        res.json({ success: true });
    } catch (e) {
        console.error("❌ Review API Error:", e.message);
        res.status(500).send(e.message);
    }
});

router.get('/reviews/:userId', async (req, res) => {
    try {
        const searchIds = getSearchIds(req.params.userId);
        const list = await Review.find({ targetUserId: { $in: searchIds } }).sort({ timestamp: -1 }).limit(20);
        res.json(list);
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
