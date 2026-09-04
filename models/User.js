const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
    title: { type: String, default: "" },
    amount: { type: Number, default: 0 },
    type: { type: String, default: "CREDIT" },
    timestamp: { type: Date, default: Date.now }
}, { _id: false });

const UserSchema = new mongoose.Schema({
    _id: { type: String, required: true }, // Clean Phone ID (923...)
    phone: { type: String, unique: true, required: true },
    name: { type: String, default: "" },
    role: { type: String, enum: ['Driver', 'Passenger', 'Admin'], default: 'Passenger' },
    walletBalance: { type: Number, default: 0 },
    gender: { type: String, default: "" },
    dateOfBirth: { type: String, default: "" },
    profilePhoto: { type: String, default: "" },
    rating: { type: Number, default: 5.0 },
    isOnline: { type: Boolean, default: false },
    lastLat: { type: Number, default: 0 },
    lastLng: { type: Number, default: 0 },
    driverRegistered: { type: Boolean, default: false },
    driverVerificationStatus: { type: String, default: 'not_submitted' },
    vehicleInfo: { type: Object, default: null },
    documents: { type: Object, default: {} },
    welcomeBonusApplied: { type: Boolean, default: true },
    transactions: [TransactionSchema]
}, { timestamps: true }); // REMOVED _id: false

module.exports = mongoose.model('User', UserSchema);
