const mongoose = require("mongoose");

// Define the structure for individual payments embedded in the bill
const paymentSchema = new mongoose.Schema({
  telegramId: {
    type: String,
    required: true,
  },
  fullName: String,
  amount: Number,
  reference: String,
  paidAt: {
    type: Date,
    default: Date.now,
  },
});

// Define the main bill structure
const billSchema = new mongoose.Schema(
  {
    totalAmount: Number,
    splitAmount: Number,
    totalPeople: Number,
    dueDate: Date,
    isActive: {
      type: Boolean,
      default: true,
    },
    lateFeeApplied: Boolean,
    billedTenants: [String], // 🔥 CRUCIAL: Mongoose will now save the Telegram IDs
    payments: [paymentSchema], // Embedded payments array
  },
  { timestamps: true }
);

module.exports = mongoose.model("Bill", billSchema);