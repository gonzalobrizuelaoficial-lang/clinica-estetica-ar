require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { z } = require('zod');
const { Redis } = require('@upstash/redis');

const AnthropicSDK = require('@anthropic-ai/sdk');
const Anthropic = AnthropicSDK.default || AnthropicSDK;
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const PORT = process.env.PORT || 8934;
const ROOT = __dirname;

const app = express();
app.use(express.static(ROOT));
app.use(express.json());

// ================= Shortlinks (link + QR cortos, con atribución de canal) =================
// Cada campaña genera dos URLs largas idénticas salvo el query param `canal`
// (link vs qr). Guardamos cada una bajo un código corto en Upstash Redis
// (REST, sin conexión TCP persistente) para que el link a compartir y el QR
// sean cortos y estables, sin depender del disco de Render (que no es
// persistente entre reinicios del free tier).
const SHORT_CODE_BYTES = 5; // ~7 caracteres en base62, suficiente para no colisionar en el volumen de este proyecto
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomShortCode() {
  const bytes = crypto.randomBytes(SHORT_CODE_BYTES);
  let code = '';
  for (let i = 0; i < bytes.length; i++) code += BASE62[bytes[i] % BASE62.length];
  return code;
}

let redisClient = null;
function getRedisClient() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  if (!redisClient) {
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redisClient;
}

app.post('/api/shorten', async function (req, res) {
  const redis = getRedisClient();
  if (!redis) {
    return res.status(500).json({ error: 'El servidor no tiene configurado el shortlink (faltan las variables de entorno de Upstash Redis).' });
  }

  const longUrl = req.body && req.body.longUrl;
  if (!longUrl || typeof longUrl !== 'string') {
    return res.status(400).json({ error: 'Falta longUrl.' });
  }

  try {
    let code = randomShortCode();
    // Colisión extremadamente improbable con 5 bytes random, pero se verifica igual.
    for (let attempts = 0; attempts < 5 && (await redis.get('short:' + code)) !== null; attempts++) {
      code = randomShortCode();
    }
    await redis.set('short:' + code, longUrl);
    const shortUrl = req.protocol + '://' + req.get('host') + '/s/' + code;
    res.json({ shortUrl: shortUrl });
  } catch (err) {
    console.error('[shorten] error de Redis:', err);
    res.status(502).json({ error: 'No se pudo generar el link corto. Intentá de nuevo en un momento.' });
  }
});

app.get('/s/:code', async function (req, res) {
  const redis = getRedisClient();
  if (!redis) return res.status(500).send('Shortlink no configurado en el servidor.');

  try {
    const longUrl = await redis.get('short:' + req.params.code);
    if (!longUrl) return res.status(404).send('Este link no existe o venció.');
    res.redirect(302, longUrl);
  } catch (err) {
    console.error('[shortlink redirect] error de Redis:', err);
    res.status(502).send('No se pudo resolver el link. Intentá de nuevo en un momento.');
  }
});

// ================= Anti-duplicados (un reclamo por WhatsApp por campaña) =================
// Se escopea por campaña (cid, generado en el configurador al tocar "Generar
// link y QR"), no por negocio: así dos campañas distintas del mismo cliente
// en el mismo mes no se bloquean entre sí. La clave se hashea (no se guarda
// el WhatsApp en texto plano en Redis) y el TTL es la ventana de días que el
// usuario configuró para esa campaña.
const COOLDOWN_DAYS_MIN = 1;
const COOLDOWN_DAYS_MAX = 365;

