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

    async getTransactions(userId) {
        if (PROVIDER === 'FIRESTORE') {
            const snapshot = await this.db.collection('transactions')
                .where('userId', '==', userId)
                .orderBy('timestamp', 'desc')
                .limit(20)
                .get();
            const list = [];
            snapshot.forEach(doc => list.push({ id: doc.id, ...doc.data() }));
            return list;
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
