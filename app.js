import { nearestStops, planJourneys } from './journey.js';

const LOCATOR_HASH = '4d5af2578d1f42adabc3165aa4456953';
const API_ROOT = `https://nimbus.wialon.com/api/locator/${LOCATOR_HASH}`;
const REFRESH_MS = 30_000;
const $ = (selector) => document.querySelector(selector);

const state = {
  stops: [],
  routes: [],
  patterns: [],
  mode: 'home',
  activePanel: 'map',
  query: '',
  selectedStop: null,
  selectedRoute: null,
  nearest: null,
  arrivals: [],
  arrivalsLoading: false,
  arrivalsError: '',
  lastUpdate: null,
  favorites: new Set(readStored('eskisehir-favorite-stops', [])),
  favoriteRoutes: new Set(readStored('eskisehir-favorite-routes', [])),
  originPoint: null,
  originSource: '',
  destinationPoint: null,
  mapPickMode: 'browse',
  journeyLoading: false,
  journeyError: '',
  journeyOptions: [],
  map: null,
  mapFavoritesOnly: false,
  toastTimer: null,
  refreshTimer: null,
  requestId: 0
};

function readStored(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function cleanText(value) {
  const text = String(value ?? '').normalize('NFC').trim();
  if (!text || text.includes('\uFFFD') || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return '';
  return text;
}

function setStatus(text, kind = '') {
  $('#status-text').textContent = text;
  const status = $('#service-status');
  status.classList.toggle('is-ready', kind === 'ready');
  status.classList.toggle('is-error', kind === 'error');
}

async function fetchJson(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${API_ROOT}${path}`, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Sunucu yanıtı: ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function stopCoordinates(stop) {
  const point = Array.isArray(stop?.p) ? stop.p[0] : null;
  const latitude = Number(point?.y);
  const longitude = Number(point?.x);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < 35 || latitude > 43 || longitude < 25 || longitude > 46) return null;
  return { latitude, longitude };
}

function haversineKm(a, b) {
  const rad = (n) => n * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function stopLabel(stop) {
  return cleanText(stop?.n) || 'Durak';
}

function stopDescription(stop) {
  const description = cleanText(stop?.d);
  return description && description !== stopLabel(stop) ? description : '';
}

function routeLabel(route) {
  return cleanText(route?.n) || 'Hat';
}

function routeDescription(route) {
  const description = cleanText(route?.d);
  return description && description !== routeLabel(route) ? description : '';
}

function stopById(id) {
  return state.stops.find((stop) => String(stop.id) === String(id));
}

function routeById(id) {
  return state.routes.find((route) => String(route.id) === String(id));
}

function routeOptionLabel(route) {
  const description = routeDescription(route);
  if (description) return `${routeLabel(route)} — ${description}`;
  const stops = routeStops(route);
  const first = stops[0] ? stopLabel(stops[0]) : '';
  const last = stops.length > 1 ? stopLabel(stops[stops.length - 1]) : '';
  const direction = first && last ? `${first} → ${last}` : `${stops.length} durak`;
  return `${routeLabel(route)} · ${direction}`;
}

function populateRouteSelect() {
  const select = $('#route-select');
  const options = [...state.routes].sort((a, b) => routeOptionLabel(a).localeCompare(routeOptionLabel(b), 'tr-TR'));
  select.innerHTML = '<option value="">Otobüs hattı seçin</option>' + options.map((route) => `<option value="${escapeHtml(route.id)}">${escapeHtml(routeOptionLabel(route))}</option>`).join('');
}

function syncMap() {
  const route = state.mode === 'route' ? state.selectedRoute : null;
  const stop = state.mode === 'stop' ? state.selectedStop : null;
  if (state.map) {
    state.map.update({
      route,
      selectedStop: stop?.id ?? null,
      favorites: state.favorites,
      favoritesOnly: state.mapFavoritesOnly,
      origin: state.originPoint,
      destination: state.destinationPoint,
      pickMode: state.mapPickMode
    });
  }
  const select = $('#route-select');
  if (select) select.value = route ? String(route.id) : '';
  const clearRoute = $('#clear-route');
  if (clearRoute) clearRoute.hidden = !route;
  const favoriteToggle = $('#map-favorites-toggle');
  if (favoriteToggle) {
    favoriteToggle.setAttribute('aria-pressed', String(state.mapFavoritesOnly));
    favoriteToggle.textContent = state.mapFavoritesOnly ? 'Tüm duraklar' : 'Favori duraklar';
  }
  const status = $('#map-selection-status');
  if (status) {
    status.textContent = state.mapPickMode === 'origin'
      ? 'Başlangıç noktasını seçmek için haritaya dokunun.'
      : state.mapPickMode === 'destination' ? 'Varış noktasını seçmek için haritaya dokunun.'
      : route ? `${routeLabel(route)} hattının güzergâhı ve durakları`
      : stop ? `Durak ${stopLabel(stop)} seçildi`
      : state.originPoint && state.destinationPoint ? 'Başlangıç ve varış noktaları seçildi.'
      : state.destinationPoint ? 'Varış yeri seçildi. Yol tarifi için hazır.'
      : 'Durakları seçin ya da yol tarifi bölümünden haritadan yer belirleyin.';
  }
  const originPicker = $('#pick-origin');
  if (originPicker) originPicker.setAttribute('aria-pressed', String(state.mapPickMode === 'origin'));
  const destinationPicker = $('#pick-destination');
  if (destinationPicker) destinationPicker.setAttribute('aria-pressed', String(state.mapPickMode === 'destination'));
}

function syncPresentation() {
  document.body.dataset.panel = state.activePanel;
  for (const button of document.querySelectorAll('.app-tab')) {
    const tab = button.dataset.tab;
    const active = tab === 'map'
      ? state.activePanel === 'map' || state.activePanel === 'stop' || state.activePanel === 'route'
      : tab === state.activePanel;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (state.map) {
    requestAnimationFrame(() => state.map?.invalidate());
  }
}

function setSelectionUrl(type, id) {
  const url = new URL(location.href);
  url.searchParams.delete('stop');
  url.searchParams.delete('route');
  if (type && id != null) url.searchParams.set(type, String(id));
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function announce(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

function formatDistance(km) {
  if (km < 0.025) return '0 m';
  if (km < 1) return `${Math.max(50, Math.round(km * 1000 / 50) * 50)} m`;
  return `${km.toFixed(1).replace('.', ',')} km`;
}

function iconStar(filled = false) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" ${filled ? 'fill="currentColor"' : ''}></path></svg>`;
}

function renderTop() {
  if (!navigator.onLine) {
    setStatus('İnternet bağlantısı yok', 'error');
  } else if (state.stops.length) {
    setStatus('Durak verisi hazır', 'ready');
  }
}

function render() {
  renderTop();
  renderHomeResults();
  renderPanel();
  renderJourneyControls();
  syncMap();
  syncPresentation();
}

function stopResultButton(stop, distance = null) {
  const detail = stopDescription(stop);
  const subtitle = distance == null ? 'Otobüs gelişlerini görün' : `${formatDistance(distance)} uzaklıkta`;
  return `<button class="result-button" type="button" data-action="select-stop" data-id="${escapeHtml(stop.id)}" aria-label="${escapeHtml(stopLabel(stop))} numaralı durağı seç${distance == null ? '' : `, ${escapeHtml(formatDistance(distance))} uzaklıkta`}">
    <span class="stop-number">${escapeHtml(stopLabel(stop))}</span>
    <span class="result-copy"><strong>${escapeHtml(detail || `Durak ${stopLabel(stop)}`)}</strong><span>${escapeHtml(subtitle)}</span></span>
    <span class="result-arrow" aria-hidden="true">›</span>
  </button>`;
}

function routeResultButton(route) {
  const detail = routeDescription(route);
  return `<button class="result-button" type="button" data-action="select-route" data-id="${escapeHtml(route.id)}" aria-label="${escapeHtml(routeLabel(route))} hattını aç${detail ? `, ${escapeHtml(detail)}` : ''}">
    <span class="route-number">${escapeHtml(routeLabel(route))}</span>
    <span class="result-copy"><strong>${escapeHtml(detail || `${routeLabel(route)} hattı`)}</strong><span>${Number(route.s?.length || 0)} durak</span></span>
    <span class="result-arrow" aria-hidden="true">›</span>
  </button>`;
}

function matches(query) {
  const normalized = query.toLocaleLowerCase('tr-TR').trim();
  if (!normalized) return { stops: [], routes: [] };
  const stops = state.stops.filter((stop) => `${stopLabel(stop)} ${stopDescription(stop)}`.toLocaleLowerCase('tr-TR').includes(normalized));
  const routes = state.routes.filter((route) => `${routeLabel(route)} ${routeDescription(route)}`.toLocaleLowerCase('tr-TR').includes(normalized));
  return { stops, routes };
}

function renderFavorites() {
  const stops = [...state.favorites].map(stopById).filter(Boolean).slice(0, 5);
  const routes = [...state.favoriteRoutes].map(routeById).filter(Boolean).slice(0, 5);
  if (!stops.length && !routes.length) {
    return `<div class="hint-box"><strong>Kolay erişim için durak veya hat ekleyin</strong>Bir durağı ya da otobüs hattını açıp “Sık kullandıklarım” düğmesine basın.</div>`;
  }
  const stopSection = stops.length ? `<div class="section-heading"><h2>Sık kullandığım duraklar</h2></div><div class="favorite-list">${stops.map((stop) => stopResultButton(stop)).join('')}</div>` : '';
  const routeSection = routes.length ? `<div class="section-heading favorite-route-heading"><h2>Sık kullandığım otobüsler</h2></div><div class="favorite-list">${routes.map(routeResultButton).join('')}</div>` : '';
  return `${stopSection}${routeSection}`;
}

function renderHomeResults() {
  const section = $('#results-section');
  if (state.mode !== 'home') {
    section.innerHTML = '';
    return;
  }

  if (state.query.trim()) {
    const found = matches(state.query);
    if (!found.stops.length && !found.routes.length) {
      section.innerHTML = `<div class="empty-box"><strong>Sonuç bulamadık</strong>Durak numarasını ya da hat adını kontrol edip yeniden deneyin.</div>`;
      return;
    }
    const groups = [];
    if (found.stops.length) groups.push(`<div class="section-heading"><h2>Duraklar</h2><p>${found.stops.length} sonuç</p></div><div class="result-list">${found.stops.slice(0, 7).map((stop) => stopResultButton(stop)).join('')}</div>${found.stops.length > 7 ? '<p class="field-help">İlk 7 durak gösteriliyor. Aramanızı daraltın.</p>' : ''}`);
    if (found.routes.length) groups.push(`<div class="section-heading ${found.stops.length ? 'route-results-heading' : ''}"><h2>Hatlar</h2><p>${found.routes.length} sonuç</p></div><div class="result-list">${found.routes.slice(0, 7).map(routeResultButton).join('')}</div>${found.routes.length > 7 ? '<p class="field-help">İlk 7 hat gösteriliyor. Aramanızı daraltın.</p>' : ''}`);
    section.innerHTML = groups.join('');
    return;
  }

  if (state.nearest) {
    const list = state.nearest.slice(0, 7).map(({ stop, distance }) => stopResultButton(stop, distance)).join('');
    section.innerHTML = `<div class="section-heading"><h2>Yakınınızdaki duraklar</h2><p>En yakından başlayarak</p></div><div class="result-list">${list}</div>`;
    return;
  }

  section.innerHTML = `<div class="section-heading"><h2>Hızlı erişim</h2></div>${renderFavorites()}`;
}

function routesAtStop(stopId) {
  return state.routes.filter((route) => Array.isArray(route.s) && route.s.some((id) => String(id) === String(stopId)));
}

function routeStops(route) {
  const ordered = [];
  for (const id of route?.s || []) {
    const stop = stopById(id);
    if (stop && !ordered.some((item) => String(item.id) === String(stop.id))) ordered.push(stop);
  }
  return ordered;
}

function arrivalValue(item) {
  const seconds = Number(item?.eta?.tt);
  if (item?.in || !Number.isFinite(seconds) || seconds <= 0) return { main: '<1', unit: 'dakikadan az', seconds: 0, soon: true };
  if (seconds < 3600) return { main: String(Math.ceil(seconds / 60)), unit: 'dakika içinde', seconds, soon: seconds < 300 };
  const timestamp = Number(item.pt);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return {
      main: new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp * 1000)),
      unit: 'tahmini saat', seconds, soon: false
    };
  }
  return { main: '—', unit: 'saat bilgisi yok', seconds: Number.MAX_SAFE_INTEGER, soon: false };
}

