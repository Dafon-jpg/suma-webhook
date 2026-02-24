# 🧮 Suma — WhatsApp Expense Tracker

> Bot de WhatsApp para gestión de gastos personales.  
> Enviá _"gasté 5000 en pizza"_ y Suma lo registra automáticamente.

**Built by Suma Digital** · Stack: TypeScript · Vercel · Supabase · WhatsApp Cloud API

---

## 📁 Estructura del proyecto

```
suma-webhook/
├── api/
│   └── webhook.ts              ← Vercel serverless function (entry point)
├── src/
│   ├── types/
│   │   └── index.ts            ← Interfaces y tipos compartidos
│   ├── lib/
│   │   └── supabase.ts         ← Cliente Supabase (singleton)
│   ├── services/
│   │   ├── expense-parser.ts   ← Parseo de mensajes (regex + LLM)
│   │   ├── expense-repository.ts ← Operaciones CRUD en Supabase
│   │   └── whatsapp.ts         ← Envío de mensajes via WA Cloud API
│   └── utils/
│       └── config.ts           ← Validación de env vars
├── supabase/
│   └── migration_001_init.sql  ← Schema de la DB
├── tests/
│   └── expense-parser.test.ts  ← Unit tests
├── .env.example
├── package.json
├── tsconfig.json
└── vercel.json
```

---

## 🚀 Setup paso a paso

### 1. Clonar y configurar

```bash
git clone <tu-repo>
cd suma-webhook
npm install
cp .env.example .env.local
```

### 2. Configurar Supabase

1. Crear un proyecto en [supabase.com](https://supabase.com)
2. Ir a **SQL Editor** y correr el contenido de `supabase/migration_001_init.sql`
3. Ir a **Settings → API** y copiar:
   - `Project URL` → `SUPABASE_URL`
   - `service_role key` → `SUPABASE_SERVICE_ROLE_KEY`

### 3. Configurar WhatsApp Cloud API

1. Ir a [developers.facebook.com](https://developers.facebook.com)
2. Crear una app tipo **Business**
3. Agregar el producto **WhatsApp**
4. En **API Setup**, copiar:
   - `Phone Number ID` → `WHATSAPP_PHONE_NUMBER_ID`
   - `Temporary Access Token` → `WHATSAPP_API_TOKEN`
5. Elegir un `WHATSAPP_VERIFY_TOKEN` (cualquier string seguro)

### 4. Deploy a Vercel

```bash
npm i -g vercel
vercel login
vercel
```

Después, en **Vercel Dashboard → Settings → Environment Variables**, agregar todas las variables del `.env.example`.

### 5. Configurar el Webhook en Meta

1. Ir a tu app en Meta → **WhatsApp → Configuration**
2. En **Webhook URL**, poner: `https://tu-proyecto.vercel.app/api/webhook`
3. En **Verify Token**, poner tu `WHATSAPP_VERIFY_TOKEN`
4. Suscribirse al campo: **messages**

---

## 💬 Formatos de mensaje soportados

| Mensaje                    | Monto    | Descripción   | Categoría       |
|----------------------------|----------|---------------|-----------------|
| `gasté 5000 en pizza`      | 5000     | pizza         | comida          |
| `pagué $1.500 de luz`      | 1500     | luz           | servicios       |
| `uber $3200`               | 3200     | uber          | transporte      |
| `5000 pizza`               | 5000     | pizza         | comida          |
| `$2.500,50 en supermercado`| 2500.50  | supermercado  | supermercado    |

---

## 🧪 Tests

```bash
npm test
```

---

## 📊 Para análisis de datos

El schema incluye views SQL listas para consumir desde Python/Jupyter:

- `v_monthly_summary` — Resumen mensual por categoría
- `v_daily_totals` — Totales diarios por usuario

Ejemplo con pandas:

```python
import pandas as pd
from supabase import create_client

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
data = supabase.table("v_monthly_summary").select("*").execute()
df = pd.DataFrame(data.data)
```
