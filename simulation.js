const DATA_PATH = "data";

const state = {
	map: null,
	isRealtime: true,
	simTimeMs: Date.now(),
	playing: true,
	speed: 1,
	lastTickMs: Date.now(),
	visibleRoutes: new Set(),
	routePolylines: new Map(),
	stationMarkers: new Map(),
	trainMarkers: new Map(),
	ignoreMapClickUntil: 0,
};

const gtfs = {
	stops: [],
	routes: [],
	trips: [],
	stopTimes: [],
	frequencies: [],
	calendars: [],
	shapes: [],
	stopsById: new Map(),
	routesById: new Map(),
	tripsById: new Map(),
	stopTimesByTrip: new Map(),
	stopTimesByStop: new Map(),
	frequenciesByTrip: new Map(),
	shapesById: new Map(),
	shapeMetaById: new Map(),
	routeStopSet: new Map(),
};

const els = {
	clock: document.getElementById("sim-clock"),
	loading: document.getElementById("sim-loading"),
	realtimeToggle: document.getElementById("realtime-toggle"),
	playPause: document.getElementById("play-pause"),
	simDatetime: document.getElementById("sim-datetime"),
	speedSlider: document.getElementById("speed-slider"),
	speedLabel: document.getElementById("speed-label"),
	lineFilters: document.getElementById("line-filters"),
	detailsSheet: document.getElementById("details-sheet"),
	sheetTitle: document.getElementById("sheet-title"),
	sheetContent: document.getElementById("sheet-content"),
	sheetClose: document.getElementById("sheet-close"),
};

function parseCsv(text) {
	const lines = text.trim().split("\n");
	if (!lines.length) return [];

	const headers = splitCsvLine(lines[0]).map((h) => h.trim());
	const rows = [];

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		const values = splitCsvLine(line);
		const row = {};
		for (let j = 0; j < headers.length; j++) {
			row[headers[j]] = (values[j] || "").trim();
		}
		rows.push(row);
	}

	return rows;
}

function splitCsvLine(line) {
	const out = [];
	let cur = "";
	let inQuotes = false;

	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') {
			inQuotes = !inQuotes;
			continue;
		}
		if (ch === "," && !inQuotes) {
			out.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	out.push(cur);
	return out;
}

async function fetchCsv(fileName) {
	const res = await fetch(`${DATA_PATH}/${fileName}`);
	if (!res.ok) {
		throw new Error(`Unable to load ${fileName}`);
	}
	return parseCsv(await res.text());
}

function timeToSeconds(str) {
	if (!str) return 0;
	const [h, m, s] = str.split(":").map(Number);
	return h * 3600 + m * 60 + s;
}

function secondsToTime(secs) {
	const normalized = ((Math.floor(secs) % 86400) + 86400) % 86400;
	const h = String(Math.floor(normalized / 3600)).padStart(2, "0");
	const m = String(Math.floor((normalized % 3600) / 60)).padStart(2, "0");
	const s = String(normalized % 60).padStart(2, "0");
	return `${h}:${m}:${s}`;
}

function getDayKey(dateObj) {
	return [
		"sunday",
		"monday",
		"tuesday",
		"wednesday",
		"thursday",
		"friday",
		"saturday",
	][dateObj.getDay()];
}

function getActiveServiceIds(dateObj) {
	const dateNum = Number(
		`${dateObj.getFullYear()}${String(dateObj.getMonth() + 1).padStart(2, "0")}${String(dateObj.getDate()).padStart(2, "0")}`,
	);
	const dayKey = getDayKey(dateObj);

	const active = new Set();
	for (const cal of gtfs.calendars) {
		if (
			dateNum >= Number(cal.start_date || 0) &&
			dateNum <= Number(cal.end_date || 99999999) &&
			cal[dayKey] === "1"
		) {
			active.add(cal.service_id);
		}
	}
	if (!active.size) {
		gtfs.calendars.forEach((cal) => active.add(cal.service_id));
	}
	return active;
}

function syncDatetimeInput() {
	const date = new Date(state.simTimeMs);
	date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
	els.simDatetime.value = date.toISOString().slice(0, 16);
}

function getCurrentDate() {
	if (state.isRealtime) return new Date();
	return new Date(state.simTimeMs);
}

