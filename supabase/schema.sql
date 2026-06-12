-- ============================================================
-- SCHEMA COMPLETO PARA EL SAAS DE WHATSAPP BOT
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- ── Tabla de usuarios del SaaS ───────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  plan        TEXT DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Conexiones WhatsApp Business ────────────────────────────
CREATE TABLE IF NOT EXISTS connections (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  phone_number     TEXT,
  phone_number_id  TEXT NOT NULL,
  waba_id          TEXT NOT NULL,
  access_token     TEXT NOT NULL,
  is_active        BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Flujos del chatbot ───────────────────────────────────────
-- nodes y edges se guardan como JSONB (estructura del constructor)
CREATE TABLE IF NOT EXISTS flows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  nodes       JSONB DEFAULT '[]'::jsonb,
  edges       JSONB DEFAULT '[]'::jsonb,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Activadores (keyword → flujo) ───────────────────────────
CREATE TABLE IF NOT EXISTS triggers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  flow_id        UUID REFERENCES flows(id) ON DELETE CASCADE,
  connection_id  UUID REFERENCES connections(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  keyword        TEXT NOT NULL,
  is_active      BOOLEAN DEFAULT TRUE,
  is_repeatable  BOOLEAN DEFAULT TRUE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Conversaciones (una por contacto) ───────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  connection_id   UUID REFERENCES connections(id) ON DELETE CASCADE,
  contact_phone   TEXT NOT NULL,
  contact_name    TEXT,
  last_message    TEXT,
  last_message_at TIMESTAMPTZ,
  unread_count    INT DEFAULT 0,
  status          TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed', 'pending')),
  tags            TEXT[] DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Mensajes individuales ────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID REFERENCES conversations(id) ON DELETE CASCADE,
  content          TEXT NOT NULL,
  direction        TEXT CHECK (direction IN ('inbound', 'outbound')),
  msg_type         TEXT DEFAULT 'text',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Registro de ejecuciones de triggers ─────────────────────
CREATE TABLE IF NOT EXISTS trigger_executions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id       UUID REFERENCES triggers(id) ON DELETE CASCADE,
  contact_phone    TEXT NOT NULL,
  conversation_id  UUID REFERENCES conversations(id) ON DELETE CASCADE,
  executed_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ÍNDICES para performance
-- ============================================================
CREATE INDEX idx_flows_user_id ON flows(user_id);
CREATE INDEX idx_triggers_user_id ON triggers(user_id);
CREATE INDEX idx_triggers_keyword ON triggers(keyword);
CREATE INDEX idx_connections_phone_number_id ON connections(phone_number_id);
CREATE INDEX idx_conversations_user_id ON conversations(user_id);
CREATE INDEX idx_conversations_contact ON conversations(contact_phone, connection_id);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

-- ============================================================
-- ROW LEVEL SECURITY (RLS) — cada usuario solo ve sus datos
-- ============================================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger_executions ENABLE ROW LEVEL SECURITY;

-- Nota: Como el backend usa service_role_key, bypasea RLS.
-- RLS protege accesos directos desde el frontend si alguna vez usas Supabase JS directo.

-- ============================================================
-- FUNCIÓN: actualizar updated_at automáticamente
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_connections_updated_at BEFORE UPDATE ON connections FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_flows_updated_at BEFORE UPDATE ON flows FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_triggers_updated_at BEFORE UPDATE ON triggers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
