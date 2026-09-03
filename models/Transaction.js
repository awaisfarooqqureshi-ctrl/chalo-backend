const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    amount: { type: Number, required: true },
    type: { type: String, enum: ['CREDIT', 'DEBIT'], required: true },
    category: { type: String, enum: ['TOPUP', 'RIDE_INCOME', 'COMMISSION', 'BONUS', 'WITHDRAWAL'], required: true, index: true },
    status: { type: String, default: 'COMPLETED' },
    reference: { type: String, index: true }, // Ride ID or Payment ID
    timestamp: { type: Number, default: () => Date.now() }
}, { timestamps: true });

module.exports = mongoose.model('Transaction', TransactionSchema);