function getCurrentSeconds() {
	const currentDate = getCurrentDate();
	return (
		currentDate.getHours() * 3600 +
		currentDate.getMinutes() * 60 +
		currentDate.getSeconds()
	);
}

function buildIndexes() {
	gtfs.stopsById.clear();
	gtfs.routesById.clear();
	gtfs.tripsById.clear();
	gtfs.stopTimesByTrip.clear();
	gtfs.stopTimesByStop.clear();
	gtfs.frequenciesByTrip.clear();
	gtfs.shapesById.clear();
	gtfs.shapeMetaById.clear();
	gtfs.routeStopSet.clear();

	for (const stop of gtfs.stops) {
		if (stop.status && stop.status !== "valid") continue;
		const lat = Number(stop.stop_lat);
		const lon = Number(stop.stop_lon);
		if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
		stop.lat = lat;
		stop.lon = lon;
		gtfs.stopsById.set(stop.stop_id, stop);
	}

	for (const route of gtfs.routes) {
		gtfs.routesById.set(route.route_id, route);
		gtfs.routeStopSet.set(route.route_id, new Set());
	}

	for (const trip of gtfs.trips) {
		gtfs.tripsById.set(trip.trip_id, trip);
	}

	for (const st of gtfs.stopTimes) {
		const arrSecs = timeToSeconds(st.arrival_time || st.departure_time);
		const depSecs = timeToSeconds(st.departure_time || st.arrival_time);
		const seq = Number(st.stop_sequence || 0);
		const normalized = {
			...st,
			arrSecs,
			depSecs,
			seq,
		};

		if (!gtfs.stopTimesByTrip.has(st.trip_id)) {
			gtfs.stopTimesByTrip.set(st.trip_id, []);
		}
		gtfs.stopTimesByTrip.get(st.trip_id).push(normalized);

		if (!gtfs.stopTimesByStop.has(st.stop_id)) {
			gtfs.stopTimesByStop.set(st.stop_id, []);
		}
		gtfs.stopTimesByStop.get(st.stop_id).push(normalized);

		const trip = gtfs.tripsById.get(st.trip_id);
		if (trip && gtfs.routeStopSet.has(trip.route_id)) {
			gtfs.routeStopSet.get(trip.route_id).add(st.stop_id);
		}
	}

	for (const [tripId, stops] of gtfs.stopTimesByTrip.entries()) {
		stops.sort((a, b) => a.seq - b.seq);
		gtfs.stopTimesByTrip.set(tripId, stops);
	}

	for (const freq of gtfs.frequencies) {
		if (!gtfs.frequenciesByTrip.has(freq.trip_id)) {
			gtfs.frequenciesByTrip.set(freq.trip_id, []);
		}
		gtfs.frequenciesByTrip.get(freq.trip_id).push({
			...freq,
			startSecs: timeToSeconds(freq.start_time),
			endSecs: timeToSeconds(freq.end_time),
			headwaySecs: Number(freq.headway_secs || 0),
		});
	}

	for (const [tripId, ranges] of gtfs.frequenciesByTrip.entries()) {
		ranges.sort((a, b) => a.startSecs - b.startSecs);
		gtfs.frequenciesByTrip.set(tripId, ranges);
	}

	for (const shape of gtfs.shapes) {
		if (!gtfs.shapesById.has(shape.shape_id)) {
			gtfs.shapesById.set(shape.shape_id, []);
		}
		gtfs.shapesById.get(shape.shape_id).push({
			lat: Number(shape.shape_pt_lat),
			lon: Number(shape.shape_pt_lon),
			seq: Number(shape.shape_pt_sequence || 0),
		});
	}

	for (const [shapeId, pts] of gtfs.shapesById.entries()) {
		pts.sort((a, b) => a.seq - b.seq);
		gtfs.shapesById.set(shapeId, pts);
		gtfs.shapeMetaById.set(shapeId, buildShapeMeta(pts));
	}

	for (const trip of gtfs.trips) {
		const seq = gtfs.stopTimesByTrip.get(trip.trip_id);
		const shapeMeta = gtfs.shapeMetaById.get(trip.shape_id);
		if (!seq || !seq.length || !shapeMeta) continue;
		projectTripStopsToShape(seq, shapeMeta);
	}
}

