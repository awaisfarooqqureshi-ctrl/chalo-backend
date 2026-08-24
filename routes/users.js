const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
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

// ALL USER DATA NOW COMES FROM RTDB
router.get('/profile/:userId', async (req, res) => {
    try {
        const cleanId = req.params.userId.replace('+', '').trim();
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

router.post('/update-profile', async (req, res) => {
    try {
        const profile = req.body;
        const uid = (profile.uid || "").toString().replace('+', '').trim();

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

router.post('/register-driver', async (req, res) => {
    try {
        const { userId, vehicleInfo, documents } = req.body;
        const cleanId = userId.toString().replace('+', '').trim();

        const db = admin.database();
        await db.ref(`users/${cleanId}`).update({
            driverRegistered: true,
            driverVerificationStatus: 'pending',
            vehicleInfo,
            ...documents // licenseFrontUrl, cnicFrontUrl etc
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

router.get('/transactions/:userId', async (req, res) => {
    try {
        const cleanId = req.params.userId.replace('+', '').trim();
        const db = admin.database();
        const snapshot = await db.ref(`users/${cleanId}/transactions`).get();
        res.json(snapshot.exists() ? Object.values(snapshot.val()) : []);
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
