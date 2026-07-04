// Data stores
let stops = [];
let routes = {};
let trips = {};
let stopTimes = [];
let frequencies = [];
let calendars = {};
let tripFirstStopTimes = {}; // trip_id -> seconds of first stop's departure

// State
let pinnedStations = JSON.parse(localStorage.getItem("pinnedStations")) || [];
let gtfsLoaded = false;
let updateInterval;

// Elements
const clockEl = document.getElementById("clock");
const simToggle = document.getElementById("simulated-time-toggle");
const simControls = document.getElementById("simulated-time-controls");
const simDatetime = document.getElementById("simulated-datetime");
const searchInput = document.getElementById("station-search");
const searchResults = document.getElementById("search-results");
const pinnedContainer = document.getElementById("pinned-stations");
const mainLoading = document.getElementById("main-loading");
const cardTemplate = document.getElementById("station-card-template");
const rowTemplate = document.getElementById("train-row-template");

// --- Initialization ---

async function init() {
	setupEventListeners();
	updateClock();
	setInterval(updateClock, 1000);

	// Set default simulated time to now for convenience if toggled
	const nowLocal = new Date();
	nowLocal.setMinutes(nowLocal.getMinutes() - nowLocal.getTimezoneOffset());
	simDatetime.value = nowLocal.toISOString().slice(0, 16);

	await loadGtfsData();
	gtfsLoaded = true;
	mainLoading.classList.add("hidden");

	renderPinnedStations();
	updateInterval = setInterval(renderPinnedStations, 10000); // 10s refresh for timers
}

function setupEventListeners() {
	simToggle.addEventListener("change", (e) => {
		if (e.target.checked) {
			simControls.classList.remove("hidden");
		} else {
			simControls.classList.add("hidden");
		}
		if (gtfsLoaded) renderPinnedStations();
	});

	simDatetime.addEventListener("change", () => {
		if (simToggle.checked && gtfsLoaded) renderPinnedStations();
	});

	searchInput.addEventListener("input", handleSearch);

	// Close dropdown on click outside
	document.addEventListener("click", (e) => {
		if (!e.target.closest(".search-container")) {
			searchResults.classList.add("hidden");
		}
	});
}

function getCurrentTime() {
	if (simToggle.checked && simDatetime.value) {
		return new Date(simDatetime.value);
	}
	return new Date();
}

function updateClock() {
	const t = getCurrentTime();
	clockEl.textContent = t.toLocaleTimeString("en-US", { hour12: false });
}

// --- CSV Parsing ---

async function fetchCsv(filename) {
	const res = await fetch(`data/${filename}`);
	if (!res.ok) throw new Error(`Failed to load ${filename}`);
	const text = await res.text();
	return parseCsv(text);
}

function parseCsv(text) {
	const lines = text.trim().split("\n");
	if (lines.length === 0) return [];

	const headers = lines[0].split(",").map((h) => h.trim());
	const data = [];

	for (let i = 1; i < lines.length; i++) {
		// Handle basic commas, assuming no complex quoted commas in this GTFS string fields
		// Since stops.txt geometry might have commas inside [object Object], we split carefully
		// But for our files, simple split usually suffices except maybe stops.txt.
		// A naive split:
		let row = [];
		let inQuotes = false;
		let currentWord = "";
		const line = lines[i].trim();
		if (!line) continue;

		for (let char of line) {
			if (char === '"') inQuotes = !inQuotes;
			else if (char === "," && !inQuotes) {
				row.push(currentWord.trim());
				currentWord = "";
			} else {
				currentWord += char;
			}
		}
		row.push(currentWord.trim());

		// Map to object
		const obj = {};
		for (let j = 0; j < headers.length; j++) {
			obj[headers[j]] = row[j] || "";
		}
		data.push(obj);
	}
	return data;
}

// --- Data Loading ---