function allArrivals() {
  const arrivals = [];
  for (const group of state.arrivals || []) {
    const route = routeById(group.id);
    for (const item of group.tt || []) {
      const value = arrivalValue(item);
      if (value.main === '—') continue;
      arrivals.push({ route, group, item, value });
    }
  }
  return arrivals.sort((a, b) => a.value.seconds - b.value.seconds).slice(0, 8);
}

function renderArrivalCard(entry) {
  const route = entry.route;
  const item = entry.item;
  const live = item.uid !== null && item.uid !== undefined;
  const value = entry.value;
  const line = route ? routeLabel(route) : `Hat ${entry.group.id}`;
  const direction = routeDescription(route);
  const updated = state.lastUpdate ? `Son kontrol ${new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(state.lastUpdate)}` : '';
  return `<article class="arrival-card">
    <div class="arrival-route"><span class="route-number">${escapeHtml(line)}</span><span class="arrival-route-copy"><strong>${escapeHtml(direction || `${line} hattı`)}</strong><span>${live ? 'Araç bilgisi alındı' : 'Tarife bilgisi'}</span></span></div>
    <div class="eta ${value.soon ? 'is-soon' : ''}" aria-label="${escapeHtml(`${value.main} ${value.unit}`)}"><strong>${escapeHtml(value.main)}</strong><span>${escapeHtml(value.unit)}</span></div>
    <div class="arrival-meta"><span class="${live ? 'live-tag' : 'schedule-tag'}">${live ? 'Canlı araç tahmini' : 'Tarifeye göre'}</span><span>${escapeHtml(updated)}</span></div>
  </article>`;
}

