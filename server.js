require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "chebrox",
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

const productFields = `
  p.id, p.name, p.sku, p.category, p.laboratory, p.stock,
  p.entry_date AS entryDate, p.expiration, p.price, p.sale_price AS salePrice,
  p.wholesale, p.status, pr.name AS provider, pr.ruc AS providerRuc,
  pr.id AS providerId
`;

async function findProvider(connection, name, ruc) {
  const [rows] = await connection.execute(
    "SELECT id, name, ruc FROM providers WHERE name = ? OR ruc = ? LIMIT 1",
    [name, ruc],
  );
  return rows[0];
}

async function ensureProvider(connection, name, ruc) {
  const existing = await findProvider(connection, name, ruc);
  if (existing) return existing;
  const [result] = await connection.execute(
    "INSERT INTO providers (name, ruc) VALUES (?, ?)",
    [name, ruc],
  );
  return { id: result.insertId, name, ruc };
}

async function getProductBySku(connection, sku) {
  const [rows] = await connection.execute(
    `SELECT ${productFields} FROM products p JOIN providers pr ON pr.id = p.provider_id WHERE p.sku = ?`,
    [sku],
  );
  return rows[0];
}

function productPayload(body) {
  return {
    name: String(body.name || "").trim(),
    sku: String(body.sku || "").trim(),
    category: String(body.category || "Medicamentos").trim(),
    laboratory: String(body.laboratory || "").trim(),
    stock: Number(body.stock || 0),
    entryDate: body.entryDate || new Date().toISOString().slice(0, 10),
    expiration: body.expiration || null,
    price: Number(body.price || 0),
    salePrice: Number(body.salePrice || 0),
    wholesale: Number(body.wholesale || Number(body.stock || 0) * Number(body.price || 0)),
    status: body.status === "pending" ? "pending" : "active",
  };
}

app.post("/api/auth/login", (req, res) => {
  const valid = String(req.body.pin || "") === String(process.env.CHEBROX_PIN || "2026");
  if (!valid) return res.status(401).json({ error: "PIN incorrecto." });
  return res.json({ authenticated: true });
});

app.get("/api/bootstrap", async (req, res, next) => {
  try {
    const [providers] = await pool.query("SELECT id, name, ruc FROM providers ORDER BY name");
    const [products] = await pool.query(`SELECT ${productFields} FROM products p JOIN providers pr ON pr.id = p.provider_id ORDER BY p.created_at DESC`);
    const [orders] = await pool.query(`SELECT ${productFields}, o.order_quantity AS orderQuantity, o.added_at AS addedAt, pr.name AS recommendedProvider FROM orders o JOIN products p ON p.id = o.product_id JOIN providers pr ON pr.id = p.provider_id ORDER BY o.added_at DESC`);
    res.json({ providers, products: products.filter((product) => product.status === "active"), pendingProducts: products.filter((product) => product.status === "pending"), orders });
  } catch (error) { next(error); }
});

app.get("/api/providers", async (req, res, next) => {
  try { const [rows] = await pool.query("SELECT id, name, ruc FROM providers ORDER BY name"); res.json(rows); } catch (error) { next(error); }
});

app.post("/api/providers", async (req, res, next) => {
  const name = String(req.body.name || "").trim();
  const ruc = String(req.body.ruc || "").trim();
  if (!name || !/^\d{11}$/.test(ruc)) return res.status(400).json({ error: "Nombre y RUC válido son obligatorios." });
  try {
    const [result] = await pool.execute("INSERT INTO providers (name, ruc) VALUES (?, ?)", [name, ruc]);
    res.status(201).json({ id: result.insertId, name, ruc });
  } catch (error) { next(error); }
});

app.delete("/api/providers/:id", async (req, res, next) => {
  try { await pool.execute("DELETE FROM providers WHERE id = ?", [req.params.id]); res.status(204).end(); } catch (error) { next(error); }
});

app.post("/api/products", async (req, res, next) => {
  const product = productPayload(req.body);
  if (!product.name || !product.sku || product.stock <= 0) return res.status(400).json({ error: "Nombre, ID y cantidad válida son obligatorios." });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const provider = await ensureProvider(connection, String(req.body.provider || "").trim(), String(req.body.providerRuc || "00000000000").trim());
    await connection.execute(
      `INSERT INTO products (name, sku, category, laboratory, stock, entry_date, expiration, provider_id, price, sale_price, wholesale, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name=VALUES(name), category=VALUES(category), laboratory=VALUES(laboratory), stock=VALUES(stock), entry_date=VALUES(entry_date), expiration=VALUES(expiration), provider_id=VALUES(provider_id), price=VALUES(price), sale_price=VALUES(sale_price), wholesale=VALUES(wholesale), status=VALUES(status)`,
      [product.name, product.sku, product.category, product.laboratory, product.stock, product.entryDate, product.expiration, provider.id, product.price, product.salePrice, product.wholesale, product.status],
    );
    await connection.commit();
    res.status(201).json(await getProductBySku(connection, product.sku));
  } catch (error) { await connection.rollback(); next(error); } finally { connection.release(); }
});

app.put("/api/products/:sku", async (req, res, next) => {
  req.body.sku = req.params.sku;
  req.method = "POST";
  req.url = "/api/products";
  return app._router.handle(req, res, next);
});

app.delete("/api/products/:sku", async (req, res, next) => {
  try { await pool.execute("DELETE FROM products WHERE sku = ?", [req.params.sku]); res.status(204).end(); } catch (error) { next(error); }
});

app.delete("/api/products", async (req, res, next) => {
  try { await pool.query("DELETE FROM products"); res.status(204).end(); } catch (error) { next(error); }
});

app.post("/api/orders", async (req, res, next) => {
  try {
    const [product] = await pool.execute("SELECT id FROM products WHERE sku = ?", [req.body.sku]);
    if (!product[0]) return res.status(404).json({ error: "Producto no encontrado." });
    await pool.execute("INSERT INTO orders (product_id, order_quantity) VALUES (?, ?) ON DUPLICATE KEY UPDATE order_quantity = VALUES(order_quantity)", [product[0].id, Math.max(1, Number(req.body.orderQuantity || 1))]);
    res.status(201).json({ saved: true });
  } catch (error) { next(error); }
});

app.put("/api/orders/:sku", async (req, res, next) => {
  try { await pool.execute("UPDATE orders o JOIN products p ON p.id = o.product_id SET o.order_quantity = ? WHERE p.sku = ?", [Math.max(1, Number(req.body.orderQuantity || 1)), req.params.sku]); res.json({ saved: true }); } catch (error) { next(error); }
});

app.delete("/api/orders/:sku", async (req, res, next) => {
  try { await pool.execute("DELETE o FROM orders o JOIN products p ON p.id = o.product_id WHERE p.sku = ?", [req.params.sku]); res.status(204).end(); } catch (error) { next(error); }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.code === "ER_DUP_ENTRY" ? 409 : 500).json({ error: "No se pudo completar la operación." });
});

app.listen(port, () => console.log(`CHEBROX disponible en http://localhost:${port}`));
