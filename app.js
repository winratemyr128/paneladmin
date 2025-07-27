const express = require('express');
const fileUpload = require('express-fileupload');
const path = require('path');
const http = require('http');
const socketIO = require('socket.io');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_PREMIUM_ID = process.env.CHANNEL_PREMIUM_ID;
const CHANNEL_LIFETIME_ID = process.env.CHANNEL_LIFETIME_ID;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!BOT_TOKEN || !CHANNEL_PREMIUM_ID || !CHANNEL_LIFETIME_ID) {
  console.error('ERROR: BOT_TOKEN atau CHANNEL ID belum diset di file .env');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const PORT = process.env.PORT || 3000;
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const transactionsFile = path.join(__dirname, 'transactions.json');
let transactions = [];

function loadTransactions() {
  try {
    if (fs.existsSync(transactionsFile)) {
      const data = fs.readFileSync(transactionsFile, 'utf-8');
      transactions = JSON.parse(data);
      if (!Array.isArray(transactions)) transactions = [];
    } else {
      transactions = [];
    }
  } catch (error) {
    console.error('Gagal load transactions:', error);
    transactions = [];
  }
}

function saveTransactions() {
  try {
    fs.writeFileSync(transactionsFile, JSON.stringify(transactions, null, 2), 'utf-8');
  } catch (error) {
    console.error('Gagal simpan transactions:', error);
  }
}

loadTransactions();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({ createParentPath: true }));
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

app.use(session({
  secret: process.env.SESSION_SECRET || 'default_secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

function isAuthenticated(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.redirect('/login');
}

// Login
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    return res.redirect('/');
  }
  return res.render('login', { error: 'Username atau password salah' });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Dashboard (terproteksi)
app.get('/', isAuthenticated, (req, res) => {
  res.render('dashboard', { transactions });
});

// Delete transaksi
function removeTransactionById(id) {
  const index = transactions.findIndex(t => t.id === id);
  if (index === -1) return false;

  const transaksi = transactions[index];
  if (transaksi.buktiPath) {
    const filePath = path.join(__dirname, transaksi.buktiPath.replace(/^\//, ''));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  transactions.splice(index, 1);
  saveTransactions();
  io.emit('delete_transaction', { id });
  return true;
}

async function generateInviteLink(chatId) {
  try {
    const inviteLink = await bot.createChatInviteLink(chatId, {
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 86400,
    });
    return inviteLink.invite_link;
  } catch (error) {
    console.error(`Gagal generate invite link:`, error.response?.body || error.message);
    return null;
  }
}

app.post('/api/approve/:id', isAuthenticated, async (req, res) => {
  const id = req.params.id;
  const transaksi = transactions.find(t => t.id === id);
  if (!transaksi) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });

  const userId = transaksi.userId;
  const paket = transaksi.paket.toLowerCase();

  try {
    const messages = [];
    if (paket === 'lifetime') {
      const link1 = await generateInviteLink(CHANNEL_PREMIUM_ID);
      const link2 = await generateInviteLink(CHANNEL_LIFETIME_ID);
      if (!link1 || !link2) return res.status(500).json({ error: 'Gagal membuat link invite' });
      messages.push(`🎉 Transaksi abang dah LULUS untuk pakej *Lifetime*!`);
      messages.push(`👉 Join Premium:\n${link1}`);
      messages.push(`👉 Join Lifetime:\n${link2}`);
    } else {
      const link = await generateInviteLink(CHANNEL_PREMIUM_ID);
      if (!link) return res.status(500).json({ error: 'Gagal membuat link invite' });
      messages.push(`🎉 Transaksi abang dah LULUS untuk pakej *${paket}*!\n👉 Join Premium:\n${link}`);
    }

    for (const msg of messages) {
      await bot.sendMessage(userId, msg, { parse_mode: 'Markdown' });
    }

    if (!removeTransactionById(id)) {
      return res.status(500).json({ error: 'Gagal hapus transaksi' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error approve:', error.response?.body || error.message);
    res.status(500).json({ error: 'Terjadi kesalahan' });
  }
});

app.post('/api/tolak/:id', isAuthenticated, async (req, res) => {
  const id = req.params.id;
  const transaksi = transactions.find(t => t.id === id);
  if (!transaksi) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });

  try {
    await bot.sendMessage(
      transaksi.userId,
      `⚠️ Maaf ya bossku, transaksi tak dapat diluluskan oleh admin.\n\nNak tahu sebab? Boleh tanya sini 👉 @selvimyr128`
    );
  } catch (error) {
    console.error('Gagal kirim pesan penolakan:', error.response?.body || error.message);
  }

  if (!removeTransactionById(id)) return res.status(500).json({ error: 'Gagal hapus transaksi' });

  res.json({ success: true });
});

app.post('/api/contact-customer/:id', isAuthenticated, async (req, res) => {
  const id = req.params.id;
  const transaksi = transactions.find(t => t.id === id);
  if (!transaksi) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });

  const msg = `📢 Hal yang perlu anda buat sekarang:\n\nSila mesej admin di sini 👉 @selvimyr128\n\nDan minta:\n✅ ID Game anda\n✅ Tolong approve transaksi anda supaya boleh join Channel Premium`;

  try {
    await bot.sendMessage(transaksi.userId, msg, { parse_mode: 'Markdown' });
    res.json({ success: true });
  } catch (error) {
    console.error('Gagal kirim pesan:', error.response?.body || error.message);
    res.status(500).json({ error: 'Gagal kirim pesan' });
  }
});

app.post('/api/bukti', async (req, res) => {
  try {
    const { userId, username, paket } = req.body;
    const bukti = req.files?.bukti;
    if (!userId || !username || !paket || !bukti) return res.status(400).json({ error: 'Data tidak lengkap' });

    const fileExt = path.extname(bukti.name);
    const buktiFilename = `${Date.now()}_${uuidv4()}${fileExt}`;
    const buktiPath = path.join(uploadsDir, buktiFilename);
    const relativePath = `/uploads/${buktiFilename}`;

    await bukti.mv(buktiPath);

    const newTransaction = {
      id: uuidv4(),
      userId,
      username,
      paket,
      buktiPath: relativePath,
      timestamp: new Date().toISOString(),
      status: 'pending'
    };

    transactions.push(newTransaction);
    saveTransactions();
    io.emit('new_transaction', newTransaction);

    return res.json({ success: true });
  } catch (error) {
    console.error('Gagal simpan bukti:', error.response?.body || error.message);
    return res.status(500).json({ error: 'Gagal simpan bukti' });
  }
});

io.on('connection', (socket) => {
  console.log('User connected via Socket.IO:', socket.id);
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
});
