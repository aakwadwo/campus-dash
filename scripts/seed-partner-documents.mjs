/**
 * Uploads placeholder verification images for every seeded Partner applicant.
 *
 * Without this the admin approval screen has document PATHS in the database but
 * no OBJECTS in storage, so both panels render "could not load" and the
 * approve/reject decision cannot be walked through manually.
 *
 * The images are generated here rather than committed: binary fixtures in a
 * repository invite the question of whose ID that actually is, and the answer
 * has to stay "nobody's". Each is a flat colour block, distinct per applicant
 * and per document type, so a tester can see at a glance that the right image
 * loaded in the right panel.
 *
 *   node scripts/seed-partner-documents.mjs
 */
import { deflateSync } from 'node:zlib';
import pg from 'pg';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'partner-documents';

if (!SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is not set. Run with: npm run seed:documents');
  process.exit(1);
}

// --- A minimal PNG encoder --------------------------------------------------
// Small enough to not be worth a dependency: signature, IHDR, IDAT, IEND.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(width, height, [r, g, b], stripe) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  // 10..12 = compression, filter, interlace — all zero

  const raw = Buffer.alloc(height * (1 + width * 3));
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    raw[at] = 0; // filter: none
    at += 1;
    for (let x = 0; x < width; x += 1) {
      // A diagonal band makes it obvious this is a generated placeholder and
      // not a photograph that someone forgot to remove.
      const band = stripe && (x + y) % 90 < 30;
      raw[at] = band ? 255 - r : r;
      raw[at + 1] = band ? 255 - g : g;
      raw[at + 2] = band ? 255 - b : b;
      at += 3;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Upload -----------------------------------------------------------------

async function upload(path, body) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'image/png',
      'x-upsert': 'true',
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  }
}

const client = new pg.Client({
  host: process.env.TEST_PGHOST || '127.0.0.1',
  port: Number(process.env.TEST_PGPORT || 54322),
  database: 'postgres',
  user: 'postgres',
  password: 'postgres',
});

await client.connect();

try {
  // Two documents, two owners. The student ID photograph is the CUSTOMER's and
  // lives on customer_profiles; the live face photograph is the PARTNER's and
  // lives on partner_profiles. The review screen shows them side by side, so
  // both have to exist for it to be worth looking at.
  const { rows } = await client.query(`
    select u.id as user_id, u.full_name, p.status,
           c.student_id_image_path, p.face_image_path
      from public.users u
      left join public.customer_profiles c on c.user_id = u.id
      left join public.partner_profiles  p on p.user_id = u.id
     where c.student_id_image_path is not null
        or p.face_image_path is not null
     order by u.full_name
  `);

  if (rows.length === 0) {
    console.log('No accounts carry document paths. Run `npm run db:reset` first.');
  }

  for (const [index, row] of rows.entries()) {
    // A different hue per applicant so two open review tabs are never confused.
    const hue = (index * 67) % 200;
    const documents = [
      [row.student_id_image_path, [60 + hue, 90, 200 - hue], true],
      [row.face_image_path, [200 - hue, 150, 60 + hue], false],
    ];

    for (const [path, colour, stripe] of documents) {
      if (!path) continue;
      await upload(path, png(400, 260, colour, stripe));
      console.log(`  ${row.full_name.padEnd(22)} ${path}`);
    }
  }

  console.log(`\nUploaded placeholder documents for ${rows.length} account(s).`);
} finally {
  await client.end();
}
