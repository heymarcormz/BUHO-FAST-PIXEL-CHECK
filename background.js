/* =========================================================
   background.js — Búho Pixel Check
   Service Worker de Manifest V3.
   Lee cookies asociadas a cada plataforma para la URL activa,
   con manejo de errores y respuestas estructuradas.
   ========================================================= */

'use strict';

// ========================================================
// MAPEO DE COOKIES POR PLATAFORMA
// Los patrones que terminan en '_' se buscan como prefijo (startsWith).
// ========================================================

const COOKIE_MAP = [
  {
    platform: 'Google Analytics 4',
    cookies: ['_ga', '_gid', '_gat', '_ga_']
  },
  {
    platform: 'Google Ads',
    cookies: ['_gcl_au', '_gcl_aw', '_gcl_dc', '_gcl_gb', '_gcl_ha', '_gcl']
  },
  {
    platform: 'Meta (Facebook)',
    cookies: ['_fbp', '_fbc']
  },
  {
    platform: 'TikTok',
    cookies: ['_ttp', '_tt_enable_cookie', 'tt_webid', 'tt_webid_v2', 'ttclid', 'ticsid']
  },
  {
    platform: 'Bing Ads',
    cookies: ['_uetsid', '_uetvid', '_uetmsclkid']
  },
  {
    platform: 'Adobe Analytics',
    cookies: ['s_cc', 's_sq', 's_fid', 's_vi', 'AMCV_', 'AMCVS_']
  },
  {
    platform: 'QuantumMetric',
    cookies: ['_qm', 'QuantumMetricSessionID', 'QuantumMetricUserID']
  }
];

// ========================================================
// LECTURA DE COOKIES
// ========================================================

/**
 * Lee las cookies de la URL proporcionada y las agrupa por plataforma.
 * @param {string} url - URL de la pestaña inspeccionada.
 * @returns {Promise<Array<{platform, name, value, domain, detected}>>}
 */
async function readCookiesForUrl(url) {
  const results = [];

  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return results;
  }

  try {
    const allCookies = await chrome.cookies.getAll({ url });

    if (!Array.isArray(allCookies)) {
      return results;
    }

    COOKIE_MAP.forEach((group) => {
      group.cookies.forEach((pattern) => {
        const isPrefix = pattern.endsWith('_');
        const matched = allCookies.filter((cookie) => {
          if (!cookie || !cookie.name) return false;
          return isPrefix ? cookie.name.startsWith(pattern) : cookie.name === pattern;
        });

        matched.forEach((cookie) => {
          results.push({
            platform: group.platform,
            name: cookie.name,
            value: cookie.value || '',
            domain: cookie.domain || '',
            detected: true
          });
        });
      });
    });
  } catch (error) {
    console.error('[Búho Pixel Check] Error leyendo cookies:', error);
  }

  return results;
}

// ========================================================
// MENSAJES
// ========================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'GET_COOKIES') {
    readCookiesForUrl(request.url)
      .then((cookies) => {
        sendResponse({ success: true, cookies: cookies });
      })
      .catch((err) => {
        console.error('[Búho Pixel Check] Error en GET_COOKIES:', err);
        sendResponse({ success: false, error: err ? err.message : 'Unknown error', cookies: [] });
      });
    return true; // Respuesta asíncrona
  }
});

// ========================================================
// INSTALACIÓN
// ========================================================

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Búho Pixel Check] Extensión instalada/actualizada. Razón:', details.reason);
});