function renderStopPanel() {
  const stop = state.selectedStop;
  if (!stop) return '';
  const description = stopDescription(stop);
  const favorite = state.favorites.has(String(stop.id));
  const routes = routesAtStop(stop.id);
  const arrivals = allArrivals();
  let arrivalContent = '';
  if (state.arrivalsLoading && !arrivals.length) {
    arrivalContent = `<div class="hint-box" role="status">Geliş bilgileri yükleniyor…</div>`;
  } else if (arrivals.length) {
    arrivalContent = `<div class="arrival-list">${arrivals.map(renderArrivalCard).join('')}</div>`;
    if (state.arrivalsError) arrivalContent += `<p class="error-box" style="margin-top:10px">Yenileme yapılamadı. Önceki bilgi gösteriliyor; bağlantıyı kontrol edin.</p>`;
  } else if (state.arrivalsError) {
    arrivalContent = `<div class="error-box"><strong>Geliş bilgisi alınamadı</strong><br>İnternet bağlantısını kontrol edip yeniden deneyin.<br><button class="small-action" type="button" data-action="refresh">Tekrar dene</button></div>`;
  } else {
    arrivalContent = `<div class="empty-box"><strong>Şu an geliş tahmini yok</strong>Bu durak için canlı araç ya da tarife bilgisi gelmedi. Biraz sonra yeniden kontrol edebilirsiniz.</div>`;
  }

  const routeContent = routes.length
    ? `<h3 class="panel-subheading">Bu duraktan geçen hatlar</h3><div class="result-list">${routes.map(routeResultButton).join('')}</div>`
    : '';

  return `<div class="detail-heading"><button class="back-button" type="button" data-action="home" aria-label="Aramaya dön">‹</button><div><h2>Durak ${escapeHtml(stopLabel(stop))}</h2><p>${escapeHtml(description || 'Eskişehir otobüs durağı')}</p></div></div>
    <div class="stop-summary"><span class="stop-number">${escapeHtml(stopLabel(stop))}</span><span class="stop-summary-copy"><strong>Geliş bilgileri</strong><span>${state.arrivalsLoading ? 'Güncel bilgi kontrol ediliyor' : 'Son kontrol: ' + (state.lastUpdate ? new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(state.lastUpdate) : 'henüz yapılmadı')}</span></span></div>
    <div class="detail-actions">
      <button class="action-button ${favorite ? 'is-favorite' : ''}" type="button" data-action="favorite" aria-pressed="${favorite}">${iconStar(favorite)}<span>${favorite ? 'Sık kullandıklarımdan çıkar' : 'Sık kullandıklarıma ekle'}</span></button>
      <button class="action-button" type="button" data-action="refresh"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"></path><path d="M5.5 9a7 7 0 0 1 12-2L20 12M4 12l2.5 5a7 7 0 0 0 12-2"></path></svg><span>Yenile</span></button>
    </div>
    ${arrivalContent}${routeContent}`;
}

