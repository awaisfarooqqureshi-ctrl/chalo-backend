const mongoose = require('mongoose');

const CarpoolOfferSchema = new mongoose.Schema({
    driverId: { type: String, required: true },
    driverName: { type: String, default: "" },
    pickupLocation: { type: String, required: true },
    destination: { type: String, required: true },
    pickupLat: { type: Number, required: true },
    pickupLng: { type: Number, required: true },
    destLat: { type: Number, required: true },
    destLng: { type: Number, required: true },
    price: { type: Number, required: true },
    totalSeats: { type: Number, required: true },
    availableSeats: { type: Number, required: true },
    departureTime: { type: String, required: true },
    status: { type: String, enum: ['ACTIVE', 'COMPLETED', 'CANCELLED'], default: 'ACTIVE' },
    timestamp: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('CarpoolOffer', CarpoolOfferSchema);
