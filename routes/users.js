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

// --- 3. Driver Registration (Firestore & RTDB Hybrid) ---
router.post('/register-driver', async (req, res) => {
    try {
        const { userId, vehicleInfo, documents, isOwner } = req.body;
        const cleanId = getCleanId(userId);
        const db = admin.database();
        const fs = admin.firestore();

        // Check duplicates in Firestore
        const duplicateCnic = await fs.collection('drivers').where('cnic', '==', documents.cnic).get();
        if (!duplicateCnic.empty) return res.status(400).json({ success: false, message: "CNIC already registered" });

        const userRef = db.ref(`users/${cleanId}`);
        const userSnap = await userRef.get();
        const userProfile = userSnap.val() || {};

        const updates = { driverRegistered: true, driverVerificationStatus: 'pending', isOwner, vehicleInfo, cnic: documents.cnic, ...documents };

        // Welcome Bonus
        if (!userProfile.welcomeBonusApplied) {
            const bonus = 300;
            updates.walletBalance = Math.round(((Number(userProfile.walletBalance) || 0) + bonus) * 100) / 100;
            updates.welcomeBonusApplied = true;

            await fs.collection('transactions').add({
                userId: cleanId,
                title: "Driver Welcome Bonus",
                amount: bonus,
                type: "CREDIT",
                category: "BONUS",
                timestamp: Date.now()
            });
        }
        await userRef.update(updates);

        // Also save a copy in Firestore for advanced indexing
        await fs.collection('drivers').doc(cleanId).set({
            userId: cleanId,
            cnic: documents.cnic,
            plate: vehicleInfo.numberPlate,
            status: 'pending',
            updatedAt: Date.now()
        });

        res.json({ success: true });
    } catch (e) {
        console.error("❌ Driver Registration Error:", e.message);
        res.status(500).json({ message: e.message });
    }
});

// --- 4. Profile & History Routes ---
router.get('/profile/:userId', async (req, res) => {
    try {
        const cleanId = getCleanId(req.params.userId);
        const snap = await admin.database().ref(`users/${cleanId}`).get();
        if (snap.exists()) res.json(snap.val());
        else res.status(404).send("Not found");
    } catch(e) { res.status(500).send(e.message); }
});

router.get('/transactions/:userId', async (req, res) => {
    try {
        const cleanId = getCleanId(req.params.userId);
        const fs = admin.firestore();
        const snapshot = await fs.collection('transactions')
            .where('userId', '==', cleanId)
            .orderBy('timestamp', 'desc')
            .limit(20)
            .get();

        const list = [];
        snapshot.forEach(doc => list.push({ id: doc.id, ...doc.data() }));
        res.json(list);
    } catch (e) { res.status(500).send(e.message); }
});

router.get('/summary/:userId', async (req, res) => {
    try {
        const cleanId = getCleanId(req.params.userId);
        const fs = admin.firestore();
        const startOfDay = new Date().setHours(0,0,0,0);

        const snapshot = await fs.collection('transactions')
            .where('userId', '==', cleanId)
            .where('timestamp', '>=', startOfDay)
            .get();

        let today = 0;
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.category === 'RIDE_INCOME') today += data.amount;
        });

        res.json({ todayEarnings: today, monthlyEarnings: 0 });
    } catch (e) { res.status(500).send(e.message); }
});

router.post('/review', async (req, res) => {
    try {
        const data = req.body;
        const targetId = getCleanId(data.targetUserId);
        const reviewerId = getCleanId(data.reviewerId);
        const role = (data.role || "Passenger").toLowerCase();
        const fs = admin.firestore();

        // 1. Save to Firestore
        await fs.collection('reviews').add({
            ...data,
            targetUserId: targetId,
            reviewerId: reviewerId,
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
    } catch (e) {
        console.error("❌ Review API Error:", e.message);
        res.status(500).send(e.message);
    }
});

router.get('/reviews/:userId', async (req, res) => {
    try {
        const cleanId = getCleanId(req.params.userId);
        const fs = admin.firestore();
        const snapshot = await fs.collection('reviews')
            .where('targetUserId', '==', cleanId)
            .orderBy('timestamp', 'desc')
            .limit(20)
            .get();

        const list = [];
        snapshot.forEach(doc => list.push({ id: doc.id, ...doc.data() }));
        res.json(list);
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
