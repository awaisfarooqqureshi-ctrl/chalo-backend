const mongoose = require('mongoose');

const ReviewSchema = new mongoose.Schema({
    rideId: { type: String, required: true, index: true },
    reviewerId: { type: String, required: true, index: true },
    reviewerName: { type: String, default: "User" },
    reviewerPhoto: { type: String, default: "" },
    targetUserId: { type: String, required: true, index: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: "" },
    compliments: { type: Array, default: [] },
    role: { type: String, enum: ['Passenger', 'Driver'], required: true }, // Who is writing the review
    timestamp: { type: Number, default: () => Date.now() }
}, { timestamps: true });

module.exports = mongoose.model('Review', ReviewSchema);