function renderRoutePanel() {
  const route = state.selectedRoute;
  if (!route) return '';
  const stops = routeStops(route);
  const direction = routeDescription(route);
  const favorite = state.favoriteRoutes.has(String(route.id));
  const stopButtons = stops.map((stop) => `<button class="stop-button" type="button" data-action="select-stop" data-id="${escapeHtml(stop.id)}"><span class="stop-number">${escapeHtml(stopLabel(stop))}</span><span class="result-copy"><strong>${escapeHtml(stopDescription(stop) || `Durak ${stopLabel(stop)}`)}</strong><span>Bu duraktaki otobüsleri görün</span></span><span class="result-arrow" aria-hidden="true">›</span></button>`).join('');
  return `<div class="detail-heading"><button class="back-button" type="button" data-action="home" aria-label="Aramaya dön">‹</button><div><h2>${escapeHtml(routeLabel(route))} otobüsü</h2><p>${escapeHtml(direction || `${stops.length} durak · güzergâh haritada gösteriliyor`)}</p></div></div>
    <div class="detail-actions"><button class="action-button ${favorite ? 'is-favorite' : ''}" type="button" data-action="favorite-route" aria-pressed="${favorite}">${iconStar(favorite)}<span>${favorite ? 'Sık kullandıklarımdan çıkar' : 'Sık kullandıklarıma ekle'}</span></button></div>
    <div class="hint-box"><strong>Hangi duraktan bineceksiniz?</strong>Haritadaki bir durağa ya da aşağıdaki durak adına dokunun.</div>
    <h3 class="panel-subheading">Hat üzerindeki duraklar</h3><div class="route-stop-list">${stopButtons || '<div class="empty-box">Bu hat için durak listesi bulunamadı.</div>'}</div>`;
}

function renderPanel() {
  const panel = $('#panel-section');
  if (state.mode === 'stop') panel.innerHTML = renderStopPanel();
  else if (state.mode === 'route') panel.innerHTML = renderRoutePanel();
  else panel.innerHTML = '';
}

function durationText(seconds) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes} dk`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} sa${remainder ? ` ${remainder} dk` : ''}`;
}

function formatJourneyArrival(timestamp) {
  const arrival = new Date(timestamp);
  const time = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(arrival);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const sameDate = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDate(arrival, today)) return `bugün ${time}`;
  if (sameDate(arrival, tomorrow)) return `yarın ${time}`;
  return `${new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long' }).format(arrival)} ${time}`;
}