function buildShapeMeta(points) {
	if (!points || !points.length) {
		return { points: [], cumulative: [], total: 0 };
	}

	const cumulative = [0];
	for (let i = 1; i < points.length; i++) {
		const prev = points[i - 1];
		const cur = points[i];
		const seg = geoDistanceMeters(prev.lat, prev.lon, cur.lat, cur.lon);
		cumulative.push(cumulative[i - 1] + seg);
	}

	return {
		points,
		cumulative,
		total: cumulative[cumulative.length - 1] || 0,
	};
}

function geoDistanceMeters(lat1, lon1, lat2, lon2) {
	const r = 6371000;
	const toRad = Math.PI / 180;
	const dLat = (lat2 - lat1) * toRad;
	const dLon = (lon2 - lon1) * toRad;
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(lat1 * toRad) *
			Math.cos(lat2 * toRad) *
			Math.sin(dLon / 2) *
			Math.sin(dLon / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return r * c;
}

function projectTripStopsToShape(seq, shapeMeta) {
	if (!shapeMeta.points.length) return;
	let fromIndex = 0;

	for (let i = 0; i < seq.length; i++) {
		const stop = gtfs.stopsById.get(seq[i].stop_id);
		if (!stop) continue;

		let bestIndex = fromIndex;
		let bestDist = Infinity;
		for (let p = fromIndex; p < shapeMeta.points.length; p++) {
			const point = shapeMeta.points[p];
			const d = geoDistanceMeters(stop.lat, stop.lon, point.lat, point.lon);
			if (d < bestDist) {
				bestDist = d;
				bestIndex = p;
			}
		}

		seq[i].shapeDist = shapeMeta.cumulative[bestIndex] || 0;
		fromIndex = bestIndex;
	}
}

async function loadGtfs() {
	const [stops, routes, trips, stopTimes, frequencies, calendars, shapes] =
		await Promise.all([
			fetchCsv("stops.txt"),
			fetchCsv("routes.txt"),
			fetchCsv("trips.txt"),
			fetchCsv("stop_times.txt"),
			fetchCsv("frequencies.txt"),
			fetchCsv("calendar.txt"),
			fetchCsv("shapes.txt"),
		]);

	gtfs.stops = stops;
	gtfs.routes = routes;
	gtfs.trips = trips;
	gtfs.stopTimes = stopTimes;
	gtfs.frequencies = frequencies;
	gtfs.calendars = calendars;
	gtfs.shapes = shapes;

	buildIndexes();
}

function createMap() {
	state.map = L.map("map", {
		zoomControl: false,
		attributionControl: true,
		doubleClickZoom: true,
	}).setView([3.14, 101.69], 11);

	L.tileLayer(
		"https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
		{
			subdomains: "abcd",
			maxZoom: 19,
			attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
		},
	).addTo(state.map);

	state.map.on("click", () => {
		if (Date.now() < state.ignoreMapClickUntil) return;
		closeDetails();
	});
}

function createLineFilters() {
	const saved = JSON.parse(localStorage.getItem("simVisibleRoutes") || "null");
	const allRouteIds = gtfs.routes.map((r) => r.route_id);
	const startVisible =
		Array.isArray(saved) && saved.length ? saved : allRouteIds;
	state.visibleRoutes = new Set(startVisible);

	els.lineFilters.innerHTML = "";
	for (const route of gtfs.routes) {
		const chip = document.createElement("button");
		chip.type = "button";
		chip.className = "line-chip";
		chip.textContent = route.route_short_name || route.route_id;
		chip.dataset.routeId = route.route_id;
		chip.style.backgroundColor = `#${route.route_color || "7f8c8d"}`;
		chip.style.color = `#${route.route_text_color || "ffffff"}`;
		chip.onclick = () => {
			if (state.visibleRoutes.has(route.route_id)) {
				state.visibleRoutes.delete(route.route_id);
			} else {
				state.visibleRoutes.add(route.route_id);
			}
			updateLineFilterStyles();
			persistVisibleRoutes();
			renderVisibility();
			renderTrains();
		};
		els.lineFilters.appendChild(chip);
	}

	updateLineFilterStyles();
}

function updateLineFilterStyles() {
	els.lineFilters.querySelectorAll(".line-chip").forEach((chip) => {
		const id = chip.dataset.routeId;
		chip.classList.toggle("is-off", !state.visibleRoutes.has(id));
	});
}

function persistVisibleRoutes() {
	localStorage.setItem(
		"simVisibleRoutes",
		JSON.stringify(Array.from(state.visibleRoutes)),
	);
}

function drawRoutePolylines() {
	const allLatLngs = [];
	for (const trip of gtfs.trips) {
		if (state.routePolylines.has(trip.shape_id)) continue;
		const pts = gtfs.shapesById.get(trip.shape_id);
		if (!pts || pts.length < 2) continue;

		const route = gtfs.routesById.get(trip.route_id);
		const color = `#${route?.route_color || "95a5a6"}`;
		const latLngs = pts.map((p) => [p.lat, p.lon]);
		const line = L.polyline(latLngs, {
			color,
			weight: 3,
			opacity: 0.7,
		});
		line.routeId = trip.route_id;
		line.addTo(state.map);
		state.routePolylines.set(trip.shape_id, line);
		allLatLngs.push(...latLngs);
	}

	if (allLatLngs.length) {
		state.map.fitBounds(allLatLngs, { padding: [16, 16] });
	}
}

function drawStations() {
	for (const stop of gtfs.stopsById.values()) {
		const marker = L.circleMarker([stop.lat, stop.lon], {
			radius: 4,
			fillColor: "#22384a",
			fillOpacity: 0.8,
			color: "#ffffff",
			weight: 1,
			className: "station-dot",
		});

		marker.stopId = stop.stop_id;
		marker.on("click", (e) => {
			state.ignoreMapClickUntil = Date.now() + 220;
			if (e && e.originalEvent) {
				L.DomEvent.stopPropagation(e.originalEvent);
			}
			openStationDetails(stop.stop_id);
		});
		marker.addTo(state.map);
		state.stationMarkers.set(stop.stop_id, marker);
	}
}

function stationVisible(stopId) {
	for (const routeId of state.visibleRoutes) {
		const routeStops = gtfs.routeStopSet.get(routeId);
		if (routeStops && routeStops.has(stopId)) return true;
	}
	return false;
}

function renderVisibility() {
	for (const line of state.routePolylines.values()) {
		const visible = state.visibleRoutes.has(line.routeId);
		line.setStyle({ opacity: visible ? 0.7 : 0 });
	}

	for (const [stopId, marker] of state.stationMarkers.entries()) {
		const visible = stationVisible(stopId);
		if (visible) marker.addTo(state.map);
		else marker.remove();
	}
}

function interpolate(from, to, ratio) {
	return {
		lat: from.lat + (to.lat - from.lat) * ratio,
		lon: from.lon + (to.lon - from.lon) * ratio,
	};
}

function wrapDiff(target, current) {
	let diff = target - current;
	if (diff < -43200) diff += 86400;
	if (diff > 43200) diff -= 86400;
	return diff;
}

function getRunsAtCurrentTime() {
	const nowDate = getCurrentDate();
	const currentSecs = getCurrentSeconds();
	const activeServices = getActiveServiceIds(nowDate);
	const output = [];

	for (const trip of gtfs.trips) {
		if (!activeServices.has(trip.service_id)) continue;
		if (!state.visibleRoutes.has(trip.route_id)) continue;

		const times = gtfs.stopTimesByTrip.get(trip.trip_id);
		if (!times || times.length < 2) continue;
		const freqs = gtfs.frequenciesByTrip.get(trip.trip_id);
		if (!freqs || !freqs.length) continue;

		const firstDep = times[0].depSecs;
		const lastArr = times[times.length - 1].arrSecs;
		const tripDuration = Math.max(1, lastArr - firstDep);

		for (const f of freqs) {
			if (!f.headwaySecs) continue;
			const maxRuns = Math.floor((f.endSecs - f.startSecs) / f.headwaySecs);
			for (let i = 0; i <= maxRuns; i++) {
				const runStart = f.startSecs + i * f.headwaySecs;
				const rel = wrapDiff(currentSecs, runStart);
				if (rel < 0 || rel > tripDuration) continue;

				const runId = `${trip.trip_id}_${runStart}`;
				const currentTripSec = firstDep + rel;
				const pos = getPositionOnTrip(times, currentTripSec, trip);
				if (!pos) continue;

				output.push({
					runId,
					trip,
					route: gtfs.routesById.get(trip.route_id),
					runStart,
					headwaySecs: f.headwaySecs,
					windowStartSecs: f.startSecs,
					windowEndSecs: f.endSecs,
					tripSec: currentTripSec,
					...pos,
				});
			}
		}
	}

	return output;
}

function getPositionOnTrip(stopsSeq, tripSec, trip) {
	const shapeMeta = gtfs.shapeMetaById.get(trip.shape_id);

	for (let i = 0; i < stopsSeq.length - 1; i++) {
		const cur = stopsSeq[i];
		const next = stopsSeq[i + 1];
		const curStop = gtfs.stopsById.get(cur.stop_id);
		const nextStop = gtfs.stopsById.get(next.stop_id);
		if (!curStop || !nextStop) continue;

		if (tripSec >= cur.arrSecs && tripSec <= cur.depSecs) {
			return {
				lat: curStop.lat,
				lon: curStop.lon,
				currentStopId: cur.stop_id,
				nextStopId: next.stop_id,
				ratio: 0,
			};
		}

		if (tripSec >= cur.depSecs && tripSec <= next.arrSecs) {
			const span = Math.max(1, next.arrSecs - cur.depSecs);
			const ratio = Math.min(1, Math.max(0, (tripSec - cur.depSecs) / span));
			let pos = interpolate(curStop, nextStop, ratio);

			if (
				shapeMeta &&
				typeof cur.shapeDist === "number" &&
				typeof next.shapeDist === "number"
			) {
				const dist = cur.shapeDist + (next.shapeDist - cur.shapeDist) * ratio;
				const shaped = getPointAtShapeDistance(shapeMeta, dist);
				if (shaped) pos = shaped;
			}

			return {
				lat: pos.lat,
				lon: pos.lon,
				currentStopId: cur.stop_id,
				nextStopId: next.stop_id,
				ratio,
			};
		}
	}

	const last = stopsSeq[stopsSeq.length - 1];
	const lastStop = gtfs.stopsById.get(last.stop_id);
	if (!lastStop) return null;

	if (tripSec >= last.arrSecs) {
		return {
			lat: lastStop.lat,
			lon: lastStop.lon,
			currentStopId: last.stop_id,
			nextStopId: last.stop_id,
			ratio: 1,
		};
	}

	return null;
}

function getPointAtShapeDistance(shapeMeta, dist) {
	if (!shapeMeta || !shapeMeta.points.length) return null;
	if (dist <= 0) return shapeMeta.points[0];
	if (dist >= shapeMeta.total)
		return shapeMeta.points[shapeMeta.points.length - 1];

	let low = 0;
	let high = shapeMeta.cumulative.length - 1;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (shapeMeta.cumulative[mid] < dist) low = mid + 1;
		else high = mid;
	}

	const idx = Math.max(1, low);
	const prevIdx = idx - 1;
	const prevDist = shapeMeta.cumulative[prevIdx];
	const nextDist = shapeMeta.cumulative[idx];
	const segSpan = Math.max(1, nextDist - prevDist);
	const ratio = (dist - prevDist) / segSpan;
	return interpolate(shapeMeta.points[prevIdx], shapeMeta.points[idx], ratio);
}

