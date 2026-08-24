const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

// Publish Carpool Offer: Pure RTDB
router.post('/offer', async (req, res) => {
    try {
        const db = admin.database();
        const offerRef = db.ref('carpool_offers').push();
        const offerId = offerRef.key;

        const offerData = {
            ...req.body,
            id: offerId,
            status: 'ACTIVE',
            createdAt: Date.now()
        };

        await offerRef.set(offerData);
        res.json({ success: true, offer: offerData });
    } catch (e) {
        console.error("Carpool Offer Error:", e.message);
        res.status(500).send(e.message);
    }
});

router.get('/offers', async (req, res) => {
    try {
        const db = admin.database();
        const snapshot = await db.ref('carpool_offers').get();
        const offers = [];
        snapshot.forEach(child => {
            const val = child.val();
            if (val.status === 'ACTIVE') offers.push(val);
        });
        res.json(offers.reverse());
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
