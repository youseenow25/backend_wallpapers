require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const Stripe = require('stripe');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'wv-secret-key-change-in-production';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

[
  path.join(__dirname, 'uploads/covers'),
  path.join(__dirname, 'uploads/files'),
].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── PostgreSQL ────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/wallpaper',
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallpapers (
      id               SERIAL PRIMARY KEY,
      title            TEXT NOT NULL,
      description      TEXT DEFAULT '',
      price            NUMERIC(10,2) NOT NULL DEFAULT 0,
      cover_image      TEXT DEFAULT '',
      file_path        TEXT DEFAULT '',
      tags             TEXT DEFAULT '',
      featured         INTEGER DEFAULT 0,
      stripe_product_id TEXT DEFAULT '',
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Add stripe_product_id column if it doesn't exist (for existing DBs)
  await pool.query(`
    ALTER TABLE wallpapers ADD COLUMN IF NOT EXISTS stripe_product_id TEXT DEFAULT ''
  `);
  await pool.query(`
    ALTER TABLE wallpapers ADD COLUMN IF NOT EXISTS cross_sell_price_id TEXT DEFAULT ''
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS download_tokens (
      id          SERIAL PRIMARY KEY,
      token       TEXT UNIQUE NOT NULL,
      order_id    INTEGER NOT NULL,
      wallpaper_id INTEGER NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE wallpapers ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'other'
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id                SERIAL PRIMARY KEY,
      email             TEXT NOT NULL,
      wallpaper_ids     TEXT NOT NULL,
      total             NUMERIC(10,2) NOT NULL,
      status            TEXT DEFAULT 'pending',
      stripe_session_id TEXT DEFAULT '',
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_session_id TEXT DEFAULT ''
  `);

  const { rows } = await pool.query('SELECT COUNT(*) AS c FROM wallpapers');
  if (parseInt(rows[0].c, 10) === 0) {
    const seeds = [
      ['Neon Tokyo',     'A vibrant cityscape bathed in electric neon light at midnight.',  6.99, 'https://picsum.photos/seed/neon1/900/600',     'city,neon,night',        1],
      ['Arctic Silence', 'Frozen tundra shimmering beneath the dancing northern lights.',   7.99, 'https://picsum.photos/seed/arctic2/900/600',   'nature,winter,aurora',   1],
      ['Desert Dusk',    'Golden hour melting over vast, rolling sand dunes.',              6.99, 'https://picsum.photos/seed/desert3/900/600',   'nature,desert,sunset',   0],
      ['Ocean Drift',    'Deep ocean gradients in teal and midnight blue.',                 8.99, 'https://picsum.photos/seed/ocean4/900/600',    'abstract,ocean,minimal', 1],
      ['Mountain Mist',  'Alpine peaks emerging dramatically from morning fog.',            7.99, 'https://picsum.photos/seed/mountain5/900/600', 'nature,mountain',        0],
      ['Urban Grid',     'Geometric city patterns captured from high above.',               6.99, 'https://picsum.photos/seed/urban6/900/600',    'city,minimal,abstract',  0],
      ['Crimson Bloom',  'Macro photography of a scarlet poppy in full bloom.',             8.99, 'https://picsum.photos/seed/flower7/900/600',   'nature,macro,floral',    1],
      ['Void Minimal',   'Pure geometric abstraction — black, void, and form.',             5.99, 'https://picsum.photos/seed/minimal8/900/600',  'abstract,minimal',       0],
    ];
    for (const [title, desc, price, img, tags, featured] of seeds) {
      await pool.query(
        'INSERT INTO wallpapers (title, description, price, cover_image, tags, featured) VALUES ($1,$2,$3,$4,$5,$6)',
        [title, desc, price, img, tags, featured],
      );
    }
    console.log('  Seeded 8 demo wallpapers');
  }
}

// ── Stripe: discount tiers ────────────────────────────────────────────────────

const DISCOUNT_TIERS = [
  { minItems: 5, percent: 50 },
  { minItems: 3, percent: 40 },
  { minItems: 2, percent: 30 },
];

function getDiscountTier(totalItems) {
  return DISCOUNT_TIERS.find(d => totalItems >= d.minItems) || null;
}

const CROSS_SELL_DISCOUNT_PERCENT = 15;

