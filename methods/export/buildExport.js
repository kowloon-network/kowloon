// methods/export/buildExport.js
// "Download my data": builds a zip of everything one person made on this
// server and stores it in the bucket under _exports/. Run by the backup
// worker (workers/backup.js) from an ExportJob, never inside a request --
// someone with years of photos can have gigabytes of media.
//
// What goes in:
//   README.txt         what each file is
//   posts.html         the posts as a readable page (opens in any browser)
//   profile.json       the account and profile (no password hash or keys)
//   posts.json, replies.json, pages.json, bookmarks.json, circles.json,
//   groups.json (groups they created), reactions.json, reports.json
//   media/             every file they uploaded, plus media.json
//
// Deleted things are left out: deletion here means gone.
//
// The zip is streamed straight into storage: media is read from the bucket
// one file at a time (addReadStreamLazy), so memory use stays flat however
// big the export is. Media is stored uncompressed -- it's already compressed.

import yazl from 'yazl'
import { PassThrough } from 'stream'
import { Upload } from '@aws-sdk/lib-storage'
import {
  User, Post, Reply, Page, Bookmark, Circle, Group, React as ReactModel, Flag, File,
} from '#schema'
import { getStorageAdapter } from '#methods/files/index.js'
import { getSetting } from '#methods/settings/cache.js'
import logger from '#methods/utils/logger.js'

const USER_SECRETS = [
  'password', 'privateKey', 'passwordResetToken', 'passwordResetExpires',
  'emailVerificationToken', 'emailVerificationExpires', 'tokensValidAfter',
]

// Database bookkeeping that means nothing outside this server.
function clean(doc) {
  if (!doc || typeof doc !== 'object') return doc
  const { _id, __v, signature, ...rest } = doc
  return rest
}

const json = (v) => Buffer.from(JSON.stringify(v, null, 2) + '\n', 'utf8')

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// A filename that is safe on every OS and unique within media/.
function mediaName(file, used) {
  const ext = (file.extension || (file.originalFileName || '').split('.').pop() || 'bin')
    .replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8) || 'bin'
  let base = (file.originalFileName || file.name || 'file').replace(/\.[^.]+$/, '')
  base = base.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'file'
  let name = `${base}.${ext}`
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}-${n}.${ext}`
  used.add(name.toLowerCase())
  return name
}

function readme({ siteName, domain, user, counts, missing }) {
  const lines = [
    `Your data from ${siteName} (${domain})`,
    `Account: ${user.id}`,
    `Made: ${new Date().toUTCString()}`,
    '',
    'posts.html      Your posts as a page you can open in any web browser.',
    'profile.json    Your account and profile.',
    `posts.json      Your posts (${counts.posts}).`,
    `replies.json    Your replies (${counts.replies}).`,
    `pages.json      Pages you wrote (${counts.pages}).`,
    `bookmarks.json  Your bookmarks and bookmark folders (${counts.bookmarks}).`,
    `circles.json    Your circles and who is in them (${counts.circles}), including`,
    '                Following, Blocked, Muted and the groups you belong to.',
    `groups.json     Groups you created (${counts.groups}).`,
    `reactions.json  Your reactions to posts and replies (${counts.reactions}).`,
    `reports.json    Reports you sent to moderators (${counts.reports}).`,
    `media/          Files you uploaded (${counts.media}). media.json says which`,
    '                post each one belongs to.',
    '',
    'The .json files are plain text in JSON format, readable by other software.',
    'Things you deleted are not included.',
  ]
  if (missing.length) {
    lines.push('', `${missing.length} uploaded file(s) could not be found in storage and are missing:`)
    for (const m of missing) lines.push(`  ${m}`)
  }
  return Buffer.from(lines.join('\n') + '\n', 'utf8')
}

function postsHtml({ siteName, user, posts, mediaPathById }) {
  const name = user.profile?.name || user.username
  const items = posts.map((p) => {
    const when = p.createdAt ? new Date(p.createdAt).toUTCString() : ''
    const media = (p.attachments || [])
      .map((a) => {
        const path = mediaPathById.get(a.fileId || a.id)
        if (!path) return ''
        const alt = esc(a.alt || a.summary || a.name || '')
        return /^image\//.test(a.mediaType || '')
          ? `<img src="${esc(path)}" alt="${alt}">`
          : `<p><a href="${esc(path)}">${esc(path)}</a></p>`
      })
      .join('')
    const link = p.href ? `<p><a href="${esc(p.href)}">${esc(p.href)}</a></p>` : ''
    return `<article>
<p class="meta">${esc(p.type)} &middot; ${esc(when)}${p.url ? ` &middot; <a href="${esc(p.url)}">original</a>` : ''}</p>
${p.title ? `<h2>${esc(p.title)}</h2>` : ''}
${link}${p.body || ''}${media}
</article>`
  })
  return Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)}: posts from ${esc(siteName)}</title>
<style>
body{font:17px/1.6 Georgia,serif;max-width:40em;margin:2em auto;padding:0 1em;color:#222;background:#fdfdfb}
h1{font-weight:normal}article{border-top:1px solid #ddd;padding:1em 0}
.meta{font:13px/1.4 system-ui,sans-serif;color:#777;margin:0}
img{max-width:100%;height:auto;display:block;margin:.5em 0}a{color:#2a4d8f}
</style></head><body>
<h1>${esc(name)}</h1>
<p class="meta">${esc(user.id)} &middot; ${posts.length} posts, newest first</p>
${items.join('\n')}
</body></html>
`, 'utf8')
}

