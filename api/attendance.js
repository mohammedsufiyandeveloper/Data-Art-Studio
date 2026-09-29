/**
 * Today's attendance headcounts for the studio's Attendance output. Proxies
 * the Tusker management backend's attendance summary
 * (GET /api/integrations/attendance/summary) so its API key never reaches
 * the browser.
 *
 * Runs as a Vercel serverless function in production and as Vite dev/preview
 * middleware locally (see vite.config.js), so it only uses plain Node
 * req/res calls.
 *
 * TUSKER_ATTENDANCE_API_URL (the full summary endpoint URL),
 * TUSKER_ATTENDANCE_API_KEY and TUSKER_ATTENDANCE_WORKSPACE_ID come from the
 * environment: Vercel's project settings when deployed, .env locally.
 */
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function attendance(req, res) {
  const base = process.env.TUSKER_ATTENDANCE_API_URL;
  const workspaceId = process.env.TUSKER_ATTENDANCE_WORKSPACE_ID;
  const key = process.env.TUSKER_ATTENDANCE_API_KEY;
  if (!base || !workspaceId || !key) {
    send(res, 500, {
      error: "TUSKER_ATTENDANCE_API_URL / _API_KEY / _WORKSPACE_ID not configured"
    });
    return;
  }

  try {
    const url = new URL(base);
    url.searchParams.set("workspaceId", workspaceId);
    const apiRes = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const body = await apiRes.json().catch(() => ({}));
    if (!apiRes.ok || !body.success) {
      throw new Error(body.error || `Tusker → HTTP ${apiRes.status}`);
    }

    // Every member is counted in exactly one status, so `present` means on
    // time and excludes `late`. Absent is everyone with no check-in who
    // isn't on leave.
    const { date, totalMembers, present, late, absent, halfDay, onLeave } = body.data;
    send(res, 200, { date, total: totalMembers, present, late, absent, halfDay, onLeave });
  } catch (err) {
    send(res, 502, { error: String(err.message || err) });
  }
}
