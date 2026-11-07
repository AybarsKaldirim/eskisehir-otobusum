const DEFAULT_CENTER = [39.776, 30.52];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function coordinates(stop) {
  const point = Array.isArray(stop?.p) ? stop.p[0] : null;
  const lat = Number(point?.y);
  const lng = Number(point?.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 35 || lat > 43 || lng < 25 || lng > 46) return null;
  return [lat, lng];
}

function decodePolyline(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > 200_000) return [];
  const points = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  try {
    while (index < encoded.length && points.length < 15_000) {
      const deltas = [];
      for (let axis = 0; axis < 2; axis++) {
        let result = 0;
        let shift = 0;
        let byte;
        do {
          if (index >= encoded.length || shift > 30) return [];
          byte = encoded.charCodeAt(index++) - 63;
          if (byte < 0 || byte > 63) return [];
          result |= (byte & 0x1f) << shift;
          shift += 5;
        } while (byte >= 0x20);
        deltas.push(result & 1 ? ~(result >> 1) : result >> 1);
      }
      latitude += deltas[0];
      longitude += deltas[1];
      const point = [latitude / 100_000, longitude / 100_000];
      if (point[0] >= 35 && point[0] <= 43 && point[1] >= 25 && point[1] <= 46) points.push(point);
    }
  } catch {
    return [];
  }
  return points;
}

function stopName(stop) {
  const name = String(stop?.n ?? '').trim();
  return name && !name.includes('\uFFFD') ? name : 'Durak';
}

function stopDescription(stop) {
  const description = String(stop?.d ?? '').trim();
  return description && !description.includes('\uFFFD') ? description : '';
}

function pointIcon(L, type) {
  const label = type === 'origin' ? 'A' : 'B';
  return L.divIcon({
    className: 'journey-marker-wrap',
    html: `<span class="journey-marker journey-marker-${type}">${label}</span>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22]
  });
}

function markerIcon(L, stop, { favorite, selected }) {
  const label = stopName(stop);
  const size = label.length > 4 ? 48 : 40;
  const classes = ['map-stop-pin'];
  if (favorite) classes.push('is-favorite');
  if (selected) classes.push('is-selected');
  return L.divIcon({
    className: 'map-stop-icon',
    html: `<span class="${classes.join(' ')}">${escapeHtml(label)}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    tooltipAnchor: [0, -size / 2]
  });
}

