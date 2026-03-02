require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const cron = require("node-cron");

const connectDB = require("./config/db");
const User = require("./models/User");
const Bill = require("./models/Bill");

connectDB();

/* =====================================================
   INIT
===================================================== */

if (!process.env.BOT_TOKEN) {
  console.error("❌ BOT_TOKEN missing in .env");
  process.exit(1);
}

if (!process.env.PAYSTACK_SECRET_KEY) {
  console.error("❌ PAYSTACK_SECRET_KEY missing in .env");
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

app.use("/paystack-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

/* =====================================================
   UTILITIES
===================================================== */

const isAdmin = (ctx) =>
  ctx.from.id.toString() === process.env.ADMIN_ID;

const safeReply = async (ctx, message, options = {}) => {
  try {
    return await ctx.reply(message, options);
  } catch (err) {
    console.error("Reply error:", err.message);
  }
};

const deleteCommandMessage = async (ctx) => {
  if (ctx.chat.type !== "private") {
    try { await ctx.deleteMessage(); } catch {}
  }
};

const getActiveBill = async () => {
  const bill = await Bill.findOne({ isActive: true });
  if (!bill) return null;

  bill.billedTenants = bill.billedTenants || [];
  bill.payments = bill.payments || [];

  return bill;
};

const formatCurrency = (amount) =>
  `₦${Number(amount || 0).toFixed(2)}`;

const mentionUser = (user) => {
  if (user.username) return `@${user.username}`;
  return `<a href="tg://user?id=${user.telegramId}">${user.fullName}</a>`;
};

/* =====================================================
   START
===================================================== */

bot.start(async (ctx) => {
  try {
    const telegramId = ctx.from.id.toString();

    let user = await User.findOne({ telegramId });

    if (!user) {
      user = await User.create({
        telegramId,
        username: ctx.from.username || "",
        fullName: `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim(),
        role: telegramId === process.env.ADMIN_ID ? "ADMIN" : "TENANT",
        isActive: true,
      });

      return safeReply(ctx, `✅ Registered as ${user.role}`);
    }

    safeReply(ctx, `👋 Welcome back ${user.fullName}`);

  } catch (err) {
    console.error(err);
    safeReply(ctx, "❌ Registration error.");
  }
});

/* =====================================================
   NEW BILL (CASE-INSENSITIVE FIX)
===================================================== */

bot.command("newbill", async (ctx) => {
  try {
    deleteCommandMessage(ctx);
    if (!isAdmin(ctx)) return;

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2)
      return safeReply(ctx, "Usage:\n/newbill 2000\n/newbill 2000 @user1 @user2");

    const amount = parseFloat(parts[1]);
    if (!amount || amount <= 0)
      return safeReply(ctx, "Invalid amount.");

    // Extract tagged usernames without forcing lowercase
    const taggedUsernames = parts
      .slice(2)
      .filter(p => p.startsWith("@"))
      .map(u => u.replace("@", ""));

    let users = [];

    if (taggedUsernames.length === 0) {
      // ALL ACTIVE USERS INCLUDING ADMIN
      users = await User.find({ isActive: true });
    } else {
      // Create case-insensitive regex for each tagged user
      const regexUsernames = taggedUsernames.map(u => new RegExp(`^${u}$`, "i"));
      
      users = await User.find({
        isActive: true,
        username: { $in: regexUsernames }
      });

      if (users.length !== taggedUsernames.length)
        return safeReply(ctx, "⚠️ Some tagged users were not found or are inactive.");

      // ALWAYS include admin
      const adminUser = await User.findOne({ telegramId: process.env.ADMIN_ID });
      if (adminUser && !users.some(u => u.telegramId.toString() === adminUser.telegramId.toString())) {
        users.push(adminUser);
      }
    }

    if (!users.length)
      return safeReply(ctx, "No users to bill.");

    const splitAmount = amount / users.length;

    await Bill.updateMany({ isActive: true }, { isActive: false });

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7);

    await Bill.create({
      totalAmount: amount,
      splitAmount,
      totalPeople: users.length,
      dueDate,
      payments: [],
      billedTenants: users.map(u => u.telegramId.toString()), // Force string IDs
      isActive: true,
      createdAt: new Date()
    });

    const mentions = users.map(mentionUser).join(" ");

    await bot.telegram.sendMessage(
      process.env.GROUP_ID,
      `⚡ <b>New Electricity Bill</b>\n\n` +
      `💰 Total: ${formatCurrency(amount)}\n` +
      `👥 Sharing: ${users.length}\n` +
      `💵 Each: ${formatCurrency(splitAmount)}\n` +
      `📅 Due: ${dueDate.toDateString()}\n\n` +
      `${mentions}`,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    console.error("NewBill error:", err);
    safeReply(ctx, "❌ Bill creation failed.");
  }
});

/* =====================================================
   PAY (ISOLATED DM HANDLING)
===================================================== */

bot.command("pay", async (ctx) => {
  try {
    deleteCommandMessage(ctx);

    const telegramId = ctx.from.id.toString();
    const user = await User.findOne({ telegramId });

    if (!user) return safeReply(ctx, "❌ Not registered. Send me a private message to register.");
    if (!user.isActive) return safeReply(ctx, "🚫 Inactive.");

    const bill = await getActiveBill();
    if (!bill) return safeReply(ctx, "❌ No active bill.");

    // Ensure strict string comparison
    const tenantIds = bill.billedTenants.map(id => id.toString());

    if (!tenantIds.includes(telegramId))
        return safeReply(ctx, "❌ You are not part of this bill.");

    if (bill.payments.some(p => p.telegramId === telegramId))
      return safeReply(ctx, "✅ Already paid.");

    if (!process.env.PAYSTACK_SECRET_KEY)
      return safeReply(ctx, "❌ Payment system not configured.");

    // 1. ISOLATED PAYSTACK INITIALIZATION
    let response;
    try {
      response = await axios.post(
        "https://api.paystack.co/transaction/initialize",
        {
          email: `${telegramId}@compound.com`,
          amount: Math.round(bill.splitAmount * 100),
          currency: "NGN",
          metadata: { telegramId }
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            "Content-Type": "application/json"
          },
          timeout: 10000
        }
      );
    } catch (paystackErr) {
      console.error("Paystack Error:", paystackErr.response?.data || paystackErr.message);
      return safeReply(ctx, "❌ Payment provider is currently unavailable.");
    }

    const link = response.data?.data?.authorization_url;

    if (!link) {
      return safeReply(ctx, "❌ Unable to generate payment link.");
    }

    // 2. ISOLATED TELEGRAM DM HANDLING
    try {
      await ctx.telegram.sendMessage(
        telegramId,
        `💳 Electricity Bill\nAmount: ${formatCurrency(bill.splitAmount)}`,
        Markup.inlineKeyboard([
          Markup.button.url("💰 Pay Now", link)
        ])
      );
      return safeReply(ctx, "🔒 Payment link sent privately. Check your DMs!");
    } catch (tgErr) {
      console.error("Telegram DM Error:", tgErr.message);
      return safeReply(
        ctx,
        "❌ I can't DM you the payment link because you haven't started a chat with me.\n\n" +
        "👉 **Please click my profile, send me a `/start` message, and then try `/pay` again.**",
        { parse_mode: "Markdown" }
      );
    }

  } catch (err) {
    console.error("PAY COMMAND FATAL ERROR:", err);
    safeReply(ctx, "❌ An unexpected error occurred.");
  }
});

/* =====================================================
   WEBHOOK
===================================================== */

app.post("/paystack-webhook", async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];
    const hash = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest("hex");

    if (hash !== signature) return res.sendStatus(401);

    const event = JSON.parse(req.body.toString());
    if (event.event !== "charge.success")
      return res.sendStatus(200);

    const telegramId = event.data.metadata.telegramId.toString();
    const reference = event.data.reference;
    const amount = event.data.amount / 100;

    const bill = await getActiveBill();
    if (!bill) return res.sendStatus(200);

    if (bill.payments.some(p => p.reference === reference))
      return res.sendStatus(200);

    const user = await User.findOne({ telegramId });

    bill.payments.push({
      telegramId,
      amount,
      reference,
      paidAt: new Date()
    });

    await bill.save();

    const userMention = user ? mentionUser(user) : "A tenant";

    await bot.telegram.sendMessage(
      process.env.GROUP_ID,
      `🎉 ${userMention} paid ${formatCurrency(amount)}`,
      { parse_mode: "HTML" }
    );

    res.sendStatus(200);

  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

/* =====================================================
   SERVER
===================================================== */

app.get("/", (req, res) =>
  res.send("🚀 Compound Billing Engine Running")
);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () =>
  console.log(`Server running on ${PORT}`)
);

bot.launch().then(() =>
  console.log("Bot running...")
);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));