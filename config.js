'use strict';
// Configuración de la nube (Supabase). La "anon key" es pública por diseño:
// solo sirve para llegar al servidor; lo que protege tus datos es la CLAVE DE SINCRONIZACIÓN
// que generas en la app y que nunca sale de tus dispositivos.
//
// Cuando se cree el proyecto en Supabase se llenan estos dos valores.
window.MD_CONFIG = {
  SUPABASE_URL: 'https://hmzbgtoismdfsdljihwh.supabase.co',
  SUPABASE_KEY: 'sb_publishable_vN2mDuOuSxeyOYC2zycnRQ_Loez2tci',
  // Dirección pública de la app web (GitHub Pages). Se usa para los códigos QR de vinculación.
  APP_URL: 'https://ernestobucio-spec.github.io/mi-dinero/',
  VERSION: '2.1.2'
};
