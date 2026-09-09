/* =========================================================
   panel.js — Búho Pixel Check
   Lógica del panel de DevTools:
   · Inyecta injected.js en MAIN world para leer variables globales.
   · Si MAIN world falla, usa content.js como fallback.
   · Intercepta peticiones de red con chrome.devtools.network.
   · Solicita cookies al service worker.
   · Agrupa resultados por ID de propiedad/píxel con sus parámetros únicos.
   · Filtra la tabla por plataforma en tiempo real.
   · Renderiza la tabla de 5 columnas y permite exportar CSV/JSON.
   ========================================================= */

(function () {
  'use strict';

  // Referencias del DOM
  const elBody = document.getElementById('results-body');
  const elStatus = document.getElementById('scan-status');
  const elScanUrl = document.getElementById('scan-url');
  const elScanTime = document.getElementById('scan-time');
  const elBtnScan = document.getElementById('btn-scan');
  const elBtnCsv = document.getElementById('btn-export-csv');
  const elBtnJson = document.getElementById('btn-export-json');
  const elThemeToggle = document.getElementById('theme-toggle');
  const elThemeIcon = elThemeToggle.querySelector('.theme-icon');
  const elLogo = document.getElementById('app-logo');
  const elPlatformFilter = document.getElementById('platform-filter');

  // Estado
  let currentTabId = null;
  let currentUrl = '';
  let currentDomain = '';
  let allFindings = [];
  let filteredFindings = [];
  let currentFilter = 'all';
  let currentTheme = 'dark';
  let lastDomResults = [];
  let lastCookieResults = [];

  // Datos interceptados de red en tiempo real
  const networkData = {
    ga4: new Map(), // key: tid (G-XXXXXXXXXX), value: { cid, sid, sct }
    tiktok: new Set(),
    meta: new Set(), // Pixel IDs numéricos de Meta
    adobe: new Set() // Marketing Cloud Visitor IDs (mid) de Adobe
  };

  // ========================================================
  // INICIALIZACIÓN
  // ========================================================

  document.addEventListener('DOMContentLoaded', () => {
    try {
      currentTabId = chrome.devtools.inspectedWindow.tabId;
    } catch (e) {
      currentTabId = null;
    }
    loadTheme();
    bindEvents();
    handleLogoError();
  });

  function bindEvents() {
    elBtnScan.addEventListener('click', runScan);
    elBtnCsv.addEventListener('click', exportToCSV);
    elBtnJson.addEventListener('click', exportToJSON);
    elThemeToggle.addEventListener('click', toggleTheme);
    elPlatformFilter.addEventListener('change', onFilterChange);

    // Iniciar escucha de peticiones de red lo antes posible
    initNetworkListener();

    // Auto-escaneo con retardo para asegurar que el content script esté listo
    setTimeout(runScan, 400);
  }

  function handleLogoError() {
    elLogo.addEventListener('error', () => {
      elLogo.style.display = 'none';
      const placeholder = document.createElement('div');
      placeholder.className = 'logo-placeholder';
      placeholder.textContent = '🦉';
      placeholder.title = 'Búho Pixel Check';
      elLogo.parentNode.insertBefore(placeholder, elLogo);
    });
  }

  // ========================================================
  // TEMAS
  // ========================================================

  function loadTheme() {
    chrome.storage.local.get(['bpcTheme'], (result) => {
      currentTheme = result.bpcTheme || 'dark';
      applyTheme(currentTheme);
    });
  }

  function toggleTheme() {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(currentTheme);
    chrome.storage.local.set({ bpcTheme: currentTheme });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    elThemeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
    elThemeToggle.setAttribute(
      'aria-label',
      theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'
    );
  }

  // ========================================================
  // RED: INTERCEPCIÓN DE PETICIONES
  // ========================================================

  function extractUrlParams(url) {
    const params = {};
    try {
      const urlObj = new URL(url);
      urlObj.searchParams.forEach((value, key) => {
        params[key] = value;
      });
    } catch (e) {
      // URL malformada; se ignora
    }
    return params;
  }

  function extractPostDataParams(postDataText) {
    const params = {};
    if (!postDataText) return params;

    try {
      const json = JSON.parse(postDataText);
      Object.keys(json).forEach((key) => {
        params[key] = String(json[key]);
      });
      return params;
    } catch (e) {
      // No es JSON
    }

    try {
      const searchParams = new URLSearchParams(postDataText);
      searchParams.forEach((value, key) => {
        params[key] = value;
      });
    } catch (e) {
      // Ignorar
    }

    return params;
  }

  function getAllRequestParams(request) {
    const urlParams = extractUrlParams(request.request.url || '');
    const postDataText = request.request.postData ? request.request.postData.text : '';
    const postParams = extractPostDataParams(postDataText);
    return { ...postParams, ...urlParams };
  }

  function handleNetworkRequest(request) {
    try {
      const url = request.request.url || '';

      // GA4
      if (/google-analytics\.com\/g\/collect|analytics\.google\.com\/g\/collect/i.test(url)) {
        const params = getAllRequestParams(request);
        const tid = params.tid;
        if (tid && /^G-[A-Z0-9]{10}$/i.test(tid)) {
          const normalizedTid = tid.toUpperCase();
          const existing = networkData.ga4.get(normalizedTid) || {};
          networkData.ga4.set(normalizedTid, {
            cid: params.cid || existing.cid || '',
            sid: params.sid || existing.sid || '',
            sct: params.sct || existing.sct || ''
          });
          refreshTableFromNetwork();
        }
      }

      // TikTok
      if (/analytics\.tiktok\.com|business-api\.tiktok\.com/i.test(url)) {
        const params = getAllRequestParams(request);
        const pixelCode = params.pixel_code || params.sdkid || '';
        if (pixelCode) {
          networkData.tiktok.add(pixelCode);
          refreshTableFromNetwork();
        }
      }

      // Meta (Facebook) Pixel: solo dominios oficiales y parámetro id=
      if (/facebook\.com\/tr\/|connect\.facebook\.net/i.test(url)) {
        const params = getAllRequestParams(request);
        const pixelId = params.id || '';
        if (/^\d{12,16}$/.test(pixelId)) {
          networkData.meta.add(pixelId);
          refreshTableFromNetwork();
        }
      }

      // Adobe Analytics: Marketing Cloud Visitor ID (mid)
      if (/2o7\.net|omtrdc\.net/i.test(url)) {
        const params = getAllRequestParams(request);
        const mid = params.mid || '';
        if (mid && mid.length >= 20) {
          networkData.adobe.add(mid);
          refreshTableFromNetwork();
        }
      }
    } catch (e) {
      console.error('[Búho Pixel Check] Error en handleNetworkRequest:', e);
    }
  }

  function initNetworkListener() {
    if (!chrome.devtools || !chrome.devtools.network || !chrome.devtools.network.onRequestFinished) {
      console.warn('[Búho Pixel Check] API de red de DevTools no disponible.');
      return;
    }
    chrome.devtools.network.onRequestFinished.addListener(handleNetworkRequest);
  }

  function refreshTableFromNetwork() {
    if (!allFindings.length || !currentUrl) return;
    const scannedAt = new Date().toLocaleString();
    elScanTime.textContent = scannedAt + ' (actualizado por red)';
    rebuildFindings();
  }

  // ========================================================
  // ESCANEO PRINCIPAL
  // ========================================================

  async function runScan() {
    if (!currentTabId) {
      setStatus('No se pudo identificar la pestaña inspeccionada.', 'error');
      return;
    }

    setLoading(true);
    setStatus('Escaneando página inspeccionada…', 'scanning');

    try {
      currentUrl = await getInspectedUrl();
      currentDomain = extractHostname(currentUrl);
      elScanUrl.textContent = currentUrl || 'URL no disponible';
      elScanUrl.title = currentUrl || '';

      if (!currentUrl) {
        throw new Error('No se pudo determinar la URL de la página inspeccionada.');
      }

      let domResults = [];
      try {
        await injectMainWorldScanner(currentTabId);
        domResults = await executeMainWorldScan(currentTabId);
      } catch (mainErr) {
        console.warn('[Búho Pixel Check] MAIN world falló, usando fallback:', mainErr);
        domResults = await executeContentScan(currentTabId);
      }
      lastDomResults = Array.isArray(domResults) ? domResults : [];

      const cookieResponse = await getCookiesFromBackground(currentUrl);
      lastCookieResults = (cookieResponse && cookieResponse.cookies) ? cookieResponse.cookies : [];

      const scannedAt = new Date().toLocaleString();
      elScanTime.textContent = scannedAt;

      rebuildFindings(scannedAt);
      setStatus(`Escaneo completado · ${allFindings.length} IDs detectados.`, 'ok');
    } catch (error) {
      console.error('[Búho Pixel Check] Error de escaneo:', error);
      setStatus('Error: ' + (error.message || 'No se pudo completar el escaneo.'), 'error');
      renderError(error.message || 'Error desconocido.');
    } finally {
      setLoading(false);
    }
  }

  function getInspectedUrl() {
    return new Promise((resolve, reject) => {
      chrome.devtools.inspectedWindow.eval(
        'document.location.href',
        (result, isException) => {
          if (isException) {
            reject(new Error('No se pudo leer la URL de la página inspeccionada.'));
          } else {
            resolve(result || '');
          }
        }
      );
    });
  }

  async function injectMainWorldScanner(tabId) {
    return chrome.scripting.executeScript({
      target: { tabId },
      files: ['injected.js'],
      world: 'MAIN',
      injectImmediately: true
    });
  }

  function executeMainWorldScan(tabId) {
    return new Promise((resolve, reject) => {
      chrome.devtools.inspectedWindow.eval(
        'window.__buhoPixelCheckScan ? window.__buhoPixelCheckScan() : []',
        (result, isException) => {
          if (isException) {
            reject(new Error(isException.value || 'Error ejecutando escáner en MAIN world.'));
          } else {
            resolve(Array.isArray(result) ? result : []);
          }
        }
      );
    });
  }

  async function executeContentScan(tabId) {
    try {
      return await chrome.tabs.sendMessage(tabId, { action: 'SCAN_PAGE' });
    } catch (err) {
      return new Promise((resolve, reject) => {
        const listener = (message, sender) => {
          if (sender.tab && sender.tab.id === tabId && message.action === 'SCAN_PAGE_RESULT') {
            chrome.runtime.onMessage.removeListener(listener);
            resolve(Array.isArray(message.payload) ? message.payload : []);
          }
        };
        chrome.runtime.onMessage.addListener(listener);

        chrome.scripting
          .executeScript({ target: { tabId }, files: ['content.js'] })
          .catch(reject);

        setTimeout(() => {
          chrome.runtime.onMessage.removeListener(listener);
          reject(new Error('Tiempo de espera agotado en el escaneo de respaldo.'));
        }, 8000);
      });
    }
  }

  function getCookiesFromBackground(url) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Timeout leyendo cookies', cookies: [] });
      }, 8000);

      try {
        chrome.runtime.sendMessage({ action: 'GET_COOKIES', url }, (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message, cookies: [] });
            return;
          }
          resolve(response || { success: true, cookies: [] });
        });
      } catch (e) {
        clearTimeout(timeout);
        resolve({ success: false, error: e.message, cookies: [] });
      }
    });
  }

  // ========================================================
  // PARSEO DE GA4 POR MEASUREMENT ID
  // ========================================================

  function parseGA4ByMid(cookies) {
    const result = {
      globalClientId: '',
      sessions: {}, // key: G-XXXXXXXXXX, value: { sessionId, sessionNumber, cookieValue }
      measurementIds: []
    };
    if (!Array.isArray(cookies)) return result;

    const gaCookie = cookies.find(
      (c) => c.platform === 'Google Analytics 4' && c.name === '_ga'
    );
    if (gaCookie && gaCookie.value) {
      const parts = gaCookie.value.split('.');
      if (parts.length >= 4) {
        result.globalClientId = parts.slice(2).join('.');
      }
    }

    cookies
      .filter((c) => c.platform === 'Google Analytics 4' && c.name.startsWith('_ga_'))
      .forEach((sessionCookie) => {
        const match = sessionCookie.name.match(/^_ga_(G[A-Z0-9]{10})$/i);
        if (match) {
          const mid = 'G-' + match[1].substring(1);
          if (!result.measurementIds.includes(mid)) {
            result.measurementIds.push(mid);
          }

          const parts = sessionCookie.value.split('.');
          if (parts.length >= 3 && parts[0] === 'GS1') {
            result.sessions[mid] = {
              sessionId: parts[2] || '',
              sessionNumber: parts[3] || '',
              cookieValue: sessionCookie.value
            };
          }
        }
      });

    return result;
  }

  // ========================================================
  // AGRUPACIÓN POR ID (FINDINGS)
  // ========================================================

  function rebuildFindings(timestamp) {
    const scannedAt = timestamp || new Date().toLocaleString();
    const ga4Parsed = parseGA4ByMid(lastCookieResults);
    allFindings = buildFindings(lastDomResults, lastCookieResults, ga4Parsed, currentUrl, scannedAt);
    applyFilter();
  }

  function buildFindings(domResults, cookieResults, ga4Parsed, url, timestamp) {
    const findings = [];
    const domByPlatform = groupByPlatform(domResults);
    const cookiesByPlatform = groupByPlatform(cookieResults);

    // =====================================================
    // GA4: una fila por Measurement ID
    // =====================================================
    const ga4Mids = unique([
      ...(domByPlatform['Google Analytics 4'] || []).flatMap((item) => item.ids || []),
      ...(ga4Parsed.measurementIds || []),
      ...Array.from(networkData.ga4.keys())
    ]).filter((id) => /^G-[A-Z0-9]{10}$/i.test(id));

    if (ga4Mids.length) {
      ga4Mids.forEach((mid) => {
        const details = [];
        const net = networkData.ga4.get(mid.toUpperCase());

        if (net && net.cid) {
          details.push({ name: 'Client ID', value: net.cid });
        } else if (ga4Parsed.globalClientId) {
          details.push({ name: 'Client ID', value: ga4Parsed.globalClientId });
        }

        if (net && net.sid) {
          details.push({ name: 'Session ID', value: net.sid });
        }
        if (net && net.sct) {
          details.push({ name: 'Session Number', value: net.sct });
        }

        const session = ga4Parsed.sessions[mid];
        if (session) {
          if (!net || !net.sid) {
            details.push({ name: 'Session ID', value: session.sessionId });
          }
          if (!net || !net.sct) {
            details.push({ name: 'Session Number', value: session.sessionNumber });
          }
          details.push({ name: sessionCookieName(mid), value: session.cookieValue });
        }

        findings.push(createFinding('Google Analytics 4', mid, details, url, timestamp));
      });
    } else if (hasCookiesForPlatform(cookiesByPlatform, 'Google Analytics 4') || ga4Parsed.globalClientId) {
      // GA4 presente por cookies pero sin MID identificado
      const details = [];
      if (ga4Parsed.globalClientId) {
        details.push({ name: 'Client ID', value: ga4Parsed.globalClientId });
      }
      details.push(...cookieDetails(cookiesByPlatform['Google Analytics 4'] || []));
      findings.push(createFinding('Google Analytics 4', 'No detectado', details, url, timestamp));
    }

    // =====================================================
    // TikTok: una fila por Pixel ID, con ttclid y ticsid destacados
    // =====================================================
    const tiktokIds = unique([
      ...(domByPlatform['TikTok'] || []).flatMap((item) => item.ids || []),
      ...Array.from(networkData.tiktok)
    ]);
    const tiktokCookies = cookiesByPlatform['TikTok'] || [];
    const tiktokTrackedCookies = ['ttclid', 'ticsid'];
    const tiktokTrackedDetails = tiktokCookies
      .filter((c) => tiktokTrackedCookies.includes(c.name))
      .map((c) => ({ name: c.name, value: c.value }));
    const tiktokOtherDetails = tiktokCookies
      .filter((c) => !tiktokTrackedCookies.includes(c.name))
      .map((c) => ({ name: c.name, value: c.value }));
    const tiktokAllDetails = [...tiktokTrackedDetails, ...tiktokOtherDetails];

    if (tiktokIds.length) {
      tiktokIds.forEach((id) => {
        findings.push(createFinding('TikTok', id, tiktokAllDetails, url, timestamp));
      });
    } else if (tiktokAllDetails.length) {
      findings.push(createFinding('TikTok', 'No detectado', tiktokAllDetails, url, timestamp));
    }

    // =====================================================
    // Meta (Facebook): una fila por Pixel ID (DOM + red)
    // =====================================================
    const metaIds = unique(
      (domByPlatform['Meta (Facebook)'] || [])
        .flatMap((item) => item.ids || [])
        .filter((id) => /^\d{12,16}$/.test(id))
        .concat(Array.from(networkData.meta))
    );
    const metaCookies = cookiesByPlatform['Meta (Facebook)'] || [];
    if (metaIds.length) {
      metaIds.forEach((id) => {
        findings.push(createFinding('Meta (Facebook)', id, cookieDetails(metaCookies), url, timestamp));
      });
    } else if (hasCookiesForPlatform(cookiesByPlatform, 'Meta (Facebook)') || wasDetected(domByPlatform['Meta (Facebook)'])) {
      findings.push(createFinding('Meta (Facebook)', 'No detectado', cookieDetails(metaCookies), url, timestamp));
    }

    // =====================================================
    // Adobe Analytics: IDs de DOM + Marketing Cloud Visitor ID (mid) de red
    // =====================================================
    const adobeIds = unique([
      ...(domByPlatform['Adobe Analytics'] || []).flatMap((item) => item.ids || []),
      ...Array.from(networkData.adobe)
    ]);
    const adobeCookies = cookiesByPlatform['Adobe Analytics'] || [];
    if (adobeIds.length) {
      adobeIds.forEach((id) => {
        findings.push(createFinding('Adobe Analytics', id, cookieDetails(adobeCookies), url, timestamp));
      });
    } else if (hasCookiesForPlatform(cookiesByPlatform, 'Adobe Analytics') || wasDetected(domByPlatform['Adobe Analytics'])) {
      findings.push(createFinding('Adobe Analytics', 'No detectado', cookieDetails(adobeCookies), url, timestamp));
    }

    // =====================================================
    // Plataformas restantes: una fila por ID detectado
    // =====================================================
    const genericPlatforms = [
      'Google Tag Manager',
      'Google Ads',
      'Floodlight',
      'QuantumMetric',
      'Bing Ads'
    ];

    genericPlatforms.forEach((platform) => {
      const ids = unique((domByPlatform[platform] || []).flatMap((item) => item.ids || []));
      const cookies = cookiesByPlatform[platform] || [];

      if (ids.length) {
        ids.forEach((id) => {
          findings.push(createFinding(platform, id, cookieDetails(cookies), url, timestamp));
        });
      } else if (hasCookiesForPlatform(cookiesByPlatform, platform) || wasDetected(domByPlatform[platform])) {
        findings.push(createFinding(platform, 'No detectado', cookieDetails(cookies), url, timestamp));
      }
    });

    return findings;
  }

  function createFinding(platform, id, details, url, timestamp) {
    return {
      platform,
      id: id || 'No detectado',
      details: details || [],
      url: url || '',
      timestamp: timestamp || '',
      detected: id && id !== 'No detectado'
    };
  }

  function groupByPlatform(items) {
    const map = {};
    (items || []).forEach((item) => {
      if (!item || !item.platform) return;
      if (!map[item.platform]) map[item.platform] = [];
      map[item.platform].push(item);
    });
    return map;
  }

  function hasCookiesForPlatform(map, platform) {
    return (map[platform] || []).length > 0;
  }

  function wasDetected(items) {
    return (items || []).some((item) => item.detected);
  }

  function cookieDetails(cookies) {
    return (cookies || []).map((c) => ({ name: c.name, value: c.value }));
  }

  function sessionCookieName(mid) {
    return '_ga_' + mid.replace('-', '');
  }

  // ========================================================
  // FILTRO POR PLATAFORMA
  // ========================================================

  function onFilterChange(event) {
    currentFilter = event.target.value;
    applyFilter();
  }

  function applyFilter() {
    if (currentFilter === 'all') {
      filteredFindings = allFindings;
    } else {
      filteredFindings = allFindings.filter((f) => f.platform === currentFilter);
    }
    renderTable(filteredFindings);
    updateFilterInfo();
  }

  function updateFilterInfo() {
    if (currentFilter === 'all') {
      elStatus.textContent = `Mostrando ${filteredFindings.length} de ${allFindings.length} IDs`;
    } else {
      elStatus.textContent = `${currentFilter}: ${filteredFindings.length} ID(s)`;
    }
    elStatus.style.color = 'var(--color-text)';
  }

  // ========================================================
  // RENDERIZADO
  // ========================================================

  function renderTable(rows) {
    elBody.innerHTML = '';

    if (!rows || rows.length === 0) {
      elBody.innerHTML = `
        <tr>
          <td colspan="5" class="empty-state">
            <strong>${allFindings.length ? 'Ningún resultado para este filtro' : 'No hay datos aún'}</strong>
            ${allFindings.length ? 'Prueba con otro filtro o haz clic en Escanear.' : 'Haz clic en <em>Escanear</em> para analizar la página inspeccionada.'}
          </td>
        </tr>
      `;
      return;
    }

    rows.forEach((row) => {
      const tr = document.createElement('tr');

      const tdPlatform = document.createElement('td');
      tdPlatform.className = 'cell-platform';
      tdPlatform.textContent = row.platform;

      const tdId = document.createElement('td');
      tdId.className = 'cell-id';
      if (row.id && row.id !== 'No detectado') {
        const tag = document.createElement('span');
        tag.className = 'id-tag';
        tag.textContent = row.id;
        tdId.appendChild(tag);
      } else {
        tdId.innerHTML = '<span class="badge badge-not-found">No detectado</span>';
      }

      const tdDetails = document.createElement('td');
      tdDetails.className = 'cell-cookies';
      if (row.details && row.details.length) {
        row.details.forEach((detail) => {
          const rowDiv = document.createElement('div');
          rowDiv.className = 'cookie-row';
          rowDiv.innerHTML = `
            <span class="cookie-name">${escapeHtml(detail.name)}:</span>
            <span class="cookie-value" title="${escapeHtml(detail.value)}">${escapeHtml(truncate(detail.value, 70))}</span>
          `;
          tdDetails.appendChild(rowDiv);
        });
      } else {
        tdDetails.innerHTML = '<span class="badge badge-not-found">No hay parámetros asociados</span>';
      }

      const tdUrl = document.createElement('td');
      tdUrl.className = 'cell-url';
      tdUrl.textContent = row.url;
      tdUrl.title = row.url;

      const tdTime = document.createElement('td');
      tdTime.className = 'cell-time';
      tdTime.textContent = row.timestamp;

      tr.appendChild(tdPlatform);
      tr.appendChild(tdId);
      tr.appendChild(tdDetails);
      tr.appendChild(tdUrl);
      tr.appendChild(tdTime);
      elBody.appendChild(tr);
    });
  }

  function renderError(message) {
    elBody.innerHTML = `
      <tr>
        <td colspan="5" class="empty-state">
          <strong>Error de escaneo</strong>
          ${escapeHtml(message)}
        </td>
      </tr>
    `;
  }

  function setLoading(active) {
    if (active) {
      elBody.innerHTML = `
        <tr class="loading-row">
          <td colspan="5">
            <span class="spinner"></span>
            Analizando DOM, scripts y cookies…
          </td>
        </tr>
      `;
    }
  }

  function setStatus(text, type) {
    elStatus.textContent = text;
    elStatus.style.color =
      type === 'error' ? 'var(--color-danger)' :
      type === 'ok' ? 'var(--color-success)' :
      'var(--color-text)';
  }

  // ========================================================
  // EXPORTACIÓN
  // ========================================================

  function exportToCSV() {
    const dataToExport = filteredFindings.length ? filteredFindings : allFindings;
    if (!dataToExport.length) {
      alert('No hay datos para exportar. Realiza un escaneo primero.');
      return;
    }

    const headers = ['Plataforma', 'ID de Propiedad / Pixel', 'Cookies y Parámetros Únicos del ID', 'URL Escaneada', 'Fecha y Hora del Escaneo'];
    const lines = [headers.join(',')];

    dataToExport.forEach((row) => {
      const details = row.details.map((d) => `${d.name}=${d.value}`).join(' | ') || 'Ninguno';
      lines.push([
        csvCell(row.platform),
        csvCell(row.id),
        csvCell(details),
        csvCell(row.url),
        csvCell(row.timestamp)
      ].join(','));
    });

    downloadFile(lines.join('\n'), 'buho-pixel-check-report.csv', 'text/csv;charset=utf-8;');
  }

  function exportToJSON() {
    const dataToExport = filteredFindings.length ? filteredFindings : allFindings;
    if (!dataToExport.length) {
      alert('No hay datos para exportar. Realiza un escaneo primero.');
      return;
    }

    const payload = {
      meta: {
        extension: 'Búho Pixel Check v1.3.2',
        url: currentUrl,
        domain: currentDomain,
        exportedAt: new Date().toISOString(),
        activeFilter: currentFilter
      },
      findings: dataToExport.map((row) => ({
        platform: row.platform,
        id: row.id,
        details: row.details,
        url: row.url,
        timestamp: row.timestamp,
        detected: row.detected
      }))
    };

    downloadFile(JSON.stringify(payload, null, 2), 'buho-pixel-check-report.json', 'application/json');
  }

  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ========================================================
  // UTILIDADES
  // ========================================================

  function unique(arr) {
    return Array.from(new Set((arr || []).filter(Boolean)));
  }

  function extractHostname(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return url || '';
    }
  }

  function csvCell(value) {
    const text = String(value ?? '').replace(/"/g, '""');
    return `"${text}"`;
  }

  function truncate(text, maxLength) {
    const str = String(text);
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength) + '…';
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
})();
