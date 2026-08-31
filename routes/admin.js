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

// 4. Seed Default Bonuses (GET added for easy browser access)
router.get('/bonuses/seed', async (req, res) => {
    try {
        const db = admin.database();
        const defaults = {
            "daily_hero_bike": {
                id: "daily_hero_bike",
                title: "Daily Bike Hero",
                description: "Complete 10 rides today",
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
            },
            "beginner_bonus_all": {
                id: "beginner_bonus_all",
                title: "Starter Bonus",
                description: "Complete your first 3 rides",
                type: "RIDE_COMPLETION",
                target: 3,
                reward: 100,
                vehicleGroup: "ALL",
                isActive: true,
                colorHex: "#2196F3"
            }
        };

        await db.ref('bonus_schemes').update(defaults);
        res.send(`<h1>✅ Success!</h1><p>Comprehensive bonuses seeded for both groups.</p><pre>${JSON.stringify(defaults, null, 2)}</pre>`);
    } catch (error) {
        res.status(500).send(`<h1>❌ Error</h1><p>${error.message}</p>`);
    }
});

// Also keep POST for API usage
router.post('/bonuses/seed', async (req, res) => {
    try {
        const db = admin.database();
        const defaults = {
            "daily_hero_bike": {
                id: "daily_hero_bike",
                title: "Daily Bike Hero",
                description: "Complete 10 rides today",
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
            },
            "beginner_bonus_all": {
                id: "beginner_bonus_all",
                title: "Starter Bonus",
                description: "Complete your first 3 rides",
                type: "RIDE_COMPLETION",
                target: 3,
                reward: 100,
                vehicleGroup: "ALL",
                isActive: true,
                colorHex: "#2196F3"
            }
        };
        await db.ref('bonus_schemes').update(defaults);
        res.json({ success: true, message: "Comprehensive bonuses seeded", data: defaults });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 5. Seed Dummy Data for Testing (Islamabad Area)
router.get('/test-seed', async (req, res) => {
    try {
        const db = admin.database();
        const baseLat = 33.6844;
        const baseLon = 73.0479;
        const radius = 0.08; // Roughly 8-10km range

        const vehicleTypes = ["Bike", "Mini", "Comfort", "Van"];
        const dummyDrivers = {};
        const dummyRides = {};

        // Generate 20 Dummy Drivers
        for (let i = 1; i <= 20; i++) {
            const id = `dummy_driver_${i}`;
            const vType = vehicleTypes[Math.floor(Math.random() * vehicleTypes.length)];
            dummyDrivers[id] = {
                uid: id,
                name: `Test Driver ${i}`,
                phoneNumber: `+92300${1000000 + i}`,
                role: "Driver",
                isOnline: true,
                driverStatus: "AVAILABLE",
                lastLat: baseLat + (Math.random() * radius * 2 - radius),
                lastLon: baseLon + (Math.random() * radius * 2 - radius),
                rotation: Math.random() * 360,
                vehicleInfo: { type: vType, model: "Testing Car", numberPlate: `TEST-${i}` },
                driverRating: (4 + Math.random()).toFixed(1),
                isDummy: true // Flag for easy cleanup
            };
        }

        // Generate 20 Dummy Ride Requests
        for (let j = 1; j <= 20; j++) {
            const rideId = `dummy_ride_${j}`;
            const vType = vehicleTypes[Math.floor(Math.random() * vehicleTypes.length)];
            const originalFare = 200 + Math.floor(Math.random() * 500);
            const offeredFare = Math.random() > 0.5 ? originalFare + 50 : originalFare; // 50% are "RAISED"

            dummyRides[rideId] = {
                id: rideId,
                passengerName: `Test Passenger ${j}`,
                passengerId: `dummy_pass_${j}`,
                serviceType: "CITY_RIDE",
                vehicleType: vType,
                pickupLocation: `Sector G-${Math.floor(Math.random() * 11) + 1}, Islamabad`,
                destination: `Sector F-${Math.floor(Math.random() * 11) + 1}, Islamabad`,
                pickupLat: baseLat + (Math.random() * radius - (radius/2)),
                pickupLon: baseLon + (Math.random() * radius - (radius/2)),
                destinationLat: baseLat + (Math.random() * radius - (radius/2)),
                destinationLon: baseLon + (Math.random() * radius - (radius/2)),
                originalFare: originalFare,
                offeredFare: offeredFare,
                status: "FINDING_DRIVER",
                timestamp: Date.now() - (Math.random() * 600000), // Up to 10 mins old
                isDummy: true
            };
        }

        await db.ref('users').update(dummyDrivers);
        await db.ref('active_rides').update(dummyRides);

        res.send(`<h1>✅ Test Data Seeded!</h1><p>20 Drivers and 20 Rides created in Islamabad.</p><p><a href="/admin/test-clean">Click here to Clean Up</a></p>`);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 6. Clean Dummy Data
router.get('/test-clean', async (req, res) => {
    try {
        const db = admin.database();

        // Remove drivers with isDummy flag
        const usersSnap = await db.ref('users').get();
        const updates = {};
        usersSnap.forEach(child => {
            if (child.val().isDummy) updates[child.key] = null;
        });
        await db.ref('users').update(updates);

        // Remove rides with isDummy flag
        const ridesSnap = await db.ref('active_rides').get();
        const rideUpdates = {};
        ridesSnap.forEach(child => {
            if (child.val().isDummy) rideUpdates[child.key] = null;
        });
        await db.ref('active_rides').update(rideUpdates);

        res.send(`<h1>🧹 Cleanup Complete!</h1><p>All dummy test data has been removed from database.</p><p><a href="/admin/test-seed">Seed Again</a></p>`);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
