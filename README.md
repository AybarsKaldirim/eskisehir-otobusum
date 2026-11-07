# Eskişehir Otobüsüm

Installable mobile-first PWA for finding Eskişehir bus stops and showing the next arrival information from the supplied NimBus public locator.

## Run locally

Node.js 18 or newer is required; there are no npm dependencies.

```sh
npm run dev
```

Open <http://127.0.0.1:5173>. Geolocation requires browser permission and works on localhost or HTTPS. On iPhone, open in Safari, choose **Share → Add to Home Screen**; the layout includes safe-area and standalone PWA support.

## Data source

The app reads the public locator's browser-facing JSON endpoints:

- `/api/locator/{locator-hash}/data` — stops and route/stop relationships
- `/api/locator/{locator-hash}/online/stop/{stop-id}` — upcoming arrivals for a selected stop

The locator hash is included in `app.js` because the supplied share link is public. The separate embedded Flespi/MQTT credential is **not copied or used by this app**. The “Canlı” view embeds the supplied public Wialon Locator page, which renders its own live vehicle positions; the custom “Duraklar” map shows stops and selected route paths. The trip planner checks direct routes and one transfer using locator timetable/prediction data and conservative walking time; it is approximate, not traffic-aware turn-by-turn navigation. Stop arrivals refresh every 30 seconds. The service worker caches only the app shell, never transit responses or map tiles.

The user confirmed on 07.11.2026 that use of the supplied public locator is permitted. Its browser-facing endpoints are still undocumented and may change or be withdrawn. The prototype currently displays tiles from `tile.openstreetmap.de` with visible OpenStreetMap attribution; this community service has no SLA and may restrict distributed/high-volume apps, so use an appropriate tile provider for launch. The app distinguishes vehicle-linked predictions from timetable entries and does not label timetable-only data as live.

## MVP features

- Search by stop or route number/name.
- Find nearby stops with optional location permission.
- iOS-first full-screen map with a switch between clustered stops/route paths and the public Locator’s live bus view.
- Select a stop pin to view arrivals, or choose a bus route to draw its decoded locator polyline and highlight stops.
- Select an origin and destination on the map or use device location; stop markers can be selected as trip endpoints.
- Find direct and one-transfer bus itineraries from the locator stop/route graph.
- Estimate trip time from per-stop timetable rows, current stop arrival predictions, and conservative walking time; label the result as approximate.
- Show stop arrivals and refresh them every 30 seconds.
- Follow a route to pick one of its stops.
- Save frequently used stops and routes locally.
- Large-text toggle, keyboard focus states, high-contrast controls, iOS safe-area/tab-bar layout, offline shell, and explicit connection/error messages.
