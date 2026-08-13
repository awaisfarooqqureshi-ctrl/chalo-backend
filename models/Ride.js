const mongoose = require('mongoose');

const RideSchema = new mongoose.Schema({
    passengerId: { type: String, required: true },
    passengerName: { type: String, default: "" },
    driverId: { type: String, default: null },
    driverName: { type: String, default: "" },
    pickupLocation: { type: String, required: true },
    destination: { type: String, required: true },
    pickupLat: { type: Number, required: true },
    pickupLng: { type: Number, required: true },
    destLat: { type: Number, default: 0 },
    destLng: { type: Number, default: 0 },
    fare: { type: Number, default: 0 },
    serviceType: { type: String, enum: ['CITY_RIDE', 'DELIVERY', 'CARPOOL', 'CITY_TO_CITY'], default: 'CITY_RIDE' },
    status: { type: String, enum: ['PENDING', 'ACCEPTED', 'COMPLETED', 'CANCELLED'], default: 'PENDING' },
    timestamp: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('Ride', RideSchema);
