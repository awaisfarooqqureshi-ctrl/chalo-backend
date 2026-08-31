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
                vehicleInfo: { type: vType, model: "Testing Car", numberPlate: `TEST-${i}`, ownerName: "Test Owner" },
                driverRating: parseFloat((4 + Math.random()).toFixed(1)),
                driverReviewCount: Math.floor(Math.random() * 50),
                driverCompletedRides: Math.floor(Math.random() * 100),
                isDummy: true
            };
        }

        // Generate 20 Dummy Ride Requests
        for (let j = 1; j <= 20; j++) {
            const rideId = `dummy_ride_${j}`;
            const vType = vehicleTypes[Math.floor(Math.random() * vehicleTypes.length)];
            const originalFare = 200 + Math.floor(Math.random() * 500);
            const offeredFare = Math.random() > 0.5 ? originalFare + 50 : originalFare;

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
                timestamp: Math.floor(Date.now() - (Math.random() * 600000)),
                lastPing: Date.now(),
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

// 6. Clean Dummy Data (Optimized)
router.get('/test-clean', async (req, res) => {
    try {
        const db = admin.database();
        const updates = {};

        // Directly target the specific dummy IDs instead of fetching all users
        for (let i = 1; i <= 20; i++) {
            updates[`users/dummy_driver_${i}`] = null;
            updates[`active_rides/dummy_ride_${i}`] = null;
        }

        await db.ref().update(updates);

        res.send(`<h1>🧹 Cleanup Complete!</h1><p>20 Dummy Drivers and 20 Dummy Rides removed instantly.</p><p><a href="/admin/test-seed">Seed Again</a></p>`);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 7. Simulate Bids from Dummy Drivers to a Real Ride
router.get('/test-bids', async (req, res) => {
    try {
        const db = admin.database();

        // Find the first non-dummy active ride
        const ridesSnap = await db.ref('active_rides').get();
        let targetRideId = null;
        let offeredFare = 0;

        ridesSnap.forEach(child => {
            const r = child.val();
            if (!r.isDummy && r.status === "FINDING_DRIVER") {
                targetRideId = child.key;
                offeredFare = r.offeredFare;
            }
        });

        if (!targetRideId) {
            return res.status(404).send("<h1>❌ No active passenger ride found!</h1><p>Please request a ride from the mobile app first.</p>");
        }

        // Get 5 dummy drivers
        const usersSnap = await db.ref('users').get();
        const dummyDrivers = [];
        usersSnap.forEach(child => {
            const u = child.val();
            if (u.isDummy && u.role === "Driver") dummyDrivers.push(u);
        });

        const selectedDrivers = dummyDrivers.sort(() => 0.5 - Math.random()).slice(0, 5);
        const bids = [];

        for (const driver of selectedDrivers) {
            const bidId = `bid_${driver.uid}_${Date.now()}`;
            const bidFare = offeredFare + (Math.floor(Math.random() * 11) * 10 - 50); // +/- 50 variation

            const bidData = {
                id: bidId,
                driverId: driver.uid,
                driverName: driver.name,
                rating: parseFloat(driver.driverRating),
                vehicleModel: driver.vehicleInfo.model,
                vehiclePlate: driver.vehicleInfo.numberPlate,
                vehicleType: driver.vehicleInfo.type,
                bidFare: bidFare,
                distanceToPickup: (Math.random() * 3).toFixed(1),
                etaMinutes: Math.floor(Math.random() * 10) + 2,
                lat: driver.lastLat,
                lon: driver.lastLon,
                timestamp: Date.now(),
                expiresAt: Date.now() + 30000, // 30 sec
                status: "PENDING"
            };

            await db.ref(`active_rides/${targetRideId}/offers/${driver.uid}`).set(bidData);
            bids.push(bidData);
        }

        res.send(`<h1>✅ 5 Bids Sent!</h1><p>Dummy drivers have sent offers to ride: <b>${targetRideId}</b></p><p>Check your mobile app now!</p>`);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 8. Unblock User
router.get('/unblock/:phone', async (req, res) => {
    // ... logic remains same ...
});

module.exports = router;
