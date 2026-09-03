const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const Transaction = require('../models/Transaction');
const Review = require('../models/Review');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// 1. Cloudinary Config (From Variables)
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// 2. Multer Storage Config
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'chalo_docs',
        format: async (req, file) => 'jpg',
        public_id: (req, file) => `doc_${Date.now()}`
    },
});
const upload = multer({ storage: storage });

// 3. Upload Image Proxy
router.post('/upload-image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });
        res.json({ success: true, url: req.file.path });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 4. Get User Profile from RTDB
router.get('/profile/:userId', async (req, res) => {
    try {
        const cleanId = req.params.userId.replace(/\+/g, '').trim();
        const db = admin.database();
        const snapshot = await db.ref(`users/${cleanId}`).get();

        if (snapshot.exists()) {
            res.json(snapshot.val());
        } else {
            res.status(404).send("Not found");
        }
    } catch(e) {
        res.status(500).send(e.message);
    }
});

// 5. Update Profile in RTDB
router.post('/update-profile', async (req, res) => {
    try {
        const profile = req.body;
        const uid = (profile.uid || "").toString().replace(/\+/g, '').trim();

        if (!uid) return res.status(400).send("ID missing");

        const db = admin.database();
        await db.ref(`users/${uid}`).update({
            name: profile.name,
            gender: profile.gender,
            dateOfBirth: profile.dateOfBirth,
            role: profile.role || "Passenger",
            profilePhoto: profile.profilePhoto
        });

        res.json({ success: true });
    } catch(e) {
        res.status(500).send(e.message);
    }
});

// 6. Register Driver in RTDB
router.post('/register-driver', async (req, res) => {
    try {
        const { userId, vehicleInfo, documents } = req.body;
        const cleanId = userId.toString().replace(/\+/g, '').trim();

        const db = admin.database();
        await db.ref(`users/${cleanId}`).update({
            driverRegistered: true,
            driverVerificationStatus: 'pending',
            vehicleInfo,
            ...documents
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// 7. Get User Transactions from MongoDB (Limited to 15)
router.get('/transactions/:userId', async (req, res) => {
    try {
        const cleanId = req.params.userId.replace(/\+/g, '').trim();
        const transactions = await Transaction.find({
            userId: { $in: [cleanId, `+${cleanId}`] }
        })
        .sort({ timestamp: -1 })
        .limit(15);
        res.json(transactions);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 10. Get Accounting Summary (Daily/Monthly)
router.get('/summary/:userId', async (req, res) => {
    try {
        const cleanId = req.params.userId.replace(/\+/g, '').trim();
        const now = new Date();
        const startOfDay = new Date(now.setHours(0,0,0,0)).getTime();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

        const dailyIncome = await Transaction.aggregate([
            { $match: { userId: cleanId, category: 'RIDE_INCOME', timestamp: { $gte: startOfDay } } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);

        const monthlyIncome = await Transaction.aggregate([
            { $match: { userId: cleanId, category: 'RIDE_INCOME', timestamp: { $gte: startOfMonth } } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);

        const totalTopups = await Transaction.aggregate([
            { $match: { userId: cleanId, category: 'TOPUP' } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);

        res.json({
            todayEarnings: dailyIncome[0]?.total || 0,
            monthlyEarnings: monthlyIncome[0]?.total || 0,
            totalTopups: totalTopups[0]?.total || 0
        });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 8. Submit Review to MongoDB & RTDB Aggregate
router.post('/review', async (req, res) => {
    try {
        const reviewData = req.body;
        const cleanTargetId = reviewData.targetUserId.toString().replace(/\+/g, '').trim();
        const cleanReviewerId = reviewData.reviewerId.toString().replace(/\+/g, '').trim();

        // A. Save to MongoDB History
        const review = new Review({
            ...reviewData,
            targetUserId: cleanTargetId,
            reviewerId: cleanReviewerId
        });
        await review.save();

        // B. Update RTDB Aggregates for Real-time Display
        const db = admin.database();
        const userRef = db.ref(`users/${cleanTargetId}`);
        const snapshot = await userRef.get();

        if (snapshot.exists()) {
            const profile = snapshot.val();
            const isDriverReview = reviewData.role === "Passenger"; // Passenger reviewing Driver

            if (isDriverReview) {
                const oldCount = profile.driverReviewCount || 0;
                const oldRating = profile.driverRating || 5.0;
                const newCount = oldCount + 1;
                const newRating = ((oldRating * oldCount) + reviewData.rating) / newCount;
                await userRef.update({ driverReviewCount: newCount, driverRating: newRating });
            } else {
                const oldCount = profile.passengerReviewCount || 0;
                const oldRating = profile.passengerRating || 5.0;
                const newCount = oldCount + 1;
                const newRating = ((oldRating * oldCount) + reviewData.rating) / newCount;
                await userRef.update({ passengerReviewCount: newCount, passengerRating: newRating });
            }
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 9. Get User Reviews from MongoDB
router.get('/reviews/:userId', async (req, res) => {
    try {
        const cleanId = req.params.userId.replace(/\+/g, '').trim();
        const reviews = await Review.find({ targetUserId: cleanId })
            .sort({ timestamp: -1 })
            .limit(20);
        res.json(reviews);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

module.exports = router;