app.post('/api/check-play', async function (req, res) {
  const redis = getRedisClient();
  // Fail-open: si Redis no está configurado o falla, nunca bloqueamos a un
  // cliente real por un problema de infraestructura del lado nuestro.
  if (!redis) return res.json({ duplicate: false });

  const scopeKey = req.body && req.body.scopeKey;
  const whatsapp = req.body && req.body.whatsapp;
  const cooldownDaysRaw = req.body && req.body.cooldownDays;
  if (!scopeKey || !whatsapp || typeof scopeKey !== 'string' || typeof whatsapp !== 'string') {
    return res.status(400).json({ error: 'Falta scopeKey o whatsapp.' });
  }
  const cooldownDays = Math.min(COOLDOWN_DAYS_MAX, Math.max(COOLDOWN_DAYS_MIN, parseInt(cooldownDaysRaw, 10) || 30));

  try {
    const hash = crypto.createHash('sha256').update(scopeKey + ':' + whatsapp).digest('hex');
    const key = 'played:' + hash;
    const result = await redis.set(key, '1', { nx: true, ex: cooldownDays * 86400 });
    res.json({ duplicate: result === null });
  } catch (err) {
    console.error('[check-play] error de Redis:', err);
    res.json({ duplicate: false });
  }
});

// ================= Subida de logo =================
// El logo se embebe directo en el link/QR como data URI (en vez de guardarse
// como archivo en el servidor) porque el hosting gratuito (Render free) no
// garantiza disco persistente entre reinicios — un logo guardado en disco
// podría desaparecer de una demo que ya está funcionando. Por eso se achica
// agresivamente: el link completo tiene que entrar en la capacidad de una QR
// (nivel de corrección M: ~2331 bytes), así que el aporte del logo se acota
// a unos pocos cientos/mil bytes en base64, no a los ~2MB originales.
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
// El data URI del logo viaja adentro de cfg.logo, que a su vez se vuelve a
// codificar en base64 completo (assets/js/config.js:encodeConfig) — esa doble
// codificación infla el tamaño final ~33% más. Por eso el presupuesto acá es
// más chico de lo que el límite de la QR (~2331 bytes totales, nivel M)
// sugeriría a simple vista: hay que dejar margen para esa segunda vuelta de
// base64 más el resto de los campos (webhook, pregunta, premios).
const LOGO_BASE64_BUDGET = 1200;
// PNG paletizado (pocos colores + transparencia real) comprime mucho mejor
// que WebP para logos típicos (colores planos, texto, íconos) — probado:
// un logo simple de 2 colores entra en ~880 base64 chars a 64px paletizado,
// contra ~3700+ en WebP a 96px.
const LOGO_STEPS = [
  { size: 128, colors: 32 },
  { size: 96, colors: 32 },
  { size: 96, colors: 16 },
  { size: 64, colors: 16 },
  { size: 48, colors: 16 },
  { size: 32, colors: 8 },
];
const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES },
  fileFilter(req, file, cb) {
    if (file.mimetype === 'image/png' || file.mimetype === 'image/jpeg') cb(null, true);
    else cb(new Error('TIPO_NO_SOPORTADO'));
  },
});

app.post('/api/upload-logo', function (req, res) {
  uploadLogo.single('logo')(req, res, async function (err) {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'El archivo pesa más de 2MB. Probá con una imagen más liviana.' });
      }
      if (err.message === 'TIPO_NO_SOPORTADO') {
        return res.status(400).json({ error: 'Formato no soportado. Subí un PNG o JPG.' });
      }
      console.error('[upload-logo]', err);
      return res.status(400).json({ error: 'No se pudo procesar el archivo.' });
    }
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });

    try {
      let base64 = null;
      for (const step of LOGO_STEPS) {
        const buffer = await sharp(req.file.buffer)
          .resize(step.size, step.size, { fit: 'inside', withoutEnlargement: true })
          .png({ palette: true, colors: step.colors, compressionLevel: 9 })
          .toBuffer();
        const candidate = buffer.toString('base64');
        if (candidate.length <= LOGO_BASE64_BUDGET) {
          base64 = candidate;
          break;
        }
      }

      if (!base64) {
        return res.status(400).json({
          error: 'El logo es muy complejo para achicarlo a un tamaño apto para el link/QR. Probá con una versión más simple (colores planos, sin fotos) o más chica.',
        });
      }

      res.json({ dataUrl: 'data:image/png;base64,' + base64 });
    } catch (procErr) {
      console.error('[upload-logo] error al procesar imagen:', procErr);
      res.status(500).json({ error: 'No se pudo procesar el logo.' });
    }
  });
});