function ensureTrainMarker(run) {
	let marker = state.trainMarkers.get(run.runId);
	if (!marker) {
		marker = L.circleMarker([run.lat, run.lon], {
			radius: 7,
			fillColor: `#${run.route?.route_color || "95a5a6"}`,
			fillOpacity: 1,
			color: "#fff",
			weight: 2,
			className: "train-dot",
		});
		marker.runId = run.runId;
		marker.currentRun = run;
		marker.on("click", (e) => {
			state.ignoreMapClickUntil = Date.now() + 220;
			if (e && e.originalEvent) {
				L.DomEvent.stopPropagation(e.originalEvent);
			}
			if (marker.currentRun) openTrainDetails(marker.currentRun);
		});
		marker.addTo(state.map);
		state.trainMarkers.set(run.runId, marker);
	}
	return marker;
}

function renderTrains() {
	const runs = getRunsAtCurrentTime();
	const alive = new Set();

	for (const run of runs) {
		alive.add(run.runId);
		const marker = ensureTrainMarker(run);
		marker.setLatLng([run.lat, run.lon]);
		marker.setStyle({ fillColor: `#${run.route?.route_color || "95a5a6"}` });
		marker.currentRun = run;
	}

	for (const [runId, marker] of state.trainMarkers.entries()) {
		if (alive.has(runId)) continue;
		marker.remove();
		state.trainMarkers.delete(runId);
	}
}

