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

// ================= Cuentas (admin + clientes) y autenticación =================
// HTTP Basic Auth respaldado en Redis, sin sesiones/cookies ni dependencias
// nuevas (bcrypt/passport/jsonwebtoken): el navegador cachea las credenciales
// por origen y las reenvía solo en los fetch() que ya hacen configurador.html
// y dashboard.html. Desactivar una cuenta la corta al instante, sin sesión
// que revocar.
const AUTH_REALM = 'ARhook';

function accountKey(username) {
  return 'account:' + String(username).trim().toLowerCase();
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function verifyPassword(password, salt, expectedHash) {
  const candidate = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(String(expectedHash), 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

async function getAccount(username) {
  const redis = getRedisClient();
  if (!redis || !username) return null;
  const raw = await redis.get(accountKey(username));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function saveAccount(username, account) {
  const redis = getRedisClient();
  await redis.set(accountKey(username), JSON.stringify(account));
}

async function listAccounts() {
  const redis = getRedisClient();
  if (!redis) return [];
  const keys = await redis.keys('account:*');
  if (!keys || keys.length === 0) return [];
  const accounts = await Promise.all(
    keys.map(async function (key) {
      const raw = await redis.get(key);
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Object.assign({ username: key.slice('account:'.length) }, data);
    })
  );
  return accounts;
}

function parseBasicAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch (e) {
    return null;
  }
}

// requireAuth() acepta cualquier cuenta activa; requireAuth('admin') exige ese rol.
function requireAuth(role) {
  return async function (req, res, next) {
    const creds = parseBasicAuth(req);
    if (!creds) {
      res.set('WWW-Authenticate', 'Basic realm="' + AUTH_REALM + '"');
      return res.status(401).send('Ingresá tu usuario y contraseña.');
    }
    try {
      const account = await getAccount(creds.username);
      if (!account || !account.active || !verifyPassword(creds.password, account.salt, account.passwordHash)) {
        res.set('WWW-Authenticate', 'Basic realm="' + AUTH_REALM + '"');
        return res.status(401).send('Usuario o contraseña incorrectos, o cuenta desactivada.');
      }
      if (role && account.role !== role) {
        return res.status(403).send('No tenés permiso para acceder a esta sección.');
      }
      req.account = {
        username: String(creds.username).trim().toLowerCase(),
        role: account.role,
        businessName: account.businessName,
        campaignIds: account.campaignIds || [],
      };
      next();
    } catch (err) {
      console.error('[auth] error:', err);
      res.status(500).send('No se pudo verificar el acceso.');
    }
  };
}

async function bootstrapAdminAccount() {
  const redis = getRedisClient();
  if (!redis) return;
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) return;
  const existing = await getAccount(process.env.ADMIN_USER);
  if (existing) return;
  const salt = crypto.randomBytes(16).toString('hex');
  await saveAccount(process.env.ADMIN_USER, {
    passwordHash: hashPassword(process.env.ADMIN_PASSWORD, salt),
    salt: salt,
    role: 'admin',
    active: true,
    businessName: 'Admin',
    campaignIds: [],
  });
  console.log('[AR FLOW] Cuenta admin creada para "' + process.env.ADMIN_USER + '".');
}

// Rutas explícitas ANTES de express.static para que la autenticación
// intercepte antes de que el archivo se sirva como estático.
app.get('/configurador.html', requireAuth('admin'), function (req, res) {
  res.sendFile(path.join(ROOT, 'configurador.html'));
});
app.get('/dashboard.html', requireAuth(), function (req, res) {
  res.sendFile(path.join(ROOT, 'dashboard.html'));
});

app.use(express.static(ROOT));

app.post('/api/shorten', requireAuth('admin'), async function (req, res) {
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

app.post('/api/upload-logo', requireAuth('admin'), function (req, res) {
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

app.post('/api/extract-business-info', requireAuth('admin'), function (req, res) {
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

// ================= Contadores de rendimiento por campaña =================
// Camino paralelo y liviano al envío a Make (assets/js/crm.js:pingStats):
// solo cuenta, no reemplaza ni depende del registro en el Sheet del cliente.
const STATS_EVENT_TYPES = ['jugado', 'ganado', 'reclamado'];

app.post('/api/log-event', async function (req, res) {
  const redis = getRedisClient();
  if (!redis) return res.status(204).end(); // sin Redis no hay dónde contar; no es un error para el visitante

  const cid = req.body && req.body.cid;
  const type = req.body && req.body.type;
  if (!cid || typeof cid !== 'string' || STATS_EVENT_TYPES.indexOf(type) === -1) {
    return res.status(400).json({ error: 'Falta cid o type inválido.' });
  }

  try {
    await redis.hincrby('stats:' + cid, type, 1);
    res.status(204).end();
  } catch (err) {
    console.error('[log-event] error de Redis:', err);
    res.status(204).end(); // fire-and-forget desde el navegador del visitante: nunca lo bloqueamos por esto
  }
});

async function getStatsForCid(cid) {
  const redis = getRedisClient();
  if (!redis) return { jugado: 0, ganado: 0, reclamado: 0 };
  const raw = await redis.hgetall('stats:' + cid);
  return {
    jugado: parseInt((raw && raw.jugado) || 0, 10),
    ganado: parseInt((raw && raw.ganado) || 0, 10),
    reclamado: parseInt((raw && raw.reclamado) || 0, 10),
  };
}

app.get('/api/stats', requireAuth(), async function (req, res) {
  try {
    if (req.account.role === 'admin') {
      const accounts = await listAccounts();
      const clients = await Promise.all(
        accounts
          .filter(function (a) { return a.role !== 'admin'; })
          .map(async function (acc) {
            const campaigns = await Promise.all(
              (acc.campaignIds || []).map(async function (cid) {
                return Object.assign({ cid: cid }, await getStatsForCid(cid));
              })
            );
            return { username: acc.username, businessName: acc.businessName, active: acc.active, campaigns: campaigns };
          })
      );
      return res.json({ clients: clients });
    }

    const campaigns = await Promise.all(
      (req.account.campaignIds || []).map(async function (cid) {
        return Object.assign({ cid: cid }, await getStatsForCid(cid));
      })
    );
    res.json({ businessName: req.account.businessName, campaigns: campaigns });
  } catch (err) {
    console.error('[stats] error:', err);
    res.status(502).json({ error: 'No se pudieron cargar las estadísticas.' });
  }
});

// ================= Administración de cuentas de clientes =================
app.get('/api/admin/accounts', requireAuth('admin'), async function (req, res) {
  try {
    const accounts = await listAccounts();
    res.json({
      accounts: accounts
        .filter(function (a) { return a.role !== 'admin'; })
        .map(function (a) {
          return { username: a.username, businessName: a.businessName, active: a.active, campaignIds: a.campaignIds || [] };
        }),
    });
  } catch (err) {
    console.error('[admin/accounts] error:', err);
    res.status(502).json({ error: 'No se pudieron cargar las cuentas.' });
  }
});

app.post('/api/admin/accounts', requireAuth('admin'), async function (req, res) {
  const username = req.body && req.body.username && String(req.body.username).trim().toLowerCase();
  const password = req.body && req.body.password;
  const businessName = req.body && req.body.businessName;
  const cid = req.body && req.body.cid;
  if (!username || !password || !businessName) {
    return res.status(400).json({ error: 'Faltan username, password o businessName.' });
  }

  try {
    const existing = await getAccount(username);
    if (existing) return res.status(409).json({ error: 'Ya existe una cuenta con ese usuario.' });

    const salt = crypto.randomBytes(16).toString('hex');
    const account = {
      passwordHash: hashPassword(password, salt),
      salt: salt,
      role: 'client',
      active: true,
      businessName: String(businessName).trim(),
      campaignIds: cid ? [String(cid).trim()] : [],
    };
    await saveAccount(username, account);
    res.status(201).json({ username: username, businessName: account.businessName, active: true, campaignIds: account.campaignIds });
  } catch (err) {
    console.error('[admin/accounts create] error:', err);
    res.status(502).json({ error: 'No se pudo crear la cuenta.' });
  }
});

app.patch('/api/admin/accounts/:username', requireAuth('admin'), async function (req, res) {
  const username = String(req.params.username).trim().toLowerCase();
  try {
    const account = await getAccount(username);
    if (!account) return res.status(404).json({ error: 'No existe esa cuenta.' });

    if (typeof req.body.active === 'boolean') account.active = req.body.active;
    if (req.body.addCampaignId && typeof req.body.addCampaignId === 'string') {
      account.campaignIds = account.campaignIds || [];
      const trimmed = req.body.addCampaignId.trim();
      if (trimmed && account.campaignIds.indexOf(trimmed) === -1) account.campaignIds.push(trimmed);
    }
    await saveAccount(username, account);
    res.json({ username: username, active: account.active, campaignIds: account.campaignIds });
  } catch (err) {
    console.error('[admin/accounts patch] error:', err);
    res.status(502).json({ error: 'No se pudo actualizar la cuenta.' });
  }
});

app.listen(PORT, function () {
  console.log('[AR FLOW] Servidor corriendo en http://localhost:' + PORT);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[AR FLOW] Falta ANTHROPIC_API_KEY en .env — la extracción de documentos con IA no va a funcionar hasta que la configures.');
  }
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.warn('[AR FLOW] Falta UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN en .env — el link corto y el QR del configurador no van a funcionar hasta que las configures.');
  }
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
    console.warn('[AR FLOW] Falta ADMIN_USER / ADMIN_PASSWORD en .env — sin esto no se crea ninguna cuenta admin y NADIE (ni vos) va a poder entrar a /configurador.html ni a /dashboard.html.');
  }
  bootstrapAdminAccount().catch(function (err) {
    console.error('[bootstrap-admin] error:', err);
  });
});
