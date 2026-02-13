const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createWorker } = require('tesseract.js'); 
const Jimp = require('jimp');
const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// --- Database Connection ---
// ⚠️ อย่าลืมแก้ password ให้ตรงกับเครื่องตัวเองนะครับ
const pool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: 5432,
});

// --- Upload Config ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `meter-${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

const LOCAL_TESSDATA = path.join(__dirname, 'tessdata');

// ================= API ROUTES =================

// 1. Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'ไม่พบชื่อผู้ใช้' });
    const user = result.rows[0];
    if (password !== user.password) return res.status(401).json({ error: 'รหัสผ่านผิด' });
    res.json({ success: true, user: { id: user.id, username: user.username, name: user.full_name } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. OCR Service
app.post('/api/ocr', upload.single('image'), async (req, res) => {
  let worker = null; 
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });
    const meterType = req.body.meter_type || 'water';
    const processedPath = path.join(__dirname, 'uploads', `processed-${req.file.filename}`);
    const image = await Jimp.read(req.file.path);

    // Image Processing
    if (meterType === 'electric') {
      await image.resize(1000, Jimp.AUTO); 
      if (image.bitmap.height < 500) {
        await image.greyscale().invert().contrast(0.4).writeAsync(processedPath);
      } else {
        await image.crop(150, 350, 550, 150).greyscale().invert().contrast(0.4).writeAsync(processedPath);
      }
    } else {
      await image.resize(1000, Jimp.AUTO).greyscale().normalize().contrast(0.8).writeAsync(processedPath);
    }

    worker = await createWorker('eng', 1, {
        langPath: LOCAL_TESSDATA, gzip: false, cachePath: LOCAL_TESSDATA, logger: m => {} 
    });
    await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
    const { data: { text } } = await worker.recognize(processedPath);
    const cleanedText = text.replace(/[^0-9]/g, '').trim();

    if (!cleanedText) return res.json({ success: false, error: "มองไม่เห็นตัวเลข", image_path: `uploads/${req.file.filename}` });
    res.json({ success: true, reading: cleanedText, image_path: `uploads/${req.file.filename}`, meter_type: meterType });

  } catch (error) { 
    console.error('OCR Error:', error.message);
    res.status(500).json({ success: false, error: "Error processing image" }); 
  } finally {
    if (worker) await worker.terminate();
  }
});

// 3. Save Reading
app.post('/api/save', async (req, res) => {
  try {
    const { reading, image_path, room_number, meter_type, user_id } = req.body;
    const query = `
      INSERT INTO readings (reading_value, image_url, room_number, meter_type, recorded_by, created_at) 
      VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *
    `;
    await pool.query(query, [reading || '0000', image_path, room_number, meter_type, user_id]);
    res.json({ success: true, message: "Saved" });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ==========================================
// 4. API Readings (แก้ไข: ดึงชื่อผู้จด recorder_name เพิ่มเติม)
// ==========================================
app.get('/api/readings', async (req, res) => {
    try {
      const query = `
        SELECT 
          r.id, 
          r.room_number, 
          r.meter_type, 
          r.reading_value, 
          r.image_url, 
          r.created_at,
          
          -- คำนวณเลขมิเตอร์ครั้งก่อน
          COALESCE(LAG(CAST(r.reading_value AS INTEGER)) OVER (PARTITION BY r.room_number, r.meter_type ORDER BY r.created_at), 0) as previous_reading,
          
          -- คำนวณหน่วยที่ใช้จริง
          CASE 
            WHEN LAG(CAST(r.reading_value AS INTEGER)) OVER (PARTITION BY r.room_number, r.meter_type ORDER BY r.created_at) IS NULL THEN 0
            ELSE (CAST(r.reading_value AS INTEGER) - LAG(CAST(r.reading_value AS INTEGER)) OVER (PARTITION BY r.room_number, r.meter_type ORDER BY r.created_at))
          END as usage,
          
          -- ข้อมูลผู้เช่า
          (SELECT COUNT(*) FROM tenants t WHERE TRIM(t.room_number) = TRIM(r.room_number)) as tenant_count,
          (SELECT STRING_AGG(name, ', ') FROM tenants t WHERE TRIM(t.room_number) = TRIM(r.room_number)) as tenant_names,

          -- ✅ เพิ่มบรรทัดนี้: ดึงชื่อจากตาราง users โดยใช้ ID จาก recorded_by
          (SELECT username FROM users WHERE id = r.recorded_by) as recorder_name
        
        FROM readings r
        ORDER BY r.created_at DESC
      `;
      const { rows } = await pool.query(query);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. API Tenants
app.get('/api/tenants', async (req, res) => {
  try {
    //รับค่าคำค้นหาจากหน้าบ้าน
    const { search } = req.query;

    //ตั้ง query เริ่มต้น
    let query = 'SELECT id, room_number, name, student_id FROM tenants';
    let params = [];

    //ถ้ามีการส่งคำค้นหามา
    if (search) {
      //เพิ่มเเงื่อนไข WHERE: หาชื่อ OR หาเลขห้อง (ILIKE เพื่อไม่สนตัวเล็ฏตัวใหญ่)
      query += ' WHERE name ILIKE $1 OR room_number ILIKE $1';
      params.push(`%${search}%`); // % ใช้สำหรับค้นหาคำแค่บางส่วน
    }

    //เรียงตามห้อง
    query += ' ORDER BY room_number ASC';

    //ยิงไป database พร้อมตัวแปร 
    const { rows } = await pool.query(query, params);

    res.json(rows);
  } catch (err) { 
    console.error(err);
    res.status(500).json({ error: err.message }); 
  }
});

// 6. เพิ่มผู้เช่า
app.post('/api/tenants', async (req, res) => {
  try {
    const { name, room_number, student_id } = req.body;
    const query = 'INSERT INTO tenants (name, room_number, student_id) VALUES ($1, $2, $3) RETURNING *';
    const { rows } = await pool.query(query, [name, room_number, student_id]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 7. ลบผู้เช่า
app.delete('/api/tenants/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server Running on port ${port}`);
});