function renderJourneyCard(option, index) {
  const arrival = formatJourneyArrival(option.arrivalMs);
  const title = index === 0 ? 'En kısa tahmini süre' : `Alternatif ${index + 1}`;
  const legs = option.legs.map((leg, legIndex) => {
    const wait = leg.waitSeconds > 30 ? `Otobüs bekleme yaklaşık ${durationText(leg.waitSeconds)} (${leg.waitSource.toLocaleLowerCase('tr-TR')})` : `Otobüs beklemesi çok kısa (${leg.waitSource.toLocaleLowerCase('tr-TR')})`;
    const ride = `Yolculuk yaklaşık ${durationText(leg.rideSeconds)}`;
    const transfer = legIndex < option.legs.length - 1 ? '<p class="journey-leg-info">Bu durakta aktarma yapın.</p>' : '';
    return `<div class="journey-leg">
      <div class="journey-leg-top"><span class="route-number">${escapeHtml(routeLabel(leg.route))}</span><strong>${escapeHtml(routeDescription(leg.route) || `${routeLabel(leg.route)} otobüsü`)}</strong></div>
      <p class="journey-leg-stops">Bin: ${escapeHtml(stopDescription(leg.fromStop) || `Durak ${stopLabel(leg.fromStop)}`)} · İn: ${escapeHtml(stopDescription(leg.toStop) || `Durak ${stopLabel(leg.toStop)}`)}</p>
      <p class="journey-leg-info">${escapeHtml(wait)} · ${escapeHtml(ride)}</p>${transfer}
      <button class="journey-map-button" type="button" data-action="journey-route" data-id="${escapeHtml(leg.route.id)}">Bu hattı haritada göster</button>
    </div>`;
  }).join('');
  const walk = `Başlangıç durağına ${formatDistance(option.startWalkKm)}, varış durağından ${formatDistance(option.endWalkKm)} yürüyüş.`;
  return `<article class="journey-card">
    <div class="journey-card-header"><strong>${escapeHtml(title)}${option.transfers ? ` · ${option.transfers} aktarma` : ' · direkt hat'}</strong><span class="journey-duration">~${escapeHtml(durationText(option.totalSeconds))}</span></div>
    <p class="journey-arrival-time">Tahmini varış: ${escapeHtml(arrival)}</p>
    ${legs}
    <p class="journey-total-note">${escapeHtml(walk)} Süre; tarifedeki sefer, bekleme ve yürüme üzerinden yaklaşık hesaplanır. Trafik ve sefer değişiklikleri süreyi etkileyebilir.</p>
  </article>`;
}

function renderJourneyControls() {
  const origin = $('#journey-origin');
  const destination = $('#journey-destination');
  const button = $('#plan-journey');
  const picker = $('#pick-origin');
  const destinationPicker = $('#pick-destination');
  const help = $('#journey-help');
  const results = $('#journey-results');
  if (!origin || !destination || !button || !picker || !destinationPicker || !help || !results) return;

  origin.textContent = state.originPoint ? state.originSource : 'Konumunuzu kullanın ya da haritadan başlangıç seçin.';
  destination.textContent = state.destinationPoint ? 'Haritada seçilen varış yeri' : 'Haritada gitmek istediğiniz yere dokunun.';
  button.disabled = !state.destinationPoint || state.journeyLoading;
  button.textContent = state.journeyLoading ? 'Seferler aranıyor…' : 'Buraya nasıl giderim?';
  picker.setAttribute('aria-pressed', String(state.mapPickMode === 'origin'));
  picker.textContent = state.mapPickMode === 'origin' ? 'Haritada başlangıç seçiliyor…' : 'Başlangıç yerini haritadan seç';
  destinationPicker.setAttribute('aria-pressed', String(state.mapPickMode === 'destination'));
  destinationPicker.textContent = state.mapPickMode === 'destination' ? 'Haritada varış seçiliyor…' : 'Varış yerini haritadan seç';

  if (state.journeyLoading) help.textContent = 'Yakın duraklar, uygun hatlar ve sefer saatleri kontrol ediliyor.';
  else if (state.journeyError) help.textContent = state.journeyError;
  else if (state.mapPickMode === 'origin') help.textContent = 'Başlangıç noktası için haritadaki bir yere ya da durağa dokunun.';
  else if (state.mapPickMode === 'destination') help.textContent = 'Varış noktası için haritadaki bir yere ya da durağa dokunun.';
  else if (state.destinationPoint && !state.originPoint) help.textContent = 'Varış yeri seçildi. Başlangıç için konumunuzu kullanın ya da haritada bir yer seçin.';
  else if (state.destinationPoint && state.originPoint) help.textContent = 'Başlangıç ve varış hazır. Sefer seçeneklerini görmek için düğmeye basın.';
  else help.textContent = 'Konumunuzu kullanın veya “Başlangıç yerini haritadan seç” düğmesine basın; ardından haritadan varış yerini seçin.';

  if (state.journeyLoading) results.innerHTML = '<div class="hint-box" role="status">Otobüs seçenekleri hesaplanıyor…</div>';
  else if (state.journeyError) results.innerHTML = `<div class="empty-box"><strong>Yol tarifi bulunamadı</strong>${escapeHtml(state.journeyError)}</div>`;
  else if (state.journeyOptions.length) results.innerHTML = `<div class="journey-results">${state.journeyOptions.map(renderJourneyCard).join('')}</div>`;
  else results.innerHTML = '';
}