/**
 * Build the export for one account and upload it.
 * @returns {Promise<{archiveKey, archiveName, sizeBytes}>}
 */
export async function buildExport(job, updateProgress = async () => {}) {
  const actorId = job.actorId
  const user = await User.findOne({ id: actorId }).lean()
  if (!user) throw new Error('Account not found')

  const storage = await getStorageAdapter()
  if (!storage?.client || !storage?.bucket) throw new Error('Storage is not configured')

  const domain = getSetting('domain') || actorId.split('@').pop()
  const siteName = getSetting('profile')?.name || 'Kowloon'
  const live = { deletedAt: null }

  await updateProgress('Collecting your posts')
  const [posts, replies, pages, bookmarks, circles, groups, reactions, reports, files] = await Promise.all([
    Post.find({ actorId, ...live }).sort({ createdAt: -1 }).lean(),
    Reply.find({ actorId, ...live }).sort({ createdAt: -1 }).lean(),
    Page.find({ actorId, ...live }).sort({ createdAt: -1 }).lean(),
    Bookmark.find({ ownerId: actorId, ...live }).sort({ createdAt: -1 }).lean(),
    Circle.find({ actorId, ...live }).lean(),
    Group.find({ actorId, ...live }).lean(),
    ReactModel.find({ actorId, deletedAt: { $in: [null, undefined] } }).sort({ createdAt: -1 }).lean(),
    Flag.find({ actorId }).sort({ createdAt: -1 }).lean(),
    File.find({ actorId, ...live, storageKey: { $exists: true, $ne: null } }).lean(),
  ])

  // Check each upload is really in storage before promising it in the zip:
  // one missing object would otherwise fail the whole export.
  await updateProgress('Checking your files')
  const present = []
  const missing = []
  for (const f of files) {
    try {
      if (await storage.exists(f.storageKey)) present.push(f)
      else missing.push(f.originalFileName || f.id)
    } catch {
      missing.push(f.originalFileName || f.id)
    }
  }

  const used = new Set()
  const mediaPathById = new Map()
  const mediaIndex = present.map((f) => {
    const path = `media/${mediaName(f, used)}`
    mediaPathById.set(f.id, path)
    return {
      path,
      id: f.id,
      originalFileName: f.originalFileName,
      mediaType: f.mediaType,
      description: f.summary || undefined,
      belongsTo: f.parentObject || undefined,
      uploadedAt: f.createdAt,
    }
  })

  const profile = clean(user)
  for (const k of USER_SECRETS) delete profile[k]

  const counts = {
    posts: posts.length, replies: replies.length, pages: pages.length,
    bookmarks: bookmarks.length, circles: circles.length, groups: groups.length,
    reactions: reactions.length, reports: reports.length, media: present.length,
  }

  const zip = new yazl.ZipFile()
  const opts = { mtime: new Date() }
  zip.addBuffer(readme({ siteName, domain, user, counts, missing }), 'README.txt', opts)
  zip.addBuffer(postsHtml({ siteName, user, posts, mediaPathById }), 'posts.html', opts)
  zip.addBuffer(json(profile), 'profile.json', opts)
  zip.addBuffer(json(posts.map(clean)), 'posts.json', opts)
  zip.addBuffer(json(replies.map(clean)), 'replies.json', opts)
  zip.addBuffer(json(pages.map(clean)), 'pages.json', opts)
  zip.addBuffer(json(bookmarks.map(clean)), 'bookmarks.json', opts)
  zip.addBuffer(json(circles.map(clean)), 'circles.json', opts)
  zip.addBuffer(json(groups.map(clean)), 'groups.json', opts)
  zip.addBuffer(json(reactions.map(({ actor, ...r }) => clean(r))), 'reactions.json', opts)
  zip.addBuffer(json(reports.map(clean)), 'reports.json', opts)
  zip.addBuffer(json(mediaIndex), 'media/media.json', opts)

  let done = 0
  present.forEach((f, i) => {
    zip.addReadStreamLazy(
      mediaIndex[i].path,
      { compress: false, mtime: f.createdAt ? new Date(f.createdAt) : new Date() },
      (cb) => {
        storage.getStream(f.storageKey).then(
          (stream) => {
            stream.on('end', () => {
              done++
              if (done % 10 === 0) updateProgress(`Adding your files (${done} of ${present.length})`).catch(() => {})
            })
            cb(null, stream)
          },
          (err) => cb(err)
        )
      }
    )
  })
  zip.end()

  const safeUser = String(user.username || 'account').replace(/[^\w-]/g, '')
  const stamp = new Date().toISOString().slice(0, 10)
  const archiveName = `${domain}-${safeUser}-${stamp}.zip`
  const archiveKey = `_exports/${job._id}/${archiveName}`

  await updateProgress(present.length ? `Adding your files (0 of ${present.length})` : 'Packing')

  // Count the bytes as they pass on their way to storage.
  let sizeBytes = 0
  const counter = new PassThrough()
  counter.on('data', (chunk) => { sizeBytes += chunk.length })
  zip.outputStream.on('error', (err) => counter.destroy(err))
  zip.outputStream.pipe(counter)

  await new Upload({
    client: storage.client,
    params: {
      Bucket: storage.bucket,
      Key: archiveKey,
      Body: counter,
      ContentType: 'application/zip',
    },
  }).done()

  logger.info('[export] Built data export', { actorId, archiveKey, sizeBytes, ...counts, missing: missing.length })
  return { archiveKey, archiveName, sizeBytes }
}

export default buildExport
