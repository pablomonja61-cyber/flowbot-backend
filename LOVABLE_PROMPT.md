# PROMPT COMPLETO PARA LOVABLE
# Pega esto exactamente en Lovable al crear tu proyecto

---

Construye una aplicación SaaS completa llamada **FlowBot** para automatización de WhatsApp Business con IA. Es similar a SendyPro / ManyChat. El usuario puede crear flujos visuales de chatbot, configurar activadores por palabras clave, entrenar un agente IA con info de su producto, y ver conversaciones en tiempo real.

## STACK
- React + TypeScript
- Tailwind CSS
- React Flow (para el constructor de flujos drag & drop)
- Axios para llamadas a la API
- Zustand para estado global
- React Router para navegación

## DISEÑO VISUAL
- Tema oscuro (fondo #0A0A0A, tarjetas #141414, bordes #2A2A2A)
- Color primario: verde WhatsApp #25D366
- Acento violeta para IA: #7C3AED
- Fuente: Inter
- Sidebar izquierdo fijo de 240px
- Layout tipo dashboard moderno

## URL BASE DE LA API
Todas las llamadas van a: `https://TU_BACKEND.railway.app`
Guardar en variable de entorno: VITE_API_URL

## AUTENTICACIÓN
- Guardar JWT en localStorage como `flowbot_token`
- Incluir en headers: `Authorization: Bearer {token}`
- Si la API devuelve 401, redirigir a /login

---

## PANTALLAS Y RUTAS

### 1. /login — Pantalla de Login
- Logo "FlowBot" con icono de WhatsApp en verde
- Formulario: email + password
- Botón "Iniciar sesión" verde
- Link "Crear cuenta" → /register
- POST /api/auth/login → guardar token → redirigir a /dashboard

### 2. /register — Registro
- Campos: nombre, email, password
- POST /api/auth/register → guardar token → redirigir a /dashboard

### 3. /dashboard — Panel principal
Header con: "Buen día, {nombre}" + badge del plan actual

**4 tarjetas de métricas** (GET /api/conversations/stats/summary):
- Conversaciones hoy
- Mensajes hoy  
- Conversaciones activas
- Total histórico

**Sección "Mis flujos"** — lista las últimas 4 (GET /api/flows):
- Tarjeta por flujo: nombre, badge activo/inactivo, botón Editar
- Botón "+ Nuevo flujo" → /flows/new

**Sección "Activadores recientes"** — lista los últimos 4 (GET /api/triggers):
- Nombre, keyword en badge, conexión asociada

### 4. /flows — Lista de flujos
- Tabla o grid con todos los flujos
- Columnas: nombre, estado (toggle activo/inactivo), fecha creación, acciones
- Botón "+ Crear flujo" arriba a la derecha
- Click en flujo → /flows/{id}/edit

### 5. /flows/new y /flows/:id/edit — Constructor de flujos ⭐ (pantalla más importante)

**Layout:**
- Barra superior: input nombre del flujo + botón "Guardar" verde + botón "← Volver"
- Panel izquierdo (220px): panel de nodos disponibles para arrastrar
- Canvas central: área de construcción con React Flow
- Panel derecho (260px): propiedades del nodo seleccionado

**Panel izquierdo — Nodos disponibles (con drag & drop al canvas):**

Sección BÁSICOS:
- 🟢 Inicio del flujo (solo puede haber 1, color verde)
- 🔵 Mensaje/Contenido (color azul)
- 🟣 Menú con botones (color morado)

Sección AUTOMATIZACIÓN:
- 🟠 Seguimiento / Delay (color naranja)
- 🟡 Condición (color amarillo)
- 🔴 Etiqueta (color rojo)
- 🔔 Notificación (color naranja oscuro)

Sección IA:
- 🤖 Agente IA (color violeta degradado, destacado visualmente)

Sección INTEGRACIONES:
- 📊 Google Sheets (gris)
- 📨 Mensajes API (azul oscuro)

**Canvas central:**
- Fondo oscuro con grid de puntos (como SendyPro)
- Nodos arrastrables y conectables
- Conectar: arrastrar desde el punto naranja de salida de un nodo al punto de entrada del siguiente
- Cada nodo muestra: ícono + nombre del tipo + preview del contenido configurado
- Click en nodo → abre panel derecho con sus propiedades
- Botón X en cada nodo para eliminar

**Panel derecho — Propiedades según tipo de nodo:**

Para nodo "Mensaje/Contenido":
- Textarea: "Texto del mensaje"
- Toggle: incluir imagen (sí/no)
- Input: segundos de delay antes de enviar

Para nodo "Menú con botones":
- Textarea: texto principal
- Lista dinámica de botones (máx 3): input por cada uno + botón agregar/eliminar
- Cada botón tiene su propio punto de salida en el nodo

Para nodo "Agente IA":
- Textarea grande (10 filas): "Contexto de tu producto / Información del negocio"
- Placeholder: "Ejemplo: Vendo brigadeiros gourmet a S/10 cada caja de 9 unidades. Delivery en Lima. Pagos por Yape, Plin y transferencia. Mi número es 999-999-999..."
- Selector modelo: Claude Haiku (rápido y económico) / Claude Sonnet (más inteligente)
- Texto de ayuda: "La IA responderá dudas y cerrará ventas usando esta información"

Para nodo "Condición":
- Select: variable a evaluar (texto del usuario / respuesta IA)
- Select: operador (contiene / es igual a / empieza con / no contiene)
- Input: valor a comparar
- El nodo tiene 2 salidas: ✅ Sí / ❌ No

Para nodo "Seguimiento/Delay":
- Input número: tiempo de espera
- Select: segundos / minutos / horas

Para nodo "Notificación":
- Input: número de WhatsApp a notificar
- Textarea: mensaje de la notificación
- Variable disponible: {{phone}} para el número del contacto

Para nodo "Etiqueta":
- Input: nombre de la etiqueta

**Guardar flujo:**
- PUT /api/flows/:id con { name, nodes: [...], edges: [...] }
- Los nodes y edges son el estado de React Flow serializado
- Mostrar toast de éxito "Flujo guardado ✓"

**Crear nuevo flujo:**
- POST /api/flows con { name: "Nuevo flujo", nodes: [nodo inicio], edges: [] }
- Redirigir al editor con el id recibido

### 6. /triggers — Activadores
Lista en tabla:
- Nombre, keyword (badge verde), flujo asociado, conexión, estado toggle, acciones

Botón "+ Nuevo activador" abre modal con:
- Input: Nombre del activador (ej: "Precio brigadeiros")
- Input: Frase activadora / keyword (ej: "precio", "hola", "info")
- Select: Flujo a ejecutar (GET /api/flows para poblar)
- Select: Conexión WhatsApp (GET /api/connections para poblar)
- Toggle: Estado (activo/inactivo)
- Toggle: Repetible (si puede dispararse varias veces al mismo contacto)
- Botón "Crear activador" → POST /api/triggers

### 7. /connections — Conexiones WhatsApp
Lista de números conectados con estado y botón desconectar.

Botón "+ Conectar número" abre modal paso a paso:

**Paso 1 — Instrucciones:**
"Para conectar WhatsApp Business necesitas:
1. Una cuenta en Meta for Developers (developers.facebook.com)
2. Una app con el producto WhatsApp activado
3. El Phone Number ID de tu número
4. Tu WABA ID (WhatsApp Business Account ID)
5. Un token de acceso permanente"
Botón: "Ya tengo mis datos → Siguiente"

**Paso 2 — Formulario:**
- Input: Nombre de la conexión (ej: "Bot brigadeiros")
- Input: Phone Number ID
- Input: WABA ID  
- Input (password): Access Token
Botón: "Conectar" → POST /api/connections
Si éxito: mostrar "✓ Conectado: {número}" con badge verde

### 8. /inbox — Conversaciones en tiempo real
Layout dos columnas:

**Columna izquierda (360px) — Lista de conversaciones:**
- Búsqueda por nombre/número
- Cada item: avatar con inicial, nombre/número, último mensaje, hora, badge de no leídos
- Polling cada 10 segundos: GET /api/conversations
- Click → carga mensajes en columna derecha

**Columna derecha — Mensajes:**
- Burbujas estilo WhatsApp: mensajes entrantes izquierda (gris), salientes derecha (verde)
- GET /api/conversations/:id/messages
- Auto-scroll al último mensaje
- Mostrar hora de cada mensaje

### 9. /settings — Configuración
- Sección "Mi cuenta": nombre, email, plan actual
- Sección "API Keys": input para pegar Anthropic API Key (se guarda en el backend del usuario)
- Sección "Peligro": botón eliminar cuenta

---

## SIDEBAR NAVEGACIÓN
Ícono + texto para cada sección:
- 🏠 Dashboard → /dashboard
- ⚡ Flujos → /flows
- 🎯 Activadores → /triggers
- 📱 Conexiones → /connections
- 💬 Inbox → /inbox (con badge de no leídos)
- ⚙️ Configuración → /settings

Footer del sidebar: avatar + nombre del usuario + badge del plan

---

## COMPONENTES GLOBALES
- Toast notifications (éxito en verde, error en rojo)
- Loading spinner para llamadas a API
- Modal reutilizable con overlay oscuro
- Estado vacío con ilustración cuando no hay datos
- Botones: primario verde, secundario gris oscuro, peligro rojo

---

## ESTADO GLOBAL (Zustand)
```
store: {
  user: null,
  token: null,
  login(token, user),
  logout(),
}
```

---

## NOTAS IMPORTANTES
1. El constructor de flujos usa React Flow (@xyflow/react) — importarlo con: `import ReactFlow from '@xyflow/react'`
2. Los nodos personalizados de React Flow tienen un punto de entrada (izquierda, círculo blanco) y uno de salida (derecha, círculo naranja) 
3. Al guardar un flujo, serializar con `toObject()` de React Flow y enviar `{ nodes, edges }` al backend
4. Al cargar un flujo existente, usar los `nodes` y `edges` guardados para restaurar el estado de React Flow
5. El nodo "Agente IA" debe verse destacado visualmente — usar degradado violeta y ícono de robot
6. Responsive solo en desktop (min-width: 1024px), no necesita mobile
