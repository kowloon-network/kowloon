# Kowloon server

Kowloon is a small, open-source social network made of independent communities. Each community runs its own server, and Kowloon servers federate with each other, so members of one can read and talk with people on another. Instead of followers, people organise who they read into Circles, and every post says exactly who can see it.

This repository is the server: a Node.js / Express API backed by MongoDB, with uploaded files in S3-compatible storage (MinIO in a normal install). The production Docker image also bundles the [web frontend](https://github.com/kowloon-network/kowloon-frontend).

**Documentation: <https://kowloon.network/docs/>**

## Running a server

You don't need this repository to run Kowloon. A one-line installer sets up everything with Docker:

```bash
curl -fsSL https://raw.githubusercontent.com/kowloon-network/kowloon/main/install.sh | bash
```

Read [Installing Kowloon](https://kowloon.network/docs/admin/install/) first: it covers what you need, the setup wizard, and what to do afterwards. See also [Upgrading](https://kowloon.network/docs/admin/upgrading/), [Recovering from a lost server](https://kowloon.network/docs/admin/restore/), and [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

## Developing

You need Node.js 22, MongoDB 7, and an S3-compatible bucket.

The `docker-compose.yml` here is a three-server federation testbed (its header explains it), but you can start just its database and storage for single-server work:

```bash
docker compose up -d mongodb minio
```

That gives you MongoDB on `localhost:27018` and MinIO on `localhost:9000`, with its console on `localhost:9001` (user and password `minioadmin`). Create a bucket called `kowloon` in the console.

Then:

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- add `MONGO_URI=mongodb://localhost:27018/kowloon` (`.env.example` doesn't include it, and the server won't start without it);
- set `NODE_ENV=development`, so the server accepts requests from the web frontend's dev server on `localhost:5173`;
- leave `DOMAIN=localhost` and the MinIO settings as they are;
- set `ADMIN_USERNAME` and `ADMIN_PASSWORD` if you want an admin account created on first start.

```bash
npm start
```

The server listens on port 3000 (`PORT` changes it). It sends outgoing federation in-process; the other background jobs run as separate processes when you need them:

```bash
node workers/federationPull.js   # fetch posts from other servers
node workers/mediaProcessor.js   # process uploaded media
node workers/backup.js           # backups and data exports
```

For the web interface, run the [frontend](https://github.com/kowloon-network/kowloon-frontend) alongside, with `VITE_SERVER_URL=http://localhost:3000`.

## Tests

The tests need a MongoDB to talk to:

```bash
DOMAIN=kwln.org MONGO_URI=mongodb://localhost:27018/kowloon npm test
```

Each test file creates and wipes its own `kowloon_test_*` database on that MongoDB, so **never point the tests at a server with real data**. `npm run test:unit` runs only the unit tests; `npm run test:int` only the integration tests. The same suite runs in CI before any image is published.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before you start, and follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, see [SECURITY.md](SECURITY.md) -- please don't open a public issue.

## Licence

Kowloon is licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE).
