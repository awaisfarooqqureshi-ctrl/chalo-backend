const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const Transaction = require('../models/Transaction');
const Review = require('../models/Review');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// 1. Cloudinary Config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// 2. Multer Storage
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: { folder: 'chalo_docs', format: async () => 'jpg', public_id: () => `doc_${Date.now()}` },
});
const upload = multer({ storage: storage });

// 3. Helper: Robust Multi-ID Generator
function getSearchIds(userId) {
    if (!userId) return [];
    const rawId = userId.toString().trim();
    const cleanId = rawId.replace(/\+/g, '').replace(/^0/, '').replace(/^92/, '').trim();
    return [rawId, cleanId, `0${cleanId}`, `92${cleanId}`, `+92${cleanId}`, `+${cleanId}`];
}

// 4. Get User Profile (RTDB)
router.get('/profile/:userId', async (req, res) => {
    try {
        const cleanId = req.params.userId.replace(/\+/g, '').trim();
        const snapshot = await admin.database().ref(`users/${cleanId}`).get();
        if (snapshot.exists()) res.json(snapshot.val());
        else res.status(404).send("Not found");
    } catch(e) { res.status(500).send(e.message); }
});

// 5. Update Profile
router.post('/update-profile', async (req, res) => {
    try {
        const profile = req.body;
        const uid = (profile.uid || "").toString().replace(/\+/g, '').trim();
        if (!uid) return res.status(400).send("ID missing");
        await admin.database().ref(`users/${uid}`).update({
            name: profile.name, gender: profile.gender, dateOfBirth: profile.dateOfBirth,
            role: profile.role || "Passenger", profilePhoto: profile.profilePhoto
        });
        res.json({ success: true });
    } catch(e) { res.status(500).send(e.message); }
});

// 6. Get Transactions (MongoDB)
router.get('/transactions/:userId', async (req, res) => {
    try {
        const searchIds = getSearchIds(req.params.userId);
        const transactions = await Transaction.find({ userId: { $in: searchIds } }).sort({ timestamp: -1 }).limit(20);
        res.json(transactions);
    } catch (e) { res.status(500).send(e.message); }
});

// 7. Accounting Summary
router.get('/summary/:userId', async (req, res) => {
    try {
        const searchIds = getSearchIds(req.params.userId);
        const now = new Date();
        const startOfDay = new Date(now.setHours(0,0,0,0)).getTime();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

        const daily = await Transaction.aggregate([{ $match: { userId: { $in: searchIds }, category: 'RIDE_INCOME', timestamp: { $gte: startOfDay } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
        const monthly = await Transaction.aggregate([{ $match: { userId: { $in: searchIds }, category: 'RIDE_INCOME', timestamp: { $gte: startOfMonth } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
        const topups = await Transaction.aggregate([{ $match: { userId: { $in: searchIds }, category: 'TOPUP' } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);

        res.json({ todayEarnings: daily[0]?.total || 0, monthlyEarnings: monthly[0]?.total || 0, totalTopups: topups[0]?.total || 0 });
    } catch (e) { res.status(500).send(e.message); }
});

// 8. Submit Review: Mandatory MongoDB + RTDB Sync
router.post('/review', async (req, res) => {
    try {
        const data = req.body;
        console.log(`📝 Review Submission: From=${data.reviewerId} To=${data.targetUserId}`);

        // A. Save to MongoDB
        try {
            const review = new Review({
                rideId: data.rideId,
                reviewerId: data.reviewerId,
                reviewerName: data.reviewerName,
                reviewerPhoto: data.reviewerPhoto,
                targetUserId: data.targetUserId,
                rating: Number(data.rating),
                comment: data.comment || "",
                compliments: data.compliments || [],
                role: data.role,
                timestamp: Date.now()
            });
            await review.save();
            console.log("✅ Review saved in MongoDB Atlas.");
        } catch (mErr) { console.error("❌ Review MongoDB Save Error:", mErr.message); }

        // B. Update RTDB Aggregate Rating
        const cleanTargetId = data.targetUserId.toString().replace(/\+/g, '').trim();
        const userRef = admin.database().ref(`users/${cleanTargetId}`);
        const snapshot = await userRef.get();
        if (snapshot.exists()) {
            const profile = snapshot.val();
            const isDriver = data.role === "Passenger";
            const updates = {};
            if (isDriver) {
                const count = (profile.driverReviewCount || 0) + 1;
                updates.driverReviewCount = count;
                updates.driverRating = ((profile.driverRating || 5.0) * (count - 1) + data.rating) / count;
            } else {
                const count = (profile.passengerReviewCount || 0) + 1;
                updates.passengerReviewCount = count;
                updates.passengerRating = ((profile.passengerRating || 5.0) * (count - 1) + data.rating) / count;
            }
            await userRef.update(updates);
            console.log("⭐ RTDB Rating Aggregated.");
        }
        res.json({ success: true });
    } catch (e) { console.error("❌ Review Route Error:", e.message); res.status(500).send(e.message); }
});

// 9. Get User Reviews (MongoDB)
router.get('/reviews/:userId', async (req, res) => {
    try {
        const searchIds = getSearchIds(req.params.userId);
        console.log(`📜 Fetching reviews for variant IDs:`, searchIds);
        const reviews = await Review.find({ targetUserId: { $in: searchIds } }).sort({ timestamp: -1 }).limit(20);
        console.log(`✅ Found ${reviews.length} reviews.`);
        res.json(reviews);
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
