require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const cron = require("node-cron");

const connectDB = require("./config/db");
const User = require("./models/User");
const Bill = require("./models/Bill");

// Initialize Database
connectDB();

if (!process.env.BOT_TOKEN || !process.env.PAYSTACK_SECRET_KEY) {
  console.error("❌ CRITICAL: Missing environment variables.");
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

/* =====================================================
   MIDDLEWARE (ORDER IS CRITICAL FOR WEBHOOKS)
===================================================== */
// Paystack webhook MUST be parsed as raw data to verify the cryptographic signature
app.use("/paystack-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

/* =====================================================
   UTILITIES
===================================================== */
const isAdmin = (ctx) => ctx.from.id.toString() === process.env.ADMIN_ID;

const safeReply = async (ctx, message, options = {}) => {
  try {
    return await ctx.reply(message, options);
  } catch (err) {
    console.error("Reply error:", err.message);
  }
};

const formatCurrency = (amount) => `₦${Number(amount || 0).toFixed(2)}`;

const mentionUser = (user) => {
  if (user.username) return `@${user.username}`;
  return `<a href="tg://user?id=${user.telegramId}">${user.fullName || "Tenant"}</a>`;
};

/* =====================================================
   COMMAND: /start (REGISTRATION)
===================================================== */
bot.start(async (ctx) => {
  try {
    const telegramId = ctx.from.id.toString();
    const username = ctx.from.username || "";
    const fullName = `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();

    let user = await User.findOne({ telegramId });

    if (!user) {
      user = await User.create({
        telegramId,
        username,
        fullName,
        role: telegramId === process.env.ADMIN_ID ? "ADMIN" : "TENANT",
        isActive: true,
      });
      return safeReply(ctx, `✅ Successfully registered as ${user.role}. You can now receive bills.`);
    }

    // Update details in case they changed their Telegram name
    user.username = username;
    user.fullName = fullName;
    await user.save();

    safeReply(ctx, `👋 Welcome back, ${user.fullName}!`);
  } catch (err) {
    console.error("Start command error:", err);
    safeReply(ctx, "❌ An error occurred during registration.");
  }
});

/* =====================================================
   COMMAND: /newbill (ADMIN ONLY)
===================================================== */
/* =====================================================
   COMMAND: /newbill (ADMIN GUARANTEED)
===================================================== */
bot.command("newbill", async (ctx) => {
  try {
    if (ctx.chat.type !== "private") {
      try { await ctx.deleteMessage(); } catch {}
    }
    
    if (!isAdmin(ctx)) return;

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) {
      return safeReply(ctx, "📝 Usage:\n`/newbill 2000` (Bills everyone)\n`/newbill 2000 @user1 @user2` (Specific users)", { parse_mode: "Markdown" });
    }

    const amount = parseFloat(parts[1]);
    if (isNaN(amount) || amount <= 0) return safeReply(ctx, "❌ Invalid amount.");

    const taggedUsernames = parts.slice(2).filter(p => p.startsWith("@")).map(u => u.replace("@", ""));
    let users = [];

    if (taggedUsernames.length === 0) {
      // MODE 1: All active users
      users = await User.find({ isActive: true });
    } else {
      // MODE 2: Specific tagged users
      const regexUsernames = taggedUsernames.map(u => new RegExp(`^${u}$`, "i"));
      users = await User.find({ isActive: true, username: { $in: regexUsernames } });

      if (users.length !== taggedUsernames.length) {
        return safeReply(ctx, "⚠️ Error: One or more tagged users were not found in the database. Ensure they have typed /start.");
      }
    }

    // 🔥 THE FIX: Universal Admin Inclusion
    // This runs for EVERY bill, guaranteeing the Admin is never left out.
    const adminUser = await User.findOne({ telegramId: process.env.ADMIN_ID });
    if (adminUser) {
      const isAdminAlreadyIncluded = users.some(u => String(u.telegramId) === String(adminUser.telegramId));
      if (!isAdminAlreadyIncluded) {
        users.push(adminUser);
      }
    }

    if (!users.length) return safeReply(ctx, "❌ No users found to bill.");

    const splitAmount = amount / users.length;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7);

    // Deactivate old bills
    await Bill.updateMany({ isActive: true }, { isActive: false });

    // Create the new bill
    await Bill.create({
      totalAmount: amount,
      splitAmount,
      totalPeople: users.length,
      dueDate,
      payments: [],
      billedTenants: users.map(u => String(u.telegramId)),
      isActive: true,
    });

    const mentions = users.map(mentionUser).join(" ");

    await bot.telegram.sendMessage(
      process.env.GROUP_ID,
      `⚡ <b>New Compound Electricity Bill</b>\n\n` +
      `💰 Total: ${formatCurrency(amount)}\n` +
      `👥 Sharing: ${users.length} people\n` +
      `💵 Each: ${formatCurrency(splitAmount)}\n` +
      `📅 Due: ${dueDate.toDateString()}\n\n` +
      `📢 ${mentions}`,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    console.error("NewBill error:", err);
    safeReply(ctx, "❌ Fatal error creating the bill.");
  }
});

/* =====================================================
   COMMAND: /pay (PRODUCTION SAFE)
===================================================== */
bot.command("pay", async (ctx) => {
  try {
    if (ctx.chat.type !== "private") {
      try { await ctx.deleteMessage(); } catch {}
    }

    const telegramId = String(ctx.from.id);
    const user = await User.findOne({ telegramId });

    if (!user) return safeReply(ctx, "❌ You must register first. Send me a private `/start` message.");
    if (!user.isActive) return safeReply(ctx, "🚫 Your account is inactive.");

    const bill = await Bill.findOne({ isActive: true });
    if (!bill) return safeReply(ctx, "❌ There is no active bill right now.");

    if (!bill.billedTenants.includes(telegramId)) {
      return safeReply(ctx, "❌ You are not included in the current bill.");
    }

    if (bill.payments.some(p => p.telegramId === telegramId)) {
      return safeReply(ctx, "✅ You have already paid this bill.");
    }

    // Step 1: Initialize Paystack securely
    let paystackRes;
    try {
      paystackRes = await axios.post(
        "https://api.paystack.co/transaction/initialize",
        {
          email: `${telegramId}@compound-bot.com`, // Dummy email required by Paystack
          amount: Math.round(bill.splitAmount * 100), // Paystack requires Kobo/Cents
          currency: "NGN",
          metadata: { telegramId }
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            "Content-Type": "application/json"
          },
          timeout: 8000
        }
      );
    } catch (apiErr) {
      console.error("Paystack Init Error:", apiErr.response?.data || apiErr.message);
      return safeReply(ctx, "❌ Payment provider is down. Try again later.");
    }

    const authUrl = paystackRes.data?.data?.authorization_url;
    if (!authUrl) return safeReply(ctx, "❌ Failed to generate a payment link.");

    // Step 2: Attempt to DM the user
    try {
      await ctx.telegram.sendMessage(
        telegramId,
        `💳 <b>Electricity Bill Checkout</b>\n\nAmount Due: ${formatCurrency(bill.splitAmount)}`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([Markup.button.url("💰 Pay Securely Now", authUrl)])
        }
      );
      
      // If triggered from a group, let them know in the group that a DM was sent
      if (ctx.chat.type !== "private") {
        return safeReply(ctx, "🔒 I have sent your private payment link to your DMs.");
      }
    } catch (tgErr) {
      console.error("Telegram DM block:", tgErr.message);
      return safeReply(
        ctx,
        "❌ **I cannot send you the payment link!**\n\nTelegram blocks bots from sending private messages unless you message them first. Please click my profile, send me `/start`, and then type `/pay` again.",
        { parse_mode: "Markdown" }
      );
    }

  } catch (err) {
    console.error("Pay command error:", err);
    safeReply(ctx, "❌ An unexpected error occurred while processing your request.");
  }
});
/* =====================================================
   COMMAND: /history (USER PAYMENT HISTORY)
===================================================== */
bot.command("history", async (ctx) => {
  try {
    // Keep history private to avoid spamming the compound group
    if (ctx.chat.type !== "private") {
      try { await ctx.deleteMessage(); } catch {}
      return safeReply(ctx, "⚠ Please send me this command in our private chat.");
    }

    const telegramId = String(ctx.from.id);

    // Find all bills where this user has a successful payment, sorted newest first
    const bills = await Bill.find({
      "payments.telegramId": telegramId
    }).sort({ createdAt: -1 });

    if (!bills || bills.length === 0) {
      return safeReply(ctx, "📭 You do not have any payment history yet.");
    }

    let totalPaid = 0;
    let msg = `📜 <b>Your Payment History</b>\n\n`;

    for (const bill of bills) {
      // Extract just this user's payment from the embedded array
      const payment = bill.payments.find(p => String(p.telegramId) === telegramId);
      
      if (payment) {
        totalPaid += payment.amount;
        msg += 
          `🗓 <b>Date:</b> ${payment.paidAt.toDateString()}\n` +
          `💰 <b>Amount:</b> ${formatCurrency(payment.amount)}\n` +
          `🆔 <b>Ref:</b> <code>${payment.reference}</code>\n` +
          `---------------------------\n`;
      }
    }

    msg += `\n🏆 <b>Total All-Time Paid:</b> ${formatCurrency(totalPaid)}`;

    return safeReply(ctx, msg, { parse_mode: "HTML" });

  } catch (err) {
    console.error("History command error:", err);
    safeReply(ctx, "❌ An error occurred while fetching your history.");
  }
});

/* =====================================================
   COMMAND: /mybalance (CURRENT OUTSTANDING BALANCE)
===================================================== */
bot.command("mybalance", async (ctx) => {
  try {
    // Keep balances private
    if (ctx.chat.type !== "private") {
      try { await ctx.deleteMessage(); } catch {}
      return safeReply(ctx, "⚠ Please send me this command in our private chat.");
    }

    const telegramId = String(ctx.from.id);
    
    // Fetch the single active bill
    const bill = await Bill.findOne({ isActive: true });

    if (!bill) {
      return safeReply(ctx, "✅ There is no active electricity bill right now. You are all caught up!");
    }

    // Check if the user is even on this specific bill
    if (!bill.billedTenants.includes(telegramId)) {
      return safeReply(ctx, "✅ You were not included in the current active bill. Your balance is ₦0.00.");
    }

    // Check if they have already paid it
    const hasPaid = bill.payments.some(p => String(p.telegramId) === telegramId);

    if (hasPaid) {
      const payment = bill.payments.find(p => String(p.telegramId) === telegramId);
      return safeReply(
        ctx, 
        `✅ <b>Account Settled</b>\n\nYou already paid ${formatCurrency(payment.amount)} for the current cycle on ${payment.paidAt.toDateString()}.`,
        { parse_mode: "HTML" }
      );
    }

    // If they are on the bill and haven't paid, calculate the days left
    const daysLeft = Math.ceil((new Date(bill.dueDate) - new Date()) / (1000 * 60 * 60 * 24));
    const urgency = daysLeft < 0 ? "🚨 OVERDUE" : `⏳ ${daysLeft} days remaining`;

    return safeReply(
      ctx,
      `⚠ <b>Outstanding Balance</b>\n\n` +
      `Amount Due: <b>${formatCurrency(bill.splitAmount)}</b>\n` +
      `Due Date: ${bill.dueDate.toDateString()}\n` +
      `Status: ${urgency}\n\n` +
      `Type /pay to settle your balance now.`,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    console.error("MyBalance command error:", err);
    safeReply(ctx, "❌ An error occurred while checking your balance.");
  }
});

/* =====================================================
   COMMAND: /markpaid (MANUAL RECONCILIATION)
===================================================== */
bot.command("markpaid", async (ctx) => {
  try {
    if (ctx.chat.type !== "private") {
      try { await ctx.deleteMessage(); } catch {}
    }
    
    // Strict admin-only access
    if (!isAdmin(ctx)) return;

    // Expected format: /markpaid 2000 @username CASH-REF
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 4) {
      return safeReply(
        ctx, 
        "📝 Usage: `/markpaid <amount> <@tenant> <reference>`\nExample: `/markpaid 2000 @johndoe CASH-JAN`", 
        { parse_mode: "Markdown" }
      );
    }

    const amount = parseFloat(parts[1]);
    if (isNaN(amount) || amount <= 0) return safeReply(ctx, "❌ Invalid amount.");

    const usernameTag = parts[2].replace("@", "");
    // Join any remaining parts into a single reference string
    const reference = parts.slice(3).join("-").toUpperCase(); 

    // Find the user case-insensitively
    const user = await User.findOne({ username: new RegExp(`^${usernameTag}$`, "i") });
    if (!user) return safeReply(ctx, `❌ Could not find user @${usernameTag} in the database.`);

    const telegramId = String(user.telegramId);

    const bill = await Bill.findOne({ isActive: true });
    if (!bill) return safeReply(ctx, "❌ There is no active electricity bill right now.");

    if (!bill.billedTenants.includes(telegramId)) {
      return safeReply(ctx, "❌ That user is not part of the current active bill.");
    }

    if (bill.payments.some(p => String(p.telegramId) === telegramId)) {
      return safeReply(ctx, "✅ That user has already paid for this billing cycle.");
    }

    // Push the manual payment to the embedded array
    bill.payments.push({
      telegramId: telegramId,
      fullName: user.fullName,
      amount: amount,
      reference: `MANUAL-${reference}`,
      paidAt: new Date()
    });

    await bill.save();

    // Broadcast the success to the compound group just like the webhook does
    await bot.telegram.sendMessage(
      process.env.GROUP_ID,
      `✅ <b>Manual Payment Received!</b>\n\n` +
      `${mentionUser(user)} has paid ${formatCurrency(amount)} offline.\n` +
      `🧾 Ref: <code>MANUAL-${reference}</code>\n` +
      `📊 Progress: ${bill.payments.length} / ${bill.totalPeople} paid.`,
      { parse_mode: "HTML" }
    );

    // Reply to the admin privately to confirm execution
    safeReply(ctx, `✅ Successfully marked ${user.username || user.fullName} as paid.`);

  } catch (err) {
    console.error("Markpaid command error:", err);
    safeReply(ctx, "❌ An error occurred while processing the manual payment.");
  }
});

/* =====================================================
   COMMAND: /deactivate & /activate (TENANT STATUS)
===================================================== */
bot.command("deactivate", async (ctx) => {
  try {
    if (ctx.chat.type !== "private") {
      try { await ctx.deleteMessage(); } catch {}
    }
    
    if (!isAdmin(ctx)) return;

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) return safeReply(ctx, "📝 Usage: `/deactivate @tenant`", { parse_mode: "Markdown" });

    const usernameTag = parts[1].replace("@", "");
    const user = await User.findOne({ username: new RegExp(`^${usernameTag}$`, "i") });

    if (!user) return safeReply(ctx, "❌ User not found in the database.");
    
    // Safety lock: Prevent admin from deactivating themselves
    if (String(user.telegramId) === process.env.ADMIN_ID) {
      return safeReply(ctx, "❌ Security constraint: You cannot deactivate the Admin account.");
    }

    if (!user.isActive) return safeReply(ctx, "⚠️ This user is already deactivated.");

    user.isActive = false;
    await user.save();

    safeReply(ctx, `🚫 <b>Account Deactivated</b>\n${mentionUser(user)} is marked as inactive and will be excluded from future bills.`, { parse_mode: "HTML" });

  } catch (err) {
    console.error("Deactivate error:", err);
    safeReply(ctx, "❌ Error deactivating user.");
  }
});

bot.command("activate", async (ctx) => {
  try {
    if (ctx.chat.type !== "private") {
      try { await ctx.deleteMessage(); } catch {}
    }
    
    if (!isAdmin(ctx)) return;

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) return safeReply(ctx, "📝 Usage: `/activate @tenant`", { parse_mode: "Markdown" });

    const usernameTag = parts[1].replace("@", "");
    const user = await User.findOne({ username: new RegExp(`^${usernameTag}$`, "i") });

    if (!user) return safeReply(ctx, "❌ User not found in the database.");
    
    if (user.isActive) return safeReply(ctx, "⚠️ This user is already active.");

    user.isActive = true;
    await user.save();

    safeReply(ctx, `✅ <b>Account Activated</b>\n${mentionUser(user)} is active again and will be included when the next bill is generated.`, { parse_mode: "HTML" });

  } catch (err) {
    console.error("Activate error:", err);
    safeReply(ctx, "❌ Error activating user.");
  }
});

/* =====================================================
   WEBHOOK (PAYSTACK LISTENER)
===================================================== */
app.post("/paystack-webhook", async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];
    const hash = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(req.body) // req.body is raw buffer here because of express.raw()
      .digest("hex");

    if (hash !== signature) {
      console.warn("⚠️ Unauthorized webhook attempt.");
      return res.sendStatus(401);
    }

    const event = JSON.parse(req.body.toString());
    
    // Always return 200 quickly to acknowledge receipt to Paystack
    res.sendStatus(200);

    if (event.event !== "charge.success") return;

    const telegramId = String(event.data.metadata.telegramId);
    const reference = event.data.reference;
    const amountPaid = event.data.amount / 100;

    const bill = await Bill.findOne({ isActive: true });
    if (!bill || !bill.billedTenants.includes(telegramId)) return;
    
    // Prevent duplicate processing of the same webhook reference
    if (bill.payments.some(p => p.reference === reference)) return;

    const user = await User.findOne({ telegramId });

    // Atomic update to the embedded array
    bill.payments.push({
      telegramId,
      fullName: user ? user.fullName : "Unknown Tenant",
      amount: amountPaid,
      reference,
      paidAt: new Date()
    });
    
    await bill.save();

    // Notify the group
    await bot.telegram.sendMessage(
      process.env.GROUP_ID,
      `🎉 <b>Payment Received!</b>\n\n${mentionUser(user || { telegramId, fullName: "Tenant" })} has paid ${formatCurrency(amountPaid)}.\n📊 Progress: ${bill.payments.length} / ${bill.totalPeople} paid.`,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

/* =====================================================
   CRON: DAILY REMINDER (Runs every day at 9 AM)
===================================================== */
cron.schedule("0 9 * * *", async () => {
  try {
    const bill = await Bill.findOne({ isActive: true });
    if (!bill) return;

    const paidIds = bill.payments.map(p => p.telegramId);
    const unpaidIds = bill.billedTenants.filter(id => !paidIds.includes(id));

    if (unpaidIds.length === 0) return;

    const unpaidUsers = await User.find({ telegramId: { $in: unpaidIds } });
    const mentions = unpaidUsers.map(mentionUser).join(" ");
    
    const daysLeft = Math.ceil((new Date(bill.dueDate) - new Date()) / (1000 * 60 * 60 * 24));

    let timeText = daysLeft > 0 ? `${daysLeft} days left` : daysLeft === 0 ? "DUE TODAY" : `OVERDUE by ${Math.abs(daysLeft)} days`;

    await bot.telegram.sendMessage(
      process.env.GROUP_ID,
      `⏰ <b>Electricity Bill Reminder</b>\n\nAmount Due: ${formatCurrency(bill.splitAmount)}\nStatus: ${timeText}\n\nWaiting on: ${mentions}`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    console.error("Cron Reminder Error:", err);
  }
});

/* =====================================================
   SERVER BOOT
===================================================== */
app.get("/", (req, res) => res.send("🚀 Compound Billing Engine is Online"));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`🌍 Server listening on port ${PORT}`));

bot.launch().then(() => console.log("🤖 Telegram Bot connected and polling..."));

// Graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));