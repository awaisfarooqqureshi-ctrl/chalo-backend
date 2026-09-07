const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const multer = require('multer');
const { Storage } = require('@google-cloud/storage');

// 1. Google Cloud Storage Setup
const storage = new Storage();
const PUBLIC_BUCKET = process.env.GCS_PUBLIC_BUCKET || 'chalodrive-assets';
const PRIVATE_BUCKET = process.env.GCS_PRIVATE_BUCKET || 'chalodrive-docs';

const publicBucket = storage.bucket(PUBLIC_BUCKET);
const privateBucket = storage.bucket(PRIVATE_BUCKET);

// 2. Multer Setup (Memory Storage for GCS Proxy)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Helper: Standardized Clean ID for Firestore
function getSearchIds(userId) {
    if (!userId) return [];
    const rawId = userId.toString().trim();
    const cleanId = rawId.replace(/\+/g, '').replace(/^0/, '').replace(/^92/, '').trim();
    return [rawId, cleanId, `0${cleanId}`, `92${cleanId}`, `+92${cleanId}`, `+${cleanId}`];
}

function getCleanId(userId) {
    if (!userId) return "";
    return userId.toString().replace(/\+/g, '').trim();
}

// --- 2. Smart Image Upload Proxy (Dual Security) ---
router.post('/upload-image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: "No file" });

        // DETERMINE DESTINATION: Is it a sensitive document?
        const uploadType = req.body.type || 'PHOTO';
        const isSensitive = uploadType === 'DOC' || uploadType === 'CNIC' || uploadType === 'LICENSE';

        const targetBucket = isSensitive ? privateBucket : publicBucket;
        const bucketName = isSensitive ? PRIVATE_BUCKET : PUBLIC_BUCKET;

        const fileName = `${isSensitive ? 'documents' : 'uploads'}/${Date.now()}_${req.file.originalname.replace(/\s+/g, '_')}`;
        const blob = targetBucket.file(fileName);

        const blobStream = blob.createWriteStream({
            resumable: false,
            contentType: req.file.mimetype,
            metadata: { cacheControl: 'public, max-age=31536000' }
        });

        blobStream.on('error', (err) => {
            console.error("❌ GCS Upload Error:", err.message);
            res.status(500).json({ success: false, message: err.message });
        });

        blobStream.on('finish', () => {
            const resultUrl = isSensitive
                ? `gs://${bucketName}/${fileName}`
                : `https://storage.googleapis.com/${bucketName}/${fileName}`;

            console.log(`✅ File uploaded to ${bucketName}: ${resultUrl}`);
            res.json({ success: true, url: resultUrl });
        });

        blobStream.end(req.file.buffer);
    } catch (e) {
        console.error("🔥 Critical Upload Error:", e.message);
        res.status(500).json({ success: false, message: e.message });
    }
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
        const targetId = data.targetUserId.toString().replace(/\+/g, '').trim();
        const reviewerId = data.reviewerId.toString().replace(/\+/g, '').trim();
        const role = (data.role || "Passenger").toLowerCase();

        // 1. Save to MongoDB (Separate Collection)
        const mongoRole = role.charAt(0).toUpperCase() + role.slice(1);
        await new Review({
            ...data,
            targetUserId: targetId,
            reviewerId: reviewerId,
            role: mongoRole === "Driver" || mongoRole === "Passenger" ? mongoRole : "Passenger",
            rideId: data.rideId || "MANUAL",
            timestamp: Date.now()
        }).save();

        // 2. EMBED IN RIDE DOCUMENT (Google AI Recommendation)
        if (data.rideId && data.rideId !== "MANUAL") {
            const reviewField = (role === "passenger") ? "driverReview" : "passengerReview";
            await MongoRide.findOneAndUpdate(
                { id: data.rideId },
                { [reviewField]: { rating: data.rating, comment: data.comment || "", createdAt: new Date() } }
            );
        }

        // 3. Update RTDB Aggregate Rating
        const ref = admin.database().ref(`users/${targetId}`);
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
            console.log(`⭐ RTDB Aggregate Updated for ${targetId}: ${prefix}Rating=${newRating}, Count=${newCount}`);
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
