const express = require('express');
const router = express.Router();
const CarpoolOffer = require('../models/Carpool');

router.post('/offer', async (req, res) => {
    try {
        const offer = await CarpoolOffer.create(req.body);
        res.json({ success: true, offer });
    } catch (e) { res.status(500).send(e.message); }
});

router.get('/offers', async (req, res) => {
    try {
        const offers = await CarpoolOffer.find({ status: 'ACTIVE' }).sort({ createdAt: -1 });
        res.json(offers);
    } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
