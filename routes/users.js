const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const Transaction = require('../models/Transaction');
const Review = require('../models/Review');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// Cloudinary
cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
const storage = new CloudinaryStorage({ cloudinary: cloudinary, params: { folder: 'chalo_docs', format: async () => 'jpg' } });
const upload = multer({ storage: storage });

// Helper: Aggressive ID Filter (Last 10 digits)
function getIdentityFilter(userId) {
    if (!userId) return null;
    const digits = userId.toString().replace(/\D/g, '').slice(-10);
    return new RegExp(digits + '$');
}

// Routes
router.get('/profile/:userId', async (req, res) => {
    try {
        const cleanId = req.params.userId.replace(/\+/g, '').trim();
        const snapshot = await admin.database().ref(`users/${cleanId}`).get();
        if (snapshot.exists()) res.json(snapshot.val());
        else res.status(404).send("Not found");
    } catch(e) { res.status(500).send(e.message); }
});

router.get('/transactions/:userId', async (req, res) => {
    try {
        const regex = getIdentityFilter(req.params.userId);
        const transactions = await Transaction.find({ userId: regex }).sort({ timestamp: -1 }).limit(20);
        res.json(transactions);
    } catch (e) { res.status(500).send(e.message); }
});

router.get('/summary/:userId', async (req, res) => {
    try {
        const regex = getIdentityFilter(req.params.userId);
        const now = new Date();
        const startOfDay = new Date(now.setHours(0,0,0,0)).getTime();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

        const daily = await Transaction.aggregate([{ $match: { userId: regex, category: 'RIDE_INCOME', timestamp: { $gte: startOfDay } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
        const monthly = await Transaction.aggregate([{ $match: { userId: regex, category: 'RIDE_INCOME', timestamp: { $gte: startOfMonth } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
        const topups = await Transaction.aggregate([{ $match: { userId: regex, category: 'TOPUP' } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);

        res.json({ todayEarnings: daily[0]?.total || 0, monthlyEarnings: monthly[0]?.total || 0, totalTopups: topups[0]?.total || 0 });
    } catch (e) { res.status(500).send(e.message); }
});

router.post('/review', async (req, res) => {
    try {
        const data = req.body;
        // 1. Mandatory Save to MongoDB
        await new Review({
            rideId: data.rideId || "MANUAL", reviewerId: data.reviewerId, reviewerName: data.reviewerName,
            reviewerPhoto: data.reviewerPhoto, targetUserId: data.targetUserId, rating: Number(data.rating),
            comment: data.comment || "", compliments: data.compliments || [], role: data.role || "Passenger",
            timestamp: Date.now()
        }).save();

        // 2. Update RTDB Aggregates
        const cleanId = data.targetUserId.toString().replace(/\+/g, '').trim();
        const ref = admin.database().ref(`users/${cleanId}`);
        const snap = await ref.get();
        if (snap.exists()) {
            const p = snap.val();
            const isDriver = data.role === "Passenger";
            const fieldPrefix = isDriver ? "driver" : "passenger";
            const count = (p[`${fieldPrefix}ReviewCount`] || 0) + 1;
            const newRating = ((p[`${fieldPrefix}Rating`] || 5.0) * (count - 1) + data.rating) / count;
            await ref.update({ [`${fieldPrefix}ReviewCount`]: count, [`${fieldPrefix}Rating`]: newRating });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

router.get('/reviews/:userId', async (req, res) => {
    try {
        const regex = getIdentityFilter(req.params.userId);
        const reviews = await Review.find({ targetUserId: regex }).sort({ timestamp: -1 }).limit(20);
        res.json(reviews);
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