function formatMins(secondsAway) {
	if (secondsAway <= 0) return "Arriving";
	const mins = Math.floor(secondsAway / 60);
	if (mins <= 1) return "1 min";
	return `${mins} min`;
}

function formatHeadway(headwaySecs) {
	if (!headwaySecs || headwaySecs <= 0) return "N/A";
	if (headwaySecs < 60) return `${headwaySecs}s`;
	const mins = Math.round(headwaySecs / 60);
	return `${mins} min`;
}

function toTowards(headsign) {
	const raw = (headsign || "").trim();
	if (!raw) return "Unknown";

	const toMatch = raw.match(/\bto\b\s+(.+)$/i);
	if (toMatch && toMatch[1]) return toMatch[1].trim();

	if (/^towards\s+/i.test(raw)) {
		return raw.replace(/^towards\s+/i, "").trim();
	}

	if (/^from\s+/i.test(raw)) {
		const parts = raw.split(/\bto\b/i);
		if (parts.length > 1) return parts[parts.length - 1].trim();
	}

	return raw;
}

function toFrom(headsign) {
	const raw = (headsign || "").trim();
	if (!raw) return "Unknown";

	const fromToMatch = raw.match(/^from\s+(.+?)\s+to\s+.+$/i);
	if (fromToMatch && fromToMatch[1]) return fromToMatch[1].trim();

	const fromMatch = raw.match(/^from\s+(.+)$/i);
	if (fromMatch && fromMatch[1]) return fromMatch[1].trim();

	return raw;
}

