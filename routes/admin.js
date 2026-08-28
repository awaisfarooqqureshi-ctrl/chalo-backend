const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

// 1. Get all Bonus Schemes
router.get('/bonuses', async (req, res) => {
    try {
        const db = admin.database();
        const snapshot = await db.ref('bonus_schemes').get();
        const bonuses = [];
        snapshot.forEach(child => {
            bonuses.push({ id: child.key, ...child.val() });
        });
        res.json(bonuses);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. Add or Update a Bonus Scheme
router.post('/bonuses', async (req, res) => {
    const { id, title, description, type, target, reward, vehicleGroup, isActive, colorHex } = req.body;

    if (!title || !target || !reward) {
        return res.status(400).json({ success: false, message: "Title, target, and reward are required" });
    }

    try {
        const db = admin.database();
        const bonusId = id || db.ref('bonus_schemes').push().key;

        const bonusData = {
            id: bonusId,
            title,
            description: description || "",
            type: type || "RIDE_COMPLETION",
            target: parseInt(target),
            reward: parseFloat(reward),
            vehicleGroup: vehicleGroup || "ALL", // ALL, CAR, BIKE_RIKSHAW
            isActive: isActive !== undefined ? isActive : true,
            colorHex: colorHex || "#FFC107",
            updatedAt: Date.now()
        };

        await db.ref(`bonus_schemes/${bonusId}`).set(bonusData);
        res.json({ success: true, message: "Bonus scheme saved successfully", data: bonusData });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. Delete a Bonus Scheme
router.delete('/bonuses/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const db = admin.database();
        await db.ref(`bonus_schemes/${id}`).remove();
        res.json({ success: true, message: "Bonus scheme deleted" });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4. Seed Default Bonuses (Helper for the user)
router.post('/bonuses/seed', async (req, res) => {
    try {
        const db = admin.database();
        const defaults = {
            "daily_hero_bike": {
                id: "daily_hero_bike",
                title: "Daily Bike Hero",
                description: "Complete 10 rides in a day",
                type: "RIDE_COMPLETION",
                target: 10,
                reward: 200,
                vehicleGroup: "BIKE_RIKSHAW",
                isActive: true,
                colorHex: "#4CAF50"
            },
            "mega_goal_car": {
                id: "mega_goal_car",
                title: "Mega Car Goal",
                description: "Complete 15 rides for a big reward",
                type: "RIDE_COMPLETION",
                target: 15,
                reward: 1000,
                vehicleGroup: "CAR",
                isActive: true,
                colorHex: "#FFD700"
            }
        };

        await db.ref('bonus_schemes').update(defaults);
        res.json({ success: true, message: "Default bonuses seeded to database" });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
