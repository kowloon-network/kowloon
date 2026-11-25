# Changelog

What changed in each Kowloon release, written for the people who run
servers. Versions follow `MAJOR.MINOR.PATCH`: until 1.0, a new MINOR can need
an action from you, and when it does it's listed here under **Before you
upgrade**.

How to upgrade: https://kowloon.network/docs/admin/upgrading/

## 0.9.0 -- unreleased

The first versioned release. Servers installed before this tracked `latest`;
see **Before you upgrade**.

### Before you upgrade

- Older installs run `ghcr.io/kowloon-network/kowloon:latest` (or the old
  `ghcr.io/jzellis/kowloon:latest`, which no longer updates). Change every
  `image:` line for the app and workers in your `docker-compose.yml` to
  `ghcr.io/kowloon-network/kowloon:0.9.0`, then `docker compose pull` and
  `docker compose up -d`.
- Add a file limit to the `mongo` service, or Mongo can crash with "Too many
  open files" as your server grows:

  ```yaml
  ulimits:
    nofile:
      soft: 64000
      hard: 64000
  ```

### New for server admins

- New servers create their Terms of Service, Privacy Policy and Community
  Rules pages on first start, filled in with the server's name and contact
  address. Edited or deleted pages are never recreated.
- `/health` now checks file storage and each background worker, not just the
  database. It reports `degraded` when a worker has stopped and returns 503
  when the database or storage is unreachable.
- The installer pins your server to the release you installed. Set
  `KOWLOON_VERSION` to install a specific version.
- Kowloon now runs on 64-bit ARM as well as Intel/AMD, so a Raspberry
  Pi 5 can host a server.
- An app Settings screen for server admins, with the email confirmation
  switch (in the next app build).

### For members

- Content warnings: 13 categories plus a free-text note, with each reader
  choosing show, warn or hide per category. Moderators can add warnings.
- Download your data: a zip of your posts, files and settings.
- Sign out everywhere else.
- Report people, replies and groups, not just posts.
- Change your email address (with your password).
- Location data is stripped from iPhone photos and from audio and video.
- Groups work within their own server for now: people can join groups on
  their own server only, and group posts stay there. Joining groups on
  other servers will come back once it works properly.
- Photos keep their shape in the feed, cropped around the important part.

### Fixes

- Privacy: adding someone from another server to one of your circles sent
  a message to their server. It no longer does; circles never leave your
  server.
- "Send the link again" for email confirmation works even when the server
  doesn't require confirmation.
- The setup wizard installed an image name we no longer publish.
- Security fixes in third-party packages (follow-redirects, Sentry,
  nodemailer in the setup wizard).