function handleMapPoint(point) {
  state.journeyOptions = [];
  state.journeyError = '';
  if (state.mapPickMode === 'origin') {
    state.originPoint = point;
    state.originSource = 'Haritada seçilen başlangıç yeri';
    state.activePanel = 'journey';
    state.mapPickMode = 'browse';
    announce('Başlangıç noktası seçildi.');
  } else if (state.mapPickMode === 'destination') {
    state.destinationPoint = point;
    state.activePanel = 'journey';
    state.mapPickMode = 'browse';
    announce('Varış noktası seçildi. “Buraya nasıl giderim?” düğmesine basın.');
  }
  syncMap();
  renderJourneyControls();
  syncPresentation();
}

function pickOriginOnMap() {
  state.activePanel = 'map';
  state.mapPickMode = 'origin';
  state.journeyError = '';
  state.journeyOptions = [];
  syncMap();
  renderJourneyControls();
  syncPresentation();
  window.scrollTo({ top: $('#map-section').offsetTop - 12, behavior: 'smooth' });
  announce('Haritada başlangıç noktanıza dokunun.');
}

function pickDestinationOnMap() {
  state.activePanel = 'map';
  state.mapPickMode = 'destination';
  state.journeyError = '';
  state.journeyOptions = [];
  syncMap();
  renderJourneyControls();
  syncPresentation();
  window.scrollTo({ top: $('#map-section').offsetTop - 12, behavior: 'smooth' });
  announce('Haritada varış noktanıza dokunun.');
}

async function calculateJourney() {
  if (!state.originPoint || !state.destinationPoint) return;
  state.journeyLoading = true;
  state.journeyError = '';
  state.journeyOptions = [];
  renderJourneyControls();
  try {
    const starts = nearestStops(state.originPoint, state.stops, 3);
    const arrivalsByStop = new Map();
    await Promise.all(starts.map(async ({ stop }) => {
      try {
        const response = await fetchJson(`/online/stop/${encodeURIComponent(stop.id)}`);
        arrivalsByStop.set(String(stop.id), { items: response.r || [], fetchedAt: Date.now() });
      } catch {
        arrivalsByStop.set(String(stop.id), { items: [], fetchedAt: Date.now() });
      }
    }));
    const result = planJourneys({
      origin: state.originPoint,
      destination: state.destinationPoint,
      stops: state.stops,
      routes: state.routes,
      patterns: state.patterns,
      arrivalsByStop
    });
    state.journeyOptions = result.options;
    if (!result.options.length) state.journeyError = 'Yakınınızda uygun sefer bulamadık. Başlangıç veya varış noktasını bir durağa yaklaştırıp yeniden deneyin.';
  } catch {
    state.journeyError = 'Sefer bilgileri alınamadı. İnternet bağlantınızı kontrol edip yeniden deneyin.';
  } finally {
    state.journeyLoading = false;
    renderJourneyControls();
  }
}

function planJourney() {
  if (!state.destinationPoint || state.journeyLoading) return;
  if (state.originPoint) {
    calculateJourney();
    return;
  }
  if (!navigator.geolocation) {
    pickOriginOnMap();
    return;
  }
  state.journeyLoading = true;
  state.journeyError = '';
  renderJourneyControls();
  navigator.geolocation.getCurrentPosition((position) => {
    state.originPoint = { latitude: position.coords.latitude, longitude: position.coords.longitude };
    state.originSource = 'Mevcut konumunuz';
    state.mapPickMode = 'browse';
    syncMap();
    calculateJourney();
  }, () => {
    state.journeyLoading = false;
    pickOriginOnMap();
    state.journeyError = '';
    renderJourneyControls();
  }, { enableHighAccuracy: false, timeout: 12_000, maximumAge: 60_000 });
}

async function loadArrivals(stopId) {
  const requestId = ++state.requestId;
  state.arrivalsLoading = true;
  state.arrivalsError = '';
  renderPanel();
  try {
    const payload = await fetchJson(`/online/stop/${encodeURIComponent(stopId)}`);
    if (requestId !== state.requestId || String(state.selectedStop?.id) !== String(stopId)) return;
    state.arrivals = Array.isArray(payload.r) ? payload.r : [];
    state.lastUpdate = new Date();
    state.arrivalsError = payload.error ? 'Tahmin verisi şu anda sunulamıyor.' : '';
  } catch (error) {
    if (requestId !== state.requestId) return;
    state.arrivalsError = error.name === 'AbortError' ? 'Bağlantı zaman aşımına uğradı.' : 'Geliş verisi alınamadı.';
  } finally {
    if (requestId === state.requestId) {
      state.arrivalsLoading = false;
      renderPanel();
    }
  }
}

