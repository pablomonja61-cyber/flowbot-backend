const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const supabase = require('../models/supabase');
const { v4: uuidv4 } = require('uuid');

router.use(auth);

// ── POST /api/media/upload ────────────────────────────────────
// Acepta JSON: { name, type, data (base64) }
router.post('/upload', async (req, res, next) => {
  try {
    const { name, type, data } = req.body;

    if (!name || !data) {
      return res.status(400).json({ error: 'Se requiere name y data (base64)' });
    }

    // Convertir base64 a buffer
    const base64Data = data.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const ext = name.split('.').pop();
    const mimeType = type || 'application/octet-stream';
    const uniqueName = `${req.user.id}/${uuidv4()}.${ext}`;

    // Subir a Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('media')
      .upload(uniqueName, buffer, {
        contentType: mimeType,
        upsert: false
      });

    if (uploadError) throw uploadError;

    // Obtener URL pública
    const { data: urlData } = supabase.storage
      .from('media')
      .getPublicUrl(uniqueName);

    const publicUrl = urlData.publicUrl;

    // Guardar en tabla media
    const { data: record, error } = await supabase
      .from('media')
      .insert({
        id: uuidv4(),
        user_id: req.user.id,
        name,
        url: publicUrl,
        type: mimeType,
        size: buffer.length,
        path: uniqueName,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(record);
  } catch (err) {
    console.error('[Media upload error]', err);
    next(err);
  }
});

// ── GET /api/media ────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { type } = req.query;
    let query = supabase
      .from('media')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (type && type !== 'all') {
      query = query.ilike('type', `${type}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/media/:id ─────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const { data: file, error: findError } = await supabase
      .from('media')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (findError || !file) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }

    await supabase.storage.from('media').remove([file.path]);

    const { error } = await supabase
      .from('media')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
