// Supabase devuelve como máximo 1000 filas por consulta (aunque se pida .limit(20000)).
// Esta función lee todas las páginas para que los totales no se queden cortos.
// Uso: const filas = await traerTodo(() => supabase.from('tabla').select('...').eq('user_id', id).order('id'));
async function traerTodo(construir, pagina = 1000, maximo = 100000) {
  const todas = [];
  for (let desde = 0; desde < maximo; desde += pagina) {
    const { data, error } = await construir().range(desde, desde + pagina - 1);
    if (error) throw error;
    todas.push(...(data || []));
    if (!data || data.length < pagina) break;
  }
  return todas;
}
module.exports = { traerTodo };
