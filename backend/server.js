import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { google } from 'googleapis';
import { Readable } from 'stream';
import dotenv from 'dotenv';

dotenv.config()

const PORT        = process.env.PORT || 3000;
const FOLDER_ID   = process.env.DRIVE_FOLDER_ID;
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '500', 10);


console.log({ PORT, MAX_FILE_MB, FOLDER_ID });

// ─────────────────────────────────────────────────────────────
// Allowed MIME types
// ─────────────────────────────────────────────────────────────
const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic',
  'image/heif', 'image/gif', 'image/tiff',
  'video/mp4', 'video/quicktime', 'video/x-msvideo',
  'video/x-matroska', 'video/webm',
]);

// ─────────────────────────────────────────────────────────────
// Google Auth — Service Account
// ─────────────────────────────────────────────────────────────
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/drive'], // full drive scope required for Shared Drives
});

const drive = google.drive({ version: 'v3', auth });

// ─────────────────────────────────────────────────────────────
// Multer
// ─────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    ALLOWED_TYPES.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error(`File type not allowed: ${file.mimetype}`));
  },
});

// ─────────────────────────────────────────────────────────────
// Express app
// ─────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: (_origin, cb) => cb(null, true), // allow all origins locally
  methods: ['POST', 'GET'],
}));

app.use(express.json());

// ── Health check ─────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', maxFileMB: MAX_FILE_MB, folderId: FOLDER_ID });
});

// ── Single file upload ────────────────────────────────────────
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file received.' });
  }

  try {
    const { data } = await drive.files.create({
      requestBody: {
        name: req.file.originalname,
        mimeType: req.file.mimetype,
        parents: [FOLDER_ID],
      },
      media: {
        mimeType: req.file.mimetype,
        body: Readable.from(req.file.buffer),
      },
      fields: 'id, name, size, mimeType',
      supportsAllDrives: true,  // ← required for Shared Drives
    });

    console.log(`✅  Uploaded: ${data.name} (${data.id})`);
    res.json({ success: true, file: data });

  } catch (err) {
    console.error('Drive upload error:', err.message);
    res.status(500).json({ error: 'Upload to Google Drive failed.', detail: err.message });
  }
});

// ── Bulk upload ───────────────────────────────────────────────
app.post('/upload-many', upload.array('files', 20), async (req, res) => {
  if (!req.files?.length) {
    return res.status(400).json({ error: 'No files received.' });
  }

  const results = await Promise.allSettled(
    req.files.map(async (file) => {
      const { data } = await drive.files.create({
        requestBody: {
          name: file.originalname,
          mimeType: file.mimetype,
          parents: [FOLDER_ID],
        },
        media: {
          mimeType: file.mimetype,
          body: Readable.from(file.buffer),
        },
        fields: 'id, name',
        supportsAllDrives: true,  // ← required for Shared Drives
      });
      return data;
    })
  );

  const uploaded = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const failed   = results.filter(r => r.status === 'rejected').map(r => r.reason?.message);

  res.json({ uploaded, failed, total: req.files.length });
});

// ── Error handler ─────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large. Max is ${MAX_FILE_MB}MB.` });
  }
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n🚀  Upload server running on http://localhost:${PORT}`);
  console.log(`📁  Uploading to Shared Drive folder: ${FOLDER_ID}\n`);
});