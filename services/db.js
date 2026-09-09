const admin = require('firebase-admin');

// PROVIDER SELECTION: 'FIRESTORE' or 'MONGO' (Coming soon)
const PROVIDER = process.env.DB_PROVIDER || 'FIRESTORE';

class DatabaseService {
    constructor() {
        this.db = admin.firestore();
        this.rtdb = admin.database();
    }

    // --- RIDE OPERATIONS ---
    async saveRide(rideId, data) {
        if (PROVIDER === 'FIRESTORE') {
            await this.db.collection('rides').doc(rideId).set({
                ...data,
                archivedAt: Date.now()
            });
        }
        // Future: Add MongoDB implementation here
    }

    async getRideHistory(userId) {
        if (PROVIDER === 'FIRESTORE') {
            const pSnap = await this.db.collection('rides').where('passengerId', '==', userId).orderBy('archivedAt', 'desc').limit(20).get();
            const dSnap = await this.db.collection('rides').where('driverId', '==', userId).orderBy('archivedAt', 'desc').limit(20).get();

            const history = [];
            pSnap.forEach(doc => history.push({ id: doc.id, ...doc.data() }));
            dSnap.forEach(doc => history.push({ id: doc.id, ...doc.data() }));
            return history.sort((a, b) => b.archivedAt - a.archivedAt);
        }
    }

    // --- TRANSACTION OPERATIONS ---
    async addTransaction(data) {
        if (PROVIDER === 'FIRESTORE') {
            return await this.db.collection('transactions').add({
                ...data,
                timestamp: Date.now()
            });
        }
    }

    async getTransactions(userId, limit = 20) {
        if (PROVIDER === 'FIRESTORE') {
            const list = [];
            try {
                // Try Primary Query (requires index for sorting)
                console.log(`🔍 DB: Querying transactions for ${userId}...`);
                const snapshot = await this.db.collection('transactions')
                    .where('userId', '==', userId)
                    .orderBy('timestamp', 'desc')
                    .limit(limit)
                    .get();
                snapshot.forEach(doc => list.push({ id: doc.id, ...doc.data() }));

                // Try Legacy Query (requires index for sorting)
                if (list.length < limit) {
                    const legacySnap = await this.db.collection('transactions')
                        .where('fromUserId', '==', userId)
                        .orderBy('timestamp', 'desc')
                        .limit(limit)
                        .get();
                    legacySnap.forEach(doc => {
                        if (!list.find(t => t.id === doc.id)) list.push({ id: doc.id, ...doc.data() });
                    });
                }
            } catch (err) {
                if (err.message.includes("FAILED_PRECONDITION") || err.message.includes("index")) {
                    console.error("⚠️ ACTION REQUIRED: Firestore Index missing for transactions!");
                    const indexLink = err.message.match(/https:\/\/console\.firebase\.google\.com[^\s]*/);
                    if (indexLink) {
                        console.error(`👉 CLICK THIS LINK TO FIX: ${indexLink[0]}`);
                    }

                    // FALLBACK: Try fetching WITHOUT sorting (no index required)
                    console.log("🛠️ Attempting fallback query without sorting...");
                    const fallbackSnap = await this.db.collection('transactions')
                        .where('userId', '==', userId)
                        .limit(limit)
                        .get();
                    fallbackSnap.forEach(doc => list.push({ id: doc.id, ...doc.data() }));
                } else {
                    console.error("🔥 Firestore Query Error:", err.message);
                }
            }

            return list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, limit);
        }
    }

    // --- USER/DRIVER OPERATIONS ---
    async updateDriverRecord(userId, data) {
        if (PROVIDER === 'FIRESTORE') {
            await this.db.collection('drivers').doc(userId).set({
                ...data,
                updatedAt: Date.now()
            }, { merge: true });
        }
    }

    async addReview(data) {
        if (PROVIDER === 'FIRESTORE') {
            return await this.db.collection('reviews').add({
                ...data,
                timestamp: Date.now()
            });
        }
    }

    // --- NOTIFICATION OPERATIONS ---
    async saveNotification(data) {
        if (PROVIDER === 'FIRESTORE') {
            return await this.db.collection('notifications').add({
                ...data,
                isRead: false,
                timestamp: Date.now()
            });
        }
    }

    async getNotifications(userId) {
        if (PROVIDER === 'FIRESTORE') {
            const snapshot = await this.db.collection('notifications')
                .where('userId', '==', userId)
                .orderBy('timestamp', 'desc')
                .limit(20)
                .get();
            const history = [];
            snapshot.forEach(doc => history.push({ id: doc.id, ...doc.data() }));
            return history;
        }
    }

    async markNotificationRead(notifId) {
        if (PROVIDER === 'FIRESTORE') {
            await this.db.collection('notifications').doc(notifId).update({ isRead: true });
        }
    }
}

module.exports = new DatabaseService();