// Returns a Stripe Price ID discounted by CROSS_SELL_DISCOUNT_PERCENT for the
// given wallpaper, creating (and caching in the DB) one if it doesn't exist yet.
async function getOrCreateCrossSellPrice(w) {
  if (w.cross_sell_price_id) return w.cross_sell_price_id;
  if (!w.stripe_product_id) return null;
  const discountedCents = Math.round(Number(w.price) * 100 * (1 - CROSS_SELL_DISCOUNT_PERCENT / 100));
  const price = await stripe.prices.create({
    product: w.stripe_product_id,
    unit_amount: discountedCents,
    currency: 'usd',
  });
  await pool.query('UPDATE wallpapers SET cross_sell_price_id = $1 WHERE id = $2', [price.id, w.id]);
  return price.id;
}


// ── Stripe: sync wallpapers to Stripe Products ───────────────────────────────

async function syncWallpapersToStripe() {
  const { rows: wallpapers } = await pool.query(
    "SELECT id, title, description, price, cover_image FROM wallpapers WHERE stripe_product_id = '' OR stripe_product_id IS NULL"
  );
  for (const w of wallpapers) {
    try {
      const images = w.cover_image
        ? (w.cover_image.startsWith('http') ? [w.cover_image] : [`${BACKEND_URL}${w.cover_image}`])
        : [];
      const product = await stripe.products.create({
        name: w.title,
        description: w.description || undefined,
        images,
        metadata: { wallpaper_id: String(w.id) },
      });
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(Number(w.price) * 100),
        currency: 'usd',
      });
      await stripe.products.update(product.id, { default_price: price.id });
      await pool.query(
        'UPDATE wallpapers SET stripe_product_id = $1 WHERE id = $2',
        [product.id, w.id],
      );
      console.log(`  Synced "${w.title}" → ${product.id} @ $${w.price}`);
    } catch (err) {
      console.warn(`  Could not sync "${w.title}" to Stripe: ${err.message}`);
    }
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  FRONTEND_URL,
  'https://outbbo.com',
  'https://www.outbbo.com',
  'https://app.outbbo.com',
  'https://wallpapers-i14ny5wfe-aanhari2026-4185s-projects.vercel.app',
  'https://wallpapers-nnwa9i980-aanhari2026-4185s-projects.vercel.app',
  'https://wallpapers-cyan.vercel.app',
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// ── Multer ────────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, file.fieldname === 'cover'
      ? path.join(__dirname, 'uploads/covers')
      : path.join(__dirname, 'uploads/files'));
  },
  filename(req, file, cb) {
    cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ── Watermarked cover images ──────────────────────────────────────────────────

const coverCache = new Map(); // simple in-memory cache

function makeWatermarkSvg(width, height) {
  const fontSize = Math.max(14, Math.min(24, Math.round(width / 25)));
  const colStep = fontSize * 7;
  const rowStep = fontSize * 4;
  const texts = [];
  for (let row = -2; row < Math.ceil(height / rowStep) + 2; row++) {
    for (let col = -2; col < Math.ceil(width / colStep) + 2; col++) {
      const x = col * colStep + (row % 2 === 0 ? 0 : colStep / 2);
      const y = row * rowStep;
      texts.push(
        `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${fontSize}" letter-spacing="3" fill="rgba(255,255,255,0.28)" transform="rotate(-30,${x},${y})">outbbo</text>`
      );
    }
  }
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${texts.join('')}</svg>`);
}

function fetchImageBuffer(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (url.startsWith('/')) {
      // Local file
      const abs = path.join(__dirname, url.replace(/^\//, ''));
      if (fs.existsSync(abs)) return resolve(fs.readFileSync(abs));
      return reject(new Error('File not found: ' + url));
    }
    const mod = url.startsWith('https') ? require('https') : require('http');
    mod.get(url, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        return resolve(fetchImageBuffer(res.headers.location, redirects - 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

app.get('/api/covers/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (coverCache.has(id)) {
      const cached = coverCache.get(id);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(cached);
    }

    const { rows } = await pool.query('SELECT cover_image FROM wallpapers WHERE id = $1', [id]);
    if (!rows[0]?.cover_image) return res.status(404).end();

    const raw = await fetchImageBuffer(rows[0].cover_image);
    const image = sharp(raw);
    const { width, height } = await image.metadata();
    const wm = makeWatermarkSvg(width, height);

    const output = await image
      .composite([{ input: wm, blend: 'over' }])
      .jpeg({ quality: 82 })
      .toBuffer();

    // Cap cache at 100 entries
    if (coverCache.size >= 100) coverCache.delete(coverCache.keys().next().value);
    coverCache.set(id, output);

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(output);
  } catch (err) {
    console.error('Cover watermark error:', err.message);
    res.status(500).end();
  }
});

// ── Auth ──────────────────────────────────────────────────────────────────────

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── Public API ────────────────────────────────────────────────────────────────

app.get('/api/wallpapers', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, description, price, cover_image, tags, featured, type, created_at FROM wallpapers ORDER BY featured DESC, created_at DESC',
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/wallpapers/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, description, price, cover_image, tags, featured, type, created_at FROM wallpapers WHERE id = $1',
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Stripe Checkout ───────────────────────────────────────────────────────────

app.post('/api/checkout/session', async (req, res) => {
  try {
    const { items, email } = req.body;
    if (!Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'No items provided' });

    // Fetch authoritative prices from DB — never trust client-submitted prices
    const ids = items.map(i => parseInt(i.id, 10)).filter(Boolean);
    const { rows: wallpapers } = await pool.query(
      `SELECT id, title, description, price, cover_image, stripe_product_id
       FROM wallpapers WHERE id = ANY($1)`,
      [ids],
    );
    if (!wallpapers.length) return res.status(400).json({ error: 'No valid wallpapers' });

    const wallpaperMap = Object.fromEntries(wallpapers.map(w => [w.id, w]));
    const totalItems = items.reduce((s, i) => s + (i.quantity || 1), 0);
    const discount = getDiscountTier(totalItems);

    const line_items = items.map(item => {
      const w = wallpaperMap[parseInt(item.id, 10)];
      if (!w) return null;
      const originalCents = Math.round(Number(w.price) * 100);
      const discountedCents = discount
        ? Math.round(originalCents * (1 - discount.percent / 100))
        : originalCents;
      return {
        price_data: {
          currency: 'usd',
          product_data: {
            name: w.title,
            description: discount
              ? `${discount.percent}% bundle discount applied — original price $${Number(w.price).toFixed(2)}`
              : (w.description?.slice(0, 200) || undefined),
            images: (() => {
              if (!w.cover_image) return [];
              if (w.cover_image.startsWith('http')) return [w.cover_image];
              return [`${BACKEND_URL}${w.cover_image}`];
            })(),
            metadata: { wallpaper_id: String(w.id) },
          },
          unit_amount: discountedCents,
        },
        quantity: item.quantity || 1,
      };
    }).filter(Boolean);

    // Cross-sells: suggest a couple of related wallpapers (not already in the
    // cart) at a discount, shown by Stripe directly on the Checkout page.
    const { rows: crossSellCandidates } = await pool.query(
      `SELECT id, title, price, stripe_product_id, cross_sell_price_id FROM wallpapers
       WHERE NOT (id = ANY($1)) AND stripe_product_id != ''
       ORDER BY featured DESC, created_at DESC LIMIT 2`,
      [ids],
    );
    const optional_items = [];
    for (const w of crossSellCandidates) {
      const priceId = await getOrCreateCrossSellPrice(w).catch(() => null);
      if (priceId) {
        optional_items.push({
          price: priceId,
          quantity: 1,
          adjustable_quantity: { enabled: true, minimum: 0, maximum: 1 },
        });
      }
    }

    const sessionParams = {
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      success_url: `${FRONTEND_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/catalog`,
      metadata: {
        wallpaper_ids: JSON.stringify(ids),
        discount_percent: String(discount?.percent || 0),
      },
    };
    if (optional_items.length) sessionParams.optional_items = optional_items;
    if (email) sessionParams.customer_email = email;

    const session = await stripe.checkout.sessions.create(sessionParams);
    const subtotal = items.reduce((s, i) => {
      const w = wallpaperMap[parseInt(i.id, 10)];
      return w ? s + Number(w.price) * (i.quantity || 1) : s;
    }, 0);
    const discountSaved = discount ? subtotal * (discount.percent / 100) : 0;
    res.json({
      url: session.url,
      discountPercent: discount?.percent || 0,
      discountSaved: Math.round(discountSaved * 100) / 100,
    });
  } catch (err) {
    console.error('Stripe session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/checkout/verify/:sessionId', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    if (session.payment_status !== 'paid')
      return res.status(402).json({ error: 'Payment not complete' });

    // Idempotent — only create order once per session
    const { rows: existing } = await pool.query(
      'SELECT id FROM orders WHERE stripe_session_id = $1',
      [session.id],
    );
    let orderId = existing[0]?.id;
    if (!orderId) {
      // Derive what was actually purchased from Stripe's own line items —
      // not just the metadata captured at session creation — so any
      // cross-sell item the customer added on the Checkout page is included.
      const { data: lineItems } = await stripe.checkout.sessions.listLineItems(session.id, {
        expand: ['data.price.product'],
        limit: 100,
      });
      const purchasedIds = lineItems
        .map(li => li.price?.product?.metadata?.wallpaper_id)
        .filter(Boolean)
        .map(id => parseInt(id, 10));
      const wallpaper_ids = JSON.stringify(
        purchasedIds.length ? purchasedIds : JSON.parse(session.metadata?.wallpaper_ids || '[]'),
      );
      const { rows } = await pool.query(
        'INSERT INTO orders (email, wallpaper_ids, total, status, stripe_session_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [session.customer_email || '', wallpaper_ids, session.amount_total / 100, 'paid', session.id],
      );
      orderId = rows[0].id;

      const ids = JSON.parse(wallpaper_ids);
      if (ids.length) {
        const { rows: wps } = await pool.query(
          'SELECT id, title FROM wallpapers WHERE id = ANY($1)',
          [ids],
        );
        await createDownloadTokens(orderId, wps);
      }
    }

    const { rows: tokenRows } = await pool.query(
      `SELECT dt.token, w.title FROM download_tokens dt
       JOIN wallpapers w ON w.id = dt.wallpaper_id
       WHERE dt.order_id = $1 ORDER BY dt.id`,
      [orderId],
    );
    const downloads = tokenRows.map(r => ({ title: r.title, url: `${BACKEND_URL}/api/download/${r.token}` }));

    res.json({
      orderId,
      email: session.customer_email,
      total: session.amount_total / 100,
      discountPercent: parseInt(session.metadata?.discount_percent || '0', 10),
      downloads,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Download delivery ─────────────────────────────────────────────────────────

async function createDownloadTokens(orderId, wallpapers) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  for (const w of wallpapers) {
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'INSERT INTO download_tokens (token, order_id, wallpaper_id, expires_at) VALUES ($1,$2,$3,$4)',
      [token, orderId, w.id, expiresAt],
    );
  }
}

app.get('/api/download/:token', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT dt.*, w.file_path, w.title
       FROM download_tokens dt
       JOIN wallpapers w ON w.id = dt.wallpaper_id
       WHERE dt.token = $1`,
      [req.params.token],
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Invalid download link' });
    if (new Date(row.expires_at) < new Date())
      return res.status(410).json({ error: 'Download link has expired' });
    if (!row.file_path)
      return res.status(404).json({ error: 'No file attached to this wallpaper yet' });

    const absPath = path.join(__dirname, row.file_path.replace(/^\//, ''));
    if (!fs.existsSync(absPath))
      return res.status(404).json({ error: 'File not found on server' });

    const ext = path.extname(row.file_path) || '.zip';
    const filename = `${row.title.replace(/[^a-z0-9]/gi, '_')}${ext}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(absPath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── All-wallpapers bundle checkout ($24.99) ───────────────────────────────────

app.post('/api/checkout/all-bundle', async (req, res) => {
  try {
    const { email } = req.body;
    const { rows: wallpapers } = await pool.query(
      'SELECT id, title FROM wallpapers ORDER BY id',
    );
    if (!wallpapers.length) return res.status(400).json({ error: 'No wallpapers available' });

    const ids = wallpapers.map(w => w.id);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Complete Wallpaper Collection',
            description: `All ${wallpapers.length} wallpapers — yours forever`,
          },
          unit_amount: 2499,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${FRONTEND_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/catalog`,
      metadata: {
        wallpaper_ids: JSON.stringify(ids),
        discount_percent: '0',
        is_all_bundle: 'true',
      },
      ...(email ? { customer_email: email } : {}),
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Bundle session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Legacy order endpoint (kept for compatibility)
app.post('/api/orders', async (req, res) => {
  const { email, wallpaper_ids, total } = req.body;
  if (!email || !Array.isArray(wallpaper_ids) || !wallpaper_ids.length || !total)
    return res.status(400).json({ error: 'Missing fields' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO orders (email, wallpaper_ids, total) VALUES ($1,$2,$3) RETURNING id',
      [email, JSON.stringify(wallpaper_ids), total],
    );
    res.json({ id: rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin API ─────────────────────────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Invalid username or password' });
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

app.get('/api/admin/wallpapers', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM wallpapers ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/wallpapers', auth,
  upload.fields([{ name: 'cover', maxCount: 1 }, { name: 'file', maxCount: 1 }]),
  async (req, res) => {
    const { title, description, price, tags, featured, type } = req.body;
    if (!title || !price) return res.status(400).json({ error: 'Title and price required' });
    const cover_image = req.files?.cover?.[0] ? `/uploads/covers/${req.files.cover[0].filename}` : '';
    const file_path   = req.files?.file?.[0]  ? `/uploads/files/${req.files.file[0].filename}`   : '';
    try {
      const { rows } = await pool.query(
        'INSERT INTO wallpapers (title, description, price, cover_image, file_path, tags, featured, type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [title, description || '', parseFloat(price), cover_image, file_path, tags || '', featured === 'true' ? 1 : 0, type || 'other'],
      );
      const newId = rows[0].id;
      // Sync to Stripe in background
      syncWallpapersToStripe().catch(console.warn);
      res.json({ id: newId });
    } catch (err) { res.status(500).json({ error: err.message }); }
  },
);

app.put('/api/admin/wallpapers/:id', auth,
  upload.fields([{ name: 'cover', maxCount: 1 }, { name: 'file', maxCount: 1 }]),
  async (req, res) => {
    try {
      const { rows: ex } = await pool.query('SELECT * FROM wallpapers WHERE id = $1', [req.params.id]);
      if (!ex[0]) return res.status(404).json({ error: 'Not found' });
      const e = ex[0];
      const { title, description, price, tags, featured, type } = req.body;
      const cover_image = req.files?.cover?.[0] ? `/uploads/covers/${req.files.cover[0].filename}` : e.cover_image;
      const file_path   = req.files?.file?.[0]  ? `/uploads/files/${req.files.file[0].filename}`   : e.file_path;
      await pool.query(
        'UPDATE wallpapers SET title=$1, description=$2, price=$3, cover_image=$4, file_path=$5, tags=$6, featured=$7, type=$8 WHERE id=$9',
        [
          title        ?? e.title,
          description  ?? e.description,
          price        ? parseFloat(price) : e.price,
          cover_image, file_path,
          tags         ?? e.tags,
          featured === 'true' ? 1 : featured === 'false' ? 0 : e.featured,
          type         ?? e.type ?? 'other',
          req.params.id,
        ],
      );
      // Bust the cached watermarked cover so a replaced image is served fresh.
      if (req.files?.cover?.[0]) coverCache.delete(String(req.params.id));
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  },
);

app.delete('/api/admin/wallpapers/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM wallpapers WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/orders', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100');

    // Enrich each order with wallpaper titles and Stripe payment link
    const enriched = await Promise.all(rows.map(async (order) => {
      let wallpaperTitles = [];
      try {
        const ids = JSON.parse(order.wallpaper_ids || '[]');
        if (ids.length) {
          const { rows: wps } = await pool.query(
            'SELECT id, title FROM wallpapers WHERE id = ANY($1)', [ids]
          );
          wallpaperTitles = wps.map(w => w.title);
        }
      } catch {}

      let stripeUrl = null;
      let paymentStatus = order.status;
      if (order.stripe_session_id) {
        try {
          const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id, {
            expand: ['payment_intent'],
          });
          paymentStatus = session.payment_status;
          const piId = typeof session.payment_intent === 'object'
            ? session.payment_intent?.id
            : session.payment_intent;
          if (piId) stripeUrl = `https://dashboard.stripe.com/payments/${piId}`;
        } catch {}
      }

      return { ...order, wallpaperTitles, stripeUrl, paymentStatus };
    }));

    res.json(enriched);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function start() {
  await initDb();
  await syncWallpapersToStripe();

  app.listen(PORT, () => {
    console.log(`\n  ┌────────────────────────────────────────────────┐`);
    console.log(`  │  WALLVAULT API  →  http://localhost:${PORT}         │`);
    console.log(`  │  Admin Panel   →  http://localhost:${PORT}/admin    │`);
    console.log(`  │  Stripe        →  LIVE mode (rk_live_***)       │`);
    console.log(`  └────────────────────────────────────────────────┘\n`);
  });
}

start().catch(err => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});
