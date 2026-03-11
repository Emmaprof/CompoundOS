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
// app.use("/paystack-webhook", express.raw({ type: "application/json" }));
// app.use(express.json());

// // Webhooks MUST be parsed as raw data to verify the cryptographic signatures
// app.use("/paystack-webhook", express.raw({ type: "application/json" }));
// app.use("/crypto-webhook", express.raw({ type: "application/json" })); // 🔥 Your new Web3 middleware
// app.use(express.json());

// Both webhooks MUST be parsed as raw data BEFORE express.json() intercepts them!
app.use("/paystack-webhook", express.raw({ type: "application/json" }));
app.use("/crypto-webhook", express.raw({ type: "application/json" }));

// Now it is safe to parse the rest of the app as JSON
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
/* =====================================================
   COMMAND: /start (USER ONBOARDING)
===================================================== */
bot.command("start", async (ctx) => {
  try {
    // Only allow registration in private DMs to keep the group clean
    if (ctx.chat.type !== "private") {
      return safeReply(ctx, "👋 Please click my profile and send `/start` in a private message to register.");
    }

    const telegramId = String(ctx.from.id);
    const username = ctx.from.username || "";
    const fullName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");

    // Check if the user already exists in the database
    let user = await User.findOne({ telegramId });

    // 🔥 THE FIX: If they already exist, welcome them back and stop the function
    if (user) {
      return safeReply(ctx, `👋 Welcome back, ${user.fullName}!\n\nTap /help to view your payment dashboard.`);
    }

    // If the code reaches this point, they are a brand new user
    user = new User({
      telegramId,
      username,
      fullName,
      isActive: true
    });
    
    await user.save();
    console.log(`✅ New tenant registered: ${fullName} (@${username})`);

    // Send the polished welcome message ONLY to new users
    const welcomeMessage = 
      `🎉 <b>Registration Complete!</b>\n\n` +
      `Welcome to the Compound Utilities Bot, ${ctx.from.first_name}. Your account is now successfully linked to our automated billing system.\n\n` +
      `<b>How this works:</b>\n` +
      `⚡ When a new electricity or utility bill is generated, you will be notified.\n` +
      `💳 You can pay your split securely in <b>Naira</b> (Bank Transfer) or <b>Crypto</b> (USDC/USDT).\n` +
      `🧾 Your payments will be automatically verified and receipted.\n\n` +
      `You are all set! You can safely return to the main compound group chat now.\n\n` +
      `<i>(Tip: You can type /help here at any time to pull up your personal payment menu).</i>`;

    await safeReply(ctx, welcomeMessage, { parse_mode: "HTML" });

  } catch (err) {
    console.error("Start command error:", err);
    safeReply(ctx, "❌ An error occurred during registration. Please try again.");
  }
});
/* =====================================================
   COMMAND: /help (INTERACTIVE DASHBOARD)
===================================================== */
bot.command(["help", "menu"], async (ctx) => {
  try {
    // Basic buttons every tenant sees
    let buttons = [
      [Markup.button.callback("💳 Pay Bill (Naira)", "btn_pay")],
      [Markup.button.callback("🌐 Pay Bill (Crypto)", "btn_cryptopay")]
    ];

    // Secret buttons that only inject if the user is the Admin
    if (isAdmin(ctx)) {
      buttons.push([Markup.button.callback("📊 View Ledger (Admin)", "btn_ledger")]);
      buttons.push([Markup.button.callback("📥 Download Data (Admin)", "btn_export")]);
    }

    const helpText = 
      `🏠 <b>Compound Utilities Control Center</b>\n\n` +
      `Welcome to the automated billing system. Please tap an option below to manage your account:`;

    await safeReply(ctx, helpText, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(buttons)
    });

  } catch (err) {
    console.error("Help menu error:", err);
  }
});
/* =====================================================
   ACTIONS (BUTTON CLICK HANDLERS)
===================================================== */
bot.action("btn_pay", async (ctx) => {
  await ctx.answerCbQuery(); // This stops the loading spinner on the button
  await ctx.reply("Tap here to generate your Paystack checkout link: 👉 /pay");
});

bot.action("btn_cryptopay", async (ctx) => {
  await ctx.answerCbQuery(); 
  await ctx.reply("Tap here to generate your Web3 checkout link: 👉 /cryptopay");
});

bot.action("btn_ledger", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Tap here to pull the real-time financial report: 👉 /ledger");
});

