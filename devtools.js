/* =========================================================
   devtools.js — Búho Pixel Check
   Registra el panel "Búho Pixel Check" dentro de Chrome DevTools.
   ========================================================= */

'use strict';

chrome.devtools.panels.create(
  'Búho Pixel Check',     // Título visible en la pestaña de DevTools
  'logo.png',             // Icono de la pestaña
  'panel.html',           // HTML del panel
  function (panel) {
    console.log('[Búho Pixel Check] Panel registrado correctamente en DevTools.');
  }
);
