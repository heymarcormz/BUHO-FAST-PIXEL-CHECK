/* =========================================================
   content.js — Búho Pixel Check
   Content script en ISOLATED world.
   Actúa como fallback cuando no es posible inyectar el escáner
   en MAIN world o cuando el panel lo consulta directamente.
   Realiza detección por regex sobre DOM/scripts accesibles.
   ========================================================= */

(function () {
  'use strict';

  // Evitar inyecciones duplicadas
  if (window.__buhoPixelCheckContentInjected) return;
  window.__buhoPixelCheckContentInjected = true;

  // ========================================================
  // HELPERS
  // ========================================================

  function getPageText() {
    try {
      const html = document.documentElement ? document.documentElement.outerHTML : '';
      return getScriptsText() + '\n' + html;
    } catch (e) {
      return getScriptsText();
    }
  }

  function getScriptsText() {
    try {
      const scripts = Array.from(document.querySelectorAll('script'));
      return scripts.map((s) => s.textContent || s.src || '').join('\n');
    } catch (e) {
      return '';
    }
  }

  function unique(arr) {
    return Array.from(new Set(arr.filter(Boolean)));
  }

  function extractAll(text, regex) {
    const matches = [];
    let match;
    try {
      regex.lastIndex = 0;
      while ((match = regex.exec(text)) !== null) {
        matches.push(match[0]);
        if (regex.lastIndex === match.index) regex.lastIndex++;
      }
    } catch (e) {
      return [];
    }
    return unique(matches);
  }

  // ========================================================
  // DETECTORES DE RESPALDO
  // ========================================================

  function scanPage() {
    const text = getPageText();
    const results = [];

    // GTM
    results.push({
      platform: 'Google Tag Manager',
      type: 'Container ID',
      ids: extractAll(text, /GTM-[A-Z0-9]{4,}/gi),
      detected: /GTM-[A-Z0-9]{4,}/i.test(text) || typeof window.dataLayer !== 'undefined'
    });

    // GA4: detección estricta y contextual (sin leer atributos HTML/CSS)
    const ga4Ids = new Set();
    const scriptsText = getScriptsText();
    const scripts = Array.from(document.querySelectorAll('script'));

    // Llamadas gtag('config', 'G-XXXXXXXXXX')
    extractAll(scriptsText, /gtag\s*\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]{10})['"]/gi)
      .forEach((id) => ga4Ids.add(id));

    // URLs de carga
    scripts.forEach((s) => {
      if (s.src) {
        extractAll(s.src, /[?&](id|tid)=(G-[A-Z0-9]{10})/gi)
          .map((m) => m.match(/G-[A-Z0-9]{10}/i)?.[0])
          .filter(Boolean)
          .forEach((id) => ga4Ids.add(id));
      }
    });

    // dataLayer
    if (Array.isArray(window.dataLayer)) {
      try {
        extractAll(JSON.stringify(window.dataLayer), /G-[A-Z0-9]{10}/g)
          .forEach((id) => ga4Ids.add(id));
      } catch (e) { /* ignorar */ }
    }

    // Cookies de sesión _ga_GXXXXXXXXXX
    if (document.cookie) {
      document.cookie.split(';').forEach((c) => {
        const name = c.trim().split('=')[0];
        const match = name.match(/^_ga_(G[A-Z0-9]{10})$/i);
        if (match) {
          ga4Ids.add('G-' + match[1].substring(1));
        }
      });
    }

    results.push({
      platform: 'Google Analytics 4',
      type: 'Measurement ID',
      ids: Array.from(ga4Ids),
      detected: ga4Ids.size > 0 || typeof window.gtag !== 'undefined' || /googletagmanager\.com\/gtag\/js\?id=G-[A-Z0-9]{10}/i.test(scriptsText)
    });

    // Google Ads
    results.push({
      platform: 'Google Ads',
      type: 'Conversion ID',
      ids: extractAll(text, /AW-[0-9]+/gi),
      detected: /AW-[0-9]+/i.test(text) || /_gcl_/i.test(text)
    });

    // Floodlight
    results.push({
      platform: 'Floodlight',
      type: 'Advertiser ID',
      ids: extractAll(text, /DC-[0-9]+/gi),
      detected: /DC-[0-9]+/i.test(text)
    });

    // Meta (Facebook) Pixel: detección estricta (fallback)
    const metaIds = new Set();

    // Llamadas fbq('init', 'PIXEL_ID') en scripts
    extractAll(scriptsText, /fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d{12,16})['"]/gi)
      .map((m) => m.match(/\d{12,16}/)?.[0])
      .filter(Boolean)
      .forEach((id) => metaIds.add(id));

    // window.fbq.queue
    if (window.fbq && Array.isArray(window.fbq.queue)) {
      window.fbq.queue.forEach((call) => {
        if (Array.isArray(call) && call[0] === 'init' && /^\d{12,16}$/.test(String(call[1]))) {
          metaIds.add(String(call[1]));
        }
      });
    }

    // window._fbq (legacy)
    if (window._fbq && Array.isArray(window._fbq)) {
      window._fbq.forEach((call) => {
        if (Array.isArray(call) && call[0] === 'init' && /^\d{12,16}$/.test(String(call[1]))) {
          metaIds.add(String(call[1]));
        }
      });
    }

    results.push({
      platform: 'Meta (Facebook)',
      type: 'Pixel ID',
      ids: Array.from(metaIds),
      detected: metaIds.size > 0 || typeof window.fbq === 'function'
    });

    // TikTok
    const tiktokIds = extractAll(text, /ttq\.load\s*\(\s*['"]([A-Z0-9]+)['"]/gi)
      .map((m) => m.match(/[A-Z0-9]{18,}/)?.[0])
      .filter(Boolean);
    results.push({
      platform: 'TikTok',
      type: 'Pixel ID',
      ids: unique(tiktokIds),
      detected: /ttq|tiktok/i.test(text)
    });

    // QuantumMetric
    results.push({
      platform: 'QuantumMetric',
      type: 'Snippet / API',
      ids: extractAll(text, /qm-[a-z0-9]+/gi),
      detected: /quantummetric/i.test(text)
    });

    // Adobe
    const adobeIds = [];
    if (typeof window.s_account === 'string' && window.s_account) adobeIds.push(window.s_account);
    results.push({
      platform: 'Adobe Analytics',
      type: 'Report Suite / Launch',
      ids: unique([...adobeIds, ...extractAll(text, /launch-[a-z0-9-]+/gi)]),
      detected: /adobedtm|s_account/i.test(text)
    });

    // Bing
    const bingIds = extractAll(text, /uetq\.push\s*\(\s*\[\s*['"]config['"]\s*,\s*['"]([A-Z0-9]+)['"]/gi)
      .map((m) => m.match(/[A-Z0-9]{8,}/gi))
      .filter(Boolean)
      .flat();
    results.push({
      platform: 'Bing Ads',
      type: 'UET Tag ID',
      ids: unique(bingIds),
      detected: /uetq|bat\.bing/i.test(text)
    });

    return results;
  }

  // ========================================================
  // COMUNICACIÓN CON EL PANEL
  // ========================================================

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'SCAN_PAGE') {
      try {
        sendResponse(scanPage());
      } catch (e) {
        sendResponse([]);
      }
      return true;
    }
  });

  // Notificación automática al cargar (por si el panel escucha)
  try {
    chrome.runtime.sendMessage({
      action: 'SCAN_PAGE_RESULT',
      payload: scanPage()
    }).catch(() => {
      // El panel puede no estar abierto; se ignora.
    });
  } catch (e) {
    // Ignorar errores de mensajería
  }
})();
