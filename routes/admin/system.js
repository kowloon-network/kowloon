// routes/admin/system.js — Server system info
import express from "express";
import os from "os";
import { statfs, open as fsOpen, stat as fsStat } from "fs/promises";
import mongoose from "mongoose";
import route from "../utils/route.js";
import { Activity, Circle, File, Flag, Group, Invite, Page, Post, Reply, React, User } from "#schema";
import getSettings from "#methods/settings/get.js";
import { LOG_FILE } from "#methods/utils/logger.js";

const router = express.Router({ mergeParams: true });

router.get(
  "/",
  route(
    async ({ set }) => {
      const db = mongoose.connection.db;

      // DB stats
      const dbStats = await db.stats({ scale: 1024 }); // values in KB

      // Collection counts (in parallel)
      const [
        userCount, postCount, groupCount, circleCount,
        pageCount, replyCount, reactCount, activityCount,
        flagCount, inviteCount,
      ] = await Promise.all([
        User.countDocuments({ deletedAt: null }),
        Post.countDocuments({ deletedAt: null }),
        Group.countDocuments({ deletedAt: null }),
        Circle.countDocuments({}),
        Page.countDocuments({ deletedAt: null }),
        Reply.countDocuments({}),
        React.countDocuments({}),
        Activity.countDocuments({}),
        Flag.countDocuments({ status: "open" }),
        Invite.countDocuments({ active: true, deletedAt: null }),
      ]);

      // Calendar-boundary "since" cutoffs (UTC) for the at-a-glance activity
      // row -- "this week" starts Monday, not a rolling 7 days.
      const now = new Date();
      const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const startOfWeek = new Date(startOfDay);
      startOfWeek.setUTCDate(startOfDay.getUTCDate() - ((startOfDay.getUTCDay() + 6) % 7));
      const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));

      const [postsToday, newUsersWeek, newUsersMonth, newUsersYear, inviteUsageAgg, fileAgg] =
        await Promise.all([
          Post.countDocuments({ deletedAt: null, createdAt: { $gte: startOfDay } }),
          User.countDocuments({ deletedAt: null, createdAt: { $gte: startOfWeek } }),
          User.countDocuments({ deletedAt: null, createdAt: { $gte: startOfMonth } }),
          User.countDocuments({ deletedAt: null, createdAt: { $gte: startOfYear } }),
          Invite.aggregate([{ $group: { _id: null, used: { $sum: "$redemptionCount" } } }]),
          File.aggregate([
            { $match: { deletedAt: null } },
            { $group: { _id: "$type", count: { $sum: 1 }, sizeBytes: { $sum: "$size" } } },
          ]),
        ]);

      const mediaByType = Object.fromEntries(
        fileAgg.map((g) => [g._id || "Other", { count: g.count, sizeBytes: g.sizeBytes || 0 }])
      );

      // Disk stats for the process working directory
      let disk = null;
      try {
        const fs = await statfs(process.cwd());
        const total = fs.bsize * fs.blocks;
        const free = fs.bsize * fs.bfree;
        disk = {
          totalKb: Math.round(total / 1024),
          freeKb: Math.round(free / 1024),
          usedKb: Math.round((total - free) / 1024),
          usedPct: Math.round(((total - free) / total) * 100),
        };
      } catch {
        // statfs not available on all platforms
      }

      set("database", {
        name: dbStats.db,
        dataKb: Math.round(dbStats.dataSize),
        storageKb: Math.round(dbStats.storageSize),
        indexKb: Math.round(dbStats.indexSize),
        totalKb: Math.round(dbStats.dataSize + dbStats.indexSize),
        collections: dbStats.collections,
        objects: dbStats.objects,
      });

      set("counts", {
        users: userCount,
        posts: postCount,
        groups: groupCount,
        circles: circleCount,
        pages: pageCount,
        replies: replyCount,
        reacts: reactCount,
        activities: activityCount,
        openFlags: flagCount,
        activeInvites: inviteCount,
      });

      set("activity", {
        postsToday,
        newUsersWeek,
        newUsersMonth,
        newUsersYear,
        invitesUsed: inviteUsageAgg[0]?.used ?? 0,
      });

      set("media", {
        totalFiles: Object.values(mediaByType).reduce((sum, g) => sum + g.count, 0),
        totalSizeKb: Math.round(
          Object.values(mediaByType).reduce((sum, g) => sum + g.sizeBytes, 0) / 1024
        ),
        photos: mediaByType.Image?.count ?? 0,
        videos: mediaByType.Video?.count ?? 0,
        audio: mediaByType.Audio?.count ?? 0,
        documents: mediaByType.Document?.count ?? 0,
      });

      set("server", {
        nodeVersion: process.version,
        platform: os.platform(),
        arch: os.arch(),
        uptimeSeconds: Math.round(process.uptime()),
        memoryMb: {
          total: Math.round(os.totalmem() / 1024 / 1024),
          free: Math.round(os.freemem() / 1024 / 1024),
          processRss: Math.round(process.memoryUsage().rss / 1024 / 1024),
          processHeap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        },
      });

      if (disk) set("disk", disk);
    },
    { allowUnauth: false }
  )
);

