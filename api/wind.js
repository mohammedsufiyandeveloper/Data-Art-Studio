/**
 * Current weather for the Weather outputs (the studio's full-screen Weather
 * page and Flight Garden's Weather scene). Proxies WeatherAPI.com so
 * WEATHERAPI_KEY never reaches the browser.
 *
 * Runs as a Vercel serverless function in production and as Vite dev/preview
 * middleware locally (see vite.config.js), so it only uses plain Node
 * req/res calls. WEATHERAPI_KEY comes from Vercel's project settings when
 * deployed, .env locally.
 *
 * GET /api/wind?location=<id>  →  { kph, tempC, condition }
 */

// Every place the location pickers may ask for. An allowlist, not a
// passthrough: the client sends an id, never a raw query, so this route
// can't be used for arbitrary lookups against our key. The ids match
// WEATHER_LOCATIONS in velocitymapping.html and flight-garden/main.js.
const LOCATIONS = {
  bengaluru: "Bengaluru",
  reykjavik: "Reykjavik",
  oslo: "Oslo",
  london: "London",
  newyork: "New York",
  tokyo: "Tokyo",
  dubai: "Dubai",
  cairo: "Cairo",
  sydney: "Sydney",
  riodejaneiro: "Rio de Janeiro",
};
const DEFAULT_LOCATION_ID = "bengaluru";

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function wind(req, res) {
  const key = process.env.WEATHERAPI_KEY;
  if (!key) {
    send(res, 500, { error: "WEATHERAPI_KEY not configured" });
    return;
  }

  const locationId = new URL(req.url, "http://localhost").searchParams.get("location") || DEFAULT_LOCATION_ID;
  if (!Object.hasOwn(LOCATIONS, locationId)) {
    send(res, 400, { error: `unknown location: ${locationId}` });
    return;
  }

  try {
    const url = new URL("https://api.weatherapi.com/v1/current.json");
    url.searchParams.set("key", key);
    url.searchParams.set("q", LOCATIONS[locationId]);
    const apiRes = await fetch(url);
    if (!apiRes.ok) throw new Error(`WeatherAPI → HTTP ${apiRes.status}`);
    const data = await apiRes.json();
    send(res, 200, {
      kph: data.current.wind_kph,
      tempC: data.current.temp_c,
      condition: data.current.condition?.text ?? null,
    });
  } catch (err) {
    // The request URL carries the key, so only the message is passed on.
    send(res, 502, { error: String(err.message || err) });
  }
}
