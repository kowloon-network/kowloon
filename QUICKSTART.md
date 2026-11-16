# Kowloon Multi-Instance Quick Start

Get multiple Kowloon instances running in 3 commands!

## 1. Start Infrastructure (One Time)

```bash
./setup-infra.sh
```

This starts MongoDB, MinIO, and Traefik.

## 2. Create an Instance

```bash
./kowloon-instance.sh create kwln.org
```

Enter:
- Site title
- Admin email
- Admin password (or leave empty to auto-generate)

## 3. Add to /etc/hosts (Local Dev)

```bash
echo '127.0.0.1 kwln.org' | sudo tee -a /etc/hosts
```

## 4. Start & Access

```bash
./kowloon-instance.sh start kwln.org
```

Open http://kwln.org in your browser!

## Common Commands

```bash
# List instances
./kowloon-instance.sh list

# View logs
./kowloon-instance.sh logs kwln.org

# Stop instance
./kowloon-instance.sh stop kwln.org

# Create another instance
./kowloon-instance.sh create kwln.social
```

## Using Make (Alternative)

```bash
make create DOMAIN=kwln.org
make start DOMAIN=kwln.org
make list
make logs DOMAIN=kwln.org
```

## What You Get

- ✅ Shared MongoDB database (one server, multiple databases)
- ✅ Shared MinIO storage (one server, multiple buckets)
- ✅ Traefik routing (automatic domain-based routing)
- ✅ Each instance gets: `{domain-slug}_{8-char-uuid}`
- ✅ Secure auto-generated credentials
- ✅ No port conflicts

## Next Steps

- Check [DOCKER.md](DOCKER.md) for Docker basics
- See `make help` for all commands

## Example: Test Federation

```bash
# Create two instances
./kowloon-instance.sh create kwln.org
./kowloon-instance.sh create kwln.social

# Add both to /etc/hosts
sudo tee -a /etc/hosts <<EOF
127.0.0.1 kwln.org
127.0.0.1 kwln.social
EOF

# Start both
./kowloon-instance.sh start

# Access them
# http://kwln.org
# http://kwln.social
```

That's it! You now have two federated Kowloon instances.
