// routes/auth/export.js
// "Download my data".
//   POST /auth/export            ask for a new copy (built by the backup worker)
//   GET  /auth/export            status of the latest one, with a short-lived
//                                download link once it's ready
//   GET  /auth/export/download   the zip itself, via that signed link
//
// The download is a signed link rather than an authenticated fetch so a
// browser or phone can save a large zip straight to disk.

import express from "express";
import route from "../utils/route.js";
import { ExportJob } from "#schema";
import { getStorageAdapter } from "#methods/files/index.js";
import {
  describe,
  latestExport,
  requestExport,
  verifyDownload,
} from "#methods/export/jobs.js";
import logger from "#methods/utils/logger.js";

const refuseVisiting = (user, setStatus, set) => {
  // A visiting session is a foreign server acting for this person; it never
  // gets a copy of their whole account.
  if (user?.scope === "visiting") {
    setStatus(403);
    set("error", "A visiting session can't download this account's data");
    return true;
  }
  return false;
};

const status = route(
  async ({ user, set, setStatus }) => {
    if (refuseVisiting(user, setStatus, set)) return;
    const job = await latestExport(user.id);
    set("export", describe(job));
  },
  { allowUnauth: false }
);

const request = route(
  async ({ user, set, setStatus }) => {
    if (refuseVisiting(user, setStatus, set)) return;
    const { job, error, status: code } = await requestExport(user.id);
    if (error) {
      setStatus(code || 400);
      set("error", error);
      return;
    }
    setStatus(202);
    set("export", describe(job));
  },
  { allowUnauth: false }
);

async function download(req, res) {
  const { job: jobId, exp, sig } = req.query;
  if (!verifyDownload(jobId, exp, sig)) {
    return res.status(403).type("text/plain").send("This download link has expired. Open your settings page to get a new one.");
  }
  try {
    const job = await ExportJob.findById(jobId).lean();
    if (!job || job.status !== "done" || !job.archiveKey) {
      return res.status(404).type("text/plain").send("This download is no longer available.");
    }
    const stream = await getStorageAdapter().getStream(job.archiveKey);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${String(job.archiveName || "kowloon-data.zip").replace(/["\\\r\n]/g, "")}"`);
    if (job.sizeBytes) res.setHeader("Content-Length", String(job.sizeBytes));
    res.setHeader("Cache-Control", "private, no-store");
    stream.on("error", (err) => {
      logger.warn("[export] Download stream failed", { error: err.message });
      res.destroy(err);
    });
    stream.pipe(res);
  } catch (err) {
    logger.error("[export] Download failed", { error: err.message });
    if (!res.headersSent) res.status(500).type("text/plain").send("Couldn't send the file. Try again.");
  }
}

const router = express.Router({ mergeParams: true });
router.get("/export/download", download);
router.get("/export", status);
router.post("/export", request);
export default router;