async function loadGtfsData() {
	try {
		const [
			rawStops,
			rawRoutes,
			rawTrips,
			rawFreqs,
			rawCalendars,
			rawStopTimes,
		] = await Promise.all([
			fetchCsv("stops.txt"),
			fetchCsv("routes.txt"),
			fetchCsv("trips.txt"),
			fetchCsv("frequencies.txt"),
			fetchCsv("calendar.txt"),
			fetchCsv("stop_times.txt"),
		]);

		// Stops: Only keep unique parent stations or valid passenger stops to avoid clutter
		stops = rawStops.filter((s) => s.status === "valid" || !s.status);

		// Routes: Map by id
		rawRoutes.forEach((r) => {
			routes[r.route_id] = r;
		});

		// Trips: Map by id
		rawTrips.forEach((t) => {
			trips[t.trip_id] = t;
		});

		// Calendars: Map by service_id
		rawCalendars.forEach((c) => {
			calendars[c.service_id] = c;
		});

		// Frequencies: Sort by start time for easier processing
		frequencies = rawFreqs;

		// Stop Times: Group by stop_id for O(1) lookups: { stop_id: [stop_time_record, ...] }
		// Also build tripFirstStopTimes: trip_id -> departure seconds of the first stop in the trip
		stopTimes = {};
		tripFirstStopTimes = {};
		rawStopTimes.forEach((st) => {
			const sId = st.stop_id;
			if (!stopTimes[sId]) stopTimes[sId] = [];
			stopTimes[sId].push(st);

			// Track first stop (lowest stop_sequence) per trip for GTFS frequency offsets
			const seq = parseInt(st.stop_sequence);
			const deptSecs = timeToSeconds(st.departure_time || st.arrival_time);
			if (
				!(st.trip_id in tripFirstStopTimes) ||
				seq < tripFirstStopTimes[st.trip_id].seq
			) {
				tripFirstStopTimes[st.trip_id] = { seq, secs: deptSecs };
			}
		});
		// Flatten to just seconds
		for (const tid in tripFirstStopTimes) {
			tripFirstStopTimes[tid] = tripFirstStopTimes[tid].secs;
		}
	} catch (err) {
		console.error("Error loading GTFS data:", err);
		mainLoading.textContent = "Error loading data. Please check console.";
	}
}

// --- Search & Pinning ---

function handleSearch(e) {
	const q = e.target.value.toLowerCase().trim();
	searchResults.innerHTML = "";

	if (q.length < 2) {
		searchResults.classList.add("hidden");
		return;
	}

	const matches = stops
		.filter(
			(s) =>
				s.stop_name.toLowerCase().includes(q) ||
				(s.stop_id && s.stop_id.toLowerCase().includes(q)),
		)
		.slice(0, 10); // max 10

	if (matches.length > 0) {
		matches.forEach((s) => {
			const div = document.createElement("div");
			div.className = "dropdown-item";
			div.textContent = `${s.stop_name} (${s.category || "Stop"}) - ${s.stop_id}`;
			div.onclick = () => {
				pinStation(s);
				searchInput.value = "";
				searchResults.classList.add("hidden");
			};
			searchResults.appendChild(div);
		});
		searchResults.classList.remove("hidden");
	} else {
		searchResults.classList.add("hidden");
	}
}

function pinStation(stop) {
	if (!pinnedStations.some((p) => p.stop_id === stop.stop_id)) {
		pinnedStations.push({
			stop_id: stop.stop_id,
			stop_name: stop.stop_name,
		});
		localStorage.setItem("pinnedStations", JSON.stringify(pinnedStations));
		renderPinnedStations();
	}
}

function unpinStation(stopId) {
	pinnedStations = pinnedStations.filter((p) => p.stop_id !== stopId);
	localStorage.setItem("pinnedStations", JSON.stringify(pinnedStations));
	renderPinnedStations();
}

// --- Schedule Calculation ---

// Parse "HH:MM:SS" into seconds since midnight
function timeToSeconds(timeStr) {
	if (!timeStr) return 0;
	const parts = timeStr.split(":");
	return +parts[0] * 3600 + +parts[1] * 60 + +parts[2];
}

// Format seconds since midnight into "HH:MM"
function secondsToFormattedVal(secs) {
	const s = secs % 86400; // handle wrap around past midnight
	const lh = Math.floor(s / 3600)
		.toString()
		.padStart(2, "0");
	const lm = Math.floor((s % 3600) / 60)
		.toString()
		.padStart(2, "0");
	return `${lh}:${lm}`;
}