function beginRefreshing(stopId) {
  clearInterval(state.refreshTimer);
  loadArrivals(stopId);
  state.refreshTimer = setInterval(() => {
    if (state.mode === 'stop' && String(state.selectedStop?.id) === String(stopId) && navigator.onLine) loadArrivals(stopId);
  }, REFRESH_MS);
}

function selectStop(id) {
  const stop = stopById(id);
  if (!stop) return;
  state.mode = 'stop';
  state.activePanel = 'stop';
  state.query = '';
  state.selectedStop = stop;
  state.selectedRoute = null;
  state.arrivals = [];
  state.arrivalsError = '';
  state.arrivalsLoading = true;
  setSelectionUrl('stop', stop.id);
  $('#search-input').value = '';
  $('#clear-search').hidden = true;
  render();
  beginRefreshing(stop.id);
  window.scrollTo({ top: $('#panel-section').offsetTop - 16, behavior: 'smooth' });
}

function selectRoute(id) {
  const route = routeById(id);
  if (!route) return;
  clearInterval(state.refreshTimer);
  state.requestId++;
  state.mode = 'route';
  state.activePanel = 'route';
  state.query = '';
  state.selectedRoute = route;
  state.selectedStop = null;
  state.arrivals = [];
  setSelectionUrl('route', route.id);
  $('#search-input').value = '';
  $('#clear-search').hidden = true;
  render();
  window.scrollTo({ top: $('#map-section').offsetTop - 16, behavior: 'smooth' });
}

function goHome() {
  clearInterval(state.refreshTimer);
  state.requestId++;
  state.mode = 'home';
  state.activePanel = 'map';
  state.selectedStop = null;
  state.selectedRoute = null;
  state.arrivals = [];
  state.arrivalsLoading = false;
  setSelectionUrl(null, null);
  render();
  if (window.matchMedia('(min-width: 701px)').matches) $('#search-input').focus({ preventScroll: true });
}

function toggleFavorite() {
  const stop = state.selectedStop;
  if (!stop) return;
  const id = String(stop.id);
  if (state.favorites.has(id)) {
    state.favorites.delete(id);
    announce('Durak sık kullandıklarınızdan çıkarıldı.');
  } else {
    state.favorites.add(id);
    announce('Durak sık kullandıklarınıza eklendi.');
  }
  localStorage.setItem('eskisehir-favorite-stops', JSON.stringify([...state.favorites]));
  renderPanel();
  syncMap();
}

function toggleFavoriteRoute() {
  const route = state.selectedRoute;
  if (!route) return;
  const id = String(route.id);
  if (state.favoriteRoutes.has(id)) {
    state.favoriteRoutes.delete(id);
    announce('Otobüs sık kullandıklarınızdan çıkarıldı.');
  } else {
    state.favoriteRoutes.add(id);
    announce('Otobüs sık kullandıklarınıza eklendi.');
  }
  localStorage.setItem('eskisehir-favorite-routes', JSON.stringify([...state.favoriteRoutes]));
  renderHomeResults();
  renderPanel();
}

function findNearby() {
  if (!state.stops.length) {
    announce('Durak bilgileri henüz yüklenmedi.');
    return;
  }
  if (!navigator.geolocation) {
    announce('Bu cihaz konum bulmayı desteklemiyor.');
    return;
  }
  const button = $('#location-button');
  button.disabled = true;
  button.querySelector('span').textContent = 'Konumunuz alınıyor…';
  navigator.geolocation.getCurrentPosition((position) => {
    const origin = { latitude: position.coords.latitude, longitude: position.coords.longitude };
    state.originPoint = origin;
    state.originSource = 'Mevcut konumunuz';
    state.mapPickMode = 'browse';
    state.journeyOptions = [];
    state.journeyError = '';
    state.nearest = state.stops.map((stop) => {
      const coordinates = stopCoordinates(stop);
      return coordinates ? { stop, distance: haversineKm(origin, coordinates) } : null;
    }).filter(Boolean).filter((entry) => entry.distance <= 20).sort((a, b) => a.distance - b.distance).slice(0, 20);
    button.disabled = false;
    button.querySelector('span').textContent = 'Yakınımdaki durakları bul';
    state.query = '';
    $('#search-input').value = '';
    $('#clear-search').hidden = true;
    renderHomeResults();
    syncMap();
    renderJourneyControls();
    if (!state.nearest.length) announce('Yakın çevrenizde durak bulamadık. Haritada başlangıç yeri seçebilirsiniz.');
  }, (error) => {
    button.disabled = false;
    button.querySelector('span').textContent = 'Yakınımdaki durakları bul';
    const message = error.code === 1 ? 'Konum izni kapalı. Hat veya durak numarasıyla arayabilirsiniz.' : 'Konumunuz alınamadı. Hat veya durak numarasıyla arayabilirsiniz.';
    announce(message);
  }, { enableHighAccuracy: false, timeout: 12_000, maximumAge: 60_000 });
}

