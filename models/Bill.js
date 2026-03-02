const mongoose = require("mongoose");

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
    billedTenants: [String], // 🔥 ADDED: This tells Mongoose to save the Telegram IDs!
    payments: [paymentSchema], 
  },
  { timestamps: true }
);

module.exports = mongoose.model("Bill", billSchema);