// Check which services are active today
function getActiveServiceIds(dateObj) {
	const active = [];
	const dayNames = [
		"sunday",
		"monday",
		"tuesday",
		"wednesday",
		"thursday",
		"friday",
		"saturday",
	];
	const currentDayStr = dayNames[dateObj.getDay()];
	const dateNum = parseInt(
		dateObj.getFullYear() +
			String(dateObj.getMonth() + 1).padStart(2, "0") +
			String(dateObj.getDate()).padStart(2, "0"),
	);

	for (let sid in calendars) {
		const c = calendars[sid];
		// Check date range
		if (dateNum >= parseInt(c.start_date) && dateNum <= parseInt(c.end_date)) {
			// Check day of week flag
			if (c[currentDayStr] === "1") {
				active.push(sid);
			}
		}
	}
	// Fallback if no matching calendars (for testing with older config)
	if (active.length === 0) {
		// Attempt to guess based on names
		for (let sid in calendars) {
			if (
				(currentDayStr === "saturday" || currentDayStr === "sunday") &&
				sid.toLowerCase().includes("sun")
			)
				active.push(sid);
			else if (
				currentDayStr !== "saturday" &&
				currentDayStr !== "sunday" &&
				sid.toLowerCase().includes("monfri")
			)
				active.push(sid);
		}
	}
	return active.length > 0 ? active : Object.keys(calendars); // Ultimate fallback
}

function calculateNextTrains(stopId, limit = 2) {
	const now = getCurrentTime();
	// Seconds since midnight local time
	let currentSeconds =
		now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
	const activeServices = getActiveServiceIds(now);

	// We want the upcoming trains for this stop limit per direction.
	// Result format: { "0": [], "1": [] }
	let upcoming = { 0: [], 1: [] };

	const stopTemplates = stopTimes[stopId] || [];
	if (stopTemplates.length === 0) return upcoming;

	// We scan all active generated times
	let generatedDepartures = [];

	// Optimize: only look at frequencies that are active today
	for (let st of stopTemplates) {
		const trip = trips[st.trip_id];
		if (!trip || !activeServices.includes(trip.service_id)) continue;

		const route = routes[trip.route_id];
		const dirId = trip.direction_id || "0";
		const stopSecs = timeToSeconds(st.departure_time || st.arrival_time);

		// Let's find intervals for this trip in frequencies.txt
		const tripFreqs = frequencies.filter((f) => f.trip_id === trip.trip_id);

		for (let f of tripFreqs) {
			const startSecs = timeToSeconds(f.start_time);
			const endSecs = timeToSeconds(f.end_time);
			const headwaySecs = parseInt(f.headway_secs);

			if (!headwaySecs) continue;

			// GTFS-compliant (exact_times=0): departure = start_time + N*headway + stop_offset
			// where stop_offset = this stop's template time - trip's first stop's template time
			const tripFirstSecs = tripFirstStopTimes[trip.trip_id] ?? startSecs;
			const stopOffset = stopSecs - tripFirstSecs;
			const maxRuns = Math.floor((endSecs - startSecs) / headwaySecs);
			for (let i = 0; i <= maxRuns; i++) {
				const trainDeptSecs = startSecs + i * headwaySecs + stopOffset;

				// If it's valid and near the current time
				let diff = trainDeptSecs - currentSeconds;

				// handle next-day wrap (GTFS can exceed 24h logic)
				if (diff < -7200) diff += 86400;
				if (diff > 86400) continue;

				// show trains from -1 min to +2 hours
				if (diff > -60 && diff < 7200) {
					generatedDepartures.push({
						timeSecs: trainDeptSecs,
						route: route,
						trip: trip,
						dir: dirId,
					});
				}
			}
		}
	}

	// Sort all upcoming deps by time
	generatedDepartures.sort((a, b) => a.timeSecs - b.timeSecs);

	// Filter to top limits
	for (let dep of generatedDepartures) {
		if (upcoming[dep.dir].length < limit) {
			let diff = dep.timeSecs - currentSeconds;
			if (diff < -7200) diff += 86400;
			const diffMins = Math.floor(diff / 60);

			upcoming[dep.dir].push({
				absoluteTime: secondsToFormattedVal(dep.timeSecs),
				relativeMins: diffMins,
				headsign:
					dep.trip.trip_headsign ||
					(dep.route ? dep.route.route_long_name : "Unknown"),
				routeShort: dep.route ? dep.route.route_short_name : "RT",
				routeColor:
					dep.route && dep.route.route_color
						? `#${dep.route.route_color}`
						: "var(--route-default)",
				routeTextColor:
					dep.route && dep.route.route_text_color
						? `#${dep.route.route_text_color}`
						: "#fff",
			});
		}
		if (upcoming["0"].length >= limit && upcoming["1"].length >= limit) break;
	}

	return upcoming;
}

// --- UI Rendering ---