$('#search-input').addEventListener('input', (event) => {
  clearInterval(state.refreshTimer);
  state.requestId++;
  state.mode = 'home';
  state.activePanel = 'search';
  state.selectedStop = null;
  state.selectedRoute = null;
  state.query = event.target.value;
  state.nearest = null;
  state.activePanel = 'search';
  $('#clear-search').hidden = !state.query;
  renderHomeResults();
  syncMap();
  syncPresentation();
});

$('#clear-search').addEventListener('click', () => {
  $('#search-input').value = '';
  state.query = '';
  state.nearest = null;
  state.activePanel = 'search';
  $('#clear-search').hidden = true;
  renderHomeResults();
  syncPresentation();
  $('#search-input').focus();
});

$('#location-button').addEventListener('click', findNearby);

for (const button of document.querySelectorAll('.app-tab')) {
  button.addEventListener('click', () => {
    const tab = button.dataset.tab;
    if (tab === 'map') {
      goHome();
    } else {
      clearInterval(state.refreshTimer);
      state.requestId++;
      state.mode = 'home';
      state.selectedStop = null;
      state.selectedRoute = null;
      state.nearest = null;
      setSelectionUrl(null, null);
      if (tab === 'search') {
        state.activePanel = 'search';
      } else if (tab === 'favorites') {
        state.activePanel = 'favorites';
        state.query = '';
        $('#search-input').value = '';
        $('#clear-search').hidden = true;
      } else {
        state.activePanel = 'journey';
      }
    }
    render();
    if (tab === 'search') $('#search-input').focus({ preventScroll: true });
  });
}

$('#main-content').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'select-stop') selectStop(button.dataset.id);
  else if (action === 'select-route') selectRoute(button.dataset.id);
  else if (action === 'home') goHome();
  else if (action === 'favorite') toggleFavorite();
  else if (action === 'favorite-route') toggleFavoriteRoute();
  else if (action === 'journey-route') selectRoute(button.dataset.id);
  else if (action === 'refresh' && state.selectedStop) loadArrivals(state.selectedStop.id);
});

$('#pick-origin').addEventListener('click', pickOriginOnMap);
$('#pick-destination').addEventListener('click', pickDestinationOnMap);
$('#plan-journey').addEventListener('click', planJourney);

$('#map-favorites-toggle').addEventListener('click', () => {
  if (!state.mapFavoritesOnly && !state.favorites.size) {
    announce('Önce bir durağı sık kullandıklarınıza ekleyin.');
    return;
  }
  state.mapFavoritesOnly = !state.mapFavoritesOnly;
  syncMap();
});

$('#route-select').addEventListener('change', (event) => {
  if (event.target.value) selectRoute(event.target.value);
});

$('#clear-route').addEventListener('click', goHome);

$('#text-size-button').addEventListener('click', () => {
  const large = document.body.classList.toggle('large-text');
  localStorage.setItem('eskisehir-large-text', String(large));
  $('#text-size-button').setAttribute('aria-pressed', String(large));
  $('#text-size-button').textContent = large ? 'Yazıyı küçült' : 'Yazıyı büyüt';
});

window.addEventListener('online', renderTop);
window.addEventListener('offline', () => setStatus('İnternet bağlantısı yok', 'error'));

async function init() {
  const largeText = localStorage.getItem('eskisehir-large-text') === 'true';
  if (largeText) {
    document.body.classList.add('large-text');
    $('#text-size-button').setAttribute('aria-pressed', 'true');
    $('#text-size-button').textContent = 'Yazıyı küçült';
  }

  try {
    const data = await fetchJson('/data');
    state.stops = Array.isArray(data.stops) ? data.stops : [];
    state.routes = Array.isArray(data.routes) ? data.routes : [];
    state.patterns = Array.isArray(data.patterns) ? data.patterns : [];
    if (!state.stops.length) throw new Error('Durak listesi boş');
    populateRouteSelect();
    setStatus('Durak verisi hazır', 'ready');
    render();
    try {
      const { createTransitMap } = await import('./map.js');
      state.map = createTransitMap({ element: $('#transit-map'), stops: state.stops, onSelectStop: selectStop, onPickPoint: handleMapPoint });
      syncMap();
      const params = new URLSearchParams(location.search);
      const stopId = params.get('stop');
      const routeId = params.get('route');
      if (stopId && stopById(stopId)) selectStop(stopId);
      else if (routeId && routeById(routeId)) selectRoute(routeId);
    } catch {
      $('#transit-map').innerHTML = '<p class="map-unavailable">Harita şu anda yüklenemedi. Durak aramayı kullanabilirsiniz.</p>';
    }
  } catch {
    setStatus('Veri bağlantısı kurulamadı', 'error');
    $('#results-section').innerHTML = `<div class="error-box"><strong>Durak bilgilerini alamadık</strong><br>İnternet bağlantınızı kontrol edin ve sayfayı yenileyin.<br><button class="small-action" type="button" onclick="location.reload()">Yeniden dene</button></div>`;
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

render();
init();