function getUpcomingStopEvents(stopId, limit = 10) {
	const nowDate = getCurrentDate();
	const currentSecs = getCurrentSeconds();
	const activeServices = getActiveServiceIds(nowDate);
	const stopTemplates = gtfs.stopTimesByStop.get(stopId) || [];
	const events = [];

	for (const template of stopTemplates) {
		const trip = gtfs.tripsById.get(template.trip_id);
		if (!trip || !state.visibleRoutes.has(trip.route_id)) continue;
		if (!activeServices.has(trip.service_id)) continue;
		const route = gtfs.routesById.get(trip.route_id);
		const directionId = String(trip.direction_id ?? "0");

		const seq = gtfs.stopTimesByTrip.get(template.trip_id);
		if (!seq || !seq.length) continue;
		const firstDep = seq[0].depSecs;
		const arrOffset = template.arrSecs - firstDep;
		const depOffset = template.depSecs - firstDep;

		const freqs = gtfs.frequenciesByTrip.get(template.trip_id) || [];
		for (const f of freqs) {
			if (!f.headwaySecs) continue;
			const maxRuns = Math.floor((f.endSecs - f.startSecs) / f.headwaySecs);
			for (let i = 0; i <= maxRuns; i++) {
				const base = f.startSecs + i * f.headwaySecs;
				const arrivalSecs = base + arrOffset;
				const departureSecs = base + depOffset;

				const arrDiff = wrapDiff(arrivalSecs, currentSecs);
				const depDiff = wrapDiff(departureSecs, currentSecs);

				if (arrDiff >= -30 && arrDiff <= 7200) {
					events.push({
						type: "Arrival",
						timeSecs: arrivalSecs,
						diff: arrDiff,
						route,
						headsign: trip.trip_headsign,
						directionId,
						headwaySecs: f.headwaySecs,
					});
				}

				if (depDiff >= -30 && depDiff <= 7200) {
					events.push({
						type: "Departure",
						timeSecs: departureSecs,
						diff: depDiff,
						route,
						headsign: trip.trip_headsign,
						directionId,
						headwaySecs: f.headwaySecs,
					});
				}
			}
		}
	}

	events.sort((a, b) => a.diff - b.diff);
	return events.slice(0, limit);
}