function renderPinnedStations() {
	pinnedContainer.innerHTML = "";
	if (pinnedStations.length === 0) {
		pinnedContainer.innerHTML =
			'<div class="no-trains">No stations pinned. Search for a station above to get started.</div>';
		return;
	}

	pinnedStations.forEach((st) => {
		const template = cardTemplate.content.cloneNode(true);
		const card = template.querySelector(".station-card");
		card.dataset.stopId = st.stop_id;

		template.querySelector(".station-name").textContent = st.stop_name;

		template.querySelector(".unpin-btn").onclick = () =>
			unpinStation(st.stop_id);

		const data = calculateNextTrains(st.stop_id, 2);

		// Render direction 0
		const dir0Container = template.querySelector(
			'.platform[data-dir="0"] .trains-list',
		);
		renderTrainRows(dir0Container, data["0"]);

		// Render direction 1
		const dir1Container = template.querySelector(
			'.platform[data-dir="1"] .trains-list',
		);
		renderTrainRows(dir1Container, data["1"]);

		// Update titles based on headsigns if possible
		// updatePlatformTitle(
		// 	template.querySelector('.platform[data-dir="0"]'),
		// 	data["0"],
		// 	"Direction 1",
		// );
		// updatePlatformTitle(
		// 	template.querySelector('.platform[data-dir="1"]'),
		// 	data["1"],
		// 	"Direction 2",
		// );

		pinnedContainer.appendChild(template);
	});
}

// function updatePlatformTitle(platformEl, trainList, fallback) {
// 	const titleEl = platformEl.querySelector(".platform-title");
// 	if (trainList.length > 0 && trainList[0].headsign) {
// 		titleEl.textContent = `${trainList[0].headsign}`;
// 	} else {
// 		titleEl.textContent = fallback;
// 	}
// }

function getServiceContextKey(train) {
	return `${train.routeShort || ""}::${train.headsign || ""}`;
}

function groupTrainsForDisplay(trains) {
	const grouped = [];

	for (let i = 0; i < trains.length; i++) {
		const primary = trains[i];
		const secondary = trains[i + 1];

		if (
			secondary &&
			getServiceContextKey(primary) === getServiceContextKey(secondary)
		) {
			grouped.push({ primary, secondary });
			i++;
		} else {
			grouped.push({ primary, secondary: null });
		}
	}

	return grouped;
}

function getRelativeLabel(relativeMins) {
	if (relativeMins <= 0) {
		return { label: "Arriving", imminent: true };
	}

	if (relativeMins === 1) {
		return { label: "1 min", imminent: true };
	}

	return { label: `${relativeMins} min`, imminent: false };
}

function renderTrainRows(container, trains) {
	container.innerHTML = "";

	if (trains.length === 0) {
		container.innerHTML = '<div class="no-trains">No upcoming trains.</div>';
		return;
	}

	const groupedRows = groupTrainsForDisplay(trains);

	groupedRows.forEach(({ primary, secondary }) => {
		const rowFrag = rowTemplate.content.cloneNode(true);
		const rowEl = rowFrag.querySelector(".train-row");
		const badge = rowFrag.querySelector(".route-badge");
		badge.textContent = primary.routeShort;
		badge.style.backgroundColor = primary.routeColor;
		badge.style.color = primary.routeTextColor;

		rowFrag.querySelector(".train-headsign").textContent = primary.headsign;
		rowFrag.querySelector(".time-absolute").textContent = primary.absoluteTime;

		const rel = rowFrag.querySelector(".time-relative");
		const { label, imminent } = getRelativeLabel(primary.relativeMins);
		rel.textContent = label;
		if (imminent) {
			rel.classList.add("imminent");
		} else {
			rel.classList.remove("imminent");
		}

		const secondaryTime = rowFrag.querySelector(".time-secondary");
		if (secondary) {
			const secondaryEta = getRelativeLabel(secondary.relativeMins);
			secondaryTime.textContent = secondaryEta.label;
			secondaryTime.classList.remove("hidden");
			rowEl.classList.add("has-secondary");
			if (secondaryEta.imminent) {
				secondaryTime.classList.add("imminent");
			} else {
				secondaryTime.classList.remove("imminent");
			}
		} else {
			secondaryTime.classList.add("hidden");
			secondaryTime.classList.remove("imminent");
			rowEl.classList.remove("has-secondary");
		}

		container.appendChild(rowFrag);
	});
}

// Start
init();
