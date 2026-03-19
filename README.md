#  CompoundOS AND The Oracle

An automated, event-driven utility billing engine and Web3 financial transparency protocol built for residential compounds. 

This repository houses **CompoundOS** (the backend architecture) and **The Oracle** (the Telegram bot interface). Together, they replace manual spreadsheet tracking with dual-currency payment gateways, automated penalty logic, and a real-time data pipeline that pushes immutable financial ledgers directly to a public Dune Analytics dashboard.

## System Architecture

The system is built on a modern Node.js stack with a strict separation of concerns:

1. **The Interface (The Oracle Bot):** Tenants register, receive bill notifications, and request checkout links entirely within Telegram using the Telegraf API.
2. **The Database (MongoDB):** Maintains user states, active billing cycles, and embedded payment arrays.
3. **The Gateways (Express Webhooks):** Listens for asynchronous payment confirmations from Paystack (Fiat/Bank Transfers) and NowPayments (Web3/USDC/USDT).
4. **The Analytics Engine (Dune API):** An event-driven function triggers on every successful webhook, dynamically generating a master CSV ledger and pushing it to Dune Analytics to instantly update the public dashboard.

## Core Features

* **Dual-Currency Checkouts:** Tenants can pay their split in Fiat (Naira) or Crypto (Stablecoins on Base, Polygon, Solana, etc.).
* **Automated Penalty Logic:** The system tracks a 7-day grace period and automatically applies a mathematically precise 10% late fee to any checkout link generated after the deadline.
* **Real-Time Data Pipeline:** Moves away from cron jobs to an event-driven architecture. The moment a transaction clears on-chain or in the bank, the Dune dashboard updates.
* **Gamified Transparency:** The Dune dashboard features a "Settlement Leaderboard" (awarding 🥇🥈🥉 to the fastest payers), payment velocity tracking, and a public audit ledger.
* **Admin Command Center:** Secure, hidden commands (`/newbill`, `/broadcast`, `/markpaid`, `/forcesync`) allow the admin to manage the entire compound from their phone.

## Tech Stack

* **Backend:** Node.js, Express
* **Bot Framework:** Telegraf (Telegram API)
* **Database:** MongoDB / Mongoose
* **Payment Gateways:** Paystack API, NowPayments Web3 API
* **Data Visualization:** Dune Analytics (API & DuneSQL)

## Environment Setup

To run this engine locally, you will need the following environment variables in your `.env` file:

\`\`\`env
BOT_TOKEN=your_telegram_bot_token
ADMIN_ID=your_telegram_user_id
GROUP_ID=the_compound_telegram_group_id
MONGO_URI=your_mongodb_connection_string

# Payment Gateways
PAYSTACK_SECRET_KEY=your_paystack_key
NOWPAYMENTS_API_KEY=your_nowpayments_key
NOWPAYMENTS_IPN_SECRET=your_nowpayments_ipn_secret

# Data Pipeline
DUNE_API_KEY=your_dune_analytics_api_key
\`\`\`
