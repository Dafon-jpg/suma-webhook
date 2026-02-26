# Sección 1: Infraestructura y Resiliencia — Arquitectura

## Problema actual

```
Meta WhatsApp ──POST──▶ api/webhook.ts ──sync──▶ Gemini/Supabase ──▶ res.200
                         │                            │
                         │  ⏱ Si esto tarda >15s      │
                         │  Meta reintenta ──────────▶ GASTO DUPLICADO
                         │  No hay check de msg.id    │
                         │  No hay HMAC validation    │
```

## Arquitectura nueva

```
Meta WhatsApp
     │
     ▼
┌─────────────────────────────────────────┐
│  api/webhook.ts (THIN — max 500ms)      │
│                                         │
│  1. Validar firma HMAC (X-Hub-Signature)│
│  2. Extraer mensajes del payload        │
│  3. Encolar en Upstash QStash ─────────────▶ POST https://qstash.upstash.io/v2/publish
│  4. return res.status(200) INMEDIATO    │      target: /api/process-message
│                                         │      retries: 3
└─────────────────────────────────────────┘      delay: 0s

                    ▼ (async, seconds después)

┌──────────────────────────────────────────┐
│  api/process-message.ts (WORKER)          │
│                                           │
│  1. Validar firma QStash (Receiver SDK)   │
│  2. Check idempotencia: msg.id en DB      │
│     └─ Si existe → skip, return 200       │
│  3. Insertar msg.id en processed_messages │
│  4. Ejecutar pipeline completo:           │
│     ├─ parseExpense (regex → LLM)         │
│     ├─ downloadMedia (con retries)        │
│     ├─ upsertUser + resolveCategoryId     │
│     ├─ insertExpense                      │
│     └─ sendWhatsAppMessage (confirmación) │
│  5. Si falla → QStash reintenta auto      │
└──────────────────────────────────────────┘
```

## Decisión: ¿Por qué Upstash QStash?

| Opción           | Pro                          | Contra                       |
|-----------------|------------------------------|------------------------------|
| Upstash QStash  | Serverless-native, retries   | Nuevo servicio               |
| Inngest         | Más features (workflows)     | Overhead para este caso      |
| Supabase queue  | Ya lo tenemos                | Necesita polling/cron        |
| Background fn   | Nativo Vercel                | Solo en Pro plan ($20/mes)   |

**QStash gana** porque: funciona con Vercel free tier, maneja retries automáticos,
firma las requests (seguridad), y tiene 500 mensajes/día gratis (suficiente para MVP).

## Archivos nuevos/modificados

```
api/
├── webhook.ts           ← MODIFICADO: thin handler, solo valida + encola
└── process-message.ts   ← NUEVO: worker que procesa el mensaje
src/
├── queue/
│   └── qstash.ts        ← NUEVO: cliente QStash (publish + verify)
├── lib/
│   └── hmac.ts          ← NUEVO: validación de firma de Meta
├── services/
│   └── whatsapp-media.ts ← MODIFICADO: retry con exponential backoff
└── types/
    └── index.ts          ← MODIFICADO: nuevos tipos para queue
supabase/
└── migration_002_idempotency.sql ← NUEVO: tabla processed_messages
```

## Variables de entorno nuevas

```
QSTASH_TOKEN=           # Upstash Console → QStash → Token
QSTASH_CURRENT_SIGNING_KEY=  # Para verificar requests de QStash
QSTASH_NEXT_SIGNING_KEY=     # Key rotation de QStash
WHATSAPP_APP_SECRET=    # Meta App Dashboard → App Secret (para HMAC)
VERCEL_URL=             # Automática en Vercel, o manual en dev
```
