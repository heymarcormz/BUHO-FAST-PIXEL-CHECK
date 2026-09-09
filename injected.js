/* =========================================================
   injected.js — Búho Pixel Check
   Script inyectado en el contexto principal (MAIN world) de la página.
   Accede a variables globales privadas como window.ttq,
   window.google_tag_manager, window.dataLayer y window.gtag,
   permitiendo una detección mucho más fiable de píxeles y tags.
   ========================================================= */

(function () {
  'use strict';

  // Evitar definir el escáner más de una vez
  if (window.__buhoPixelCheckScan) return;

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

  function safeGlobal(name) {
    try {
      return window[name];
    } catch (e) {
      return undefined;
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
      // Ignorar errores de regex
    }
    return unique(matches);
  }

  function safeStringify(obj) {
    try {
      return JSON.stringify(obj);
    } catch (e) {
      return '';
    }
  }

  // ========================================================
  // DETECTORES
  // ========================================================

  function scanGTM(text) {
    const ids = extractAll(text, /GTM-[A-Z0-9]{4,}/gi);
    const hasDataLayer = !!safeGlobal('dataLayer');
    const hasGTMObject = !!safeGlobal('google_tag_manager');
    const hasGTMUrl = /googletagmanager\.com\/gtm\.js/i.test(text);

    return {
      platform: 'Google Tag Manager',
      type: 'Container ID',
      ids: ids,
      detected: ids.length > 0 || hasDataLayer || hasGTMObject || hasGTMUrl
    };
  }

  /**
   * GA4: detección estricta y contextual.
   * Patrón oficial: G-[A-Z0-9]{10}
   * No escanea atributos HTML/CSS (class, id, etc.); solo scripts,
   * variables globales, URLs de carga y cookies de sesión oficiales.
   */
  function scanGA4() {
    const ids = new Set();
    const scriptsText = getScriptsText();
    const scripts = Array.from(document.querySelectorAll('script'));

    // 1. Llamadas explícitas gtag('config', 'G-XXXXXXXXXX')
    const configMatches = extractAll(scriptsText, /gtag\s*\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]{10})['"]/gi);
    configMatches.forEach((id) => ids.add(id));

    // 2. URLs de carga del script de GA4/GTM
    scripts.forEach((s) => {
      if (s.src) {
        const srcMatches = extractAll(s.src, /[?&](id|tid)=(G-[A-Z0-9]{10})/gi)
          .map((m) => m.match(/G-[A-Z0-9]{10}/i)?.[0])
          .filter(Boolean);
        srcMatches.forEach((id) => ids.add(id));
      }
    });

    // 3. window.dataLayer
    const dataLayer = safeGlobal('dataLayer');
    if (Array.isArray(dataLayer) && dataLayer.length) {
      const dlText = safeStringify(dataLayer);
      extractAll(dlText, /G-[A-Z0-9]{10}/g).forEach((id) => ids.add(id));
    }

    // 4. window.google_tag_manager
    const gtm = safeGlobal('google_tag_manager');
    if (gtm) {
      const gtmText = safeStringify(gtm);
      extractAll(gtmText, /G-[A-Z0-9]{10}/g).forEach((id) => ids.add(id));
    }

    // 5. Endpoints de recopilación de GA4
    const collectMatches = extractAll(
      scriptsText,
      /google-analytics\.com\/g\/collect\?[^"'\s]*tid=(G-[A-Z0-9]{10})/gi
    )
      .map((m) => m.match(/G-[A-Z0-9]{10}/i)?.[0])
      .filter(Boolean);
    collectMatches.forEach((id) => ids.add(id));

    // 6. Cookies de sesión oficiales: _ga_GXXXXXXXXXX -> G-XXXXXXXXXX
    if (document.cookie) {
      const cookieNames = document.cookie.split(';').map((c) => c.trim().split('=')[0]);
      cookieNames.forEach((name) => {
        const match = name.match(/^_ga_(G[A-Z0-9]{10})$/i);
        if (match) {
          const suffix = match[1]; // GXXXXXXXXXX
          ids.add('G-' + suffix.substring(1)); // G-XXXXXXXXXX
        }
      });
    }

    const idArray = Array.from(ids);
    const hasGtag = typeof safeGlobal('gtag') === 'function' || typeof safeGlobal('gtag') === 'object';
    const hasGA4Url = /googletagmanager\.com\/gtag\/js\?id=G-[A-Z0-9]{10}/i.test(scriptsText);

    return {
      platform: 'Google Analytics 4',
      type: 'Measurement ID',
      ids: idArray,
      detected: idArray.length > 0 || hasGtag || hasGA4Url
    };
  }

  /**
   * Google Ads: búsqueda exhaustiva en múltiples fuentes.
   */
  function scanGoogleAds(text) {
    const ids = [];

    // 1. gtag('config', 'AW-XXXXXXXXX')
    const configMatches = extractAll(text, /gtag\s*\(\s*['"]config['"]\s*,\s*['"](AW-[0-9]+)['"]/gi)
      .map((m) => {
        const mm = m.match(/AW-[0-9]+/i);
        return mm ? mm[0] : null;
      })
      .filter(Boolean);
    ids.push(...configMatches);

    // 2. En window.dataLayer
    const dataLayer = safeGlobal('dataLayer');
    if (Array.isArray(dataLayer) && dataLayer.length) {
      const dlText = safeStringify(dataLayer);
      ids.push(...extractAll(dlText, /AW-[0-9]+/gi));
    }

    // 3. Dentro de window.google_tag_manager (puede contener conversiones)
    const gtm = safeGlobal('google_tag_manager');
    if (gtm) {
      const gtmText = safeStringify(gtm);
      ids.push(...extractAll(gtmText, /AW-[0-9]+/gi));
    }

    // 4. Todo el DOM y scripts
    ids.push(...extractAll(text, /AW-[0-9]+/gi));

    const uniqueIds = unique(ids);
    const hasGclCookies = /_gcl_au|_gcl_aw|_gcl_dc|_gcl_gb/i.test(text);

    return {
      platform: 'Google Ads',
      type: 'Conversion ID',
      ids: uniqueIds,
      detected: uniqueIds.length > 0 || hasGclCookies
    };
  }

  function scanFloodlight(text) {
    const ids = extractAll(text, /DC-[0-9]+/gi);
    const hasFlSrc = /src\.floodlight/i.test(text);
    const hasFlUrl = /fls\.doubleclick\.net\/activityi/i.test(text);

    return {
      platform: 'Floodlight',
      type: 'Advertiser ID',
      ids: ids,
      detected: ids.length > 0 || hasFlSrc || hasFlUrl
    };
  }

  /**
   * Meta (Facebook) Pixel: detección estricta.
   * Únicamente se aceptan IDs numéricos de 12-16 dígitos provenientes de:
   * 1. Llamadas fbq('init', 'PIXEL_ID') en scripts.
   * 2. El objeto global window.fbq.queue / window._fbq.
   * No se escanea el HTML/DOM plano en busca de números aleatorios.
   */
  function scanMeta(scriptsText) {
    const ids = new Set();

    // 1. fbq('init', 'PIXEL_ID') en scripts
    const initMatches = extractAll(scriptsText, /fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d{12,16})['"]/gi)
      .map((m) => m.match(/\d{12,16}/)?.[0])
      .filter(Boolean);
    initMatches.forEach((id) => ids.add(id));

    // 2. window.fbq.queue
    const fbq = safeGlobal('fbq');
    if (fbq && typeof fbq === 'function' && fbq.queue && Array.isArray(fbq.queue)) {
      fbq.queue.forEach((call) => {
        if (Array.isArray(call) && call[0] === 'init' && /^\d{12,16}$/.test(String(call[1]))) {
          ids.add(String(call[1]));
        }
      });
    }

    // 3. window._fbq (legacy)
    const _fbq = safeGlobal('_fbq');
    if (_fbq && Array.isArray(_fbq)) {
      _fbq.forEach((call) => {
        if (Array.isArray(call) && call[0] === 'init' && /^\d{12,16}$/.test(String(call[1]))) {
          ids.add(String(call[1]));
        }
      });
    }

    const idArray = Array.from(ids);
    const hasMetaScript = /connect\.facebook\.net\/.*\/fbevents\.js/i.test(scriptsText);

    return {
      platform: 'Meta (Facebook)',
      type: 'Pixel ID',
      ids: idArray,
      detected: idArray.length > 0 || hasMetaScript
    };
  }

  /**
   * TikTok: lectura robusta desde window.ttq y scripts.
   */
  function scanTikTok(text) {
    const ids = [];

    // 1. window.ttq — múltiples rutas posibles según versión del SDK
    const ttq = safeGlobal('ttq');
    if (ttq && typeof ttq === 'object') {
      if (Array.isArray(ttq._pixelIds)) {
        ids.push(...ttq._pixelIds);
      }
      if (Array.isArray(ttq._i)) {
        ttq._i.forEach((item) => {
          if (item) {
            if (item.pixelId) ids.push(item.pixelId);
            if (item.pixel_id) ids.push(item.pixel_id);
            if (item.id) ids.push(item.id);
          }
        });
      }
      if (ttq.pixelId) ids.push(ttq.pixelId);
      if (ttq.pixel_id) ids.push(ttq.pixel_id);
      if (ttq.config && ttq.config.pixelId) ids.push(ttq.config.pixelId);
      if (ttq.config && ttq.config.pixel_id) ids.push(ttq.config.pixel_id);
    }

    // 2. window.TiktokAnalyticsObject
    const taoName = safeGlobal('TiktokAnalyticsObject');
    if (typeof taoName === 'string') {
      const tao = safeGlobal(taoName);
      if (tao && typeof tao === 'object') {
        if (Array.isArray(tao._pixelIds)) ids.push(...tao._pixelIds);
        if (tao.pixelId) ids.push(tao.pixelId);
      }
    }

    // 3. Llamadas ttq.load('PIXEL_ID') en texto
    const loadMatches = extractAll(text, /ttq\.load\s*\(\s*['"]([A-Z0-9]+)['"]/gi)
      .map((m) => {
        const mm = m.match(/[A-Z0-9]{18,}/);
        return mm ? mm[0] : null;
      })
      .filter(Boolean);
    ids.push(...loadMatches);

    // 4. URL del SDK de TikTok
    const hasTikTokScript = /analytics\.tiktok\.com\/i18n\/pixel\/sdk\.js/i.test(text);

    const uniqueIds = unique(ids);

    return {
      platform: 'TikTok',
      type: 'Pixel ID',
      ids: uniqueIds,
      detected: uniqueIds.length > 0 || hasTikTokScript
    };
  }

  function scanQuantumMetric(text) {
    const hasQM = !!safeGlobal('QuantumMetricAPI') || !!safeGlobal('QuantumMetric');
    const hasQMScript = /quantummetric\.com|\.quantummetric\./i.test(text);
    const snippetIds = extractAll(text, /qm-[a-z0-9]+/gi);

    return {
      platform: 'QuantumMetric',
      type: 'Snippet / API',
      ids: snippetIds,
      detected: hasQM || hasQMScript || snippetIds.length > 0
    };
  }

  function scanAdobe(text) {
    const sAccount = safeGlobal('s_account');
    const hasAppMeasurement = typeof safeGlobal('s_gi') === 'function' || typeof safeGlobal('AppMeasurement') === 'function';
    const hasAdobeScript = /assets\.adobedtm\.com|adobedtm\.com\/launch/i.test(text);
    const accountIds = [];
    if (typeof sAccount === 'string' && sAccount) accountIds.push(sAccount);
    const launchIds = extractAll(text, /launch-[a-z0-9-]+/gi);
    const ids = unique([...accountIds, ...launchIds]);

    return {
      platform: 'Adobe Analytics',
      type: 'Report Suite / Launch',
      ids: ids,
      detected: ids.length > 0 || hasAppMeasurement || hasAdobeScript
    };
  }

  function scanBing(text) {
    const hasUetq = typeof safeGlobal('uetq') === 'object' || typeof safeGlobal('uetq') === 'function';
    const hasBingScript = /bat\.bing\.com\/bat\.js/i.test(text);
    const uetTags = extractAll(text, /uetq\.push\s*\(\s*\[\s*['"]config['"]\s*,\s*['"]([A-Z0-9]+)['"]/gi)
      .map((m) => m.match(/[A-Z0-9]{8,}/gi))
      .filter(Boolean)
      .flat();
    const ids = unique(uetTags);

    return {
      platform: 'Bing Ads',
      type: 'UET Tag ID',
      ids: ids,
      detected: ids.length > 0 || hasUetq || hasBingScript
    };
  }

  // ========================================================
  // ESCÁNER GLOBAL
  // ========================================================

  window.__buhoPixelCheckScan = function () {
    const text = getPageText();

    return [
      scanGTM(text),
      scanGA4(),
      scanGoogleAds(text),
      scanFloodlight(text),
      scanMeta(text),
      scanTikTok(text),
      scanQuantumMetric(text),
      scanAdobe(text),
      scanBing(text)
    ];
  };
})();