// ================= Extracción de datos del negocio con IA =================
const DOC_MAX_BYTES = 8 * 1024 * 1024;
const DOC_EXTENSIONS = ['.pdf', '.md', '.txt'];
const uploadDoc = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DOC_MAX_BYTES },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (DOC_EXTENSIONS.includes(ext)) cb(null, true);
    else cb(new Error('TIPO_NO_SOPORTADO'));
  },
});

const BusinessInfoSchema = z.object({
  biz: z.string().nullable().describe('Nombre del negocio'),
  rubro: z.string().nullable().describe('Rubro o industria del negocio'),
  q: z.string().nullable().describe('Pregunta clave para hacerle al ganador antes de reclamar el premio por WhatsApp'),
  wa: z.string().nullable().describe('Número de WhatsApp del negocio, solo dígitos'),
  prizes: z.array(z.string()).nullable().describe('Hasta 2 premios o descuentos sugeridos mencionados en el documento'),
  colors: z.object({
    bg: z.string().nullable(),
    p: z.string().nullable(),
    a: z.string().nullable(),
  }).nullable().describe('Colores de marca en hex, solo si aparecen explícitamente en el documento'),
});

// Tarea de extracción estructurada de datos -> Haiku 4.5, según la regla de
// ruteo de modelos del usuario (CLAUDE.md).
const EXTRACTION_MODEL = 'claude-haiku-4-5';

let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient) anthropicClient = new Anthropic();
  return anthropicClient;
}

app.post('/api/extract-business-info', function (req, res) {
  uploadDoc.single('doc')(req, res, async function (err) {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'El documento pesa más de 8MB. Probá con uno más liviano.' });
      }
      if (err.message === 'TIPO_NO_SOPORTADO') {
        return res.status(400).json({ error: 'Formato no soportado. Subí un PDF, .md o .txt.' });
      }
      console.error('[extract-business-info]', err);
      return res.status(400).json({ error: 'No se pudo procesar el archivo.' });
    }
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Falta configurar ANTHROPIC_API_KEY en el archivo .env del servidor.' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const instruction =
      'Este documento describe un negocio que quiere armar una campaña promocional (ruleta o raspadita). ' +
      'Extraé del documento: nombre del negocio, rubro, una pregunta clave para hacerle al ganador antes de ' +
      'reclamar el premio por WhatsApp, el número de WhatsApp si aparece, hasta 2 premios o descuentos ' +
      'sugeridos, y colores de marca en hex si se mencionan explícitamente. Si un dato no aparece en el ' +
      'documento, devolvé null para ese campo — nunca inventes información.';

    const content = [];
    if (ext === '.pdf') {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: req.file.buffer.toString('base64') },
      });
      content.push({ type: 'text', text: instruction });
    } else {
      const text = req.file.buffer.toString('utf8');
      content.push({ type: 'text', text: instruction + '\n\n---DOCUMENTO---\n' + text });
    }

    try {
      const client = getAnthropicClient();
      const response = await client.messages.parse({
        model: EXTRACTION_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: content }],
        output_config: { format: zodOutputFormat(BusinessInfoSchema) },
      });

      if (!response.parsed_output) {
        return res.status(502).json({ error: 'La IA no pudo leer el documento. Probá con otro archivo.' });
      }
      res.json(response.parsed_output);
    } catch (apiErr) {
      console.error('[extract-business-info] error de Claude:', apiErr);
      res.status(502).json({ error: 'No se pudo completar la extracción con IA. Intentá de nuevo en un momento.' });
    }
  });
});

app.listen(PORT, function () {
  console.log('[AR FLOW] Servidor corriendo en http://localhost:' + PORT);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[AR FLOW] Falta ANTHROPIC_API_KEY en .env — la extracción de documentos con IA no va a funcionar hasta que la configures.');
  }
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.warn('[AR FLOW] Falta UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN en .env — el link corto y el QR del configurador no van a funcionar hasta que las configures.');
  }
});
