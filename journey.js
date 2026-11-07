const WALKING_KMH = 3.5;
const TRANSFER_BUFFER_SECONDS = 180;
const MAX_WALK_KM = 2.5;
const DAY_MS = 24 * 60 * 60 * 1000;

function pointOf(stop) {
  const point = Array.isArray(stop?.p) ? stop.p[0] : null;
  const lat = Number(point?.y);
  const lng = Number(point?.x);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { latitude: lat, longitude: lng } : null;
}

export function distanceKm(a, b) {
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function nearestStops(point, stops, limit = 3) {
  return stops.map((stop) => {
    const coordinates = pointOf(stop);
    return coordinates ? { stop, distanceKm: distanceKm(point, coordinates) } : null;
  }).filter((item) => item && item.distanceKm <= MAX_WALK_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

function startOfDay(date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

function patternWorks(pattern, date) {
  if (!pattern) return true;
  const weekdays = Number(pattern.w);
  const mondayIndex = (date.getDay() + 6) % 7;
  if (Number.isFinite(weekdays) && weekdays > 0 && !(weekdays & (1 << mondayIndex))) return false;

  const fromDay = Number(pattern.df);
  const fromMonth = Number(pattern.mf);
  const toDay = Number(pattern.dt);
  const toMonth = Number(pattern.mt);
  if ([fromDay, fromMonth, toDay, toMonth].every(Number.isFinite) && fromDay > 0 && fromMonth > 0 && toDay > 0 && toMonth > 0) {
    const year = date.getFullYear();
    const dayNumber = Date.UTC(year, date.getMonth(), date.getDate());
    const from = Date.UTC(year, fromMonth - 1, fromDay);
    const to = Date.UTC(year, toMonth - 1, toDay);
    if (from <= to && (dayNumber < from || dayNumber > to)) return false;
    if (from > to && dayNumber < from && dayNumber > to) return false;
  }
  return true;
}

function getPattern(row, patternsById) {
  return patternsById.get(String(row.ptrn)) || null;
}

function scheduledRows(route, patternsById, date) {
  return (route.tt || []).filter((row) => Array.isArray(row.t) && patternWorks(getPattern(row, patternsById), date));
}

function nextScheduledTrip(route, fromIndex, toIndex, afterMs, patternsById, maxDays = 2) {
  if (!Array.isArray(route.tt) || fromIndex < 0 || toIndex <= fromIndex) return null;
  let best = null;
  const base = startOfDay(new Date(afterMs));

  for (let dayOffset = 0; dayOffset <= maxDays; dayOffset++) {
    const serviceDate = new Date(base.getTime() + dayOffset * DAY_MS);
    const rows = scheduledRows(route, patternsById, serviceDate);
    for (const row of rows) {
      if (row.t.length <= toIndex) continue;
      const departureSeconds = Number(row.t[fromIndex]);
      const arrivalSeconds = Number(row.t[toIndex]);
      if (!Number.isFinite(departureSeconds) || !Number.isFinite(arrivalSeconds) || departureSeconds < 0 || arrivalSeconds < 0) continue;
      const departureMs = serviceDate.getTime() + departureSeconds * 1000;
      let arrivalMs = serviceDate.getTime() + arrivalSeconds * 1000;
      if (arrivalMs <= departureMs) arrivalMs += DAY_MS;
      if (departureMs < afterMs - 1000) continue;
      if (departureMs - afterMs > DAY_MS) continue;
      const candidate = { departureMs, arrivalMs, rideSeconds: (arrivalMs - departureMs) / 1000, row };
      if (!best || candidate.departureMs < best.departureMs) best = candidate;
    }
  }
  return best;
}

function averageRideSeconds(route, fromIndex, toIndex, patternsById, date) {
  const durations = scheduledRows(route, patternsById, date).map((row) => {
    if (row.t.length <= toIndex) return null;
    const start = Number(row.t[fromIndex]);
    const end = Number(row.t[toIndex]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    let duration = end - start;
    if (duration <= 0) duration += 24 * 60 * 60;
    return duration >= 60 && duration <= 4 * 60 * 60 ? duration : null;
  }).filter(Number.isFinite);
  if (!durations.length) return null;
  return durations.reduce((sum, value) => sum + value, 0) / durations.length;
}

function estimatedRideSeconds(route, fromIndex, toIndex, stopById) {
  let distance = 0;
  let validSegments = 0;
  for (let i = fromIndex; i < toIndex; i++) {
    const a = pointOf(stopById.get(String(route.s[i])));
    const b = pointOf(stopById.get(String(route.s[i + 1])));
    if (!a || !b) continue;
    distance += distanceKm(a, b) * 1.25;
    validSegments++;
  }
  if (!validSegments) return null;
  return Math.max(180, distance / 18 * 3600 + validSegments * 25);
}

function walkingSeconds(km) {
  return km / WALKING_KMH * 3600;
}

function liveWaitSeconds(routeId, stopId, arrivalsByStop) {
  const response = arrivalsByStop.get(String(stopId));
  const groups = Array.isArray(response) ? response : response?.items || [];
  const group = groups.find((entry) => String(entry.id) === String(routeId));
  if (!group || !Array.isArray(group.tt)) return null;
  const values = group.tt.map((item) => {
    const seconds = item.in ? 0 : Number(item.eta?.tt);
    return Number.isFinite(seconds) && seconds >= 0
      ? { seconds, live: item.uid !== null && item.uid !== undefined, fetchedAt: response?.fetchedAt ?? Date.now() }
      : null;
  }).filter(Boolean);
  return values.length ? values.sort((a, b) => a.seconds - b.seconds)[0] : null;
}

function buildLeg({ route, fromStop, toStop, fromIndex, toIndex, readyAt, patternsById, stopById, liveWait = null }) {
  let trip = null;
  let departureMs = null;
  let waitSource = 'Tarifeye göre';
  let rideSeconds = averageRideSeconds(route, fromIndex, toIndex, patternsById, new Date(readyAt));
  let estimated = false;

  if (liveWait && Number.isFinite(liveWait.seconds) && liveWait.seconds >= 0) {
    const liveDeparture = liveWait.fetchedAt + liveWait.seconds * 1000;
    if (liveDeparture >= readyAt && liveDeparture - readyAt <= 3 * 60 * 60 * 1000) {
      departureMs = liveDeparture;
      waitSource = liveWait.live ? 'Canlı araç tahmini' : 'Tarifedeki geliş saati';
    }
  }

  if (departureMs === null) {
    trip = nextScheduledTrip(route, fromIndex, toIndex, readyAt, patternsById);
    if (!trip) return null;
    departureMs = trip.departureMs;
    rideSeconds = trip.rideSeconds;
  }

  if (!Number.isFinite(rideSeconds)) {
    rideSeconds = estimatedRideSeconds(route, fromIndex, toIndex, stopById);
    estimated = true;
  }
  if (!Number.isFinite(rideSeconds) || rideSeconds <= 0) return null;

  return {
    route,
    fromStop,
    toStop,
    waitSeconds: Math.max(0, (departureMs - readyAt) / 1000),
    rideSeconds,
    waitSource,
    estimated,
    departureMs,
    arrivalMs: departureMs + rideSeconds * 1000
  };
}

export function planJourneys({ origin, destination, stops, routes, patterns = [], arrivalsByStop = new Map(), now = Date.now(), limit = 3 }) {
  const startStops = nearestStops(origin, stops);
  const endStops = nearestStops(destination, stops);
  if (!startStops.length || !endStops.length) return { options: [], startStops, endStops };

  const stopById = new Map(stops.map((stop) => [String(stop.id), stop]));
  const patternsById = new Map(patterns.map((pattern) => [String(pattern.id), pattern]));
  const routesByStop = new Map();
  for (const route of routes) {
    (route.s || []).forEach((stopId, index) => {
      const key = String(stopId);
      if (!routesByStop.has(key)) routesByStop.set(key, []);
      routesByStop.get(key).push({ route, index });
    });
  }

  const options = [];
  const seen = new Set();
  const addOption = (legs, start, end) => {
    if (!legs.length) return;
    const key = `${legs.map((leg) => leg.route.id).join(':')}/${start.stop.id}/${end.stop.id}/${legs.map((leg) => leg.fromStop.id).join(':')}`;
    if (seen.has(key)) return;
    seen.add(key);
    const walkToStart = walkingSeconds(start.distanceKm);
    const walkToEnd = walkingSeconds(end.distanceKm);
    const arrivalMs = legs[legs.length - 1].arrivalMs + walkToEnd * 1000;
    options.push({
      legs,
      startStop: start.stop,
      endStop: end.stop,
      startWalkKm: start.distanceKm,
      endWalkKm: end.distanceKm,
      walkingSeconds: walkToStart + walkToEnd,
      totalSeconds: (arrivalMs - now) / 1000,
      transfers: legs.length - 1,
      estimated: legs.some((leg) => leg.estimated),
      arrivalMs
    });
  };

  for (const start of startStops) {
    for (const end of endStops) {
      const startRoutes = routesByStop.get(String(start.stop.id)) || [];
      for (const { route, index: fromIndex } of startRoutes) {
        const toIndex = (route.s || []).findIndex((id) => String(id) === String(end.stop.id));
        if (toIndex <= fromIndex) continue;
        const walkToStop = walkingSeconds(start.distanceKm);
        const readyAt = now + walkToStop * 1000;
        const liveWait = liveWaitSeconds(route.id, start.stop.id, arrivalsByStop);
        const leg = buildLeg({ route, fromStop: start.stop, toStop: end.stop, fromIndex, toIndex, readyAt, patternsById, stopById, liveWait });
        if (leg) addOption([leg], start, end);
      }
    }
  }

  for (const start of startStops) {
    const startRoutes = routesByStop.get(String(start.stop.id)) || [];
    for (const first of startRoutes) {
      const firstRoute = first.route;
      const firstReadyAt = now + walkingSeconds(start.distanceKm) * 1000;
      const firstLiveWait = liveWaitSeconds(firstRoute.id, start.stop.id, arrivalsByStop);
      for (let transferIndex = first.index + 1; transferIndex < (firstRoute.s || []).length; transferIndex++) {
        const transferId = String(firstRoute.s[transferIndex]);
        const transferStop = stopById.get(transferId);
        if (!transferStop) continue;
        const secondRoutes = routesByStop.get(transferId) || [];
        for (const second of secondRoutes) {
          if (String(second.route.id) === String(firstRoute.id)) continue;
          for (const end of endStops) {
            const finalIndex = (second.route.s || []).findIndex((id) => String(id) === String(end.stop.id));
            if (finalIndex <= second.index) continue;
            const firstLeg = buildLeg({
              route: firstRoute,
              fromStop: start.stop,
              toStop: transferStop,
              fromIndex: first.index,
              toIndex: transferIndex,
              readyAt: firstReadyAt,
              patternsById,
              stopById,
              liveWait: firstLiveWait
            });
            if (!firstLeg) continue;
            const transferReadyAt = firstLeg.arrivalMs + TRANSFER_BUFFER_SECONDS * 1000;
            const secondLeg = buildLeg({
              route: second.route,
              fromStop: transferStop,
              toStop: end.stop,
              fromIndex: second.index,
              toIndex: finalIndex,
              readyAt: transferReadyAt,
              patternsById,
              stopById
            });
            if (secondLeg) addOption([firstLeg, secondLeg], start, end);
          }
        }
      }
    }
  }

  options.sort((a, b) => a.totalSeconds - b.totalSeconds);
  return { options: options.slice(0, limit), startStops, endStops };
}
