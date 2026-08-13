const mongoose = require('mongoose');

const EmergencyAlertSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    userName: { type: String, default: "" },
    role: { type: String, required: true },
    location: {
        lat: Number,
        lng: Number
    },
    mapLink: { type: String, default: "" },
    rideId: { type: String, default: "" },
    status: { type: String, enum: ['active', 'resolved'], default: 'active' },
    timestamp: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('EmergencyAlert', EmergencyAlertSchema);