export function createTransitMap({ element, stops, onSelectStop, onPickPoint }) {
  const L = window.L;
  if (!L || typeof L.markerClusterGroup !== 'function') {
    element.innerHTML = '<p class="map-unavailable">Harita şu anda yüklenemedi. Durak aramayı kullanabilirsiniz.</p>';
    return null;
  }

  const map = L.map(element, {
    center: DEFAULT_CENTER,
    zoom: 12,
    minZoom: 8,
    maxZoom: 19,
    zoomControl: false,
    scrollWheelZoom: false,
    fadeAnimation: false,
    zoomAnimation: false,
    markerZoomAnimation: false
  });
  const baseLayer = L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
    minZoom: 0,
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap katkıda bulunanlar</a>'
  });
  baseLayer.on('tileload', (event) => {
    event.tile.style.visibility = 'visible';
    event.tile.style.opacity = '1';
  });
  baseLayer.addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  const stopLayer = L.markerClusterGroup({
    maxClusterRadius: 42,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    zoomToBoundsOnClick: true,
    disableClusteringAtZoom: 16,
    animate: false,
    chunkedLoading: true
  }).addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const endpointLayer = L.layerGroup().addTo(map);
  let currentRoute = null;
  let currentRouteId = null;
  let selectedStopId = null;
  let pickMode = 'browse';
  let favoriteIds = new Set();
  let showFavoritesOnly = false;
  let previousFavoritesKey = '';
  let previousFavoritesOnly = null;
  let previousSelectedStopId = null;
  let previousEndpointKey = '';
  let routePoints = [];

  function visibleStops() {
    const routeStopIds = currentRoute ? new Set((currentRoute.s || []).map(String)) : null;
    return stops.filter((stop) => {
      if (!coordinates(stop)) return false;
      if (routeStopIds && !routeStopIds.has(String(stop.id))) return false;
      if (showFavoritesOnly && !favoriteIds.has(String(stop.id))) return false;
      return true;
    });
  }

  function drawStops() {
    stopLayer.clearLayers();
    const markers = [];
    for (const stop of visibleStops()) {
      const point = coordinates(stop);
      const marker = L.marker(point, {
        title: `Durak ${stopName(stop)}${stopDescription(stop) ? `, ${stopDescription(stop)}` : ''}`,
        alt: `Durak ${stopName(stop)}`,
        icon: markerIcon(L, stop, {
          favorite: favoriteIds.has(String(stop.id)),
          selected: String(stop.id) === String(selectedStopId)
        }),
        keyboard: true,
        riseOnHover: true
      });
      marker.bindTooltip(escapeHtml(stopDescription(stop) || `Durak ${stopName(stop)}`), { direction: 'top', offset: [0, -8] });
      marker.on('click', () => {
        if (pickMode !== 'browse' && typeof onPickPoint === 'function') onPickPoint({ latitude: point[0], longitude: point[1] });
        else onSelectStop(stop.id);
      });
      markers.push(marker);
    }
    stopLayer.addLayers(markers);
  }

  function drawRoute(route) {
    routeLayer.clearLayers();
    routePoints = [];
    if (!route) return;
    routePoints = decodePolyline(route.path);
    if (routePoints.length < 2) {
      routePoints = (route.s || []).map((id) => stops.find((stop) => String(stop.id) === String(id))).filter(Boolean).map(coordinates).filter(Boolean);
    }
    if (routePoints.length >= 2) {
      L.polyline(routePoints, {
        color: '#0757b5',
        weight: 6,
        opacity: 0.9,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(routeLayer);
      L.polyline(routePoints, {
        color: '#fff',
        weight: 2,
        opacity: 0.82,
        interactive: false,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(routeLayer);
    }
  }

  function drawEndpoints(origin, destination) {
    endpointLayer.clearLayers();
    for (const [point, type, label] of [[origin, 'origin', 'Başlangıç'], [destination, 'destination', 'Varış']]) {
      if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) continue;
      const marker = L.marker([point.latitude, point.longitude], {
        icon: pointIcon(L, type),
        title: label,
        alt: label,
        keyboard: true,
        zIndexOffset: 1000
      }).bindTooltip(label, { direction: 'top', offset: [0, -16] });
      endpointLayer.addLayer(marker);
    }
  }

  map.on('click', (event) => {
    if (pickMode !== 'browse' && typeof onPickPoint === 'function') onPickPoint({ latitude: event.latlng.lat, longitude: event.latlng.lng });
  });

  drawStops();
  const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }));
  observer.observe(element);
  requestAnimationFrame(() => map.invalidateSize({ pan: false }));

  return {
    update({ route = null, selectedStop = null, favorites = [], favoritesOnly = false, origin = null, destination = null, pickMode: requestedPickMode = 'browse' } = {}) {
      favoriteIds = new Set([...favorites].map(String));
      showFavoritesOnly = favoritesOnly;
      selectedStopId = selectedStop == null ? null : String(selectedStop);
      pickMode = requestedPickMode === 'origin' || requestedPickMode === 'destination' ? requestedPickMode : 'browse';
      const routeId = route == null ? null : String(route.id);
      const routeChanged = routeId !== currentRouteId;
      const favoritesKey = [...favoriteIds].sort().join(',');
      const markersChanged = routeChanged || favoritesKey !== previousFavoritesKey || showFavoritesOnly !== previousFavoritesOnly || selectedStopId !== previousSelectedStopId;
      const endpointKey = [origin?.latitude, origin?.longitude, destination?.latitude, destination?.longitude].join('|');
      const endpointsChanged = endpointKey !== previousEndpointKey;
      element.classList.toggle('is-picking-origin', pickMode === 'origin');
      element.classList.toggle('is-picking-destination', pickMode === 'destination');

      if (routeChanged) {
        currentRoute = route;
        currentRouteId = routeId;
        drawRoute(route);
      }
      if (markersChanged) drawStops();
      if (endpointsChanged) drawEndpoints(origin, destination);

      if (routeChanged && routePoints.length > 1) {
        map.fitBounds(L.latLngBounds(routePoints), { padding: [32, 32], maxZoom: 14, animate: false });
      } else if (selectedStopId && selectedStopId !== previousSelectedStopId) {
        const stop = stops.find((item) => String(item.id) === selectedStopId);
        const point = coordinates(stop);
        if (point) map.setView(point, Math.max(map.getZoom(), 15), { animate: false });
      } else if (endpointsChanged && origin && destination) {
        map.fitBounds(L.latLngBounds([[origin.latitude, origin.longitude], [destination.latitude, destination.longitude]]), { padding: [42, 42], maxZoom: 14, animate: false });
      } else if (endpointsChanged && destination) {
        map.setView([destination.latitude, destination.longitude], Math.max(map.getZoom(), 13), { animate: false });
      } else if (endpointsChanged && origin) {
        map.setView([origin.latitude, origin.longitude], Math.max(map.getZoom(), 13), { animate: false });
      } else if (routeChanged && !route && !selectedStopId) {
        map.setView(DEFAULT_CENTER, 12, { animate: false });
      }

      previousEndpointKey = endpointKey;
      previousFavoritesKey = favoritesKey;
      previousFavoritesOnly = showFavoritesOnly;
      previousSelectedStopId = selectedStopId;
    },
    invalidate() {
      map.invalidateSize({ pan: false });
    },
    getMap() {
      return map;
    }
  };
}