function showDetails(title, pairs) {
	els.sheetTitle.textContent = title;
	const dl = document.createElement("dl");
	for (const [key, value] of pairs) {
		const dt = document.createElement("dt");
		dt.textContent = key;
		const dd = document.createElement("dd");
		dd.textContent = value;
		dl.appendChild(dt);
		dl.appendChild(dd);
	}
	els.sheetContent.innerHTML = "";
	els.sheetContent.appendChild(dl);
	els.detailsSheet.classList.add("open");
	els.detailsSheet.setAttribute("aria-hidden", "false");
}

function closeDetails() {
	els.detailsSheet.classList.remove("open");
	els.detailsSheet.setAttribute("aria-hidden", "true");
}

function getDirectionLabelForStation(
	stopId,
	directionId,
	events,
	mode = "towards",
) {
	const fromEvent = events.find(
		(e) => e.directionId === directionId && e.headsign,
	);
	if (fromEvent) {
		return mode === "from"
			? `From ${toFrom(fromEvent.headsign)}`
			: `Towards ${toTowards(fromEvent.headsign)}`;
	}

	const templates = gtfs.stopTimesByStop.get(stopId) || [];
	for (const t of templates) {
		const trip = gtfs.tripsById.get(t.trip_id);
		if (!trip) continue;
		if (!state.visibleRoutes.has(trip.route_id)) continue;
		if (String(trip.direction_id ?? "0") !== directionId) continue;
		return mode === "from"
			? `From ${toFrom(trip.trip_headsign)}`
			: `Towards ${toTowards(trip.trip_headsign)}`;
	}

	return `Direction ${directionId}`;
}

function openTrainDetails(run) {
	const currentStop = gtfs.stopsById.get(run.currentStopId);
	const nextStop = gtfs.stopsById.get(run.nextStopId);
	const routeName =
		run.route?.route_long_name || run.route?.route_short_name || "Route";
	const progress = `${Math.round(run.ratio * 100)}%`;
	const towards = toTowards(run.trip.trip_headsign);
	showDetails(`${run.route?.route_short_name || "TR"} train`, [
		["Line", routeName],
		["Trip", run.trip.trip_id],
		["Towards", towards],
		["Headway", formatHeadway(run.headwaySecs)],
		[
			"Service window",
			`${secondsToTime(run.windowStartSecs).slice(0, 5)}-${secondsToTime(run.windowEndSecs).slice(0, 5)}`,
		],
		["Current stop", currentStop?.stop_name || run.currentStopId],
		["Next stop", nextStop?.stop_name || run.nextStopId],
		["Progress to next", progress],
		["Sim time", secondsToTime(getCurrentSeconds())],
	]);
}

