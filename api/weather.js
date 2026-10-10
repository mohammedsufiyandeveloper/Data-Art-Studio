/**
 * Current weather for the bands on the clock. Proxies WeatherAPI.com (the
 * same API and WEATHERAPI_KEY as Data Art Studio's api/wind.js) so the key
 * never reaches the browser.
 *
 * Runs as a Vercel serverless function in production and as Vite dev/preview
 * middleware locally (see vite.config.js), so it only uses plain Node
 * req/res calls.
 *
 * GET /api/weather?ids=newyork,london,tokyo  →  [{ id, tempC, windKph, condition, tzId }]
 * Ids must come from locations.js; the client never sends a raw query, so
 * this route can't be used for arbitrary lookups against our key.
 */
import { LOCATIONS_BY_ID, MAX_PLACES } from "../world-clock/locations.js";

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function current(key, place) {
  const url = new URL("https://api.weatherapi.com/v1/current.json");
  url.searchParams.set("key", key);
  // City plus country, so e.g. "Lima" can't resolve to Lima, Ohio.
  url.searchParams.set("q", place.query ?? `${place.city}, ${place.country}`);
  const apiRes = await fetch(url);
  if (!apiRes.ok) throw new Error(`WeatherAPI → HTTP ${apiRes.status} for ${place.id}`);
  const data = await apiRes.json();
  return {
    id: place.id,
    tempC: data.current.temp_c,
    windKph: data.current.wind_kph,
    condition: data.current.condition?.text ?? null,
    tzId: data.location.tz_id,
  };
}

export default async function weather(req, res) {
  const key = process.env.WEATHERAPI_KEY;
  if (!key) {
    send(res, 500, { error: "WEATHERAPI_KEY not configured" });
    return;
  }

  const ids = (new URL(req.url, "http://localhost").searchParams.get("ids") || "").split(",").filter(Boolean);
  if (ids.length === 0 || ids.length > MAX_PLACES) {
    send(res, 400, { error: `ids must list 1–${MAX_PLACES} places` });
    return;
  }
  const unknown = ids.find((id) => !LOCATIONS_BY_ID.has(id));
  if (unknown) {
    send(res, 400, { error: `unknown location: ${unknown}` });
    return;
  }

  try {
    send(res, 200, await Promise.all(ids.map((id) => current(key, LOCATIONS_BY_ID.get(id)))));
  } catch (err) {
    // The request URL carries the key, so only the message is passed on.
    send(res, 502, { error: String(err.message || err) });
  }
}
