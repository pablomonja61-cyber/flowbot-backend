# WhatsApp SaaS Backend

Backend completo para plataforma SaaS de chatbots WhatsApp con IA.

## Stack
- **Node.js + Express** — servidor y API REST
- **Supabase** — base de datos PostgreSQL
- **Claude API (Anthropic)** — respuestas con IA
- **Meta Cloud API** — WhatsApp Business

---

## Deployment en Railway (5 pasos)

### 1. Crear cuenta y proyecto en Railway
1. Ve a [railway.app](https://railway.app) y crea cuenta
2. Click "New Project" → "Deploy from GitHub repo"
3. Sube este código a un repo de GitHub primero
4. Selecciona el repo

### 2. Configurar variables de entorno en Railway
En tu proyecto Railway → Settings → Variables, agrega:

```
PORT=3000
NODE_ENV=production
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbG...
ANTHROPIC_API_KEY=sk-ant-api03-...
JWT_SECRET=string_aleatorio_muy_largo_aqui
META_WEBHOOK_VERIFY_TOKEN=mi_token_secreto
FRONTEND_URL=https://tu-app.lovable.app
```

### 3. Configurar Supabase
1. Ve a [supabase.com](https://supabase.com) → New project
2. En el SQL Editor, ejecuta todo el contenido de `supabase/schema.sql`
3. Copia la URL y Service Role Key (Settings → API)

### 4. Configurar Meta for Developers
1. Ve a [developers.facebook.com](https://developers.facebook.com)
2. Crea una app → Tipo: Business
3. Agrega el producto "WhatsApp"
4. En WhatsApp → Configuration → Webhook:
   - URL: `https://tu-app.railway.app/webhook/whatsapp`
   - Verify Token: el mismo que pusiste en `META_WEBHOOK_VERIFY_TOKEN`
   - Suscribir a: `messages`
5. Genera un token permanente en System Users (Meta Business Manager)

### 5. Verificar que todo funciona
```bash
curl https://tu-app.railway.app/health
# Debe responder: { "status": "ok" }
```

---

## API Endpoints

### Auth
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/auth/register` | Registrar usuario |
| POST | `/api/auth/login` | Login |
| GET | `/api/auth/me` | Perfil actual |

### Flujos
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/flows` | Listar flujos |
| POST | `/api/flows` | Crear flujo |
| PUT | `/api/flows/:id` | Actualizar flujo |
| DELETE | `/api/flows/:id` | Eliminar flujo |

### Activadores
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/triggers` | Listar activadores |
| POST | `/api/triggers` | Crear activador |
| PUT | `/api/triggers/:id` | Actualizar activador |
| DELETE | `/api/triggers/:id` | Eliminar activador |

### Conexiones WhatsApp
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/connections` | Listar conexiones |
| POST | `/api/connections` | Conectar número |
| DELETE | `/api/connections/:id` | Desconectar |

### Conversaciones (Inbox)
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/conversations` | Listar conversaciones |
| GET | `/api/conversations/:id/messages` | Mensajes de una conv. |
| GET | `/api/conversations/stats/summary` | Métricas del día |

### Webhook (Meta)
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/webhook/whatsapp` | Verificación Meta |
| POST | `/webhook/whatsapp` | Mensajes entrantes |

---

## Estructura de un Flujo (JSON)

Los flujos se guardan como JSON con `nodes` y `edges`:

```json
{
  "name": "Flujo ventas brigadeiros",
  "nodes": [
    { "id": "n1", "type": "start", "data": {} },
    { "id": "n2", "type": "message", "data": { "text": "¡Hola! 👋 Bienvenido..." } },
    { "id": "n3", "type": "ai_agent", "data": { "context": "Eres asesor de ventas de Brigadeiros Gourmet..." } },
    { "id": "n4", "type": "notification", "data": { "phone": "51999999999", "message": "Nuevo lead: {{phone}}" } }
  ],
  "edges": [
    { "source": "n1", "target": "n2" },
    { "source": "n2", "target": "n3" },
    { "source": "n3", "target": "n4" }
  ]
}
```

### Tipos de nodos soportados:
- `start` / `trigger` — inicio del flujo
- `message` / `content` — enviar texto
- `buttons` / `api_message` — enviar botones interactivos
- `ai` / `ai_agent` — respuesta con Claude
- `condition` — bifurcación por condición
- `delay` — espera N segundos
- `tag` / `label` — etiquetar contacto
- `notification` — avisar a un número
- `end` — fin del flujo

---

## Estructura de un Activador

```json
{
  "name": "Precio brigadeiros",
  "keyword": "precio",
  "flow_id": "uuid-del-flujo",
  "connection_id": "uuid-de-la-conexion",
  "is_repeatable": true
}
```
El activador se dispara cuando el usuario envía un mensaje que **contiene** la keyword.

---

## Próximo paso: Prompt para Lovable

Con este backend desplegado en Railway, usa el siguiente prompt base en Lovable para construir el frontend que consuma esta API.
