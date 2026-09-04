const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    type: { type: String, default: 'GENERAL' }, // GENERAL, REJECTION, PROMO, SYSTEM
    isRead: { type: Boolean, default: false },
    timestamp: { type: Number, default: () => Date.now() }
}, { timestamps: true });

module.exports = mongoose.model('Notification', NotificationSchema);