// ── Admin / Mod circle member management ──────────────────────────────────
// These circles are owned by the server actor, not a user, so we manage them
// directly rather than going through the ActivityPub Add/Remove pipeline.

async function getRoleCircle(role) {
  const settings = await getSettings();
  const id = role === "admin" ? settings.adminCircle : settings.modCircle;
  if (!id) return null;
  return Circle.findOne({ id });
}

function toMemberDoc(user, domain) {
  return {
    id: user.id,
    name: user.profile?.name ?? user.username,
    icon: user.profile?.icon ?? null,
    inbox: user.inbox ?? null,
    outbox: user.outbox ?? null,
    url: user.url ?? null,
    server: user.server ?? domain,
  };
}

for (const role of ["admins", "mods"]) {
  const circleRole = role === "admins" ? "admin" : "mod";

  router.get(`/${role}`, async (req, res, next) => {
    try {
      const circle = await getRoleCircle(circleRole);
      if (!circle) return res.status(500).json({ error: `${role} circle not configured` });
      res.json({ members: circle.members ?? [] });
    } catch (err) { next(err); }
  });

  router.post(`/${role}`, async (req, res, next) => {
    try {
      const { userId } = req.body;
      if (!userId) return res.status(400).json({ error: "userId required" });

      const circle = await getRoleCircle(circleRole);
      if (!circle) return res.status(500).json({ error: `${role} circle not configured` });

      if (circle.members.some((m) => m.id === userId)) {
        return res.json({ ok: true, alreadyMember: true });
      }

      const user = await User.findOne({ id: userId, active: true, deletedAt: null }).lean();
      if (!user) return res.status(404).json({ error: "User not found" });

      const settings = await getSettings();
      circle.members.push(toMemberDoc(user, settings.domain));
      circle.memberCount = circle.members.length;
      await circle.save();

      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  router.delete(`/${role}/:userId`, async (req, res, next) => {
    try {
      const userId = decodeURIComponent(req.params.userId);
      const circle = await getRoleCircle(circleRole);
      if (!circle) return res.status(500).json({ error: `${role} circle not configured` });

      circle.members = circle.members.filter((m) => m.id !== userId);
      circle.memberCount = circle.members.length;
      await circle.save();

      res.json({ ok: true });
    } catch (err) { next(err); }
  });
}

// ── GET /system/logs — tail the app log file ──────────────────────────────

router.get("/logs", async (req, res) => {
  const tail = Math.min(parseInt(req.query.tail || "200", 10), 2000)
  const level = req.query.level || "all"

  try {
    await fsStat(LOG_FILE)
  } catch {
    return res.json({ lines: [], warning: "Log file not found yet — the server may have just started." })
  }

  try {
    // Read the last `tail` lines efficiently: seek to end, read a chunk,
    // split on newlines. For alpha (small servers) this is plenty.
    const CHUNK = Math.min(tail * 200, 512 * 1024) // ~200 chars/line estimate
    const st  = await fsStat(LOG_FILE)
    const fd  = await fsOpen(LOG_FILE, "r")
    const buf = Buffer.alloc(Math.min(CHUNK, st.size))
    const offset = Math.max(0, st.size - buf.length)
    await fd.read(buf, 0, buf.length, offset)
    await fd.close()

    const raw = buf.toString("utf8")
    const allLines = raw.split("\n").filter(Boolean)

    // If we read from a non-zero offset the first line is probably partial — drop it
    const lines = offset > 0 ? allLines.slice(1) : allLines

    const filtered = level === "all"
      ? lines
      : lines.filter((l) => l.toUpperCase().includes(` ${level.toUpperCase()}:`))

    const result = filtered.slice(-tail)

    return res.json({ lines: result, total: result.length, logFile: LOG_FILE })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// Synchronous full-DB JSON export (GET /admin/system/backup) removed in favor
// of the async job queue at /admin/backup (routes/admin/backup.js) — that one
// also archives S3-stored files, not just Mongo documents, and doesn't block
// the event loop loading the entire database into memory.

export default router;
