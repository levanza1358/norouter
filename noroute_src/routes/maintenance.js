// Admin endpoints for the background maintenance scheduler: read status,
// change the interval, or run the due tasks immediately. A manual run works
// even when the scheduler is stopped, which is how the dashboard verifies the
// upstream credentials without waiting for the next tick.
import { readJson, sendError, sendJson } from '../lib/http.js';
import {
  maintenanceSnapshot,
  runMaintenance,
  updateMaintenanceSettings,
  validateMaintenancePatch,
} from '../lib/maintenance.js';

const TASK_IDS = ['tokens', 'quota', 'catalog', 'proxy'];

export function handleGetMaintenance(req, res) {
  return sendJson(res, 200, maintenanceSnapshot());
}

export async function handleUpdateMaintenance(req, res) {
  let body;
  try {
    body = await readJson(req, 16 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
  const error = validateMaintenancePatch(body);
  if (error) return sendError(res, 400, error);
  updateMaintenanceSettings(body);
  return sendJson(res, 200, maintenanceSnapshot());
}

export async function handleRunMaintenance(req, res) {
  let body;
  try {
    body = await readJson(req, 16 * 1024);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }
  const ids = Array.isArray(body?.tasks) ? body.tasks.map((id) => String(id)) : null;
  if (ids && ids.some((id) => !TASK_IDS.includes(id))) return sendError(res, 400, 'Unknown maintenance task.');
  const result = await runMaintenance(ids);
  return sendJson(res, 200, result);
}
