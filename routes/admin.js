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

// 6. Clean ALL Active Rides (To fix data format issues)
router.get('/test-clean', async (req, res) => {
    try {
        const db = admin.database();

        // 1. Wipe ALL active rides to clear format conflicts (List vs Map)
        await db.ref('active_rides').remove();

        // 2. Remove specific dummy drivers
        const updates = {};
        for (let i = 1; i <= 20; i++) {
            updates[`users/dummy_driver_${i}`] = null;
        }
        await db.ref().update(updates);

        res.send(`<h1>🧹 Deep Cleanup Complete!</h1><p>Active rides folder wiped and dummy drivers removed. App should no longer crash.</p><p><a href="/admin/test-seed">Seed Fresh Data</a></p>`);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 7. Simulate Bids from Dummy Drivers to a Real Ride
router.get('/test-bids', async (req, res) => {
    try {
        const { count } = req.query;
        const bidCount = parseInt(count) || 5;
        const db = admin.database();

        // Find the first non-dummy active ride that's currently in bidding phase
        const ridesSnap = await db.ref('active_rides').get();
        let targetRideId = null;
        let offeredFare = 0;
        let rideLat = 0;
        let rideLon = 0;

        ridesSnap.forEach(child => {
            const r = child.val();
            // Accept both FINDING_DRIVER and BIDS_RECEIVED statuses
            const isInBidding = r.status === "FINDING_DRIVER" || r.status === "BIDS_RECEIVED" || r.status === "BIDS";
            if (!r.isDummy && isInBidding) {
                targetRideId = child.key;
                offeredFare = r.offeredFare || 0;
                rideLat = r.pickupLat;
                rideLon = r.pickupLon;
            }
        });

        if (!targetRideId) {
            return res.status(404).send("<h1>❌ No active passenger ride found!</h1><p>Please request a ride from the mobile app first.</p>");
        }

        // Get dummy drivers
        const usersSnap = await db.ref('users').get();
        const dummyDrivers = [];
        usersSnap.forEach(child => {
            const u = child.val();
            if (u.isDummy && u.role === "Driver") dummyDrivers.push(u);
        });

        if (dummyDrivers.length === 0) {
             return res.status(404).send("<h1>❌ No dummy drivers found in database!</h1><p>Please run <b>/admin/test-seed</b> first.</p>");
        }

        const selectedDrivers = dummyDrivers.sort(() => 0.5 - Math.random()).slice(0, bidCount);
        const bids = [];
        const radius = 0.02; // Roughly 2km around the passenger

        for (const driver of selectedDrivers) {
            const bidId = `bid_${driver.uid}_${Date.now()}`;
            const bidFare = offeredFare + (Math.floor(Math.random() * 11) * 10 - 50);

            // Move dummy driver near the actual passenger for testing
            const dLat = rideLat + (Math.random() * radius - (radius/2));
            const dLon = rideLon + (Math.random() * radius - (radius/2));

            const bidData = {
                id: bidId,
                driverId: driver.uid,
                driverName: driver.name,
                rating: parseFloat(driver.driverRating),
                vehicleModel: driver.vehicleInfo.model,
                vehiclePlate: driver.vehicleInfo.numberPlate,
                vehicleType: driver.vehicleInfo.type,
                bidFare: bidFare,
                distanceToPickup: parseFloat((Math.random() * 2).toFixed(1)),
                etaMinutes: Math.floor(Math.random() * 5) + 2,
                lat: dLat,
                lon: dLon,
                timestamp: Date.now(),
                expiresAt: Date.now() + 15000, // 15 seconds (account for latency, shows ~10s in app)
                status: "PENDING"
            };

            // Update driver's location in DB so map shows them near the pickup
            await db.ref(`users/${driver.uid}`).update({
                lastLat: dLat,
                lastLon: dLon,
                isOnline: true,
                driverStatus: "AVAILABLE"
            });

            await db.ref(`active_rides/${targetRideId}/offers/${driver.uid}`).set(bidData);
            bids.push(bidData);
        }

        // 3. Update Ride Status to BIDS_RECEIVED so UI updates properly
        await db.ref(`active_rides/${targetRideId}`).update({ status: "BIDS_RECEIVED" });

        res.send(`<h1>✅ 5 Bids Sent!</h1><p>Dummy drivers have sent offers to ride: <b>${targetRideId}</b></p><p>Check your mobile app now!</p>`);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 8. Unblock User
router.get('/unblock/:phone', async (req, res) => {
    const { phone } = req.params;
    const cleanPhone = phone.replace('+', '').trim();
    try {
        console.log(`🔓 Admin requesting unblock for: ${cleanPhone}`);
        const db = admin.database();
        await db.ref(`users/${cleanPhone}`).update({
            tempBlockExpiry: 0,
            passengerCancellationCount: 0,
            suspiciousCancellationCount: 0,
            accountStatus: "active"
        });
        res.send(`<h1>✅ User Unblocked!</h1><p>User <b>${cleanPhone}</b> is now active and can request rides again.</p><p><a href="/">Go to Home</a></p>`);
    } catch (error) {
        console.error("Unblock Error:", error.message);
        res.status(500).send(`<h1>❌ Error</h1><p>${error.message}</p>`);
    }
});

// 9. FULL DATABASE RESET & DEFAULT SEEDING
router.get('/full-reset', async (req, res) => {
    try {
        const db = admin.database();

        // 1. Wipe Dynamic Nodes (The "Trash" or temporary data)
        const nodesToWipe = [
            'active_rides',
            'history',
            'user_history',
            'temp_otps',
            'fraud_alerts',
            'support_requests',
            'bonus_history',
            'driver_bonus_progress',
            'typing',
            'call_sessions'
        ];

        for (const node of nodesToWipe) {
            await db.ref(node).remove();
        }

        // 2. Reset All Users to Offline/Idle (Keep the accounts, clear the state)
        const usersSnap = await db.ref('users').get();
        const userUpdates = {};
        if (usersSnap.exists()) {
            usersSnap.forEach(child => {
                const uid = child.key;
                userUpdates[`users/${uid}/isOnline`] = false;
                userUpdates[`users/${uid}/driverStatus`] = "OFFLINE";
                userUpdates[`users/${uid}/tempBlockExpiry`] = 0;
                userUpdates[`users/${uid}/passengerCancellationCount`] = 0;
                userUpdates[`users/${uid}/currentRideId`] = null;
            });
            await db.ref().update(userUpdates);
        }

        // 3. Seed Default System Configurations (Essential for first-run)
        const defaultConfig = {
            settings: {
                commission_rate: 10, // 10%
                min_balance_to_work: 200, // Rs. 200
                min_fare: 100,
                intercity_min_fare: 500,
                fare_rates: {
                    "Bike": 35.0,
                    "Mini": 55.0,
                    "Comfort": 75.0,
                    "Van": 90.0,
                    "Premium": 110.0
                },
                intercity_fare_rates: {
                    "Mini": 45.0,
                    "Comfort": 65.0,
                    "Van": 80.0
                }
            }
        };
        await db.ref('admin_config').set(defaultConfig);

        // 4. Seed Default Bonuses
        const defaultBonuses = {
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
            }
        };
        await db.ref('bonus_schemes').set(defaultBonuses);

        res.send(`
            <h1>🚀 Database Fully Reset & Seeded!</h1>
            <p>1. Temporary data (rides, history, alerts) wiped.</p>
            <p>2. Users reset to Offline.</p>
            <p>3. Default Fare Rates and Commission (10%) set.</p>
            <p>4. Default Bonuses seeded.</p>
            <br>
            <a href="/admin/test-seed">Step 2: Seed Dummy Drivers for Testing</a>
        `);
    } catch (error) {
        res.status(500).send(`<h1>❌ Reset Failed</h1><p>${error.message}</p>`);
    }
});

module.exports = router;
