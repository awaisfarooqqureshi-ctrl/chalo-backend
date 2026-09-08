const admin = require('firebase-admin');

async function seedDefaultConfig() {
    const db = admin.database();
    console.log("🌱 Seeding Default Configuration...");

    const defaultConfig = {
        settings: {
            app_name: "Chalo Drive",
            commission_rate: 10, // 10% commission
            welcome_bonus_amount: 300,
            min_withdrawal_limit: 1000,
            sos_number: "15",
            support_email: "support@chalodrive.app"
        },
        fares: {
            mini: { base: 100, per_km: 40, per_min: 5 },
            bike: { base: 50, per_km: 20, per_min: 2 },
            riksha: { base: 80, per_km: 30, per_min: 3 },
            comfort: { base: 150, per_km: 60, per_min: 7 },
            van: { base: 300, per_km: 100, per_min: 10 },
            premium: { base: 250, per_km: 90, per_min: 12 }
        },
        bonus_schemes: {
            "daily_target_10": {
                id: "daily_target_10",
                title: "10 Rides Daily",
                target: 10,
                reward: 500,
                isActive: true,
                type: "RIDE_COMPLETION",
                vehicleGroup: "ALL"
            },
            "weekly_super_star": {
                id: "weekly_super_star",
                title: "Weekly Super Star",
                target: 50,
                reward: 3000,
                isActive: true,
                type: "RIDE_COMPLETION",
                vehicleGroup: "CAR"
            }
        }
    };

    try {
        await db.ref('admin_config').update({
            settings: defaultConfig.settings,
            fares: defaultConfig.fares
        });
        await db.ref('bonus_schemes').set(defaultConfig.bonus_schemes);

        // NEW: Seed a default admin if none exists
        const fs = admin.firestore();
        const adminCheck = await fs.collection('admins').limit(1).get();
        if (adminCheck.empty) {
            const bcrypt = require('bcryptjs');
            const hashedPassword = await bcrypt.hash("admin123", 10);
            await fs.collection('admins').add({
                name: "System Admin",
                email: "admin@chalodrive.app",
                password: hashedPassword,
                role: 'SUPER_ADMIN',
                isActive: true,
                createdAt: Date.now()
            });
            console.log("👤 Default Admin created: admin@chalodrive.app / admin123");
        }

        console.log("✅ Successfully seeded default configuration to RTDB.");
    } catch (e) {
        console.error("❌ Seeding Failed:", e.message);
    }
}

module.exports = seedDefaultConfig;