function openStationDetails(stopId) {
	const stop = gtfs.stopsById.get(stopId);
	if (!stop) return;
	const routeNames = [];
	for (const routeId of state.visibleRoutes) {
		const set = gtfs.routeStopSet.get(routeId);
		if (set && set.has(stopId)) {
			const route = gtfs.routesById.get(routeId);
			routeNames.push(route?.route_short_name || routeId);
		}
	}
	const events = getUpcomingStopEvents(stopId, 8);
	const nextArrivalDir0 = events.find(
		(e) => e.type === "Arrival" && e.directionId === "0",
	);
	const nextArrivalDir1 = events.find(
		(e) => e.type === "Arrival" && e.directionId === "1",
	);
	const nextDepartureDir0 = events.find(
		(e) => e.type === "Departure" && e.directionId === "0",
	);
	const nextDepartureDir1 = events.find(
		(e) => e.type === "Departure" && e.directionId === "1",
	);
	const dir0ArrivalLabel = getDirectionLabelForStation(
		stopId,
		"0",
		events,
		"from",
	);
	const dir1ArrivalLabel = getDirectionLabelForStation(
		stopId,
		"1",
		events,
		"from",
	);
	const dir0DepartureLabel = getDirectionLabelForStation(
		stopId,
		"0",
		events,
		"towards",
	);
	const dir1DepartureLabel = getDirectionLabelForStation(
		stopId,
		"1",
		events,
		"towards",
	);
	const timeline = events
		.map(
			(e) =>
				`${e.type} ${
					e.type === "Arrival"
						? e.directionId === "0"
							? dir0ArrivalLabel
							: dir1ArrivalLabel
						: e.directionId === "0"
							? dir0DepartureLabel
							: dir1DepartureLabel
				} ${secondsToTime(e.timeSecs).slice(0, 5)} (${formatMins(e.diff)}) - ${
					e.route?.route_short_name || "RT"
				} towards ${toTowards(e.headsign)} [${formatHeadway(e.headwaySecs)}]`,
		)
		.join(" | ");

	showDetails(stop.stop_name, [
		["Stop ID", stop.stop_id],
		["Category", stop.category || "Station"],
		["Visible lines", routeNames.length ? routeNames.join(", ") : "None"],
		[
			`Next arrival (${dir0ArrivalLabel})`,
			nextArrivalDir0
				? `${secondsToTime(nextArrivalDir0.timeSecs).slice(0, 5)} (${formatMins(nextArrivalDir0.diff)})`
				: "None",
		],
		[
			`Next arrival (${dir1ArrivalLabel})`,
			nextArrivalDir1
				? `${secondsToTime(nextArrivalDir1.timeSecs).slice(0, 5)} (${formatMins(nextArrivalDir1.diff)})`
				: "None",
		],
		[
			`Next departure (${dir0DepartureLabel})`,
			nextDepartureDir0
				? `${secondsToTime(nextDepartureDir0.timeSecs).slice(0, 5)} (${formatMins(nextDepartureDir0.diff)})`
				: "None",
		],
		[
			`Next departure (${dir1DepartureLabel})`,
			nextDepartureDir1
				? `${secondsToTime(nextDepartureDir1.timeSecs).slice(0, 5)} (${formatMins(nextDepartureDir1.diff)})`
				: "None",
		],
		["Upcoming schedule", timeline || "No upcoming arrivals/departures"],
	]);
}

function updateClockUi() {
	const d = getCurrentDate();
	els.clock.textContent = d.toLocaleTimeString("en-US", { hour12: false });
}

function tick() {
	const now = Date.now();
	const dt = (now - state.lastTickMs) / 1000;
	state.lastTickMs = now;

	if (!state.isRealtime && state.playing) {
		state.simTimeMs += dt * 1000 * state.speed;
	}

	updateClockUi();
	renderTrains();
}

function bindControls() {
	els.realtimeToggle.onchange = () => {
		state.isRealtime = els.realtimeToggle.checked;
		if (state.isRealtime) {
			state.simTimeMs = Date.now();
		}
		els.simDatetime.disabled = state.isRealtime;
		els.speedSlider.disabled = state.isRealtime;
		els.playPause.disabled = state.isRealtime;
		syncDatetimeInput();
		tick();
	};

	els.speedSlider.oninput = () => {
		state.speed = Number(els.speedSlider.value || 1);
		els.speedLabel.textContent = `${state.speed.toFixed(1)}x`;
	};

	els.simDatetime.onchange = () => {
		if (!els.simDatetime.value) return;
		state.simTimeMs = new Date(els.simDatetime.value).getTime();
		tick();
	};

	els.playPause.onclick = () => {
		state.playing = !state.playing;
		els.playPause.textContent = state.playing ? "Pause" : "Play";
	};

	els.sheetClose.onclick = closeDetails;
}

async function init() {
	bindControls();
	createMap();

	const now = new Date();
	now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
	els.simDatetime.value = now.toISOString().slice(0, 16);

	try {
		await loadGtfs();
		createLineFilters();
		drawRoutePolylines();
		drawStations();
		renderVisibility();
		renderTrains();
		updateClockUi();
		setInterval(tick, 250);
	} catch (err) {
		console.error(err);
		els.loading.textContent = "Unable to load GTFS data for simulation.";
		return;
	}

	els.loading.style.display = "none";
}

init();