bot.action("btn_export", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Tap here to download the database CSV: 👉 /export");
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

    // 🔥 THE LATE FEE MATH 🔥
    const now = new Date();
    const isLate = now > bill.dueDate;
    const penaltyMultiplier = isLate ? 1.10 : 1.00;
    
    // Math.ceil ensures we round up to the nearest whole Naira (no decimals)
    const amountDue = Math.ceil(bill.splitAmount * penaltyMultiplier); 

    // Step 1: Initialize Paystack securely
    let paystackRes;
    try {
      paystackRes = await axios.post(
        "https://api.paystack.co/transaction/initialize",
        {
          email: `${telegramId}@compound-bot.com`, // Dummy email required by Paystack
          amount: Math.round(amountDue * 100), // 👈 Updated to charge the new calculated amountDue
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
      // Build a dynamic message so they know why they are being charged more
      let messageText = `💳 <b>Electricity Bill Checkout</b>\n\n`;
      if (isLate) {
        messageText += `⚠️ <b>Notice:</b> The 7-day deadline has passed. A 10% late fee has been applied.\n\n`;
      }
      messageText += `Amount Due: ${formatCurrency(amountDue)}`;

      await ctx.telegram.sendMessage(
        telegramId,
        messageText,
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
   COMMAND: /cryptopay (NOWPAYMENTS WEB3 GATEWAY)
===================================================== */
bot.command("cryptopay", async (ctx) => {
  try {
    if (ctx.chat.type !== "private") {
      try { await ctx.deleteMessage(); } catch {}
    }

    const telegramId = String(ctx.from.id);
    const user = await User.findOne({ telegramId });

    if (!user) return safeReply(ctx, "❌ You must register first. Send me a private `/start`.");
    if (!user.isActive) return safeReply(ctx, "🚫 Your account is inactive.");

    const bill = await Bill.findOne({ isActive: true });
    if (!bill) return safeReply(ctx, "❌ There is no active bill right now.");
    if (!bill.billedTenants.includes(telegramId)) return safeReply(ctx, "❌ You are not included in the current bill.");
    if (bill.payments.some(p => p.telegramId === telegramId)) return safeReply(ctx, "✅ You have already paid this bill.");

    if (!process.env.NOWPAYMENTS_API_KEY) return safeReply(ctx, "❌ Web3 Gateway not configured.");

    // 🔥 THE LATE FEE MATH 🔥
    const now = new Date();
    const isLate = now > bill.dueDate;
    const penaltyMultiplier = isLate ? 1.10 : 1.00;
    
    // Math.ceil ensures we round up to the nearest whole Naira (no decimals)
    const amountDue = Math.ceil(bill.splitAmount * penaltyMultiplier); 

    // Initialize NowPayments Invoice
    let cryptoRes;
    try {
      cryptoRes = await axios.post(
        "https://api.nowpayments.io/v1/invoice",
        {
          price_amount: amountDue, // 👈 Updated to charge the new calculated amountDue
          price_currency: "ngn", // The API converts NGN to live crypto value
          order_id: `WEB3-${telegramId}-${Date.now()}`,
          order_description: "Compound Electricity Bill",
        },
        {
          headers: {
            "x-api-key": process.env.NOWPAYMENTS_API_KEY,
            "Content-Type": "application/json"
          }
        }
      );
    } catch (apiErr) {
      console.error("Crypto API Error:", apiErr.response?.data || apiErr.message);
      return safeReply(ctx, "❌ Web3 Payment provider is currently down.");
    }

    const cryptoLink = cryptoRes.data?.invoice_url;
    if (!cryptoLink) return safeReply(ctx, "❌ Failed to generate a Web3 payment link.");

    try {
      // Build a dynamic message so they know why they are being charged more
      let messageText = `🌐 <b>Web3 Electricity Checkout</b>\n\n`;
      if (isLate) {
        messageText += `⚠️ <b>Notice:</b> The 7-day deadline has passed. A 10% late fee has been applied.\n\n`;
      }
      messageText += `Amount Due: ${formatCurrency(amountDue)}\nSupported: USDC & USDT on Base, BNB, Polygon, Avax, Solana.`;

      await ctx.telegram.sendMessage(
        telegramId,
        messageText,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([Markup.button.url("⛓️ Pay with Crypto", cryptoLink)])
        }
      );
      
      if (ctx.chat.type !== "private") {
        return safeReply(ctx, "🔒 I have sent your Web3 payment link to your DMs.");
      }
    } catch (tgErr) {
      return safeReply(ctx, "❌ Please click my profile, send me `/start`, and try again.");
    }
  } catch (err) {
    console.error("CryptoPay error:", err);
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
   COMMAND: /ledger (ADMIN DASHBOARD)
===================================================== */
bot.command("ledger", async (ctx) => {
  try {
    if (ctx.chat.type !== "private") {
      try { await ctx.deleteMessage(); } catch {}
    }

    if (!isAdmin(ctx)) return;

    const bill = await Bill.findOne({ isActive: true });
    if (!bill) {
      return safeReply(ctx, "📭 There is no active bill to report on.");
    }

    const paidIds = bill.payments.map(p => String(p.telegramId));
    const allTenantIds = bill.billedTenants.map(id => String(id));
    const unpaidIds = allTenantIds.filter(id => !paidIds.includes(id));

    // Fetch user data to display clean names instead of raw Telegram IDs
    const allUsers = await User.find({ telegramId: { $in: allTenantIds } });

    const getUserDisplay = (id) => {
      const u = allUsers.find(user => String(user.telegramId) === id);
      return u ? mentionUser(u) : `Unknown (${id})`;
    };

    const paidMentions = paidIds.length > 0
      ? paidIds.map(getUserDisplay).join(", ")
      : "None yet";

    const unpaidMentions = unpaidIds.length > 0
      ? unpaidIds.map(getUserDisplay).join("\n- ")
      : "Everyone has paid! 🎉";

    const totalCollected = bill.payments.reduce((sum, p) => sum + p.amount, 0);

    const msg =
      `📊 <b>Real-Time Billing Ledger</b>\n\n` +
      `💰 <b>Collected:</b> ${formatCurrency(totalCollected)} / ${formatCurrency(bill.totalAmount)}\n` +
      `👥 <b>Progress:</b> ${paidIds.length} / ${bill.totalPeople} tenants\n\n` +
      `✅ <b>PAID:</b>\n${paidMentions}\n\n` +
      `❌ <b>UNPAID:</b>\n${unpaidIds.length > 0 ? "- " + unpaidMentions : unpaidMentions}`;

    safeReply(ctx, msg, { parse_mode: "HTML" });

  } catch (err) {
    console.error("Ledger command error:", err);
    safeReply(ctx, "❌ An error occurred while generating the ledger.");
  }
});
/* =====================================================
   COMMAND: /broadcast (COMPOUND ANNOUNCEMENTS)
===================================================== */
bot.command("broadcast", async (ctx) => {
  try {
    // Keep broadcasts restricted to your private admin chat
    if (ctx.chat.type !== "private") {
      try { await ctx.deleteMessage(); } catch {}
    }

    if (!isAdmin(ctx)) return;

    // Extract the actual message from the command
    const messageText = ctx.message.text.replace("/broadcast", "").trim();

    if (!messageText) {
      return safeReply(
        ctx,
        "📝 Usage: `/broadcast <your message>`\nExample: `/broadcast The plumber is arriving at 2 PM to fix the main pipe.`",
        { parse_mode: "Markdown" }
      );
    }

    // Fetch all active tenants
    const users = await User.find({ isActive: true });

    if (users.length === 0) {
      return safeReply(ctx, "📭 There are no active users to broadcast to.");
    }

    // Acknowledge the command immediately
    safeReply(ctx, `⏳ Broadcasting message to ${users.length} tenants...`);

    let successCount = 0;
    let failCount = 0;

    // Helper function to respect Telegram's API rate limits
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    for (const user of users) {
      try {
        await bot.telegram.sendMessage(
          user.telegramId,
          `📢 <b>Compound Announcement</b>\n\n${messageText}`,
          { parse_mode: "HTML" }
        );
        successCount++;
      } catch (err) {
        console.error(`Failed to message ${user.telegramId}:`, err.message);
        failCount++;
      }
      
      // Pause for 50ms to prevent hitting Telegram's spam limits
      await sleep(50);
    }

    // Deliver the final report to the Admin
    safeReply(
      ctx,
      `✅ <b>Broadcast Complete</b>\n\n` +
      `📨 Delivered: ${successCount}\n` +
      `❌ Failed: ${failCount} (These users may have blocked the bot)`,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    console.error("Broadcast command error:", err);
    safeReply(ctx, "❌ An error occurred while broadcasting the message.");
  }
});

/* =====================================================
   COMMAND: /export (CSV LEDGER DOWNLOAD)
===================================================== */
bot.command("export", async (ctx) => {
  try {
    if (ctx.chat.type !== "private") {
      try { await ctx.deleteMessage(); } catch {}
    }

    if (!isAdmin(ctx)) return;

    // Fetch the currently active bill
    const bill = await Bill.findOne({ isActive: true });
    if (!bill) {
      return safeReply(ctx, "📭 There is no active bill to export.");
    }

    if (bill.payments.length === 0) {
      return safeReply(ctx, "📄 The active bill has no payments yet. Nothing to export.");
    }

    // Build the CSV Header
    let csvString = "Telegram ID,Full Name,Amount Paid (NGN),Reference,Date Paid\n";

    // Loop through payments and build the rows
    for (const p of bill.payments) {
      // Escape commas in names to prevent CSV formatting breaks
      const safeName = p.fullName ? p.fullName.replace(/,/g, "") : "Unknown";
      const dateStr = p.paidAt.toISOString();
      
      csvString += `${p.telegramId},${safeName},${p.amount},${p.reference},${dateStr}\n`;
    }

    // Convert string to a file buffer
    const buffer = Buffer.from(csvString, "utf-8");

    // Send the file to the admin
    await ctx.replyWithDocument(
      { source: buffer, filename: `Compound_Ledger_${new Date().toISOString().split('T')[0]}.csv` },
      { caption: "📊 Here is the latest payment data ready for your spreadsheets." }
    );

  } catch (err) {
    console.error("Export command error:", err);
    safeReply(ctx, "❌ An error occurred while generating the CSV file.");
  }
});
/* =====================================================
   ADMIN COMMAND: MANUAL DUNE SYNC
===================================================== */
bot.command("forcesync", async (ctx) => {
  try {
    // Security check: Only YOU can run this command
    if (String(ctx.from.id) !== process.env.ADMIN_ID) return;

    await ctx.reply("🔄 Manually triggering database sync to Dune Analytics...");
    
    // Call the exact same function the webhooks use
    await syncToDune();
    
    await ctx.reply("✅ Sync complete! The 'February 2026' table is live on Dune.");
  } catch (err) {
    console.error(err);
    ctx.reply("❌ Sync failed. Check the Render logs.");
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
    await syncToDune();

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
   WEBHOOK (NOWPAYMENTS WEB3 LISTENER)
===================================================== */
app.post("/crypto-webhook", async (req, res) => {
  try {
    const signature = req.headers["x-nowpayments-sig"];
    
    // 1. NowPayments requires parsing the body first
    const event = JSON.parse(req.body.toString());

    // 2. Sort the JSON keys alphabetically (The NowPayments quirk)
    const sortedString = JSON.stringify(event, Object.keys(event).sort());
    
    // 3. Hash the sorted string
    const hmac = crypto.createHmac("sha512", process.env.NOWPAYMENTS_IPN_SECRET);
    hmac.update(sortedString);
    const hash = hmac.digest("hex");

    if (hash !== signature) {
      console.warn("⚠️ Unauthorized Web3 webhook attempt.");
      return res.sendStatus(401);
    }

    // Acknowledge receipt immediately
    res.sendStatus(200);
    
    // Only process fully confirmed on-chain transactions
    if (event.payment_status !== "finished") return; 

    // Extract ID from the custom order_id created in /cryptopay
    const telegramId = String(event.order_id.split('-')[1]); 
    const txHash = event.actually_paid_hash || event.payment_id;
    const amountPaidNGN = event.price_amount;

    const bill = await Bill.findOne({ isActive: true });
    if (!bill || !bill.billedTenants.includes(telegramId)) return;
    
    if (bill.payments.some(p => p.reference === `WEB3-${txHash}`)) return;

    const user = await User.findOne({ telegramId });

    bill.payments.push({
      telegramId,
      fullName: user ? user.fullName : "Web3 Tenant",
      amount: amountPaidNGN,
      reference: `WEB3-${txHash}`,
      paidAt: new Date()
    });
    
    await bill.save();
    await syncToDune();

    await bot.telegram.sendMessage(
      process.env.GROUP_ID,
      `🌐 <b>Web3 Payment Verified!</b>\n\n${mentionUser(user || { telegramId, fullName: "Tenant" })} just paid their bill using Crypto.\n⛓️ TX: <code>${String(txHash).slice(0,6)}...${String(txHash).slice(-4)}</code>\n📊 Progress: ${bill.payments.length} / ${bill.totalPeople} paid.`,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    console.error("Crypto Webhook error:", err);
    if (!res.headersSent) res.sendStatus(500);
  }
});
/* =====================================================
   AUTOMATION: DUNE ANALYTICS REAL-TIME SYNC
===================================================== */
async function syncToDune() {
  try {
    const allBills = await Bill.find({});
    
    let csvString = "telegram_id,full_name,amount_paid_ngn,reference,date_paid,billing_cycle\n";
    let paymentCount = 0;
    
    for (const bill of allBills) {
      // 🔥 THE BULLETPROOF FILTER: Ignore any test bills created before March 9.
      // Since your test payments happened on March 7, this permanently ignores them.
      const cutoffDate = new Date("2026-03-09T00:00:00Z");
      if (new Date(bill.createdAt) < cutoffDate) continue; 

      const billDate = new Date(bill.createdAt);
      billDate.setMonth(billDate.getMonth() - 1); 
      const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const billingCycle = `${monthNames[billDate.getMonth()]} ${billDate.getFullYear()}`;

      for (const p of bill.payments) {
        const safeName = p.fullName ? p.fullName.replace(/,/g, "") : "Unknown";
        const dateObj = new Date(p.paidAt);
        const sqlDate = dateObj.toISOString().replace('T', ' ').substring(0, 19);
        
        csvString += `${p.telegramId},${safeName},${p.amount},${p.reference},${sqlDate},${billingCycle}\n`;
        paymentCount++;
      }
    }

    // 🔥 THE EMPTY STATE FIX: If no one has paid the REAL bill yet, 
    // we must STILL send a file to Dune to overwrite and erase the old test data!
    if (paymentCount === 0) {
      const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
      csvString += `0,Awaiting First Payment,0,PENDING,${now},Pending\n`;
    }

    await axios.post(
      "https://api.dune.com/api/v1/uploads/csv", 
      {
        table_name: "compound_payments", 
        data: csvString,
        description: "Real-time master ledger upload"
      },
      {
        headers: {
          "X-DUNE-API-KEY": process.env.DUNE_API_KEY,
          "Content-Type": "application/json" 
        }
      }
    );
    
    console.log(`✅ Event-Driven Sync: Ledger pushed to Dune instantly.`);

  } catch (err) {
    console.error("❌ Dune Real-Time Sync Error:", err.response?.data || err.message);
  }
}
/* =====================================================
   AUTOMATION: DAILY PAYMENT REMINDER (9:00 AM)
===================================================== */
/* =====================================================
   AUTOMATION: DAILY PAYMENT REMINDER (9:00 AM)
===================================================== */
// "0 9 * * *" means run at exactly 9:00 AM every day
cron.schedule("0 9 * * *", async () => {
  try {
    const bill = await Bill.findOne({ isActive: true });
    
    // If there is no active bill, do not send anything
    if (!bill) return;

    const paidIds = bill.payments.map(p => String(p.telegramId));
    const allTenantIds = bill.billedTenants.map(id => String(id));
    
    // Find the IDs of tenants who have not paid
    const unpaidIds = allTenantIds.filter(id => !paidIds.includes(id));

    // If the unpaid array is empty, everyone has paid. Skip the reminder.
    if (unpaidIds.length === 0) return;

    // Fetch the actual user profiles from MongoDB so we can tag them
    const unpaidUsers = await User.find({ telegramId: { $in: unpaidIds } });
    
    // Build a comma-separated list of tags
    const unpaidMentions = unpaidUsers.map(u => 
      u.username ? `@${u.username}` : `<a href="tg://user?id=${u.telegramId}">${u.fullName}</a>`
    ).join(", ");

    // Construct the professional HTML invoice message with the 10% warning
    const reminderMessage = 
      `⚠️ <b>DAILY UTILITY REMINDER</b> ⚠️\n\n` +
      `💰 <b>Base Amount:</b> ₦${bill.splitAmount.toLocaleString()} per flat\n` +
      `📅 <b>Deadline:</b> ${bill.dueDate.toDateString()} at Midnight\n` +
      `🚨 <i>(A 10% late fee applies automatically after this date)</i>\n\n` +
      `👥 <b>Status:</b> ${paidIds.length} out of ${bill.totalPeople} tenants have paid.\n\n` +
      `⏳ <b>Waiting on:</b> ${unpaidMentions || "Pending Tenants"}\n\n` +
      `👉 Tap /pay for Naira (Paystack)\n` +
      `👉 Tap /cryptopay for Web3 (USDC/USDT)`;

    // Broadcast the message to the main compound group
    await bot.telegram.sendMessage(process.env.GROUP_ID, reminderMessage, { parse_mode: "HTML" });
    
    console.log("✅ Sent daily formatted reminder with late fee warning.");

  } catch (err) {
    console.error("❌ Reminder Cron Error:", err);
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