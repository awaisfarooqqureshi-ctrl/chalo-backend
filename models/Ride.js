const mongoose = require('mongoose');

const RideSchema = new mongoose.Schema({
    passengerId: { type: String, required: true },
    passengerName: { type: String, default: "Customer" },
    passengerPhoto: { type: String, default: "" },
    passengerPhone: { type: String, default: "" },

    driverId: { type: String, default: null },
    driverName: { type: String, default: "" },
    driverPhoto: { type: String, default: "" },
    driverPhone: { type: String, default: "" },

    id: { type: String }, // Virtual ID for Android compatibility

    pickupLocation: { type: String, required: true },
    destination: { type: String, required: true },

    // Aligned with Android App property names (Lon vs Lng)
    pickupLat: { type: Number, required: true },
    pickupLon: { type: Number, required: true },
    pickupLng: { type: Number }, // Support alternate
    destinationLat: { type: Number, required: true },
    destinationLon: { type: Number, required: true },
    destinationLng: { type: Number }, // Support alternate

    fare: { type: Number, default: 0 },
    offeredFare: { type: Number, default: 0 },
    originalFare: { type: Number, default: 0 },

    serviceType: { type: String, default: 'CITY_RIDE' },
    status: { type: String, default: 'FINDING_DRIVER' },
    vehicleType: { type: String, default: 'Car' },

    paymentStatus: { type: String, default: 'PENDING' }, // PENDING, PAID, CANCELLED
    paymentMethod: { type: String, default: 'CASH' },   // CASH, WALLET
    cancelReason: { type: String, default: "" },

    stops: { type: Array, default: [] },
    offers: { type: Array, default: [] }, // Array of DriverOffer objects

    // Delivery Specific
    itemType: { type: String, default: "" },
    itemWeight: { type: String, default: "" },
    senderName: { type: String, default: "" },
    senderPhone: { type: String, default: "" },
    receiverName: { type: String, default: "" },
    receiverPhone: { type: String, default: "" },
    deliveryNote: { type: String, default: "" },

    // Intercity
    scheduledTimestamp: { type: Number, default: null },
    luggageSize: { type: String, default: "None" },

    // Carpool
    seatsBooked: { type: Number, default: 1 },

    timestamp: { type: Number, default: () => Date.now() },
    lastPing: { type: Number, default: () => Date.now() }
}, { timestamps: true });

module.exports = mongoose.model('Ride', RideSchema);
