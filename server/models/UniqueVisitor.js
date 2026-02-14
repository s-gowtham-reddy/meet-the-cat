const mongoose = require('mongoose');

const uniqueVisitorSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    location: { type: String }, // Captured only once
    firstSeen: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('UniqueVisitor', uniqueVisitorSchema);
